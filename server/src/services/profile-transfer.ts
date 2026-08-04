import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';
import { importProfile, listProfiles, profileInputSchema } from '../profiles.js';
import { assertPrivateKeyContent, sanitizeKeyFileName, saveKey } from './keys.js';
import type { Profile } from '../types.js';

/** Ошибка переноса профилей с HTTP-статусом для роутера. */
export class ProfileTransferError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const BACKUP_APP = 'ssh-commander-profiles';
const BACKUP_VERSION = 1;
// scrypt: 16 МБ памяти, заметная задержка подбора пароля — укладывается в
// дефолтный maxmem node (32 МБ).
const KDF = { algo: 'scrypt', N: 16384, r: 8, p: 1, keylen: 32 } as const;

interface BackupKey {
  name: string;
  content: string;
}

interface BackupPayload {
  profiles: Array<Omit<Profile, 'id'>>;
  keys: BackupKey[];
}

const envelopeBaseSchema = z.object({
  app: z.literal(BACKUP_APP),
  version: z.number().int().min(1),
  encrypted: z.boolean(),
});

const encryptedEnvelopeSchema = envelopeBaseSchema.extend({
  encrypted: z.literal(true),
  kdf: z.object({
    algo: z.literal('scrypt'),
    N: z.number().int().min(1024).max(1 << 20),
    r: z.number().int().min(1).max(64),
    p: z.number().int().min(1).max(16),
    keylen: z.literal(KDF.keylen),
  }),
  salt: z.string().min(1),
  iv: z.string().min(1),
  tag: z.string().min(1),
  data: z.string().min(1),
});

// Содержимое бэкапа: для открытого файла — сам envelope (лишние поля
// app/version отбрасываются), для зашифрованного — расшифрованный payload.
const payloadSchema = z.object({
  profiles: z.array(z.unknown()).default([]),
  keys: z.array(z.object({ name: z.string(), content: z.string() })).default([]),
});

export interface ExportOptions {
  /** Включать пароли/passphrase и содержимое ключей. Без них перенос требует ручного ввода секретов. */
  includeSecrets: boolean;
  /** Пароль шифрования; без него бэкап сохраняется открытым текстом. */
  passphrase?: string;
}

export function buildExport(opts: ExportOptions): string {
  const profiles = listProfiles().map((p) => {
    const { id: _id, ...rest } = p;
    if (!opts.includeSecrets) {
      delete rest.password;
      delete rest.keyPassphrase;
    }
    return rest;
  });

  // Ключи вкладываем только вместе с секретами и только из KEYS_DIR:
  // keyPath профиля — путь на хосте приложения, читать что попало нельзя.
  const keys: BackupKey[] = [];
  if (opts.includeSecrets) {
    const keysDir = path.resolve(config.keysDir);
    const seen = new Set<string>();
    for (const p of profiles) {
      if (!p.keyPath || seen.has(p.keyPath)) continue;
      seen.add(p.keyPath);
      const resolved = path.resolve(p.keyPath);
      if (!resolved.startsWith(keysDir + path.sep)) continue;
      try {
        keys.push({ name: path.basename(resolved), content: fs.readFileSync(resolved, 'utf8') });
      } catch {
        console.warn(`profile export: cannot read key ${resolved}, skipped`);
      }
    }
  }

  const payload: BackupPayload = { profiles, keys };

  if (!opts.passphrase) {
    return JSON.stringify(
      { app: BACKUP_APP, version: BACKUP_VERSION, encrypted: false, ...payload },
      null,
      2,
    );
  }

  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(opts.passphrase, salt, KDF.keylen, {
    N: KDF.N,
    r: KDF.r,
    p: KDF.p,
  });
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return JSON.stringify(
    {
      app: BACKUP_APP,
      version: BACKUP_VERSION,
      encrypted: true,
      kdf: KDF,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    },
    null,
    2,
  );
}

export interface ImportSummary {
  imported: number;
  renamed: Array<{ from: string; to: string }>;
  keysSaved: number;
  keysSkipped: string[];
  /** Профили без секрета (экспортированы без секретов) — пароль нужно задать вручную. */
  needSecrets: string[];
}

