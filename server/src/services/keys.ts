import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/** Private keys are small; anything larger is almost certainly garbage. */
export const MAX_KEY_BYTES = 64 * 1024;

const KEY_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const PRIVATE_KEY_HEADER = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;

/** Key import error with an HTTP status for the router. */
export class KeyImportError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/**
 * Reduces a key file name to a safe form: the name only, no paths.
 * Forbidden: directory separators, `..`, a leading dot (hidden files must
 * not get into the key list) and any characters outside [A-Za-z0-9._-].
 */
export function sanitizeKeyFileName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new KeyImportError('Не задано имя файла ключа');
  if (trimmed.length > 128) {
    throw new KeyImportError('Имя файла слишком длинное (максимум 128 символов)');
  }
  if (
    trimmed === '.' ||
    trimmed === '..' ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.includes('\0')
  ) {
    throw new KeyImportError('Имя файла не должно содержать путь');
  }
  if (trimmed.startsWith('.')) {
    throw new KeyImportError('Имя файла не должно начинаться с точки');
  }
  if (!KEY_NAME_PATTERN.test(trimmed)) {
    throw new KeyImportError('В имени файла допустимы только латиница, цифры и символы . _ -');
  }
  return trimmed;
}

/**
 * A profile's key path must lie inside the keys directory.
 *
 * Otherwise `keyPath` is reading an arbitrary file on the application host
 * by the SSH client: the backup export has done this check for a long time
 * (`profile-transfer.ts`), the connection — not. Returns the normalized
 * path, and that is the one opened.
 */
export function assertKeyPathAllowed(keyPath: string, keysDir: string = config.keysDir): string {
  const dir = path.resolve(keysDir);
  const resolved = path.resolve(keyPath);
  if (resolved !== dir && !resolved.startsWith(dir + path.sep)) {
    throw new KeyImportError(
      `Путь к ключу должен быть внутри каталога ключей (${dir}): ${keyPath}. ` +
        'Импортируйте ключ через форму сервера — он сохранится туда с правами 0600.',
    );
  }
  return resolved;
}

/** Checks that the content looks like a private key (PEM/OpenSSH). */
export function assertPrivateKeyContent(content: string): void {
  if (!content.trim()) throw new KeyImportError('Файл пуст');
  if (Buffer.byteLength(content, 'utf8') > MAX_KEY_BYTES) {
    throw new KeyImportError(`Файл слишком большой (максимум ${MAX_KEY_BYTES / 1024} КБ)`);
  }
  if (!PRIVATE_KEY_HEADER.test(content)) {
    throw new KeyImportError(
      'Файл не похож на приватный ключ: ожидается заголовок -----BEGIN ... PRIVATE KEY-----',
    );
  }
}

/**
 * Saves a private key into the keys directory: an atomic write (tmp+rename),
 * mode 0600. Without `overwrite` an existing file is not overwritten (409).
 * Returns the record for the key list (name + path inside the container).
 */
export function saveKey(
  keysDir: string,
  name: string,
  content: string,
  overwrite: boolean,
): { name: string; path: string } {
  const safeName = sanitizeKeyFileName(name);
  assertPrivateKeyContent(content);
  const target = path.join(keysDir, safeName);
  if (fs.existsSync(target) && !overwrite) {
    throw new KeyImportError(`Файл «${safeName}» уже существует — подтвердите перезапись`, 409);
  }
  fs.mkdirSync(keysDir, { recursive: true });
  const tmp = path.join(keysDir, `.${safeName}.tmp-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* the tmp file may not have been created */
    }
    throw err;
  }
  // In case a file with different permissions is overwritten — the
  // permissions come from tmp (0600), but the chmod guards against rename
  // quirks on exotic filesystems.
  fs.chmodSync(target, 0o600);
  return { name: safeName, path: target };
}
