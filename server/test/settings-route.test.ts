import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// The "Settings" page (epic 23, docs/settings-model-plan.md): GET returns the
// masked AI status (the key only as the fact of being set), PUT — a password
// change as a pair and a replacement/clearing of the AI config. Both routes are
// behind requireAuth. config/settings/auth read the env at module load — fresh
// modules (the setup-route.test.ts pattern).
const dataDir = mkdtempSync(path.join(tmpdir(), 'sc-settings-route-'));
process.env.DATA_DIR = dataDir;
// searchAvailable must be derived from the provider, without the env override.
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

// The cookie is substituted at call time (the variable is filled in beforeAll),
// an explicit `cookie: ''` is the no-session scenario.
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
  it('GET without a cookie → 401', async () => {
    expect((await get(noCookie)).status).toBe(401);
  });

  it('PUT without a cookie → 401', async () => {
    expect((await put({ newPassword: 'whatever-123' }, noCookie)).status).toBe(401);
  });
});

describe('GET /api/settings', () => {
  it('the masked status: the key does not leak, only apiKeySet; the DeepSeek search is enabled', async () => {
    // An explicit seed: the tests do not depend on the order (the second GET changes the provider).
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

  it('searchAvailable: non-DeepSeek without the AI_SEARCH_API_BASE env → false', async () => {
    // The password hash is untouched — the PUT tests below check it.
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

describe('PUT /api/settings — password change', () => {
  // An explicit seed: the previous describe changed the provider, the tests
  // below also check the AI-field merge.
  beforeAll(() => {
    settings.saveSettings({
      passwordHash: settings.hashPassword(PASSWORD),
      aiProvider: 'deepseek',
      aiApiKey: 'super-secret-key',
      aiApiBase: 'https://api.deepseek.com/v1',
      aiModel: 'deepseek-chat',
    });
  });

  it('a correct current password → 200, the hash replaced, the AI fields kept (merge), the session alive', async () => {
    const res = await put(
      { currentPassword: PASSWORD, newPassword: 'brand-new-pass-1' },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ai: { apiKeySet: boolean } };
    expect(body.ai.apiKeySet).toBe(true);
    expect(settings.verifyPassword('brand-new-pass-1')).toBe(true);
    expect(settings.verifyPassword(PASSWORD)).toBe(false);
    expect(onDisk().aiApiKey).toBe('super-secret-key');
    // Sessions are not invalidated: a cookie issued before the change keeps working.
    expect(auth.hasSession(cookie.split('=')[1])).toBe(true);
  });

  it('a wrong current password → 400, the password unchanged', async () => {
    const res = await put({ currentPassword: 'totally-wrong', newPassword: 'never-set-99' });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe('Неверный текущий пароль');
    expect(settings.verifyPassword('brand-new-pass-1')).toBe(true);
    expect(settings.verifyPassword('never-set-99')).toBe(false);
  });

  it('a short new password → 400', async () => {
    const res = await put({ currentPassword: 'brand-new-pass-1', newPassword: 'short' });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain('8 символов');
  });

  it('a newline in the new password → 400', async () => {
    const res = await put(
      { currentPassword: 'brand-new-pass-1', newPassword: '12345678\n' },
    );
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain('перевод строки');
  });

  it('only newPassword without the current one → 400 (the password goes as a pair)', async () => {
    const res = await put({ newPassword: 'lonely-pass-123' });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain('парой');
  });

  it('only currentPassword without the new one → 400', async () => {
    const res = await put({ currentPassword: 'brand-new-pass-1' });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain('парой');
  });
});

describe('PUT /api/settings — AI config', () => {
  it('a model-only change keeps the key, provider, base and password', async () => {
    const before = onDisk();
    const res = await put({ aiModel: 'updated-model' });
    expect(res.status).toBe(200);
    expect(onDisk()).toEqual({ ...before, aiModel: 'updated-model' });
    const text = await res.text();
    expect(JSON.parse(text).ai).toMatchObject({ model: 'updated-model', apiKeySet: true });
    expect(text).not.toContain(before.aiApiKey);
    expect(text).not.toContain('aiApiKey');
  });

  it('a Go model change via a proxy keeps its base and key', async () => {
    await put({ aiApiKey: 'go-proxy-key', aiProvider: 'opencode-go', aiApiBase: 'https://proxy.example/v1', aiModel: 'glm-5.3-flash' });
    const before = onDisk();
    const res = await put({ aiModel: 'gpt-6-luna' });
    expect(res.status).toBe(200);
    expect(onDisk()).toEqual({ ...before, aiModel: 'gpt-6-luna' });
  });

  it.each(['', '   ', 'bad model'])('an invalid model %s does not change the saved key', async (aiModel) => {
    const before = onDisk();
    expect((await put({ aiModel })).status).toBe(400);
    expect(onDisk()).toEqual(before);
  });

  it('the OpenCode Go preset is saved and read without leaking the key or enabling the search', async () => {
    const res = await put({
      aiApiKey: 'go-secret-key', aiProvider: 'opencode-go',
      aiApiBase: 'https://opencode.ai/zen/go/v1/', aiModel: 'glm-5.3-flash',
    });
    expect(res.status).toBe(200);
    const expected = {
      ai: {
        provider: 'opencode-go', apiKeySet: true, apiBase: 'https://opencode.ai/zen/go/v1',
        model: 'glm-5.3-flash', searchAvailable: false,
      },
      agentApprovalMode: 'always',
    };
    expect(await res.json()).toEqual(expected);
    expect(await (await get()).json()).toEqual(expected);
    expect(onDisk()).toMatchObject({ aiProvider: 'opencode-go', aiApiKey: 'go-secret-key' });
  });

  it('a full replacement → all four fields on disk, the trailing / trimmed, the key trimmed', async () => {
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

  it('a partial AI patch (without the model) → 400', async () => {
    const res = await put({ aiApiKey: 'sk-x', aiProvider: 'deepseek', aiApiBase: 'https://api.deepseek.com/v1' });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain('Модель');
  });

  it('a single AI field without the key → 400', async () => {
    const res = await put({ aiProvider: 'deepseek' });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain('Ключ API');
  });

  it('a key with a space → 400', async () => {
    const res = await put(
      { aiApiKey: 'sk bad', aiProvider: 'deepseek', aiApiBase: 'https://api.deepseek.com/v1', aiModel: 'm' },
    );
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain('пробелы');
  });

  it('aiApiKey: null → the AI fields removed, apiKeySet: false, the password kept', async () => {
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

  it('aiApiKey: null together with other AI fields → 400', async () => {
    const res = await put({ aiApiKey: null, aiProvider: 'deepseek' });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain('очистке');
  });

  it('a model change without a configured key → 400 and the settings unchanged', async () => {
    const before = onDisk();
    const res = await put({ aiModel: 'gpt-6-luna' });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain('Сначала задайте ключ');
    expect(onDisk()).toEqual(before);
  });

  it('an empty {} body → 400', async () => {
    const res = await put({});
    expect(res.status).toBe(400);
  });
});

// The agent access level (docs/agent-access-levels-plan.md): a standalone
// patch; enabling 'never' is gated server-side by riskAcknowledged, which is
// validated but never persisted. The describe is deliberately last: it
// mutates agentApprovalMode (and re-seeds — the describes above cleared the
// AI fields and changed the password), and the exact-match GET assertions
// above assume the default 'always'.
describe('PUT /api/settings — agent approval mode', () => {
  beforeAll(() => {
    settings.saveSettings({
      passwordHash: settings.hashPassword(PASSWORD),
      aiProvider: 'deepseek',
      aiApiKey: 'super-secret-key',
      aiApiBase: 'https://api.deepseek.com/v1',
      aiModel: 'deepseek-chat',
    });
  });

  it('GET returns the default always while the field is absent', async () => {
    const body = (await (await get()).json()) as { agentApprovalMode: string };
    expect(body.agentApprovalMode).toBe('always');
  });

  it('needed is a valid standalone patch; GET reflects it', async () => {
    const res = await put({ agentApprovalMode: 'needed' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agentApprovalMode: string };
    expect(body.agentApprovalMode).toBe('needed');
    const after = (await (await get()).json()) as { agentApprovalMode: string };
    expect(after.agentApprovalMode).toBe('needed');
    expect(onDisk().agentApprovalMode).toBe('needed');
    // Other fields are untouched (merge patch).
    expect(onDisk().aiProvider).toBe('deepseek');
    expect(onDisk().passwordHash).toMatch(/^scrypt\$/);
  });

  it("never without riskAcknowledged → 400, the mode unchanged", async () => {
    const res = await put({ agentApprovalMode: 'never' });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain('осознание рисков');
    expect(onDisk().agentApprovalMode).toBe('needed');
  });

  it('never with riskAcknowledged → 200, the flag is not persisted, a re-enable needs a fresh one', async () => {
    const res = await put({ agentApprovalMode: 'never', riskAcknowledged: true });
    expect(res.status).toBe(200);
    expect((await res.json() as { agentApprovalMode: string }).agentApprovalMode).toBe('never');
    const disk = onDisk();
    expect(disk.agentApprovalMode).toBe('never');
    expect('riskAcknowledged' in disk).toBe(false);
    // Back to a safe mode...
    expect((await put({ agentApprovalMode: 'always' })).status).toBe(200);
    // ...and 'never' again requires a fresh acknowledgement (a stale flag
    // from the earlier request would not count — it is never stored).
    expect((await put({ agentApprovalMode: 'never' })).status).toBe(400);
  });

  it('riskAcknowledged without the never mode → 400', async () => {
    const res = await put({ riskAcknowledged: true });
    expect(res.status).toBe(400);
    const res2 = await put({ agentApprovalMode: 'needed', riskAcknowledged: true });
    expect(res2.status).toBe(400);
  });

  it.each(['sometimes', 42, null])('an invalid agentApprovalMode %s → 400', async (value) => {
    const res = await put({ agentApprovalMode: value });
    expect(res.status).toBe(400);
  });

  it('the mode patch mixed with other settings → 400, nothing applied', async () => {
    const before = onDisk();
    expect((await put({ agentApprovalMode: 'needed', aiModel: 'other-model' })).status).toBe(400);
    expect((await put({ agentApprovalMode: 'needed', currentPassword: PASSWORD, newPassword: 'whatever-999' })).status).toBe(400);
    // The byte-equality of the on-disk settings proves no partial apply.
    expect(onDisk()).toEqual(before);
  });
});
