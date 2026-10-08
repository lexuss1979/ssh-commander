import { exec } from '../ssh/manager.js';
import type { ExecResult, Profile } from '../types.js';

/**
 * Profile privileges probe (docs/agent-access-levels-plan.md): is the SSH
 * user root and does it have passwordless sudo or an admin group. The UI uses
 * this only to pick the strength of the warning when enabling the agent's
 * 'never' access level — a heuristic probe never gates the mode itself
 * (sudo with a password is not visible to `sudo -n`; group membership is an
 * indicator). On a probe error the frontend falls back to the strong warning
 * (fail-closed UX), so transport errors propagate to the route (502).
 *
 * One exec with key=value markers; `sh -c` guards against non-POSIX login
 * shells (csh/fish). `id -nG` prints space-separated group names.
 * Executors take deps {execFn} for tests (the systemd.ts pattern).
 */

export interface ProfilePrivileges {
  /** The SSH user's uid is 0. */
  isRoot: boolean;
  /** Passwordless sudo (`sudo -n true`) or a sudo/wheel/admin group. */
  sudo: boolean;
}

export type ExecFn = (
  profile: Profile,
  command: string,
  opts?: { timeoutMs?: number; stdin?: string },
) => Promise<ExecResult>;

export const PRIVILEGES_TIMEOUT_MS = 15000;

export const PRIVILEGES_CMD =
  `sh -c 'echo "uid=$(id -u)"; echo "groups=$(id -nG)"; ` +
  `sudo -n true 2>/dev/null && echo "sudo_np=yes" || echo "sudo_np=no"'`;

/** Pure parser of the marker output: uid/groups/sudo_np lines. */
export function parsePrivileges(output: string): ProfilePrivileges {
  const uid = /^uid=(.*)$/m.exec(output)?.[1]?.trim();
  const groups = /^groups=(.*)$/m.exec(output)?.[1]?.trim() ?? '';
  const sudoNp = /^sudo_np=(.*)$/m.exec(output)?.[1]?.trim();
  const isRoot = uid === '0';
  // `sudo -n true` without a password ≠ "no sudo at all" (it may prompt for
  // a password) — the groups are an additional indicator, hence the `or`.
  const sudo = sudoNp === 'yes' || /\b(?:sudo|wheel|admin)\b/.test(groups);
  return { isRoot, sudo };
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; promise: Promise<ProfilePrivileges> }>();

/**
 * Privileges of the profile's SSH user, cached for 60 s per profile (the
 * metrics.ts pattern; parallel calls share one exec). A failed promise is
 * evicted — the next request tries again.
 */
export function getProfilePrivileges(
  profile: Profile,
  deps: { execFn?: ExecFn } = {},
): Promise<ProfilePrivileges> {
  const now = Date.now();
  const hit = cache.get(profile.id);
  if (hit && now - hit.at < CACHE_TTL_MS) {
    return hit.promise;
  }
  const execFn = deps.execFn ?? exec;
  const promise = execFn(profile, PRIVILEGES_CMD, { timeoutMs: PRIVILEGES_TIMEOUT_MS }).then((result) =>
    parsePrivileges(result.stdout),
  );
  cache.set(profile.id, { at: now, promise });
  promise.catch(() => {
    if (cache.get(profile.id)?.promise === promise) {
      cache.delete(profile.id);
    }
  });
  return promise;
}
