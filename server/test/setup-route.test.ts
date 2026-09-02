import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// Триггер onboarding — только отсутствие passwordHash в settings.json
// (docs/settings-model-plan.md): env-пароля в схеме больше нет.
const dataDirA = mkdtempSync(path.join(tmpdir(), 'sc-setup-a-'));
const dataDirB = mkdtempSync(path.join(tmpdir(), 'sc-setup-b-'));
process.env.DATA_DIR = dataDirA;

type SettingsModule = typeof import('../src/services/settings.js');

interface Stack {
  server: Server;
  base: string;
  authBase: string;
  settings: SettingsModule;
}

/**
 * Свежий стек express+setupRouter на отдельном data-каталоге: config/settings
 * читают env при загрузке, второй сценарий setup'а (он одноразовый на каталог)
 * требует чистых модулей и своего rate-limit- состояния auth.js.
 */
async function freshStack(dir: string): Promise<Stack> {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  process.env.DATA_DIR = dir;
  vi.resetModules();
  const express = (await import('express')).default;
  const { setupRouter } = await import('../src/routes/setup.js');
  const { authRouter } = await import('../src/routes/auth.js');
  const settings = await import('../src/services/settings.js');
  const app = express();
  app.use(express.json());
  // trust proxy — только для тестов: разводим rate-limit по X-Forwarded-For
  // (в проде trust proxy не включён, req.ip = адрес сокета).
  app.set('trust proxy', true);
  app.use('/api/setup', setupRouter);
  app.use('/api/auth', authRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, base: `${root}/api/setup`, authBase: `${root}/api/auth`, settings };
}

afterAll(async () => {
  rmSync(dataDirA, { recursive: true, force: true });
  rmSync(dataDirB, { recursive: true, force: true });
});

/** POST /api/setup от «клиента» с отдельным IP (свой rate-limit bucket). */
function post(base: string, body: unknown, ip: string): Promise<Response> {
  return fetch(base, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
}

function onDisk(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(dir, 'settings.json'), 'utf8')) as Record<string, unknown>;
}

