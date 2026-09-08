import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// Роут профилей: форма ответа без секретов (toSafeProfile) и правила экспорта
// бэкапа. config/profiles читают env при загрузке модуля — свежие модули
// (паттерн settings-route.test.ts).
const dataDir = mkdtempSync(path.join(tmpdir(), 'sc-profiles-route-'));
const keysDir = mkdtempSync(path.join(tmpdir(), 'sc-profiles-route-keys-'));
process.env.DATA_DIR = dataDir;
process.env.KEYS_DIR = keysDir;

let base = '';
let server: Server;

beforeAll(async () => {
  vi.resetModules();
  const express = (await import('express')).default;
  const { profilesRouter } = await import('../src/routes/profiles.js');
  const profiles = await import('../src/profiles.js');

  profiles.createProfile({
    name: 'srv',
    host: 'example.com',
    port: 22,
    username: 'root',
    authType: 'password',
    password: 'ssh-secret-1',
  });

  const app = express();
  app.use(express.json());
  app.use('/api/profiles', profilesRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(keysDir, { recursive: true, force: true });
});

describe('GET /api/profiles', () => {
  it('не отдаёт пароль наружу — только признак «задан»', async () => {
    const res = await fetch(`${base}/api/profiles`);
    const list = (await res.json()) as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(list[0].password).toBeUndefined();
    expect(list[0].keyPassphrase).toBeUndefined();
    expect(list[0].hasPassword).toBe(true);
    expect(list[0].username).toBe('root');
  });
});

describe('POST /api/profiles/export', () => {
  it('по умолчанию отдаёт бэкап без секретов', async () => {
    const res = await fetch(`${base}/api/profiles/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('ssh-secret-1');
    const parsed = JSON.parse(body);
    expect(parsed.encrypted).toBe(false);
    expect(parsed.profiles[0].password).toBeUndefined();
  });

  it('секреты без пароля шифрования — отказ, а не открытый файл', async () => {
    const res = await fetch(`${base}/api/profiles/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ includeSecrets: true }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/пароль шифрования/);
  });

  it('секреты с паролем — зашифрованный конверт без открытого секрета', async () => {
    const res = await fetch(`${base}/api/profiles/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ includeSecrets: true, passphrase: 'backup-pass-1' }),
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('ssh-secret-1');
    expect(JSON.parse(body).encrypted).toBe(true);
  });
});
