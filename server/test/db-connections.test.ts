import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const dataDir = mkdtempSync(path.join(tmpdir(), 'sc-dbcon-'));
process.env.DATA_DIR = dataDir;

const store = await import('../src/services/db-connections.js');

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const INPUT = {
  profileId: 'p1',
  name: 'prod',
  engine: 'postgres',
  target: { kind: 'container', containerId: 'abc123' },
  username: 'app',
  password: 'secret',
  defaultDatabase: 'appdb',
};

describe('db-connections store', () => {
  it('round-trips a connection, safe view carries no password', () => {
    const created = store.createDbConnection(INPUT);
    expect(created).toMatchObject({
      id: expect.any(String),
      profileId: 'p1',
      name: 'prod',
      engine: 'postgres',
      target: { kind: 'container', containerId: 'abc123' },
      username: 'app',
      password: 'secret',
      defaultDatabase: 'appdb',
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });

    const list = store.listDbConnections('p1');
    expect(list).toHaveLength(1);
    expect(list[0].password).toBe('secret');

    // Наружу — без пароля, но с признаком его наличия.
    const safe = store.toSafeDbConnection(created);
    expect((safe as Record<string, unknown>).password).toBeUndefined();
    expect(safe.hasPassword).toBe(true);

    // Файл персистится атомарно (tmp-файла после записи не остаётся).
    const files = readdirSync(dataDir);
    expect(files).toContain('db-connections.json');
    expect(files.some((f) => f.startsWith('db-connections.json.tmp'))).toBe(false);
    expect(JSON.parse(readFileSync(path.join(dataDir, 'db-connections.json'), 'utf8')).connections)
      .toHaveLength(1);
  });

  it('scopes list by profile', () => {
    store.createDbConnection({ ...INPUT, profileId: 'p2', name: 'other' });
    expect(store.listDbConnections('p1').map((c) => c.name)).toEqual(['prod']);
    expect(store.listDbConnections('p2').map((c) => c.name)).toEqual(['other']);
    expect(store.listDbConnections()).toHaveLength(2);
  });

  it('empty password is allowed (PG local trust) and reported hasPassword:false', () => {
    const conn = store.createDbConnection({
      ...INPUT,
      profileId: 'p3',
      password: undefined,
      defaultDatabase: undefined,
    });
    expect(conn.password).toBe('');
    expect(store.toSafeDbConnection(conn).hasPassword).toBe(false);
  });

  it('partial update: omitted password keeps the stored one', () => {
    const conn = store.createDbConnection({ ...INPUT, profileId: 'p4' });
    const updated = store.updateDbConnection(conn.id, {
      profileId: 'p4',
      name: 'renamed',
      engine: 'mysql',
      target: { kind: 'container', containerId: 'other' },
      username: 'root',
    });
    expect(updated.name).toBe('renamed');
    expect(updated.username).toBe('root');
    // Пароль не передан — сохранён прежний, как у профилей SSH.
    expect(updated.password).toBe('secret');
    expect(updated.createdAt).toBe(conn.createdAt);
    expect(store.getDbConnection(conn.id)?.password).toBe('secret');
  });

  it('update replaces the password when one is sent', () => {
    const conn = store.createDbConnection({ ...INPUT, profileId: 'p5' });
    const updated = store.updateDbConnection(conn.id, { ...INPUT, profileId: 'p5', password: 'new' });
    expect(updated.password).toBe('new');
  });

  it('update of a missing connection fails', () => {
    expect(() => store.updateDbConnection('nope', INPUT)).toThrow(/не найдено/);
  });

  it('password with a newline is rejected — stdin protocol carries one line', () => {
    expect(() => store.createDbConnection({ ...INPUT, profileId: 'p6', password: 'a\nb' }))
      .toThrow(/перевод строки/);
    expect(() => store.createDbConnection({ ...INPUT, profileId: 'p6', password: 'a\rb' }))
      .toThrow(/перевод строки/);
  });

  it('validation rejects empty name/username/container', () => {
    expect(() => store.createDbConnection({ ...INPUT, profileId: 'p7', name: '' })).toThrow();
    expect(() => store.createDbConnection({ ...INPUT, profileId: 'p7', username: '' })).toThrow();
    expect(() => store.createDbConnection({
      ...INPUT,
      profileId: 'p7',
      target: { kind: 'container', containerId: '' },
    })).toThrow();
  });

  it('host target is valid in the model (implementation arrives in v2)', () => {
    const conn = store.createDbConnection({
      ...INPUT,
      profileId: 'p8',
      target: { kind: 'host', host: 'db.internal', port: 5432 },
    });
    expect(conn.target).toEqual({ kind: 'host', host: 'db.internal', port: 5432 });
  });

  it('delete removes the connection', () => {
    const conn = store.createDbConnection({ ...INPUT, profileId: 'p9' });
    store.deleteDbConnection(conn.id);
    expect(store.getDbConnection(conn.id)).toBeUndefined();
    expect(() => store.deleteDbConnection(conn.id)).toThrow(/не найдено/);
  });

  it('moves a broken store aside and refuses to persist until restart', async () => {
    rmSync(path.join(dataDir, 'db-connections.json'), { force: true });
    writeFileSync(path.join(dataDir, 'db-connections.json'), '{not json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Свежий экземпляр модуля: кэш в памяти от предыдущих тестов не должен
    // маскировать битый файл (после рестарта процесса кэша нет).
    vi.resetModules();
    const fresh = await import('../src/services/db-connections.js');

    expect(fresh.listDbConnections()).toEqual([]);

    const backups = readdirSync(dataDir).filter((f) => f.startsWith('db-connections.json.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(path.join(dataDir, backups[0]), 'utf8')).toBe('{not json');
    expect(warn).toHaveBeenCalled();

    expect(() => fresh.createDbConnection(INPUT)).toThrow(/corrupt/);
    // Файл хранилища не пересоздаётся, пока corrupt-флаг не снят рестартом.
    expect(readdirSync(dataDir).filter((f) => f === 'db-connections.json')).toHaveLength(0);
    warn.mockRestore();
  });
});
