/**
 * Shared follow-stream limiter per profile (epic 13, per the epic 14 plan).
 *
 * There is a single SSH connection per profile (`ssh/manager.ts`); it
 * carries the persistent SFTP channel (getSftp is cached), the terminal
 * shell, docker logs, and transit metric execs — with `MaxSessions 10`
 * OpenSSH runs out of channels quickly. That is why the limit counts
 * active follow-streams **per profile**, not per subsystem:
 * `/api/services/:unit/logs?follow=1` and `/api/docker/.../logs` share one
 * counter.
 *
 * The module is deliberately separate (not inside `file-tail.ts`):
 * otherwise routes would import a counter from someone else's subsystem.
 */

/** Limit of concurrent follow-streams per profile. */
export const FOLLOW_STREAM_LIMIT = 3;

const active = new Map<string, number>();

/** Acquire a profile follow-stream slot. false — the limit is exhausted (429). */
export function acquireFollowSlot(profileId: string): boolean {
  const n = active.get(profileId) ?? 0;
  if (n >= FOLLOW_STREAM_LIMIT) return false;
  active.set(profileId, n + 1);
  return true;
}

/** Release the slot; idempotent — a repeated call does not break the counter. */
export function releaseFollowSlot(profileId: string): void {
  const n = active.get(profileId) ?? 0;
  if (n <= 1) {
    active.delete(profileId);
  } else {
    active.set(profileId, n - 1);
  }
}

/** Current number of active follow-streams of the profile (for tests/debugging). */
export function followStreamCount(profileId: string): number {
  return active.get(profileId) ?? 0;
}
