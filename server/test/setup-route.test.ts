import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// Чистый data/, APP_PASSWORD не задаём — compose-дефолт 'admin' → onboarding
// required (docs/onboarding-plan.md, правило триггера).
const dataDir = mkdtempSync(path.join(tmpdir(), 'sc-setup-route-'));
process.env.DATA_DIR = dataDir;

const express = (await import('express')).default;
const { setupRouter } = await import('../src/routes/setup.js');
const { authRouter } = await import('../src/routes/auth.js');

let server: Server;
let base = '';
let authBase = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // trust proxy — только для тестов: разводим rate-limit по X-Forwarded-For
  // (в проде trust proxy не включён, req.ip = адрес сокета).
  app.set('trust proxy', true);
  app.use('/api/setup', setupRouter);
  app.use('/api/auth', authRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  base = `${root}/api/setup`;
  authBase = `${root}/api/auth`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
});

/** POST /api/setup от отдельного «клиента» (свой IP → свой rate-limit bucket). */
function post(body: unknown, ip: string): Promise<Response> {
  return fetch(base, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
}

describe('GET /api/setup/status', () => {
  it('чистый data + env-дефолт → required: true', async () => {
    const res = await fetch(`${base}/status`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ required: true });
  });
});

describe('POST /api/setup — валидация', () => {
  it('короткий пароль → 400', async () => {
    const res = await post({ password: 'short' }, '10.0.0.2');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('8 символов');
  });

  it('перевод строки в пароле → 400', async () => {
    const res = await post({ password: '12345678\n' }, '10.0.0.3');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('перевод строки');
  });

  it('плохой base URL (не http/https) → 400', async () => {
    const res = await post({ password: 'password123', aiApiBase: 'ftp://example.com' }, '10.0.0.4');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('http');
  });

  it('ключ API с пробелом → 400', async () => {
    const res = await post({ password: 'password123', aiApiKey: 'sk with space' }, '10.0.0.5');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('пробелы');
  });
});

describe('POST /api/setup — rate-limit', () => {
  it('11-я неудачная попытка с одного IP → 429', async () => {
    const ip = '10.0.0.6';
    for (let i = 0; i < 10; i++) {
      const res = await post({ password: 'x' }, ip);
      expect(res.status).toBe(400);
    }
    const limited = await post({ password: 'x' }, ip);
    expect(limited.status).toBe(429);
  });
});

describe('POST /api/setup — успех и авто-вход', () => {
  it('валидное тело → settings записаны (хеш, хвостовой / срезан) + cookie сессии', async () => {
    const res = await post(
      { password: 'password123', aiApiKey: 'sk-test', aiApiBase: 'https://api.deepseek.com/v1/' },
      '10.0.0.7',
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get('set-cookie')).toContain('sc_session=');

    const onDisk = JSON.parse(
      readFileSync(path.join(dataDir, 'settings.json'), 'utf8'),
    ) as { passwordHash: string; aiApiKey: string; aiApiBase: string };
    expect(onDisk.passwordHash).toMatch(/^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);
    expect(onDisk.aiApiKey).toBe('sk-test');
    expect(onDisk.aiApiBase).toBe('https://api.deepseek.com/v1');
  });

  it('повторный POST после успеха → 409 (защита от перезаписи без авторизации)', async () => {
    const res = await post({ password: 'another-pass-123' }, '10.0.0.8');
    expect(res.status).toBe(409);
  });

  it('GET status после настройки → required: false', async () => {
    const res = await fetch(`${base}/status`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ required: false });
  });

  it('логин новым паролем работает (verifyPassword через settings-хеш)', async () => {
    const ok = await fetch(`${authBase}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'password123' }),
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('set-cookie')).toContain('sc_session=');

    const bad = await fetch(`${authBase}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'wrong-password' }),
    });
    expect(bad.status).toBe(401);
  });
});

describe('settings.json в data/', () => {
  it('tmp-файла после успешной записи не остаётся', () => {
    expect(readdirSync(dataDir).some((f) => f.startsWith('settings.json.tmp'))).toBe(false);
  });
});