function decryptPayload(envelope: z.infer<typeof encryptedEnvelopeSchema>, passphrase: string): unknown {
  try {
    const key = crypto.scryptSync(passphrase, Buffer.from(envelope.salt, 'base64'), envelope.kdf.keylen, {
      N: envelope.kdf.N,
      r: envelope.kdf.r,
      p: envelope.kdf.p,
    });
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(envelope.iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, 'base64')),
      decipher.final(),
    ]);
    return JSON.parse(plain.toString('utf8'));
  } catch {
    throw new ProfileTransferError('Неверный пароль или файл бэкапа повреждён');
  }
}

export function importBackup(raw: string, passphrase?: string): ImportSummary {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProfileTransferError('Файл не является JSON');
  }
  const base = envelopeBaseSchema.safeParse(parsed);
  if (!base.success) {
    throw new ProfileTransferError('Файл не похож на бэкап профилей ssh-commander');
  }
  if (base.data.version > BACKUP_VERSION) {
    throw new ProfileTransferError(
      `Бэкап версии ${base.data.version} новее, чем поддерживает приложение (${BACKUP_VERSION})`,
    );
  }

  let payloadRaw: unknown;
  if (base.data.encrypted) {
    const enc = encryptedEnvelopeSchema.safeParse(parsed);
    if (!enc.success) throw new ProfileTransferError('Повреждённый формат зашифрованного бэкапа');
    if (!passphrase) throw new ProfileTransferError('Бэкап зашифрован — укажите пароль');
    payloadRaw = decryptPayload(enc.data, passphrase);
  } else {
    payloadRaw = parsed;
  }
  const payload = payloadSchema.safeParse(payloadRaw);
  if (!payload.success) throw new ProfileTransferError('Повреждённое содержимое бэкапа');

  // Всё валидируем до первой записи: либо импортируется всё, либо ничего.
  const keys = payload.data.keys.map((k) => {
    sanitizeKeyFileName(k.name);
    try {
      assertPrivateKeyContent(k.content);
    } catch (err) {
      throw new ProfileTransferError(`Ключ «${k.name}»: ${(err as Error).message}`);
    }
    return k;
  });
  const profiles = payload.data.profiles.map((p, i) => {
    try {
      return profileInputSchema.parse(p);
    } catch (err) {
      const name =
        typeof p === 'object' && p !== null && 'name' in p ? String((p as { name: unknown }).name) : `#${i + 1}`;
      throw new ProfileTransferError(
        `Профиль «${name}» не прошёл валидацию: ${(err as Error).message}`,
      );
    }
  });

  // Ключи: существующие не затираем — профили будут ссылаться на них.
  const summary: ImportSummary = {
    imported: 0,
    renamed: [],
    keysSaved: 0,
    keysSkipped: [],
    needSecrets: [],
  };
  const keyPaths = new Map<string, string>();
  for (const k of keys) {
    const target = path.join(config.keysDir, sanitizeKeyFileName(k.name));
    keyPaths.set(k.name, target);
    if (fs.existsSync(target)) {
      summary.keysSkipped.push(k.name);
      continue;
    }
    saveKey(config.keysDir, k.name, k.content, false);
    summary.keysSaved += 1;
  }

  const existingNames = new Set(listProfiles().map((p) => p.name));
  for (const data of profiles) {
    // Перепривязываем ключ к пути в KEYS_DIR текущей установки.
    if (data.keyPath) {
      const mapped = keyPaths.get(path.basename(data.keyPath));
      if (mapped) data.keyPath = mapped;
    }
    let name = data.name;
    for (let n = 2; existingNames.has(name); n += 1) {
      name = `${data.name} (${n})`;
    }
    if (name !== data.name) {
      summary.renamed.push({ from: data.name, to: name });
      data.name = name;
    }
    existingNames.add(data.name);
    if (
      (data.authType === 'password' && !data.password) ||
      (data.authType === 'key' && (!data.keyPath || !fs.existsSync(data.keyPath)))
    ) {
      summary.needSecrets.push(data.name);
    }
    importProfile(data);
    summary.imported += 1;
  }
  return summary;
}
