import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';

/**
 * Настройки приложения (`data/settings.json`), план — docs/onboarding-plan.md.
 *
 * Паттерн `db-connections.ts`/`profiles.ts`: zod-валидация, атомарная запись
 * tmp+rename, corrupt-guard (битый файл → `*.corrupt-<timestamp>`, persist
 * отказывается перезаписывать до рестарта). Пароль хранится хешем scrypt
 * (формат `scrypt$<saltHex>$<hashHex>` — самодостаточный, допускает будущую
 * смену KDF), ключ AI — открытым текстом: тот же trust domain, что у
 * SSH-паролей `profiles.json` (осознанный компромисс локального инструмента).
 */

export interface AppSettings {
  passwordHash: string;
  /** Ключ OpenAI-совместимого API (агент); без него агент недоступен. */
  aiApiKey?: string;
  /** Опциональный оверрайд базового URL API (без хвостового `/`). */
  aiApiBase?: string;
}

const settingsSchema = z.object({
  passwordHash: z.string().min(1),
  aiApiKey: z.string().optional(),
  aiApiBase: z.string().optional(),
});

// undefined — ещё не читали; null — файла нет (или битый → corrupt = true).
let cache: AppSettings | null | undefined;
// Файл не прочитался: перенесён в *.corrupt-*, и persist() отказывается
// работать до рестарта — молчаливого затирания битого файла нет.
let corrupt = false;

function storePath(): string {
  return path.join(config.dataDir, 'settings.json');
}

function load(): AppSettings | null {
  if (cache === undefined) {
    try {
      const raw = fs.readFileSync(storePath(), 'utf8');
      cache = settingsSchema.parse(JSON.parse(raw));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        cache = null;
      } else {
        const backup = `${storePath()}.corrupt-${Date.now()}`;
        try {
          fs.renameSync(storePath(), backup);
        } catch {
          /* keep the original in place */
        }
        console.warn(
          `settings store is unreadable, moved to ${backup}; refusing to overwrite it until restart:`,
          err,
        );
        corrupt = true;
        cache = null;
      }
    }
  }
  return cache;
}

/** Чтение настроек с диска; null — файла нет или он битый (corrupt-guard). */
export function getSettings(): AppSettings | null {
  const s = load();
  return s ? { ...s } : null;
}

/** Атомарная запись настроек (tmp+rename). Отказывается при битом файле. */
export function saveSettings(s: AppSettings): void {
  if (corrupt) {
    throw new Error(
      'settings store was corrupt at startup; refusing to overwrite it — fix or remove the *.corrupt-* file and restart',
    );
  }
  fs.mkdirSync(config.dataDir, { recursive: true });
  const tmp = `${storePath()}.tmp`;
  // 0600: файл содержит хеш пароля и ключ API; при rename права переезжают с tmp.
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, storePath());
  cache = { ...s };
}

const SCRYPT_KEYLEN = 64;

/** Хеш пароля: `scrypt$<saltHex>$<hashHex>` — соль и хеш в одной строке. */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function parseHash(encoded: string): { salt: Buffer; hash: Buffer } | null {
  const parts = encoded.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return null;
  const salt = Buffer.from(parts[1], 'hex');
  const hash = Buffer.from(parts[2], 'hex');
  if (salt.length === 0 || hash.length === 0) return null;
  return { salt, hash };
}

/**
 * Проверка пароля: хеш из settings.json → scrypt + `timingSafeEqual`; настроек
 * нет → сравнение с `config.appPassword` (фолбэк env, как раньше). Битый или
 * незнакомый формат хеша — fail-closed (false), а не пропуск.
 */
export function verifyPassword(candidate: string): boolean {
  const settings = load();
  if (settings?.passwordHash) {
    const parsed = parseHash(settings.passwordHash);
    if (!parsed) return false;
    const hash = crypto.scryptSync(candidate, parsed.salt, parsed.hash.length);
    return crypto.timingSafeEqual(hash, parsed.hash);
  }
  const a = Buffer.from(candidate);
  const b = Buffer.from(config.appPassword);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Мерж AI-конфига: settings поверх env (docs/onboarding-plan.md). */
export function getAiConfig(): { apiKey: string; apiBase: string } {
  const settings = load();
  return {
    apiKey: settings?.aiApiKey ?? config.ai.apiKey,
    apiBase: settings?.aiApiBase ?? config.ai.apiBase,
  };
}

/**
 * Триггер onboarding: пароль не задан ни хешем в settings.json, ни env
 * (APP_PASSWORD === 'admin' — compose-дефолт; «env не задан» неотличим от
 * «env = admin», считаем default-значение неконфигурацией).
 */
export function onboardingRequired(): boolean {
  return !load()?.passwordHash && config.appPassword === 'admin';
}
