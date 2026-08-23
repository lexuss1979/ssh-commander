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
