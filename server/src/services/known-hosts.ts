import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';

/**
 * SSH host key fingerprints (`data/known-hosts.json`), TOFU.
 *
 * Before this module `ssh2` connected without a `hostVerifier`, i.e. it
 * accepted any server key: with a spoofed DNS/route the profile's password
 * went to a foreign host on the very first connection, and the application
 * said nothing about it.
 *
 * The trust model is like `ssh(1)`'s: the first key is remembered silently,
 * after that a mismatch aborts the connection with an explicit message. The
 * file is a cache, not user data: a broken one is moved to `*.corrupt-*` and
 * started anew (unlike `profiles.json`, where overwriting is forbidden until
 * restart).
 */

export interface KnownHost {
  /** Key algorithm from the blob itself: `ssh-ed25519`, `ecdsa-sha2-nistp256`, … */
  algo: string;
  /** `SHA256:<base64>` — the same format `ssh-keygen -lf` prints. */
  fingerprint: string;
  addedAt: number;
}

export type HostKeyStatus = 'new' | 'match' | 'mismatch';

export interface HostKeyCheck {
  status: HostKeyStatus;
  fingerprint: string;
  algo: string;
  /** The previous fingerprint — only for `mismatch`. */
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
          /* keep the original in place */
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

/** Record key. The host is case-normalized: DNS names are case-insensitive. */
export function hostKeyId(host: string, port: number): string {
  return `${host.trim().toLowerCase()}:${port}`;
}

/**
 * Algorithm from a public key blob: the first 4 bytes are the length of the
 * algorithm string (the RFC 4253 format). Garbage on input — `unknown`; the
 * check does not break because of it.
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

/** `SHA256:<base64 without padding>` — like `ssh-keygen -lf`, so it can be compared by eye. */
export function fingerprintOf(blob: Buffer): string {
  const digest = crypto.createHash('sha256').update(blob).digest('base64');
  return `SHA256:${digest.replace(/=+$/, '')}`;
}

/**
 * Compares the host key with the stored one. An unknown host is remembered
 * (TOFU) and gets `new`; a match — `match`; otherwise `mismatch`, and the
 * caller must abort the connection.
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

/** Forget a host — after a deliberate server reinstallation. */
export function forgetHostKey(host: string, port: number): void {
  const hosts = { ...load() };
  delete hosts[hostKeyId(host, port)];
  persist(hosts);
}

/** The message for the user: what happened and what to do about it. */
export function hostKeyMismatchMessage(host: string, port: number, check: HostKeyCheck): string {
  return (
    `Ключ хоста ${host}:${port} изменился — подключение прервано. ` +
    `Сохранённый отпечаток: ${check.knownFingerprint}, сервер предъявил: ${check.fingerprint}. ` +
    'Это либо переустановка сервера, либо перехват соединения. ' +
    `Сверьте отпечаток (\`ssh-keyscan -p ${port} ${host} | ssh-keygen -lf -\`) и, если смена ожидаемая, ` +
    'удалите запись хоста из data/known-hosts.json и подключитесь снова.'
  );
}

/** Tests only: reset the cache between runs with different DATA_DIR. */
export function resetKnownHostsCache(): void {
  cache = null;
}
