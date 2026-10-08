import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

// The epic 22 model (docs/settings-model-plan.md): env is read once at first
// start (seed), afterwards the source of truth is settings.json. config and
// settings read the env at module load, so each test group takes a fresh
// module instance for its env values (resetModules).
const dataDir = mkdtempSync(path.join(tmpdir(), 'sc-settings-'));
process.env.DATA_DIR = dataDir;

async function freshSettings() {
  vi.resetModules();
  return await import('../src/services/settings.js');
}

function cleanDir(): void {
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
}

function onDisk(): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
}

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('seedSettingsFromEnv', () => {
  it('an env password+key → settings on disk (the password hashed, the provider by base)', async () => {
    cleanDir();
    process.env.APP_PASSWORD = 'seed-pass-123';
    process.env.AI_API_KEY = 'env-key';
    process.env.AI_API_BASE = 'https://api.deepseek.com/v1';
    process.env.AI_MODEL = 'deepseek-chat';
    const settings = await freshSettings();

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    settings.seedSettingsFromEnv();
    log.mockRestore();

    const disk = onDisk();
    expect(disk.passwordHash).toMatch(/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    expect(disk.aiProvider).toBe('deepseek');
    expect(disk.aiApiKey).toBe('env-key');
    expect(disk.aiApiBase).toBe('https://api.deepseek.com/v1');
    expect(disk.aiModel).toBe('deepseek-chat');

    // The password works via the hash, onboarding is no longer needed.
    expect(settings.verifyPassword('seed-pass-123')).toBe(true);
    expect(settings.onboardingRequired()).toBe(false);
  });

  it('a repeated call (and a seed over existing settings) — a no-op', async () => {
    cleanDir();
    process.env.APP_PASSWORD = 'seed-pass-123';
    process.env.AI_API_KEY = 'env-key';
    const settings = await freshSettings();

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    settings.seedSettingsFromEnv();
    // A manual file edit after the seed — a repeated seed does not wipe it.
    settings.saveSettings({ ...settings.getSettings()!, aiApiKey: 'changed' });
    settings.seedSettingsFromEnv();
    log.mockRestore();

    expect(onDisk().aiApiKey).toBe('changed');
  });

  it('a seed with AI_API_KEY only (no password) → a file without passwordHash, onboarding required', async () => {
    cleanDir();
    delete process.env.APP_PASSWORD;
    process.env.AI_API_KEY = 'only-key';
    process.env.AI_API_BASE = 'https://api.openai.com/v1';
    process.env.AI_MODEL = 'gpt-4.1-mini';
    const settings = await freshSettings();

    settings.seedSettingsFromEnv();

    const disk = onDisk();
    expect('passwordHash' in disk).toBe(false);
    expect(disk.aiProvider).toBe('openai');
    expect(disk.aiApiKey).toBe('only-key');
    expect(settings.onboardingRequired()).toBe(true);
  });

  it('a seed without env (password and key empty) → no file, onboarding required', async () => {
    cleanDir();
    delete process.env.APP_PASSWORD;
    process.env.AI_API_KEY = '';
    const settings = await freshSettings();

    settings.seedSettingsFromEnv();

    expect(existsSync(path.join(dataDir, 'settings.json'))).toBe(false);
    expect(settings.onboardingRequired()).toBe(true);
  });

  it('a broken settings.json — the seed does not overwrite the file and does not block the start', async () => {
    cleanDir();
    writeFileSync(path.join(dataDir, 'settings.json'), '{not json');
    process.env.APP_PASSWORD = 'seed-pass-123';
    process.env.AI_API_KEY = 'env-key';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const settings = await freshSettings();

    expect(() => settings.seedSettingsFromEnv()).not.toThrow();

    // The file was moved to *.corrupt-* and not recreated over the broken one.
    const backups = readdirSync(dataDir).filter((f) => f.startsWith('settings.json.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(path.join(dataDir, backups[0]), 'utf8')).toBe('{not json');
    expect(readdirSync(dataDir).filter((f) => f === 'settings.json')).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('the settings.json store', () => {
  it('getSettings: no file → null', async () => {
    cleanDir();
    const settings = await freshSettings();
    expect(settings.getSettings()).toBeNull();
  });

  it('saveSettings round-trip + an atomic write (no tmp left behind)', async () => {
    cleanDir();
    const settings = await freshSettings();
    settings.saveSettings({
      passwordHash: 'scrypt$aa$bb',
      aiProvider: 'custom',
      aiApiKey: 'sk-1',
      aiApiBase: 'https://api.example/v1',
      aiModel: 'test-model',
    });
    expect(settings.getSettings()).toEqual({
      passwordHash: 'scrypt$aa$bb',
      aiProvider: 'custom',
      aiApiKey: 'sk-1',
      aiApiBase: 'https://api.example/v1',
      aiModel: 'test-model',
    });
    const files = readdirSync(dataDir);
    expect(files).toContain('settings.json');
    expect(files.some((f) => f.startsWith('settings.json.tmp'))).toBe(false);
    expect(onDisk()).toEqual({
      passwordHash: 'scrypt$aa$bb',
      aiProvider: 'custom',
      aiApiKey: 'sk-1',
      aiApiBase: 'https://api.example/v1',
      aiModel: 'test-model',
    });
  });

  it('the created file mode is 0600 (the file holds the password hash and the API key)', async () => {
    cleanDir();
    const settings = await freshSettings();
    // The Windows stat does not reflect chmod — the same skip class as in
    // bootstrap.test.ts/keys.test.ts on Windows machines.
    if (process.platform === 'win32') return;
    settings.saveSettings({ passwordHash: 'scrypt$aa$bb' });
    expect(statSync(path.join(dataDir, 'settings.json')).mode & 0o777).toBe(0o600);
  });
});

describe('password hashing', () => {
  it('the scrypt$<salt>$<hash> format', async () => {
    const settings = await freshSettings();
    expect(settings.hashPassword('secret-pass')).toMatch(/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  });

  it('verifyPassword: no settings → false even with the env password set (no fallback anymore)', async () => {
    cleanDir();
    process.env.APP_PASSWORD = 'env-pass-not-used';
    const settings = await freshSettings();
    expect(settings.verifyPassword('env-pass-not-used')).toBe(false);
    expect(settings.verifyPassword('')).toBe(false);
  });

  it('verifyPassword via the settings hash (scrypt + timingSafeEqual)', async () => {
    cleanDir();
    const settings = await freshSettings();
    settings.saveSettings({ passwordHash: settings.hashPassword('new-pass') });
    expect(settings.verifyPassword('new-pass')).toBe(true);
    expect(settings.verifyPassword('wrong-pass')).toBe(false);
  });

  it('a broken/unfamiliar hash format — fail-closed', async () => {
    cleanDir();
    const settings = await freshSettings();
    settings.saveSettings({ passwordHash: 'plaintext' });
    expect(settings.verifyPassword('plaintext')).toBe(false);
    settings.saveSettings({ passwordHash: 'scrypt$zz$' });
    expect(settings.verifyPassword('whatever')).toBe(false);
  });
});

describe('getAiSettings: settings only, the defaults are code constants', () => {
  it('OpenCode Go is read after a settings reload with its own defaults', async () => {
    cleanDir();
    const settings = await freshSettings();
    settings.saveSettings({ aiProvider: 'opencode-go', aiApiKey: 'go-key' });
    const reloaded = await freshSettings();
    expect(reloaded.getAiSettings()).toEqual({
      provider: 'opencode-go', apiKey: 'go-key',
      apiBase: 'https://opencode.ai/zen/go/v1', model: 'glm-5.3-flash',
    });
    expect(readdirSync(dataDir).some((name) => name.includes('.corrupt-'))).toBe(false);
  });

  it('no settings → defaults, provider null, an empty key (the agent is unavailable)', async () => {
    cleanDir();
    const settings = await freshSettings();
    expect(settings.getAiSettings()).toEqual({
      provider: null,
      apiKey: '',
      apiBase: 'https://api.openai.com/v1',
      model: 'gpt-4.1-mini',
    });
  });

  it('partially filled settings → merged with the constants', async () => {
    cleanDir();
    const settings = await freshSettings();
    settings.saveSettings({ passwordHash: 'scrypt$aa$bb', aiApiKey: 'sk-settings' });
    expect(settings.getAiSettings()).toEqual({
      provider: null,
      apiKey: 'sk-settings',
      apiBase: 'https://api.openai.com/v1',
      model: 'gpt-4.1-mini',
    });
  });

  it('a full AI config in settings → everything from settings, the env is not read', async () => {
    cleanDir();
    process.env.AI_API_BASE = 'https://env.example/v1';
    process.env.AI_API_KEY = 'env-key';
    process.env.AI_MODEL = 'env-model';
    const settings = await freshSettings();
    settings.saveSettings({
      aiProvider: 'deepseek',
      aiApiKey: 'sk-settings',
      aiApiBase: 'https://api.deepseek.com/v1',
      aiModel: 'deepseek-chat',
    });
    expect(settings.getAiSettings()).toEqual({
      provider: 'deepseek',
      apiKey: 'sk-settings',
      apiBase: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
    });
  });
});

describe('providerFromBase', () => {
  it.each([
    ['https://api.deepseek.com/v1', 'deepseek'],
    ['https://api.openai.com/v1', 'openai'],
    ['https://opencode.ai/zen/go/v1', 'opencode-go'],
    ['https://opencode.ai/zen/go/v1/', 'opencode-go'],
    ['https://opencode.ai.evil.example/zen/go/v1', 'custom'],
    ['https://opencode.ai/zen/v1', 'custom'],
    ['https://llm.example.com/v1', 'custom'],
  ])('%s → %s', async (base, expected) => {
    const settings = await freshSettings();
    expect(settings.providerFromBase(base)).toBe(expected);
  });
});

describe('updateSettings (epic 23, routes/settings.ts)', () => {
  const fullSettings = {
    passwordHash: 'scrypt$aa$bb',
    aiProvider: 'deepseek' as const,
    aiApiKey: 'sk-1',
    aiApiBase: 'https://api.deepseek.com/v1',
    aiModel: 'deepseek-chat',
  };

  it('a merge over the current values: the passed field changes, the rest are kept', async () => {
    cleanDir();
    const settings = await freshSettings();
    settings.saveSettings({ ...fullSettings });

    const saved = settings.updateSettings({ passwordHash: 'scrypt$cc$dd' });
    expect(saved).toEqual({ ...fullSettings, passwordHash: 'scrypt$cc$dd' });
    expect(onDisk()).toEqual({ ...fullSettings, passwordHash: 'scrypt$cc$dd' });
  });

  it('null for an AI field removes the key from the object (clearing = the agent is unavailable)', async () => {
    cleanDir();
    const settings = await freshSettings();
    settings.saveSettings({ ...fullSettings });

    settings.updateSettings({
      aiProvider: null,
      aiApiKey: null,
      aiApiBase: null,
      aiModel: null,
    });

    expect(settings.getSettings()).toEqual({ passwordHash: 'scrypt$aa$bb' });
    expect(onDisk()).toEqual({ passwordHash: 'scrypt$aa$bb' });
    // There is no way back to env: the key is empty, no preset — the agent is unavailable.
    expect(settings.getAiSettings()).toEqual({
      provider: null,
      apiKey: '',
      apiBase: 'https://api.openai.com/v1',
      model: 'gpt-4.1-mini',
    });
  });

  it('no settings — the patch creates the file', async () => {
    cleanDir();
    const settings = await freshSettings();
    settings.updateSettings({ aiApiKey: 'sk-seed' });
    expect(settings.getSettings()).toEqual({ aiApiKey: 'sk-seed' });
  });

  it('agentApprovalMode merges and the absence of the field reads as always', async () => {
    cleanDir();
    const settings = await freshSettings();
    settings.saveSettings({ ...fullSettings });
    expect(settings.getAgentApprovalMode()).toBe('always');

    settings.updateSettings({ agentApprovalMode: 'needed' });
    expect(settings.getAgentApprovalMode()).toBe('needed');
    expect(onDisk()).toEqual({ ...fullSettings, agentApprovalMode: 'needed' });

    // null removes the field — back to the default.
    settings.updateSettings({ agentApprovalMode: null });
    expect(settings.getAgentApprovalMode()).toBe('always');
    expect('agentApprovalMode' in onDisk()).toBe(false);
  });

  it('the schema rejects an unknown agentApprovalMode (the corrupt-guard)', async () => {
    cleanDir();
    writeFileSync(
      path.join(dataDir, 'settings.json'),
      JSON.stringify({ agentApprovalMode: 'sometimes' }),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fresh = await freshSettings();
    expect(fresh.getSettings()).toBeNull();
    expect(fresh.getAgentApprovalMode()).toBe('always');
    expect(
      readdirSync(dataDir).filter((f) => f.startsWith('settings.json.corrupt-')),
    ).toHaveLength(1);
    warn.mockRestore();
  });
});

describe('the onboarding trigger', () => {
  it('a passwordHash present → false', async () => {
    cleanDir();
    const settings = await freshSettings();
    settings.saveSettings({ passwordHash: 'scrypt$aa$bb' });
    expect(settings.onboardingRequired()).toBe(false);
  });

  it('no passwordHash (AI fields only) → true', async () => {
    cleanDir();
    const settings = await freshSettings();
    settings.saveSettings({ aiApiKey: 'sk-1', aiProvider: 'deepseek' });
    expect(settings.onboardingRequired()).toBe(true);
  });
});

describe('corrupt-guard (a fresh module)', () => {
  it('broken JSON → *.corrupt-*, getSettings() === null, persist refuses', async () => {
    cleanDir();
    writeFileSync(path.join(dataDir, 'settings.json'), '{not json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fresh = await freshSettings();

    expect(fresh.getSettings()).toBeNull();
    const backups = readdirSync(dataDir).filter((f) => f.startsWith('settings.json.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(path.join(dataDir, backups[0]), 'utf8')).toBe('{not json');
    expect(warn).toHaveBeenCalled();

    expect(() => fresh.saveSettings({ passwordHash: 'scrypt$aa$bb' })).toThrow(/corrupt/);
    // The file was not recreated over the broken one.
    expect(readdirSync(dataDir).filter((f) => f === 'settings.json')).toHaveLength(0);
    warn.mockRestore();
  });

  it('a zod rejection (valid JSON, wrong shape) — the same corrupt-guard', async () => {
    cleanDir();
    writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ passwordHash: 123 }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fresh = await freshSettings();

    expect(fresh.getSettings()).toBeNull();
    expect(
      readdirSync(dataDir).filter((f) => f.startsWith('settings.json.corrupt-')),
    ).toHaveLength(1);
    expect(() => fresh.saveSettings({ passwordHash: 'scrypt$aa$bb' })).toThrow(/corrupt/);
    warn.mockRestore();
  });
});
