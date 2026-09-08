import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { config } from './config.js';
import { assertKeyPathAllowed } from './services/keys.js';
import type { Profile } from './types.js';

export const profileInputSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  host: z.string().min(1, 'Host is required'),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1, 'Username is required'),
  authType: z.enum(['key', 'password']).default('password'),
  keyPath: z.string().optional(),
  keyPassphrase: z.string().optional(),
  password: z.string().optional(),
  dockerCommand: z.string().min(1).default('docker'),
  note: z.string().optional(),
  // Закреплённые пути логов (эпик 14): чипы быстрого доступа в FilesPage.
  logPaths: z.array(z.string().min(1)).max(50).optional(),
});

const profileSchema = profileInputSchema.extend({ id: z.string().min(1) });
const storeSchema = z.object({ profiles: z.array(profileSchema).default([]) });

let cache: Profile[] | null = null;
// Set when the store file failed to parse: the broken file is moved aside
// (kept for recovery) and persist() refuses to run until a restart with a
// fixed file, so a corrupt store is never silently overwritten.
let corrupt = false;

function storePath(): string {
  return path.join(config.dataDir, 'profiles.json');
}

export function listProfiles(): Profile[] {
  if (!cache) {
    try {
      const raw = fs.readFileSync(storePath(), 'utf8');
      cache = storeSchema.parse(JSON.parse(raw)).profiles;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        cache = [];
      } else {
        const backup = `${storePath()}.corrupt-${Date.now()}`;
        try {
          fs.renameSync(storePath(), backup);
        } catch {
          /* keep the original in place */
        }
        console.warn(`profiles store is unreadable, moved to ${backup}; refusing to overwrite it until restart:`, err);
        corrupt = true;
        cache = [];
      }
    }
  }
  return cache.map((p) => ({ ...p }));
}

