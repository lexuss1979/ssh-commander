import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FakeClient } from './helpers/fake-ssh2.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'sc-snippets-'));
process.env.DATA_DIR = dataDir;
writeFileSync(
  path.join(dataDir, 'profiles.json'),
  JSON.stringify({
    profiles: [
      { id: 'p1', name: 'alpha', host: 'h1', port: 22, username: 'u', authType: 'password', password: 'x' },
      { id: 'p2', name: 'beta', host: 'h2', port: 22, username: 'u', authType: 'password', password: 'x' },
    ],
  }),
);

// Happy-path запуск идёт через реальный getClient/exec → ssh2.Client (фейк).
vi.mock('ssh2', () => ({ Client: FakeClient }));

const store = await import('../src/services/snippets.js');
const { snippetsRouter } = await import('../src/routes/snippets.js');
const { closeProfileConnection } = await import('../src/ssh/manager.js');
const express = (await import('express')).default;

const INPUT = { name: 'Версия ОС', command: 'cat /etc/os-release' };

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Стор
// ---------------------------------------------------------------------------

describe('snippets store', () => {
  it('round-trips a snippet, персистится атомарно (tmp+rename)', () => {
    const created = store.createSnippet(INPUT);
    expect(created).toMatchObject({
      id: expect.any(String),
      name: 'Версия ОС',
      command: 'cat /etc/os-release',
      profileIds: null,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(store.listSnippets()).toHaveLength(1);

    const files = readdirSync(dataDir);
    expect(files).toContain('snippets.json');
    expect(files.some((f) => f.startsWith('snippets.json.tmp'))).toBe(false);
    expect(JSON.parse(readFileSync(path.join(dataDir, 'snippets.json'), 'utf8')).snippets)
      .toHaveLength(1);
  });

  it('profileIds: null — все серверы, массив — выбранные; отсутствие поля = null', () => {
    const scoped = store.createSnippet({ ...INPUT, profileIds: ['p1', 'p2'] });
    expect(scoped.profileIds).toEqual(['p1', 'p2']);
    const all = store.createSnippet({ ...INPUT, name: 'везде' });
    expect(all.profileIds).toBeNull();
    store.updateSnippet(all.id, { ...INPUT, profileIds: undefined });
    expect(store.getSnippet(all.id)?.profileIds).toBeNull();
  });

  it('update полностью заменяет поля, createdAt стабилен', () => {
    const s = store.createSnippet(INPUT);
    const updated = store.updateSnippet(s.id, {
      name: 'Место на диске',
      command: 'df -h',
      description: 'по всем точкам монтирования',
      profileIds: ['p1'],
    });
    expect(updated).toMatchObject({
      id: s.id,
      name: 'Место на диске',
      command: 'df -h',
      description: 'по всем точкам монтирования',
      profileIds: ['p1'],
      createdAt: s.createdAt,
    });
    expect(store.getSnippet(s.id)).toMatchObject({ name: 'Место на диске' });
  });

  it('update/delete несуществующего — ошибка', () => {
    expect(() => store.updateSnippet('nope', INPUT)).toThrow(/не найден/);
    expect(() => store.deleteSnippet('nope')).toThrow(/не найден/);
  });

  it('delete удаляет запись', () => {
    const s = store.createSnippet({ ...INPUT, name: 'на удаление' });
    store.deleteSnippet(s.id);
    expect(store.getSnippet(s.id)).toBeUndefined();
  });

  it('zod-отказы: пустые name/command, переполнение лимитов', () => {
    expect(() => store.createSnippet({ ...INPUT, name: '' })).toThrow();
    expect(() => store.createSnippet({ ...INPUT, command: '' })).toThrow();
    expect(() => store.createSnippet({ ...INPUT, command: 'x'.repeat(10001) })).toThrow();
    expect(() => store.createSnippet({ ...INPUT, description: 'd'.repeat(501) })).toThrow();
    expect(() => store.createSnippet({ ...INPUT, profileIds: Array.from({ length: 51 }, (_, i) => `p${i}`) })).toThrow();
    expect(() => store.createSnippet({ ...INPUT, profileIds: 'p1' as unknown as string[] })).toThrow();
    expect(() => store.createSnippet({ ...INPUT, profileIds: [1 as unknown as string] })).toThrow();
  });

  it('битый JSON → *.corrupt-* + отказ persist до рестарта', async () => {
    rmSync(path.join(dataDir, 'snippets.json'), { force: true });
    writeFileSync(path.join(dataDir, 'snippets.json'), '{not json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Свежий экземпляр модуля: кэш в памяти не должен маскировать битый файл.
    vi.resetModules();
    const fresh = await import('../src/services/snippets.js');

    expect(fresh.listSnippets()).toEqual([]);
    const backups = readdirSync(dataDir).filter((f) => f.startsWith('snippets.json.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(path.join(dataDir, backups[0]), 'utf8')).toBe('{not json');
    expect(warn).toHaveBeenCalled();

    expect(() => fresh.createSnippet(INPUT)).toThrow(/corrupt/);
    expect(readdirSync(dataDir).filter((f) => f === 'snippets.json')).toHaveLength(0);
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Схема запуска
// ---------------------------------------------------------------------------

describe('snippetRunBodySchema', () => {
  const { snippetRunBodySchema } = store;

  it('XOR: оба поля или ни одного — отказ', () => {
    expect(snippetRunBodySchema.safeParse({
      snippetId: 'a1',
      command: 'true',
      profileIds: ['p1'],
    }).success).toBe(false);
    expect(snippetRunBodySchema.safeParse({ profileIds: ['p1'] }).success).toBe(false);
  });

  it('ровно одно поле + цели — проходит', () => {
    expect(snippetRunBodySchema.safeParse({ snippetId: 'a1', profileIds: ['p1'] }).success).toBe(true);
    expect(snippetRunBodySchema.safeParse({ command: 'uptime', profileIds: ['p1', 'p2'] }).success).toBe(true);
  });

  it('profileIds: пустой или 11 — отказ; дубликаты допустимы (дедуп на роуте)', () => {
    expect(snippetRunBodySchema.safeParse({ command: 'x', profileIds: [] }).success).toBe(false);
    const ids = Array.from({ length: 11 }, (_, i) => `p${i}`);
    expect(snippetRunBodySchema.safeParse({ command: 'x', profileIds: ids }).success).toBe(false);
    expect(snippetRunBodySchema.safeParse({ command: 'x', profileIds: ['p1', 'p1'] }).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// mapRunResults
// ---------------------------------------------------------------------------

describe('mapRunResults', () => {
  const fulfilled = (code: number | null, stdout = '', stderr = '') =>
    ({ status: 'fulfilled', value: { code, stdout, stderr } }) as const;

  it('успех: ok по коду 0, stdout/stderr/ms на месте', () => {
    const [r] = store.mapRunResults([{
      profileId: 'p1',
      ms: 42,
      result: fulfilled(0, 'out', 'warn'),
    }]);
    expect(r).toEqual({ profileId: 'p1', ok: true, code: 0, stdout: 'out', stderr: 'warn', ms: 42, truncated: false });
  });

  it('ненулевой код: ok:false, это не ошибка запроса', () => {
    const [r] = store.mapRunResults([{
      profileId: 'p1',
      ms: 5,
      result: fulfilled(127, '', 'command not found'),
    }]);
    expect(r).toMatchObject({ ok: false, code: 127, stderr: 'command not found' });
    expect(r.error).toBeUndefined();
  });

  it('транспортный отказ/таймаут: ok:false, code:null, текст ошибки', () => {
    const [err] = store.mapRunResults([{
      profileId: 'p1',
      ms: 120_000,
      result: { status: 'rejected', reason: new Error('Превышено время выполнения (120 с)') },
    }]);
    expect(err).toMatchObject({
      ok: false,
      code: null,
      stdout: '',
      stderr: '',
      truncated: false,
      error: 'Превышено время выполнения (120 с)',
    });
    const [str] = store.mapRunResults([{
      profileId: 'p2',
      ms: 1,
      result: { status: 'rejected', reason: 'boom' },
    }]);
    expect(str.error).toBe('boom');
  });

  it('вывод длиннее 100 000 символов обрезается с пометкой truncated', () => {
    const big = 'x'.repeat(store.RUN_RESULT_TEXT_LIMIT + 500);
    const [r] = store.mapRunResults([{
      profileId: 'p1',
      ms: 1,
      result: fulfilled(0, big, big),
    }]);
    expect(r.stdout).toHaveLength(store.RUN_RESULT_TEXT_LIMIT);
    expect(r.stderr).toHaveLength(store.RUN_RESULT_TEXT_LIMIT);
    expect(r.truncated).toBe(true);
    // Внутренний кап exec в 2 МБ обрезал бы молча — серверная обрезка честно
    // помечает и этот случай.
    const [capped] = store.mapRunResults([{
      profileId: 'p2',
      ms: 1,
      result: fulfilled(0, 'y'.repeat(store.RUN_RESULT_TEXT_LIMIT)),
    }]);
    expect(capped.truncated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runSnippetOnProfiles (инъекция execFn)
// ---------------------------------------------------------------------------

describe('runSnippetOnProfiles', () => {
  it('команда передаётся в exec как есть, параллельно на каждый профиль', async () => {
    const calls: Array<{ profileId: string; command: string; timeoutMs?: number }> = [];
    const execFn = async (profile: { id: string }, command: string, opts: { timeoutMs?: number }) => {
      calls.push({ profileId: profile.id, command, timeoutMs: opts.timeoutMs });
      return { code: 0, stdout: `ok ${profile.id}`, stderr: '' };
    };
    const mk = (id: string) => ({
      id, name: id, host: 'h', port: 22, username: 'u', authType: 'password' as const, password: 'x',
    });
    const results = await store.runSnippetOnProfiles('echo "hi; rm -rf /" && true', [mk('a'), mk('b')], { execFn });

    // Никакого экранирования и deny-листа — уровень терминала.
    expect(calls.map((c) => c.command)).toEqual(['echo "hi; rm -rf /" && true', 'echo "hi; rm -rf /" && true']);
    expect(calls.every((c) => c.timeoutMs === store.RUN_TIMEOUT_MS)).toBe(true);
    expect(results.map((r) => [r.profileId, r.ok, r.stdout])).toEqual([
      ['a', true, 'ok a'],
      ['b', true, 'ok b'],
    ]);
    expect(results.every((r) => r.ms >= 0)).toBe(true);
  });

  it('отказ одного профиля не роняет остальные', async () => {
    const execFn = async (profile: { id: string }) => {
      if (profile.id === 'bad') throw new Error('Connection refused');
      return { code: 1, stdout: '', stderr: 'oops' };
    };
    const mk = (id: string) => ({
      id, name: id, host: 'h', port: 22, username: 'u', authType: 'password' as const, password: 'x',
    });
    const results = await store.runSnippetOnProfiles('true', [mk('good'), mk('bad')], { execFn });
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ profileId: 'good', ok: false, code: 1, stderr: 'oops' });
    expect(results[1]).toMatchObject({ profileId: 'bad', ok: false, code: null, error: 'Connection refused' });
  });
});

// ---------------------------------------------------------------------------
// withTimeout (после выноса в util/async.ts)
// ---------------------------------------------------------------------------

describe('withTimeout', () => {
  it('резолвится до дедлайна', async () => {
    const { withTimeout } = await import('../src/util/async.js');
    await expect(withTimeout(Promise.resolve(7), 1000, 'late')).resolves.toBe(7);
  });

  it('отвергается по дедлайну с текстом, если промис молчит', async () => {
    const { withTimeout } = await import('../src/util/async.js');
    const silent = new Promise<never>(() => undefined);
    await expect(withTimeout(silent, 20, 'Превышено время ожидания')).rejects.toThrow('Превышено время ожидания');
  });

  it('пробрасывает собственную ошибку промиса раньше дедлайна', async () => {
    const { withTimeout } = await import('../src/util/async.js');
    const failing = new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('ssh down')), 10));
    await expect(withTimeout(failing, 5000, 'timeout')).rejects.toThrow('ssh down');
  });
});

// ---------------------------------------------------------------------------
// Маршруты (валидация до exec + happy path через фейк ssh2)
// ---------------------------------------------------------------------------

describe('snippets routes', () => {
  let server: Server;
  let base = '';

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/snippets', snippetsRouter);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/snippets`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(async () => {
    for (const client of FakeClient.instances) {
      for (const ch of client.channels) ch.emit('close', null);
    }
    FakeClient.autoCloseAll = false;
    closeProfileConnection('p1');
    closeProfileConnection('p2');
    FakeClient.instances = [];
  });

  it('CRUD: create → list → update → delete', async () => {
    const created = await (await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'uptime', command: 'uptime -p', profileIds: ['p1'] }),
    })).json();
    expect(created.name).toBe('uptime');

    const list = await (await fetch(base)).json();
    expect(list.snippets.some((s: { id: string }) => s.id === created.id)).toBe(true);

    const updated = await (await fetch(`${base}/${created.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'uptime2', command: 'uptime' }),
    })).json();
    expect(updated).toMatchObject({ id: created.id, name: 'uptime2', profileIds: null });

    const del = await fetch(`${base}/${created.id}`, { method: 'DELETE' });
    expect(del.status).toBe(204);
    const gone = await fetch(`${base}/${created.id}`, {
      method: 'DELETE',
    });
    expect(gone.status).toBe(404);
  });

  it('POST /run: XOR — оба поля или ни одного → 400', async () => {
    const both = await fetch(`${base}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ snippetId: 'x', command: 'true', profileIds: ['p1'] }),
    });
    expect(both.status).toBe(400);
    expect(((await both.json()) as { error: string }).error).toContain('только одно');

    const neither = await fetch(`${base}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profileIds: ['p1'] }),
    });
    expect(neither.status).toBe(400);
    expect(((await neither.json()) as { error: string }).error).toContain('сниппет или команду');
  });

  it('POST /run: неизвестный snippetId → 400 до любого exec', async () => {
    const res = await fetch(`${base}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ snippetId: 'no-such', profileIds: ['p1'] }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('не найден');
    expect(FakeClient.instances).toHaveLength(0);
  });

  it('POST /run: пустой список, 11 профилей, несуществующий профиль → 400', async () => {
    const empty = await fetch(`${base}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'true', profileIds: [] }),
    });
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error: string }).error).toContain('хотя бы один');

    const ids = Array.from({ length: 11 }, (_, i) => `p${i}`);
    const over = await fetch(`${base}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'true', profileIds: ids }),
    });
    expect(over.status).toBe(400);

    // Дубликаты дедуплицируются (в списке отсутствующих — один раз).
    const missing = await fetch(`${base}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'true', profileIds: ['gone', 'gone'] }),
    });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toBe('Профили не найдены: gone');
  });

  it('POST /run: разовая команда на двух профилях — эхо команды + результаты', async () => {
    FakeClient.autoCloseAll = true;
    const res = await fetch(`${base}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'cat /etc/os-release', profileIds: ['p2', 'p1'] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { command: string; results: Array<{ profileId: string; ok: boolean; code: number; stdout: string }> };
    expect(body.command).toBe('cat /etc/os-release');
    expect(body.results.map((r) => r.profileId).sort()).toEqual(['p1', 'p2']);
    expect(body.results.every((r) => r.ok && r.code === 0 && r.stdout.includes('snapshot line 1'))).toBe(true);
  });
});
