import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// Страница «Настройки» (эпик 23, docs/settings-model-plan.md): GET отдаёт
// маскированный AI-статус (ключ — только фактом «задан»), PUT — смена пароля
// парой и замена/очистка AI-конфига. Оба роута под requireAuth. config/
// settings/auth читают env при загрузке модуля — свежие модули (паттерн
// setup-route.test.ts).
const dataDir = mkdtempSync(path.join(tmpdir(), 'sc-settings-route-'));
process.env.DATA_DIR = dataDir;
// searchAvailable должен определяться провайдером, без env-оверрайда.
delete process.env.AI_SEARCH_API_BASE;

let base = '';
let cookie = '';
let server: Server;
let settings: typeof import('../src/services/settings.js');
let auth: typeof import('../src/auth.js');

const PASSWORD = 'route-pass-123';

beforeAll(async () => {
  vi.resetModules();
  const express = (await import('express')).default;
  settings = await import('../src/services/settings.js');
  auth = await import('../src/auth.js');
  const { settingsRouter } = await import('../src/routes/settings.js');

  settings.saveSettings({
    passwordHash: settings.hashPassword(PASSWORD),
    aiProvider: 'deepseek',
    aiApiKey: 'super-secret-key',
    aiApiBase: 'https://api.deepseek.com/v1',
    aiModel: 'deepseek-chat',
  });

  const app = express();
  app.use(express.json());
  app.use('/api/settings', auth.requireAuth, settingsRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/settings`;
  const token = auth.createSession(PASSWORD);
  if (!token) throw new Error('session not created');
  cookie = `sc_session=${token}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
});

// cookie подставляется в момент вызова (переменная заполняется в beforeAll),
// явное `cookie: ''` — сценарий без сессии.
function get(headers: Record<string, string> = {}): Promise<Response> {
  return fetch(base, { headers: { cookie, ...headers } });
}

function put(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(base, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie, ...headers },
    body: JSON.stringify(body),
  });
}

const noCookie = { cookie: '' };

async function errorOf(res: Response): Promise<string> {
  return ((await res.json()) as { error?: string }).error ?? '';
}

function onDisk(): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(dataDir, 'settings.json'), 'utf8')) as Record<
    string,
    unknown
  >;
}

describe('requireAuth', () => {
  it('GET без cookie → 401', async () => {
    expect((await get(noCookie)).status).toBe(401);
  });

  it('PUT без cookie → 401', async () => {
    expect((await put({ newPassword: 'whatever-123' }, noCookie)).status).toBe(401);
  });
});

describe('GET /api/settings', () => {
  it('маскированный статус: ключ не утекает, только apiKeySet; поиск DeepSeek включён', async () => {
    // Явный сид: тесты не зависят от порядка (второй GET меняет провайдера).
    settings.saveSettings({
      passwordHash: settings.hashPassword(PASSWORD),
      aiProvider: 'deepseek',
      aiApiKey: 'super-secret-key',
      aiApiBase: 'https://api.deepseek.com/v1',
      aiModel: 'deepseek-chat',
    });
    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ai: Record<string, unknown> };
    expect(body.ai).toEqual({
      provider: 'deepseek',
      apiKeySet: true,
      apiBase: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      searchAvailable: true,
    });
    expect(JSON.stringify(body)).not.toContain('super-secret-key');
  });

  it('searchAvailable: у не-DeepSeek без env AI_SEARCH_API_BASE → false', async () => {
    // Хеш пароля не трогаем — дальше его проверяют PUT-тесты.
    settings.saveSettings({
      ...settings.getSettings()!,
      aiProvider: 'custom',
      aiApiKey: 'other-key',
      aiApiBase: 'https://llm.example.com/v1',
      aiModel: 'my-model',
    });
    const res = await get();
    const body = (await res.json()) as { ai: { searchAvailable: boolean; provider: string } };
    expect(body.ai.provider).toBe('custom');
    expect(body.ai.searchAvailable).toBe(false);
  });
});

