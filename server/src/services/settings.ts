import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';

/**
 * Application settings (`data/settings.json`), plan in
 * docs/settings-model-plan.md.
 *
 * The `db-connections.ts`/`profiles.ts` pattern: zod validation, atomic
 * tmp+rename write, corrupt-guard (a broken file → `*.corrupt-<timestamp>`,
 * persist refuses to overwrite until restart). The password is stored as an
 * scrypt hash (the format `scrypt$<saltHex>$<hashHex>` is self-contained and
 * allows a future KDF change), the AI key in plain text: the same trust
 * domain as the SSH passwords of `profiles.json` (a deliberate compromise of
 * a local tool).
 *
 * Unified configuration model: env (`APP_PASSWORD`/`AI_API_KEY`/…) is read
 * once at first start — `seedSettingsFromEnv()` seeds it into settings.json
 * (the password immediately as a hash). After the first start env is never
 * read again; the runtime source of truth is this file only; editing — the
 * "Settings" page (epic 23) or the file + a restart.
 */

export type AiProvider = 'deepseek' | 'openai' | 'opencode-go' | 'custom';

export const OPENCODE_GO_API_BASE = 'https://opencode.ai/zen/go/v1';
export const OPENCODE_GO_MODEL = 'glm-5.3-flash';

export interface AppSettings {
  /** Optional: a seed with only the AI key set writes the AI fields without
   * a password, and onboarding stays available (appends the hash via merge). */
  passwordHash?: string;
  /** Provider preset: the UI, web-search status and API headers. */
  aiProvider?: AiProvider;
  /** OpenAI-compatible API key (the agent); without it the agent is unavailable. */
  aiApiKey?: string;
  /** API base URL (without a trailing `/`). */
  aiApiBase?: string;
  /** Agent model: a provider preset without a model does not work. */
  aiModel?: string;
}

const settingsSchema = z.object({
  passwordHash: z.string().min(1).optional(),
  aiProvider: z.enum(['deepseek', 'openai', 'opencode-go', 'custom']).optional(),
  aiApiKey: z.string().optional(),
  aiApiBase: z.string().optional(),
  aiModel: z.string().optional(),
});

// undefined — not read yet; null — no file (or a broken one → corrupt = true).
let cache: AppSettings | null | undefined;
// The file failed to load: moved to *.corrupt-*, and persist() refuses to
// work until restart — no silent overwriting of a broken file.
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

/** Read settings from disk; null — no file or it is broken (corrupt-guard). */
export function getSettings(): AppSettings | null {
  const s = load();
  return s ? { ...s } : null;
}

/** Atomic settings write (tmp+rename). Refuses on a broken file. */
export function saveSettings(s: AppSettings): void {
  if (corrupt) {
    throw new Error(
      'settings store was corrupt at startup; refusing to overwrite it — fix or remove the *.corrupt-* file and restart',
    );
  }
  fs.mkdirSync(config.dataDir, { recursive: true });
  const tmp = `${storePath()}.tmp`;
  // 0600: the file holds the password hash and the API key; on rename the mode moves with tmp.
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, storePath());
  cache = { ...s };
}

const SCRYPT_KEYLEN = 64;

/** Password hash: `scrypt$<saltHex>$<hashHex>` — salt and hash in one string. */
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
 * Password check: the hash from settings.json only → scrypt +
 * `timingSafeEqual`. No settings (or the password was never seeded) → false:
 * there is no env fallback anymore, an env password at first start is
 * written as a hash via `seedSettingsFromEnv`. A broken or unknown hash
 * format fails closed (false), not open.
 */
export function verifyPassword(candidate: string): boolean {
  const settings = load();
  if (!settings?.passwordHash) return false;
  const parsed = parseHash(settings.passwordHash);
  if (!parsed) return false;
  const hash = crypto.scryptSync(candidate, parsed.salt, parsed.hash.length);
  return crypto.timingSafeEqual(hash, parsed.hash);
}

/** Exact Go address: a substring match inside a foreign domain or path must not count. */
export function isOpenCodeGoBase(base: string): boolean {
  try {
    const url = new URL(base);
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}` === OPENCODE_GO_API_BASE;
  } catch {
    return false;
  }
}

/** Provider from the base URL — for seeding and compatibility with an old custom config. */
export function providerFromBase(base: string): AiProvider {
  if (isOpenCodeGoBase(base)) return 'opencode-go';
  if (base.includes('api.deepseek.com')) return 'deepseek';
  if (base.includes('api.openai.com')) return 'openai';
  return 'custom';
}

/**
 * Seed from env at first start (docs/settings-model-plan.md): if
 * settings.json does not exist yet and env is set — the values are copied
 * into settings (the password immediately as a hash). For existing
 * installations this is a "hidden migration": they have no settings.json,
 * env is set → the file is created by itself on restart. A broken file
 * (corrupt-guard) is left alone and the start is not blocked — saveSettings
 * throws, we catch and warn.
 */
export function seedSettingsFromEnv(): void {
  if (getSettings() !== null) return; // settings exist → ignore env
  const hasPassword = Boolean(config.appPassword);
  const hasAi = Boolean(config.ai.apiKey);
  if (!hasPassword && !hasAi) return; // nothing to seed → onboarding
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

// base/model defaults are code constants, not env: env values at first start
// are already seeded into settings.json; after that env is never read.
const DEFAULT_API_BASE = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4.1-mini';

/**
 * AI config from settings.json only (the "settings over env" merge is dead,
 * docs/settings-model-plan.md). apiKey '' — the agent is unavailable;
 * provider null — no preset selected (an installation seeded without the AI
 * fields).
 */
export function getAiSettings(): {
  provider: AiProvider | null;
  apiKey: string; // '' — the agent is unavailable
  apiBase: string;
  model: string;
} {
  const s = load();
  return {
    provider: s?.aiProvider ?? null,
    apiKey: s?.aiApiKey ?? '',
    apiBase: s?.aiApiBase ?? (s?.aiProvider === 'opencode-go' ? OPENCODE_GO_API_BASE : DEFAULT_API_BASE),
    model: s?.aiModel ?? (s?.aiProvider === 'opencode-go' ? OPENCODE_GO_MODEL : DEFAULT_MODEL),
  };
}

/**
 * Onboarding trigger: no password hash in settings.json. The env password
 * does not participate: a set env was already written as a hash by the seed,
 * and the absence of APP_PASSWORD is now an honest "not set" (there is no
 * 'admin' default in config.ts anymore).
 */
export function onboardingRequired(): boolean {
  return !load()?.passwordHash;
}

/** Settings patch: a null/undefined field value removes the field from the object. */
export type SettingsPatch = { [K in keyof AppSettings]?: AppSettings[K] | null };

/**
 * Merge patch over the current settings (epic 23, routes/settings.ts): a
 * passed field is overwritten, null/undefined — removed (clearing the AI
 * fields = "the agent is unavailable", there is no return to env — it was
 * read only at first start). Fields missing from the patch are preserved.
 * Atomicity and the corrupt-guard live in saveSettings. Returns the saved
 * object (a copy).
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
