import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PROVIDERS } from '../../web/src/ai-providers.js';

// The onboarding trigger is only the absence of passwordHash in settings.json
// (docs/settings-model-plan.md): the env password is no longer in the schema.
const dataDirA = mkdtempSync(path.join(tmpdir(), 'sc-setup-a-'));
const dataDirB = mkdtempSync(path.join(tmpdir(), 'sc-setup-b-'));
const dataDirC = mkdtempSync(path.join(tmpdir(), 'sc-setup-go-'));
process.env.DATA_DIR = dataDirA;

type SettingsModule = typeof import('../src/services/settings.js');

interface Stack {
  server: Server;
  base: string;
  authBase: string;
  settings: SettingsModule;
}

/**
 * A fresh express+setupRouter stack on a separate data directory: config/settings
 * read the env at load time, the second setup scenario (it is one-shot per
 * directory) requires clean modules and its own rate-limit state of auth.js.
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
  // trust proxy — for tests only: it splits the rate-limit by X-Forwarded-For
  // (in production trust proxy is off, req.ip = the socket address).
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
  rmSync(dataDirC, { recursive: true, force: true });
});

/** POST /api/setup from a "client" with its own IP (its own rate-limit bucket). */
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

describe('setup with OpenCode Go', () => {
  it('saves the preset, sets the official URL and performs the auto-login', async () => {
    const stack = await freshStack(dataDirC);
    try {
      const res = await post(stack.base, {
        password: 'password123', aiApiKey: 'go-key', aiProvider: 'opencode-go', aiModel: PROVIDERS['opencode-go'].model,
      }, '10.2.0.1');
      expect(res.status).toBe(200);
      expect(res.headers.get('set-cookie')).toContain('sc_session=');
      expect(onDisk(dataDirC)).toMatchObject({
        aiProvider: 'opencode-go', aiApiKey: 'go-key',
        aiApiBase: 'https://opencode.ai/zen/go/v1', aiModel: 'glm-5.3-flash',
      });
      expect(stack.settings.getAiSettings().apiBase).toBe('https://opencode.ai/zen/go/v1');
      expect(stack.settings.getAiSettings()).toMatchObject({
        apiBase: PROVIDERS['opencode-go'].base, model: PROVIDERS['opencode-go'].model,
      });
    } finally {
      await new Promise<void>((resolve) => stack.server.close(() => resolve()));
    }
  });
});

describe('phase A: setup without a key — the seeded AI fields are kept', () => {
  let stack: Stack;
  let base = '';
  let authBase = '';

  beforeAll(async () => {
    stack = await freshStack(dataDirA);
    base = stack.base;
    authBase = stack.authBase;
    // A seed with the key only (as seedSettingsFromEnv with an empty APP_PASSWORD):
    // settings.json exists, passwordHash does not → onboarding stays required.
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

  it('GET /status: the AI fields are seeded, no password → required: true', async () => {
    const res = await fetch(`${base}/status`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ required: true });
  });

  describe('validation', () => {
    it('a short password → 400', async () => {
      const res = await post(base, { password: 'short' }, '10.0.0.2');
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('8 символов');
    });

    it('a newline in the password → 400', async () => {
      const res = await post(base, { password: '12345678\n' }, '10.0.0.3');
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('перевод строки');
    });

    it('a bad base URL (not http/https) → 400', async () => {
      const res = await post(
        base,
        { password: 'password123', aiApiKey: 'sk', aiApiBase: 'ftp://example.com' },
        '10.0.0.4',
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('http');
    });

    it('an API key with a space → 400', async () => {
      const res = await post(base, { password: 'password123', aiApiKey: 'sk with space' }, '10.0.0.5');
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('пробелы');
    });

    it('a key without aiProvider → 400', async () => {
      const res = await post(
        base,
        { password: 'password123', aiApiKey: 'sk-test', aiModel: 'test-model' },
        '10.0.0.12',
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('Провайдер');
    });

    it('a key without aiModel → 400 (a preset without a model does not work)', async () => {
      const res = await post(
        base,
        { password: 'password123', aiApiKey: 'sk-test', aiProvider: 'deepseek' },
        '10.0.0.13',
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('Модель');
    });

    it('an unknown aiProvider → 400', async () => {
      const res = await post(
        base,
        { password: 'password123', aiApiKey: 'sk-test', aiProvider: 'anthropic', aiModel: 'm' },
        '10.0.0.14',
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('Провайдер');
    });

    it('a model with a space → 400', async () => {
      const res = await post(
        base,
        { password: 'password123', aiApiKey: 'sk-test', aiProvider: 'deepseek', aiModel: 'deep seek' },
        '10.0.0.15',
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('пробелы');
    });

    it('custom without a base URL → 400 (otherwise the key would go to the default OpenAI base)', async () => {
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
    it('the 11th failed attempt from one IP → 429', async () => {
      const ip = '10.0.0.6';
      for (let i = 0; i < 10; i++) {
        const res = await post(base, { password: 'x' }, ip);
        expect(res.status).toBe(400);
      }
      const limited = await post(base, { password: 'x' }, ip);
      expect(limited.status).toBe(429);
    });
  });

  describe('success and auto-login', () => {
    it('a body without AI fields → the hash written, the seeded AI fields kept (a merge, not an overwrite)', async () => {
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

    it('a repeated POST after success → 409 (protection against an unauthorized overwrite)', async () => {
      const res = await post(base, { password: 'another-pass-123' }, '10.0.0.8');
      expect(res.status).toBe(409);
    });

    it('GET status after the setup → required: false', async () => {
      const res = await fetch(`${base}/status`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ required: false });
    });

    it('logging in with the new password works (verifyPassword via the settings hash)', async () => {
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

    it('no tmp file is left after a successful write', () => {
      expect(readdirSync(dataDirA).some((f) => f.startsWith('settings.json.tmp'))).toBe(false);
    });
  });
});

describe('phase B: setup with a key — all four AI fields from the body overwrite the seeded ones', () => {
  let stack: Stack;
  let base = '';

  beforeAll(async () => {
    stack = await freshStack(dataDirB);
    base = stack.base;
    // A different seeded AI config — a setup with a key must replace it entirely.
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

  it('a key + provider + base + model → the body values on disk, the trailing / trimmed', async () => {
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
