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

/** Batch download of several files/folders from one directory. */
export function buildBatchDownloadCommand(parentDir: string, names: string[]): string {
  const items = names.map((n) => shq(n)).join(' ');
  return `tar -czf - -C ${shq(parentDir)} ${items}`;
}

export function isCommandNotFound(stderr: string, code: number | null): boolean {
  return code === 127 || /command not found|: not found/i.test(stderr);
}

/**
 * tar error text for the API response: missing tar on the server becomes a
 * comprehensible message, everything else is returned as is.
 */
export function tarError(stderr: string, code: number | null): string {
  if (isCommandNotFound(stderr, code)) return TAR_NOT_FOUND_MESSAGE;
  return stderr.trim() || `tar exited with code ${code ?? 'unknown'}`;
}
