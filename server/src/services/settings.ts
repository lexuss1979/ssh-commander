import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';

/**
 * Настройки приложения (`data/settings.json`), план — docs/settings-model-plan.md.
 *
 * Паттерн `db-connections.ts`/`profiles.ts`: zod-валидация, атомарная запись
 * tmp+rename, corrupt-guard (битый файл → `*.corrupt-<timestamp>`, persist
 * отказывается перезаписывать до рестарта). Пароль хранится хешем scrypt
 * (формат `scrypt$<saltHex>$<hashHex>` — самодостаточный, допускает будущую
 * смену KDF), ключ AI — открытым текстом: тот же trust domain, что у
 * SSH-паролей `profiles.json` (осознанный компромисс локального инструмента).
 *
 * Единая модель конфигурации: env (`APP_PASSWORD`/`AI_API_KEY`/…) читается
 * один раз при первом старте — `seedSettingsFromEnv()` сеет его в settings.json
 * (пароль сразу хешем). После первого старта env не читается никогда, источник
 * правды в рантайме — только этот файл; правка — страница «Настройки» (эпик 23)
 * или файл + рестарт.
 */

export type AiProvider = 'deepseek' | 'openai' | 'custom';

export interface AppSettings {
  /** Опционален: seed при заданном только AI-ключе пишет AI-поля без пароля,
   * и onboarding остаётся доступным (дозаписывает хеш мержем). */
  passwordHash?: string;
  /** Какой пресет провайдера выбран: статус веб-поиска и UI; на логику ходьбы
   * в API не влияет. */
  aiProvider?: AiProvider;
  /** Ключ OpenAI-совместимого API (агент); без него агент недоступен. */
  aiApiKey?: string;
  /** Базовый URL API (без хвостового `/`). */
  aiApiBase?: string;
  /** Модель агента: пресет провайдера без модели не работает. */
  aiModel?: string;
}

const settingsSchema = z.object({
  passwordHash: z.string().min(1).optional(),
  aiProvider: z.enum(['deepseek', 'openai', 'custom']).optional(),
  aiApiKey: z.string().optional(),
  aiApiBase: z.string().optional(),
  aiModel: z.string().optional(),
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
 * Проверка пароля: только хеш из settings.json → scrypt + `timingSafeEqual`.
 * Настроек нет (или пароль не сеялся) → false: env-фолбэка больше нет, env-пароль
 * при первом старте записывается хешем через `seedSettingsFromEnv`. Битый или
 * незнакомый формат хеша — fail-closed (false), а не пропуск.
 */
export function verifyPassword(candidate: string): boolean {
  const settings = load();
  if (!settings?.passwordHash) return false;
  const parsed = parseHash(settings.passwordHash);
  if (!parsed) return false;
  const hash = crypto.scryptSync(candidate, parsed.salt, parsed.hash.length);
  return crypto.timingSafeEqual(hash, parsed.hash);
}

/** Провайдер по base URL — эвристика только для seed'а и UI-подписи. */
export function providerFromBase(base: string): AiProvider {
  if (base.includes('api.deepseek.com')) return 'deepseek';
  if (base.includes('api.openai.com')) return 'openai';
  return 'custom';
}

/**
 * Seed из env при первом старте (docs/settings-model-plan.md): если
 * settings.json ещё нет, а env задан — значения копируются в settings
 * (пароль — сразу хешем). Для существующих установок это «скрытая миграция»:
 * settings.json у них нет, env задан → файл создаётся сам при рестарте.
 * Битый файл (corrupt-guard) не трогаем и старт не блокируем — saveSettings
 * бросит, ловим и warn.
 */
export function seedSettingsFromEnv(): void {
  if (getSettings() !== null) return; // settings есть → env игнорируем
  const hasPassword = Boolean(config.appPassword);
  const hasAi = Boolean(config.ai.apiKey);
  if (!hasPassword && !hasAi) return; // сеять нечего → onboarding
  try {
    saveSettings({
      passwordHash: hasPassword ? hashPassword(config.appPassword) : undefined,
      aiProvider: hasAi ? providerFromBase(config.ai.apiBase) : undefined,
      aiApiKey: hasAi ? config.ai.apiKey : undefined,
      aiApiBase: hasAi ? config.ai.apiBase : undefined,
      aiModel: hasAi ? config.ai.model : undefined,
    });
    console.log('settings.json seeded from environment');
  } catch (err) {
    console.warn('settings.json seed skipped:', (err as Error).message);
  }
}

// Дефолты base/model — константы кода, не env: env-значения при первом старте
// уже посеяны в settings.json, после него env не читается.
const DEFAULT_API_BASE = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4.1-mini';

/**
 * AI-конфиг только из settings.json (мерж «settings поверх env» умер,
 * docs/settings-model-plan.md). apiKey '' — агент недоступен; provider null —
 * пресет не выбран (установка без seed'а AI-полей).
 */
export function getAiSettings(): {
  provider: AiProvider | null;
  apiKey: string; // '' — агент недоступен
  apiBase: string;
  model: string;
} {
  const s = load();
  return {
    provider: s?.aiProvider ?? null,
    apiKey: s?.aiApiKey ?? '',
    apiBase: s?.aiApiBase ?? DEFAULT_API_BASE,
    model: s?.aiModel ?? DEFAULT_MODEL,
  };
}

/**
 * Триггер onboarding: пароля хешем в settings.json нет. Env-пароль не
 * участвует: заданный env уже записан seed'ом хешем, а отсутствие APP_PASSWORD
 * теперь честное «не задан» (дефолта 'admin' в config.ts больше нет).
 */
export function onboardingRequired(): boolean {
  return !load()?.passwordHash;
}

/** Патч настроек: значение null/undefined у поля удаляет его из объекта. */
export type SettingsPatch = { [K in keyof AppSettings]?: AppSettings[K] | null };

/**
 * Мерж-патч поверх текущих настроек (эпик 23, routes/settings.ts): переданное
 * поле перезаписывается, null/undefined — удаляется (очистка AI-полей = «агент
 * недоступен», возврата к env нет — он читался только при первом старте).
 * Поля, которых нет в патче, сохраняются. Атомарность и corrupt-guard — в
 * saveSettings. Возвращает сохранённый объект (копию).
 */
export function updateSettings(patch: SettingsPatch): AppSettings {
  const next: Record<string, unknown> = { ...(getSettings() ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) {
      delete next[key];
    } else {
      next[key] = value;
    }
  }
  const saved = next as AppSettings;
  saveSettings(saved);
  return { ...saved };
}
