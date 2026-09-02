import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

// Модель эпика 22 (docs/settings-model-plan.md): env читается один раз при
// первом старте (seed), дальше источник правды — settings.json. config и
// settings читают env при загрузке модуля, поэтому каждая группа тестов
// берёт свежий экземпляр модуля под свои env-значения (resetModules).
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
  it('env пароль+ключ → settings на диске (пароль хешем, провайдер по base)', async () => {
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

    // Пароль работает через хеш, onboarding больше не нужен.
    expect(settings.verifyPassword('seed-pass-123')).toBe(true);
    expect(settings.onboardingRequired()).toBe(false);
  });

  it('повторный вызов (и seed при существующем settings) — no-op', async () => {
    cleanDir();
    process.env.APP_PASSWORD = 'seed-pass-123';
    process.env.AI_API_KEY = 'env-key';
    const settings = await freshSettings();

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    settings.seedSettingsFromEnv();
    // Ручная правка файла после seed'а — повторный seed её не затирает.
    settings.saveSettings({ ...settings.getSettings()!, aiApiKey: 'changed' });
    settings.seedSettingsFromEnv();
    log.mockRestore();

    expect(onDisk().aiApiKey).toBe('changed');
  });

  it('seed только с AI_API_KEY (без пароля) → файл без passwordHash, onboarding required', async () => {
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

  it('seed без env (пароль и ключ пусты) → файла нет, onboarding required', async () => {
    cleanDir();
    delete process.env.APP_PASSWORD;
    process.env.AI_API_KEY = '';
    const settings = await freshSettings();

    settings.seedSettingsFromEnv();

    expect(existsSync(path.join(dataDir, 'settings.json'))).toBe(false);
    expect(settings.onboardingRequired()).toBe(true);
  });

  it('битый settings.json — seed не перезаписывает файл и не блокирует старт', async () => {
    cleanDir();
    writeFileSync(path.join(dataDir, 'settings.json'), '{not json');
    process.env.APP_PASSWORD = 'seed-pass-123';
    process.env.AI_API_KEY = 'env-key';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const settings = await freshSettings();

    expect(() => settings.seedSettingsFromEnv()).not.toThrow();

    // Файл перенесён в *.corrupt-* и не пересоздан поверх битого.
    const backups = readdirSync(dataDir).filter((f) => f.startsWith('settings.json.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(path.join(dataDir, backups[0]), 'utf8')).toBe('{not json');
    expect(readdirSync(dataDir).filter((f) => f === 'settings.json')).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('хранилище settings.json', () => {
  it('getSettings: файла нет → null', async () => {
    cleanDir();
    const settings = await freshSettings();
    expect(settings.getSettings()).toBeNull();
  });

  it('saveSettings round-trip + атомарная запись (tmp не остаётся)', async () => {
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

  it('права созданного файла — 0600 (в файле хеш пароля и ключ API)', async () => {
    cleanDir();
    const settings = await freshSettings();
    // Windows-стат chmod не отражает — тот же класс пропуска, что в
    // bootstrap.test.ts/keys.test.ts на Windows-машинах.
    if (process.platform === 'win32') return;
    settings.saveSettings({ passwordHash: 'scrypt$aa$bb' });
    expect(statSync(path.join(dataDir, 'settings.json')).mode & 0o777).toBe(0o600);
  });
});

describe('хеш пароля', () => {
  it('формат scrypt$<salt>$<hash>', async () => {
    const settings = await freshSettings();
    expect(settings.hashPassword('secret-pass')).toMatch(/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  });

  it('verifyPassword: без настроек → false даже при заданном env-пароле (фолбэка больше нет)', async () => {
    cleanDir();
    process.env.APP_PASSWORD = 'env-pass-not-used';
    const settings = await freshSettings();
    expect(settings.verifyPassword('env-pass-not-used')).toBe(false);
    expect(settings.verifyPassword('')).toBe(false);
  });

  it('verifyPassword через settings-хеш (scrypt + timingSafeEqual)', async () => {
    cleanDir();
    const settings = await freshSettings();
    settings.saveSettings({ passwordHash: settings.hashPassword('new-pass') });
    expect(settings.verifyPassword('new-pass')).toBe(true);
    expect(settings.verifyPassword('wrong-pass')).toBe(false);
  });

  it('битый/незнакомый формат хеша — fail-closed', async () => {
    cleanDir();
    const settings = await freshSettings();
    settings.saveSettings({ passwordHash: 'plaintext' });
    expect(settings.verifyPassword('plaintext')).toBe(false);
    settings.saveSettings({ passwordHash: 'scrypt$zz$' });
    expect(settings.verifyPassword('whatever')).toBe(false);
  });
});

describe('getAiSettings: только settings, дефолты — константы кода', () => {
  it('настроек нет → дефолты, provider null, ключ пуст (агент недоступен)', async () => {
    cleanDir();
    const settings = await freshSettings();
    expect(settings.getAiSettings()).toEqual({
      provider: null,
      apiKey: '',
      apiBase: 'https://api.openai.com/v1',
      model: 'gpt-4.1-mini',
    });
  });

  it('частично заполненные settings → мерж с константами', async () => {
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

  it('полный AI-конфиг в settings → всё из settings, env не читается', async () => {
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
    ['https://llm.example.com/v1', 'custom'],
  ])('%s → %s', async (base, expected) => {
    const settings = await freshSettings();
    expect(settings.providerFromBase(base)).toBe(expected);
  });
});

describe('updateSettings (эпик 23, routes/settings.ts)', () => {
  const fullSettings = {
    passwordHash: 'scrypt$aa$bb',
    aiProvider: 'deepseek' as const,
    aiApiKey: 'sk-1',
    aiApiBase: 'https://api.deepseek.com/v1',
    aiModel: 'deepseek-chat',
  };

  it('мерж поверх текущих: переданное поле меняется, остальные сохраняются', async () => {
    cleanDir();
    const settings = await freshSettings();
    settings.saveSettings({ ...fullSettings });

    const saved = settings.updateSettings({ passwordHash: 'scrypt$cc$dd' });
    expect(saved).toEqual({ ...fullSettings, passwordHash: 'scrypt$cc$dd' });
    expect(onDisk()).toEqual({ ...fullSettings, passwordHash: 'scrypt$cc$dd' });
  });

  it('null у AI-поля удаляет ключ из объекта (очистка = агент недоступен)', async () => {
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
    // Возврата к env нет: ключ пуст, пресет не выбран — агент недоступен.
    expect(settings.getAiSettings()).toEqual({
      provider: null,
      apiKey: '',
      apiBase: 'https://api.openai.com/v1',
      model: 'gpt-4.1-mini',
    });
  });

  it('настроек нет — патч создаёт файл', async () => {
    cleanDir();
    const settings = await freshSettings();
    settings.updateSettings({ aiApiKey: 'sk-seed' });
    expect(settings.getSettings()).toEqual({ aiApiKey: 'sk-seed' });
  });
});

describe('триггер onboarding', () => {
  it('есть passwordHash → false', async () => {
    cleanDir();
    const settings = await freshSettings();
    settings.saveSettings({ passwordHash: 'scrypt$aa$bb' });
    expect(settings.onboardingRequired()).toBe(false);
  });

  it('нет passwordHash (только AI-поля) → true', async () => {
    cleanDir();
    const settings = await freshSettings();
    settings.saveSettings({ aiApiKey: 'sk-1', aiProvider: 'deepseek' });
    expect(settings.onboardingRequired()).toBe(true);
  });
});

describe('corrupt-guard (свежий модуль)', () => {
  it('битый JSON → *.corrupt-*, getSettings() === null, persist отказывается', async () => {
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
    // Файл не пересоздан поверх битого.
    expect(readdirSync(dataDir).filter((f) => f === 'settings.json')).toHaveLength(0);
    warn.mockRestore();
  });

  it('zod-отказ (валидный JSON, неверная форма) — тот же corrupt-guard', async () => {
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
