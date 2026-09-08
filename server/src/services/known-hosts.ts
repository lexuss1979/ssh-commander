import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';

/**
 * Отпечатки ключей SSH-хостов (`data/known-hosts.json`), TOFU.
 *
 * До этого модуля `ssh2` подключался без `hostVerifier`, то есть принимал
 * любой ключ сервера: при подмене DNS/маршрута пароль профиля уходил чужому
 * хосту на первом же подключении, и приложение об этом не сообщало.
 *
 * Модель доверия — как у `ssh(1)`: первый ключ запоминается молча, дальше
 * несовпадение обрывает подключение с явным текстом. Файл — кэш, а не данные
 * пользователя: битый переносится в `*.corrupt-*` и заводится заново
 * (в отличие от `profiles.json`, где перезапись запрещена до рестарта).
 */

export interface KnownHost {
  /** Алгоритм ключа из самого блоба: `ssh-ed25519`, `ecdsa-sha2-nistp256`, … */
  algo: string;
  /** `SHA256:<base64>` — тот же формат, что печатает `ssh-keygen -lf`. */
  fingerprint: string;
  addedAt: number;
}

export type HostKeyStatus = 'new' | 'match' | 'mismatch';

export interface HostKeyCheck {
  status: HostKeyStatus;
  fingerprint: string;
  algo: string;
  /** Прежний отпечаток — только при `mismatch`. */
  knownFingerprint?: string;
}

const hostSchema = z.object({
  algo: z.string(),
  fingerprint: z.string().min(1),
  addedAt: z.number(),
});
const storeSchema = z.object({ hosts: z.record(hostSchema).default({}) });

let cache: Record<string, KnownHost> | null = null;

function storePath(): string {
  return path.join(config.dataDir, 'known-hosts.json');
}

function load(): Record<string, KnownHost> {
  if (!cache) {
    try {
      const raw = fs.readFileSync(storePath(), 'utf8');
      cache = storeSchema.parse(JSON.parse(raw)).hosts;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        const backup = `${storePath()}.corrupt-${Date.now()}`;
        try {
          fs.renameSync(storePath(), backup);
        } catch {
          /* оставляем как есть */
        }
        console.warn(`known-hosts store is unreadable, moved to ${backup}; starting a fresh one:`, err);
      }
      cache = {};
    }
  }
  return cache;
}

function persist(hosts: Record<string, KnownHost>): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const tmp = `${storePath()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ hosts }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, storePath());
  cache = { ...hosts };
}

/** Ключ записи. Хост нормализуется регистром: DNS-имена регистронезависимы. */
export function hostKeyId(host: string, port: number): string {
  return `${host.trim().toLowerCase()}:${port}`;
}

/**
 * Алгоритм из блоба публичного ключа: первые 4 байта — длина строки-алгоритма
 * (формат RFC 4253). Мусор на входе — `unknown`, проверку это не ломает.
 */
export function algoFromBlob(blob: Buffer): string {
  try {
    const len = blob.readUInt32BE(0);
    if (len <= 0 || len > 64 || blob.length < 4 + len) return 'unknown';
    return blob.subarray(4, 4 + len).toString('ascii');
  } catch {
    return 'unknown';
  }
}

/** `SHA256:<base64 без паддинга>` — как у `ssh-keygen -lf`, чтобы сверять глазами. */
export function fingerprintOf(blob: Buffer): string {
  const digest = crypto.createHash('sha256').update(blob).digest('base64');
  return `SHA256:${digest.replace(/=+$/, '')}`;
}

/**
 * Сверяет ключ хоста с сохранённым. Незнакомый хост запоминается (TOFU) и
 * получает `new`; совпадение — `match`; иначе `mismatch`, и подключение
 * обязано быть прервано вызывающим.
 */
export function checkHostKey(host: string, port: number, blob: Buffer): HostKeyCheck {
  const id = hostKeyId(host, port);
  const algo = algoFromBlob(blob);
  const fingerprint = fingerprintOf(blob);
  const hosts = load();
  const known = hosts[id];
  if (!known) {
    persist({ ...hosts, [id]: { algo, fingerprint, addedAt: Date.now() } });
    return { status: 'new', fingerprint, algo };
  }
  if (known.fingerprint === fingerprint) {
    return { status: 'match', fingerprint, algo };
  }
  return { status: 'mismatch', fingerprint, algo, knownFingerprint: known.fingerprint };
}

/** Забыть хост — после осознанной переустановки сервера. */
export function forgetHostKey(host: string, port: number): void {
  const hosts = { ...load() };
  delete hosts[hostKeyId(host, port)];
  persist(hosts);
}

/** Текст для пользователя: что случилось и что с этим делать. */
export function hostKeyMismatchMessage(host: string, port: number, check: HostKeyCheck): string {
  return (
    `Ключ хоста ${host}:${port} изменился — подключение прервано. ` +
    `Сохранённый отпечаток: ${check.knownFingerprint}, сервер предъявил: ${check.fingerprint}. ` +
    'Это либо переустановка сервера, либо перехват соединения. ' +
    `Сверьте отпечаток (\`ssh-keyscan -p ${port} ${host} | ssh-keygen -lf -\`) и, если смена ожидаемая, ` +
    'удалите запись хоста из data/known-hosts.json и подключитесь снова.'
  );
}

/** Только для тестов: сбросить кэш между прогонами с разным DATA_DIR. */
export function resetKnownHostsCache(): void {
  cache = null;
}