function persist(list: Profile[]): void {
  if (corrupt) {
    throw new Error('profiles store was corrupt at startup; refusing to overwrite it — fix or remove the *.corrupt-* file and restart');
  }
  fs.mkdirSync(config.dataDir, { recursive: true });
  const tmp = `${storePath()}.tmp`;
  // 0600: файл хранит SSH-пароли и passphrase открытым текстом.
  fs.writeFileSync(tmp, JSON.stringify({ profiles: list }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, storePath());
  cache = list.map((p) => ({ ...p }));
}

function assertSecret(data: Pick<Profile, 'authType'> & Partial<Pick<Profile, 'keyPath' | 'password'>>): void {
  if (data.authType === 'key' && !data.keyPath) {
    throw new Error('keyPath is required for key auth');
  }
  if (data.authType === 'password' && !data.password) {
    throw new Error('password is required for password auth');
  }
  // Ключ — только из KEYS_DIR (services/keys.ts): профиль не должен уметь
  // читать произвольный файл на хосте приложения.
  if (data.keyPath) {
    assertKeyPathAllowed(data.keyPath);
  }
}

/**
 * Профиль без секретов — форма ответа API. Пароль и passphrase наружу не
 * отдаются: клиенту достаточно знать, что секрет задан (пустое поле формы =
 * «не менять», сервер и так сохраняет прежнее значение). Паттерн — как у
 * `toSafeDbConnection` в services/db-connections.ts.
 */
export type SafeProfile = Omit<Profile, 'password' | 'keyPassphrase'> & {
  hasPassword: boolean;
  hasKeyPassphrase: boolean;
};

export function toSafeProfile(profile: Profile): SafeProfile {
  const { password, keyPassphrase, ...rest } = profile;
  return { ...rest, hasPassword: Boolean(password), hasKeyPassphrase: Boolean(keyPassphrase) };
}

/**
 * Нормализация закреплённых путей логов: trim, пустые отбрасываются,
 * дедуп с сохранением порядка. Не-абсолютный путь или сегмент `..` —
 * исключение с перечнем плохих строк.
 */
export function normalizeLogPaths(input: string[]): string[] {
  const bad: string[] = [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of input) {
    const p = raw.trim();
    if (!p) continue;
    if (!p.startsWith('/') || p.split('/').includes('..')) {
      bad.push(p);
      continue;
    }
    if (!seen.has(p)) {
      seen.add(p);
      result.push(p);
    }
  }
  if (bad.length > 0) {
    throw new Error(`Некорректные пути логов (нужен абсолютный путь без ..): ${bad.join(', ')}`);
  }
  return result;
}

/**
 * Прогоняет logPaths через normalizeLogPaths после zod: схема допускает любые
 * непустые строки, а абсолютность/`..`/дедуп нужны на каждом входе (create,
 * update, импорт бэкапа), иначе относительный путь с импортом станет чипом,
 * который упадёт на assertSafePath.
 */
function withNormalizedLogPaths<T extends { logPaths?: string[] }>(data: T): T {
  if (!data.logPaths) return data;
  return { ...data, logPaths: normalizeLogPaths(data.logPaths) };
}

function validate(input: unknown): Profile {
  const data = withNormalizedLogPaths(profileInputSchema.parse(input));
  assertSecret(data);
  return { ...data, id: crypto.randomUUID().slice(0, 8) };
}

/** Parses and validates profile fields without persisting (test connection). */
export function parseProfileInput(input: unknown): Omit<Profile, 'id'> {
  const data = profileInputSchema.parse(input);
  assertSecret(data);
  return data;
}

export function getProfile(id: string): Profile | undefined {
  return listProfiles().find((p) => p.id === id);
}

export function requireProfile(id: string): Profile {
  const profile = getProfile(id);
  if (!profile) {
    throw new Error(`Profile ${id} not found`);
  }
  return profile;
}

export function createProfile(input: unknown): Profile {
  const profile = validate(input);
  const list = listProfiles();
  list.push(profile);
  persist(list);
  return { ...profile };
}

export function updateProfile(id: string, input: unknown): Profile {
  const list = listProfiles();
  const idx = list.findIndex((p) => p.id === id);
  if (idx < 0) {
    throw new Error(`Profile ${id} not found`);
  }
  const existing = list[idx];
  const data = withNormalizedLogPaths(profileInputSchema.parse(input));
  // Switching the auth type always requires the matching secret; otherwise
  // an omitted secret keeps the stored one (partial update without
  // re-sending the password).
  if (data.authType !== existing.authType) {
    assertSecret(data);
  }
  const updated: Profile = {
    ...data,
    id,
    keyPath: data.keyPath ?? existing.keyPath,
    keyPassphrase: data.keyPassphrase ?? existing.keyPassphrase,
    password: data.password ?? existing.password,
    // ProfileModal про поле не знает — непереданное не затирает пины.
    logPaths: data.logPaths ?? existing.logPaths,
  };
  assertSecret(updated);
  list[idx] = updated;
  persist(list);
  return { ...updated };
}

/**
 * Creates a profile from an imported backup: validates the shape but does
 * not require the auth secret — backups exported without secrets are
 * imported as-is and the secret is filled in later via the UI.
 */
export function importProfile(input: unknown): Profile {
  const data = withNormalizedLogPaths(profileInputSchema.parse(input));
  const profile: Profile = { ...data, id: crypto.randomUUID().slice(0, 8) };
  const list = listProfiles();
  list.push(profile);
  persist(list);
  return { ...profile };
}

/**
 * Заменяет список закреплённых путей логов (эпик 14). Отдельная функция, а не
 * полный updateProfile: полный апдейт рвёт SSH-подключение профиля и оборвал
 * бы тот самый tail-стрим, из которого пользователь жмёт «Закрепить».
 */
export function updateProfileLogPaths(id: string, paths: string[]): Profile {
  const list = listProfiles();
  const idx = list.findIndex((p) => p.id === id);
  if (idx < 0) {
    throw new Error(`Profile ${id} not found`);
  }
  const updated: Profile = { ...list[idx], logPaths: normalizeLogPaths(paths) };
  list[idx] = updated;
  persist(list);
  return { ...updated };
}

export function deleteProfile(id: string): void {
  const list = listProfiles();
  const next = list.filter((p) => p.id !== id);
  if (next.length === list.length) {
    throw new Error(`Profile ${id} not found`);
  }
  persist(next);
}

