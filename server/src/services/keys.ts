import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/** Приватные ключи маленькие; больше — почти наверняка мусор. */
export const MAX_KEY_BYTES = 64 * 1024;

const KEY_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const PRIVATE_KEY_HEADER = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;

/** Ошибка импорта ключа с HTTP-статусом для роутера. */
export class KeyImportError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/**
 * Приводит имя файла ключа к безопасному виду: только имя, без путей.
 * Запрещены разделители каталогов, `..`, ведущая точка (скрытые файлы
 * не попадают в список ключей) и любые символы вне [A-Za-z0-9._-].
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
 * Путь к ключу профиля обязан лежать внутри каталога ключей.
 *
 * Иначе `keyPath` — это чтение произвольного файла на хосте приложения силами
 * SSH-клиента: экспорт бэкапа такую проверку делал давно (`profile-transfer.ts`),
 * подключение — нет. Возвращает нормализованный путь, его и открывают.
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

/** Проверяет, что содержимое похоже на приватный ключ (PEM/OpenSSH). */
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
 * Сохраняет приватный ключ в каталог ключей: атомарная запись (tmp+rename),
 * права 0600. Без `overwrite` существующий файл не затирается (409).
 * Возвращает запись для списка ключей (имя + путь внутри контейнера).
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
      /* tmp мог не создаться */
    }
    throw err;
  }
  // На случай перезаписи файла с другими правами — права берутся с tmp (0600),
  // но chmod страхует от тонкостей rename на экзотических ФС.
  fs.chmodSync(target, 0o600);
  return { name: safeName, path: target };
}