describe('PUT /api/settings — смена пароля', () => {
  // Явный сид: предыдущий describe менял провайдера, тесты ниже проверяют
  // и мерж AI-полей.
  beforeAll(() => {
    settings.saveSettings({
      passwordHash: settings.hashPassword(PASSWORD),
      aiProvider: 'deepseek',
      aiApiKey: 'super-secret-key',
      aiApiBase: 'https://api.deepseek.com/v1',
      aiModel: 'deepseek-chat',
    });
  });

  it('верный текущий → 200, хеш заменён, AI-поля сохранены (мерж), сессия жива', async () => {
    const res = await put(
      { currentPassword: PASSWORD, newPassword: 'brand-new-pass-1' },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ai: { apiKeySet: boolean } };
    expect(body.ai.apiKeySet).toBe(true);
    expect(settings.verifyPassword('brand-new-pass-1')).toBe(true);
    expect(settings.verifyPassword(PASSWORD)).toBe(false);
    expect(onDisk().aiApiKey).toBe('super-secret-key');
    // Сессии не инвалидируются: cookie, выданная до смены, продолжает работать.
    expect(auth.hasSession(cookie.split('=')[1])).toBe(true);
  });

  it('неверный текущий → 400, пароль не изменился', async () => {
    const res = await put({ currentPassword: 'totally-wrong', newPassword: 'never-set-99' });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe('Неверный текущий пароль');
    expect(settings.verifyPassword('brand-new-pass-1')).toBe(true);
    expect(settings.verifyPassword('never-set-99')).toBe(false);
  });

  it('короткий новый пароль → 400', async () => {
    const res = await put({ currentPassword: 'brand-new-pass-1', newPassword: 'short' });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain('8 символов');
  });

  it('перевод строки в новом пароле → 400', async () => {
    const res = await put(
      { currentPassword: 'brand-new-pass-1', newPassword: '12345678\n' },
    );
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain('перевод строки');
  });

  it('только newPassword без текущего → 400 (пароль идёт парой)', async () => {
    const res = await put({ newPassword: 'lonely-pass-123' });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain('парой');
  });

  it('только currentPassword без нового → 400', async () => {
    const res = await put({ currentPassword: 'brand-new-pass-1' });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain('парой');
  });
});

describe('PUT /api/settings — AI-конфиг', () => {
  it('замена целиком → все четыре поля на диске, хвостовой / срезан, ключ trim', async () => {
    const res = await put(
      {
        aiApiKey: 'sk-replacement ',
        aiProvider: 'custom',
        aiApiBase: 'https://llm.example.com/v1/',
        aiModel: 'my-model',
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ai: Record<string, unknown> };
    expect(body.ai).toEqual({
      provider: 'custom',
      apiKeySet: true,
      apiBase: 'https://llm.example.com/v1',
      model: 'my-model',
      searchAvailable: false,
    });
    expect(onDisk().aiApiKey).toBe('sk-replacement');
  });

  it('частичный AI-патч (без модели) → 400', async () => {
    const res = await put({ aiApiKey: 'sk-x', aiProvider: 'deepseek', aiApiBase: 'https://api.deepseek.com/v1' });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain('Модель');
  });

  it('одно AI-поле без ключа → 400', async () => {
    const res = await put({ aiProvider: 'deepseek' });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain('Ключ API');
  });

  it('ключ с пробелом → 400', async () => {
    const res = await put(
      { aiApiKey: 'sk bad', aiProvider: 'deepseek', aiApiBase: 'https://api.deepseek.com/v1', aiModel: 'm' },
    );
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain('пробелы');
  });

  it('aiApiKey: null → AI-поля удалены, apiKeySet: false, пароль сохранён', async () => {
    const res = await put({ aiApiKey: null });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ai: Record<string, unknown> };
    expect(body.ai).toEqual({
      provider: null,
      apiKeySet: false,
      apiBase: 'https://api.openai.com/v1',
      model: 'gpt-4.1-mini',
      searchAvailable: false,
    });
    const disk = onDisk();
    expect('aiApiKey' in disk).toBe(false);
    expect('aiProvider' in disk).toBe(false);
    expect(disk.passwordHash).toMatch(/^scrypt\$/);
  });

  it('aiApiKey: null вместе с другими AI-полями → 400', async () => {
    const res = await put({ aiApiKey: null, aiProvider: 'deepseek' });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain('очистке');
  });

  it('пустое тело {} → 400', async () => {
    const res = await put({});
    expect(res.status).toBe(400);
  });
});
