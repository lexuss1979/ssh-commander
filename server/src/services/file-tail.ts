import { withSftp } from '../ssh/manager.js';
import { readRange, stat } from '../ssh/sftp.js';
import { shq } from '../util/shell.js';
import type { Profile } from '../types.js';

export const TAIL_DEFAULT_LINES = 500;
export const TAIL_MAX_LINES = 5000;
export const TAIL_ONCE_TIMEOUT_MS = 30000;
export const BINARY_SNIFF_LEN = 512;

export function clampTailLines(n: number): number {
  if (!Number.isFinite(n)) return TAIL_DEFAULT_LINES;
  return Math.min(TAIL_MAX_LINES, Math.max(1, Math.floor(n)));
}

export function buildTailOnceCommand(path: string, lines: number): string {
  return `tail -n ${clampTailLines(lines)} -- ${shq(path)}`;
}

// Exactly -F, not -f: follows the name and survives rotation (logrotate «mv + create»).
export function buildTailFollowCommand(path: string, lines: number): string {
  return `tail -n ${clampTailLines(lines)} -F -- ${shq(path)}`;
}

export function assertNotDirectory(mode: number): void {
  if ((mode & 0o170000) === 0o040000) {
    throw new Error('Это директория');
  }
}

export function looksBinary(head: Buffer): boolean {
  return head.includes(0);
}

/**
 * Precheck before opening a tail-stream: the file exists (stat follows the
 * symlink), is not a directory and not binary. Both checks run before the
 * route's flushHeaders, so a rejection goes as a regular JSON error. This
 * also closes off an eternal empty stream: tail -F on a missing file does
 * not fail, it silently waits for it to appear.
 */
export async function precheckTailable(profile: Profile, path: string): Promise<void> {
  await withSftp(profile, async (sftp) => {
    const stats = await stat(sftp, path);
    assertNotDirectory(stats.mode);
    const head = await readRange(sftp, path, 0, BINARY_SNIFF_LEN - 1);
    if (looksBinary(head)) {
      throw new Error('Файл бинарный — просмотр логов недоступен');
    }
  });
}
