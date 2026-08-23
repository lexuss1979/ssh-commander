import { withSftp } from '../ssh/manager.js';
import { readRange, stat } from '../ssh/sftp.js';
import { shq } from '../util/shell.js';
import type { Profile } from '../types.js';

export const TAIL_DEFAULT_LINES = 500;
export const TAIL_MAX_LINES = 5000;
export const TAIL_ONCE_TIMEOUT_MS = 30000;
export const BINARY_SNIFF_LEN = 512;
// Backpressure: предел буфера ответа, за которым follow-чанки дропаются.
export const GATE_LIMIT_BYTES = 1024 * 1024;

export function clampTailLines(n: number): number {
  if (!Number.isFinite(n)) return TAIL_DEFAULT_LINES;
  return Math.min(TAIL_MAX_LINES, Math.max(1, Math.floor(n)));
}

export function buildTailOnceCommand(path: string, lines: number): string {
  return `tail -n ${clampTailLines(lines)} -- ${shq(path)}`;
}

// Именно -F, не -f: следит за именем и переживает ротацию (logrotate «mv + create»).
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

export interface ChunkGate {
  /**
   * Пока читатель успевает (bufferedBytes не выше лимита) — чанк как есть.
   * За лимитом чанк дропается с подсчётом байт; первый чанк после возврата в
   * норму получает маркер с суммой пропущенного.
   */
  push(chunk: string, bufferedBytes: number): string | null;
}

export function createChunkGate(limitBytes = GATE_LIMIT_BYTES): ChunkGate {
  let skipped = 0;
  return {
    push(chunk: string, bufferedBytes: number): string | null {
      if (bufferedBytes > limitBytes) {
        skipped += Buffer.byteLength(chunk, 'utf8');
        return null;
      }
      if (skipped > 0) {
        const marker = `\n… [пропущено ${skipped} байт — читатель не успевает] …\n`;
        skipped = 0;
        return marker + chunk;
      }
      return chunk;
    },
  };
}

/**
 * Предпроверка перед открытием tail-стрима: файл существует (stat по симлинку
 * следует по ссылке), не директория и не бинарный. Обе проверки — до
 * flushHeaders маршрута, чтобы отказ шёл обычной JSON-ошибкой. Заодно
 * закрывает вечный пустой стрим: tail -F на отсутствующем файле не падает,
 * а молча ждёт его появления.
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
