/**
 * Общий бюджет follow-стримов на профиль. SSH-соединение на профиль одно,
 * и его каналы делят все подсистемы: постоянный SFTP, shell терминала,
 * follow docker-логов, tail файлов (эпик 14), journalctl -f (эпик 13),
 * вывод обновления пакетов (эпик 19) и транзитные exec'и метрик. OpenSSH
 * MaxSessions по умолчанию 10 — счётчик общий, а не по три на подсистему.
 */

export const FOLLOW_STREAM_LIMIT = 3;

export const FOLLOW_LIMIT_MESSAGE = `Слишком много открытых стримов логов (максимум ${FOLLOW_STREAM_LIMIT}) — закройте другие просмотрщики`;

export interface FollowLimiter {
  acquire(key: string): boolean;
  release(key: string): void;
  count(key: string): number;
}

export function createFollowLimiter(max: number): FollowLimiter {
  const counts = new Map<string, number>();
  return {
    acquire(key) {
      const current = counts.get(key) ?? 0;
      if (current >= max) return false;
      counts.set(key, current + 1);
      return true;
    },
    release(key) {
      const current = counts.get(key) ?? 0;
      if (current <= 1) counts.delete(key);
      else counts.set(key, current - 1);
    },
    count(key) {
      return counts.get(key) ?? 0;
    },
  };
}

const limiter = createFollowLimiter(FOLLOW_STREAM_LIMIT);

export function acquireFollowSlot(profileId: string): boolean {
  return limiter.acquire(profileId);
}

export function releaseFollowSlot(profileId: string): void {
  limiter.release(profileId);
}

// Backpressure follow-стримов: res.write без проверки drain расширяет буфер
// Node на быстро растущем источнике. Пауза SSH-канала потребовала бы
// расширения API execStream наружу — отклонено; вместо этого дроп чанков
// с подсчётом и маркером при возврате в норму.
export const GATE_LIMIT_BYTES = 1024 * 1024;

export interface ChunkGate {
  /**
   * Пока читатель успевает (bufferedBytes не выше лимита) — чанк как есть.
   * За лимитом чанк дропается с подсчётом байт; первый чанк после возврата в
   * норму получает маркер с суммой пропущенного.
   */
  push(chunk: string, bufferedBytes: number): string | null;
  /** Маркер для байтов, дропнутых до самого конца стрима (push их уже не ждёт). */
  finish(): string | null;
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
    finish(): string | null {
      if (skipped === 0) return null;
      const marker = `\n… [пропущено ${skipped} байт — читатель не успевает] …\n`;
      skipped = 0;
      return marker;
    },
  };
}
