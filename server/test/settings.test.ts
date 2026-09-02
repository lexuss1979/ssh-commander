import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

// До динамического импорта: config читает env при загрузке. Кастомный
// env-пароль → onboardingRequired() === false (ветка «env задан»);
// env-ключ/base — фолбэк getAiConfig.
const dataDir = mkdtempSync(path.join(tmpdir(), 'sc-settings-'));
process.env.DATA_DIR = dataDir;
process.env.APP_PASSWORD = 'custom-env-pass';
process.env.AI_API_BASE = 'https://env.example/v1';
process.env.AI_API_KEY = 'env-key';

const settings = await import('../src/services/settings.js');

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('хранилище settings.json', () => {
  it('getSettings: файла нет → null', () => {
    expect(settings.getSettings()).toBeNull();
  });

  it('verifyPassword без settings → фолбэк env (config.appPassword)', () => {
    // До первого saveSettings: кэш хранилища ещё пуст, активна env-ветка.
    expect(settings.verifyPassword('custom-env-pass')).toBe(true);
    expect(settings.verifyPassword('admin')).toBe(false);
    expect(settings.verifyPassword('')).toBe(false);
  });

  it('saveSettings round-trip + атомарная запись (tmp не остаётся)', () => {
    settings.saveSettings({
      passwordHash: 'scrypt$aa$bb',
      aiApiKey: 'sk-1',
      aiApiBase: 'https://api.example/v1',
    });
    expect(settings.getSettings()).toEqual({
      passwordHash: 'scrypt$aa$bb',
      aiApiKey: 'sk-1',
      aiApiBase: 'https://api.example/v1',
    });
    const files = readdirSync(dataDir);
    expect(files).toContain('settings.json');
    expect(files.some((f) => f.startsWith('settings.json.tmp'))).toBe(false);
    expect(JSON.parse(readFileSync(path.join(dataDir, 'settings.json'), 'utf8'))).toEqual({
      passwordHash: 'scrypt$aa$bb',
      aiApiKey: 'sk-1',
      aiApiBase: 'https://api.example/v1',
    });
  });

  it('права созданного файла — 0600 (в файле хеш пароля и ключ API)', () => {
    // Windows-стат chmod не отражает — тот же класс пропуска, что в
    // bootstrap.test.ts/keys.test.ts на Windows-машинах.
    if (process.platform === 'win32') return;
    settings.saveSettings({ passwordHash: 'scrypt$aa$bb' });
    expect(statSync(path.join(dataDir, 'settings.json')).mode & 0o777).toBe(0o600);
  });
});

describe('хеш пароля', () => {
  it('формат scrypt$<salt>$<hash>', () => {
    expect(settings.hashPassword('secret-pass')).toMatch(/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  });

  it('verifyPassword через settings-хеш (scrypt + timingSafeEqual) приоритетнее env', () => {
    const hash = settings.hashPassword('new-pass');
    settings.saveSettings({ passwordHash: hash });
    expect(settings.verifyPassword('new-pass')).toBe(true);
    expect(settings.verifyPassword('wrong-pass')).toBe(false);
    // env-пароль больше не подходит — настроенный хеш побеждает.
    expect(settings.verifyPassword('custom-env-pass')).toBe(false);
  });

  it('битый/незнакомый формат хеша — fail-closed', () => {
    settings.saveSettings({ passwordHash: 'plaintext' });
    expect(settings.verifyPassword('plaintext')).toBe(false);
    settings.saveSettings({ passwordHash: 'scrypt$zz$' });
    expect(settings.verifyPassword('whatever')).toBe(false);
  });
});

describe('getAiConfig: мерж settings поверх env', () => {
  it('настроек нет → env-значения', () => {
    // После saveSettings c хешем выше кэш непустой — сохраняем без ai-полей.
    settings.saveSettings({ passwordHash: 'scrypt$aa$bb' });
    expect(settings.getAiConfig()).toEqual({
      apiKey: 'env-key',
      apiBase: 'https://env.example/v1',
    });
  });

  it('settings поверх env, частичное перекрытие', () => {
    settings.saveSettings({
      passwordHash: 'scrypt$aa$bb',
      aiApiKey: 'sk-settings',
      aiApiBase: 'https://settings.example/v1/',
    });
    expect(settings.getAiConfig()).toEqual({
      apiKey: 'sk-settings',
      apiBase: 'https://settings.example/v1/',
    });
  });
});

describe('триггер onboarding', () => {
  it('кастомный env-пароль → required=false', () => {
    // config.appPassword = 'custom-env-pass' ≠ 'admin' — неконфигурации нет.
    expect(settings.onboardingRequired()).toBe(false);
  });
});

describe('corrupt-guard (свежий модуль)', () => {
  it('битый JSON → *.corrupt-*, getSettings() === null, persist отказывается', async () => {
    rmSync(dataDir, { recursive: true, force: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path.join(dataDir, 'settings.json'), '{not json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.resetModules();
    const fresh = await import('../src/services/settings.js');

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
    rmSync(dataDir, { recursive: true, force: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ passwordHash: 123 }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.resetModules();
    const fresh = await import('../src/services/settings.js');

    expect(fresh.getSettings()).toBeNull();
    expect(
      readdirSync(dataDir).filter((f) => f.startsWith('settings.json.corrupt-')),
    ).toHaveLength(1);
    expect(() => fresh.saveSettings({ passwordHash: 'scrypt$aa$bb' })).toThrow(/corrupt/);
    warn.mockRestore();
  });
});