describe('фаза A: setup без ключа — посеянные AI-поля сохраняются', () => {
  let stack: Stack;
  let base = '';
  let authBase = '';

  beforeAll(async () => {
    stack = await freshStack(dataDirA);
    base = stack.base;
    authBase = stack.authBase;
    // Seed только с ключом (как seedSettingsFromEnv при пустом APP_PASSWORD):
    // settings.json есть, passwordHash нет → onboarding остаётся required.
    stack.settings.saveSettings({
      aiProvider: 'deepseek',
      aiApiKey: 'seeded-key',
      aiApiBase: 'https://api.deepseek.com/v1',
      aiModel: 'deepseek-chat',
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => stack.server.close(() => resolve()));
  });

  it('GET /status: AI-поля посеяны, пароля нет → required: true', async () => {
    const res = await fetch(`${base}/status`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ required: true });
  });

  describe('валидация', () => {
    it('короткий пароль → 400', async () => {
      const res = await post(base, { password: 'short' }, '10.0.0.2');
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('8 символов');
    });

    it('перевод строки в пароле → 400', async () => {
      const res = await post(base, { password: '12345678\n' }, '10.0.0.3');
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('перевод строки');
    });

    it('плохой base URL (не http/https) → 400', async () => {
      const res = await post(
        base,
        { password: 'password123', aiApiKey: 'sk', aiApiBase: 'ftp://example.com' },
        '10.0.0.4',
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('http');
    });

    it('ключ API с пробелом → 400', async () => {
      const res = await post(base, { password: 'password123', aiApiKey: 'sk with space' }, '10.0.0.5');
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('пробелы');
    });

    it('ключ без aiProvider → 400', async () => {
      const res = await post(
        base,
        { password: 'password123', aiApiKey: 'sk-test', aiModel: 'test-model' },
        '10.0.0.12',
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('Провайдер');
    });

    it('ключ без aiModel → 400 (пресет без модели не работает)', async () => {
      const res = await post(
        base,
        { password: 'password123', aiApiKey: 'sk-test', aiProvider: 'deepseek' },
        '10.0.0.13',
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('Модель');
    });

    it('неизвестный aiProvider → 400', async () => {
      const res = await post(
        base,
        { password: 'password123', aiApiKey: 'sk-test', aiProvider: 'anthropic', aiModel: 'm' },
        '10.0.0.14',
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('Провайдер');
    });

    it('модель с пробелом → 400', async () => {
      const res = await post(
        base,
        { password: 'password123', aiApiKey: 'sk-test', aiProvider: 'deepseek', aiModel: 'deep seek' },
        '10.0.0.15',
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('пробелы');
    });

    it('custom без base URL → 400 (иначе ключ ушёл бы на дефолтную базу OpenAI)', async () => {
      const res = await post(
        base,
        { password: 'password123', aiApiKey: 'sk-test', aiProvider: 'custom', aiModel: 'm' },
        '10.0.0.16',
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('Base URL');
    });
  });

  describe('rate-limit', () => {
    it('11-я неудачная попытка с одного IP → 429', async () => {
      const ip = '10.0.0.6';
      for (let i = 0; i < 10; i++) {
        const res = await post(base, { password: 'x' }, ip);
        expect(res.status).toBe(400);
      }
      const limited = await post(base, { password: 'x' }, ip);
      expect(limited.status).toBe(429);
    });
  });

  describe('успех и авто-вход', () => {
    it('тело без AI-полей → хеш записан, посеянные AI-поля сохранены (мерж, не перезапись)', async () => {
      const res = await post(base, { password: 'password123' }, '10.0.0.7');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(res.headers.get('set-cookie')).toContain('sc_session=');

      const disk = onDisk(dataDirA);
      expect(disk.passwordHash).toMatch(/^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);
      expect(disk.aiProvider).toBe('deepseek');
      expect(disk.aiApiKey).toBe('seeded-key');
      expect(disk.aiApiBase).toBe('https://api.deepseek.com/v1');
      expect(disk.aiModel).toBe('deepseek-chat');
    });

    it('повторный POST после успеха → 409 (защита от перезаписи без авторизации)', async () => {
      const res = await post(base, { password: 'another-pass-123' }, '10.0.0.8');
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

    it('tmp-файла после успешной записи не остаётся', () => {
      expect(readdirSync(dataDirA).some((f) => f.startsWith('settings.json.tmp'))).toBe(false);
    });
  });
});

describe('фаза B: setup с ключом — все четыре AI-поля из тела затирают посеянные', () => {
  let stack: Stack;
  let base = '';

  beforeAll(async () => {
    stack = await freshStack(dataDirB);
    base = stack.base;
    // Другой посеянный AI-конфиг — setup с ключом должен заменить его целиком.
    stack.settings.saveSettings({
      aiProvider: 'openai',
      aiApiKey: 'old-key',
      aiApiBase: 'https://api.openai.com/v1',
      aiModel: 'gpt-4.1-mini',
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => stack.server.close(() => resolve()));
  });

  it('ключ + провайдер + base + модель → на диске значения из тела, хвостовой / срезан', async () => {
    const res = await post(
      base,
      {
        password: 'password123',
        aiApiKey: 'sk-new',
        aiProvider: 'deepseek',
        aiApiBase: 'https://api.deepseek.com/v1/',
        aiModel: 'deepseek-chat',
      },
      '10.1.0.2',
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain('sc_session=');

    const disk = onDisk(dataDirB);
    expect(disk.passwordHash).toMatch(/^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);
    expect(disk.aiProvider).toBe('deepseek');
    expect(disk.aiApiKey).toBe('sk-new');
    expect(disk.aiApiBase).toBe('https://api.deepseek.com/v1');
    expect(disk.aiModel).toBe('deepseek-chat');
  });
});
