import { basename, dirname } from '../util/path.js';
import { shq } from '../util/shell.js';

export const TAR_NOT_FOUND_MESSAGE =
  'На удалённом сервере не найден tar — установите его (например, apt-get install tar)';

export function buildTarDownloadCommand(path: string): string {
  return `tar -czf - -C ${shq(dirname(path))} ${shq(basename(path))}`;
}

export function buildTarUploadCommand(path: string): string {
  return `tar -xzf - -C ${shq(path)}`;
}

export function isCommandNotFound(stderr: string, code: number | null): boolean {
  return code === 127 || /command not found|: not found/i.test(stderr);
}

/**
 * Текст ошибки tar для ответа API: отсутствие tar на сервере превращаем
 * в понятное сообщение, остальное отдаём как есть.
 */
export function tarError(stderr: string, code: number | null): string {
  if (isCommandNotFound(stderr, code)) return TAR_NOT_FOUND_MESSAGE;
  return stderr.trim() || `tar exited with code ${code ?? 'unknown'}`;
}
