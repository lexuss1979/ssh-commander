/**
 * Общий лимитер follow-стримов на профиль (эпик 13, по плану эпика 14).
 *
 * SSH-соединение на профиль одно (`ssh/manager.ts`), на нём висят постоянный
 * SFTP-канал (getSftp кешируется), shell терминала, docker-логи, транзитные
 * exec'ы метрик — при `MaxSessions 10` у OpenSSH каналы кончаются быстро.
 * Поэтому лимит считает активные follow-стримы **на профиль**, а не на
 * подсистему: `/api/services/:unit/logs?follow=1` и `/api/docker/.../logs`
 * делят один счётчик.
 *
 * Модуль намеренно отдельный (не внутри `file-tail.ts`): иначе роуты
 * импортировали бы счётчик из чужой подсистемы.
 */

/** Лимит одновременных follow-стримов на профиль. */
export const FOLLOW_STREAM_LIMIT = 3;

const active = new Map<string, number>();

/** Захват слота follow-стрима профиля. false — лимит исчерпан (429). */
export function acquireFollowSlot(profileId: string): boolean {
  const n = active.get(profileId) ?? 0;
  if (n >= FOLLOW_STREAM_LIMIT) return false;
  active.set(profileId, n + 1);
  return true;
}

/** Освобождение слота; идемпотентно — повторный вызов не ломает счётчик. */
export function releaseFollowSlot(profileId: string): void {
  const n = active.get(profileId) ?? 0;
  if (n <= 1) {
    active.delete(profileId);
  } else {
    active.set(profileId, n - 1);
  }
}

/** Текущее число активных follow-стримов профиля (для тестов/отладки). */
export function followStreamCount(profileId: string): number {
  return active.get(profileId) ?? 0;
}
