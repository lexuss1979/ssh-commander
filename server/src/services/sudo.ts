import { exec } from '../ssh/manager.js';
import type { ExecResult, Profile } from '../types.js';

/**
 * Shared sudo probe (epic 17; also used by epic 19 — applying updates).
 * Extracted from `services/systemd.ts` so that subsystems do not depend on
 * each other: systemd.ts re-exports these functions (the module's public
 * API is unchanged), processes.ts imports directly.
 *
 * Invariant (as in security-audit and epic 13): the password goes as the
 * first line of the channel's stdin (`sudo -S -p ''`), never reaches the
 * command line, lives only in the memory of a single request, is not
 * logged and not persisted.
 */

/** Probe command: `sudo -S -p '' -- true` (no `sh -c`, stdin carries the password). */
export function sudoProbeCommand(): string {
  return `sudo -S -p '' -- true`;
}

export type SudoProbeResult = 'ok' | 'wrong-password' | 'not-in-sudoers' | 'sudo-not-found' | 'other';

/** Classification of the `sudo -S -p '' -- true` probe: explicit causes instead of 502. */
export function classifySudoProbe(result: ExecResult): SudoProbeResult {
  if (result.code === 0) return 'ok';
  const err = `${result.stderr}\n${result.stdout}`;
  if (/Sorry, try again/.test(err)) return 'wrong-password';
  if (/is not in the sudoers file|not allowed to execute/.test(err)) return 'not-in-sudoers';
  if (/not found/.test(err)) return 'sudo-not-found';
  return 'other';
}

export type SudoProbeExecFn = (
  profile: Profile,
  command: string,
  opts?: { timeoutMs?: number; stdin?: string },
) => Promise<ExecResult>;

/**
 * Sudo password probe: exec `sudo -S -p '' -- true` with the password as
 * the first line of stdin + classification of the result. Wrapper for
 * mutation executors (process actions; later — applying updates, epic 19).
 */
export async function probeSudo(
  profile: Profile,
  password: string,
  deps: { execFn?: SudoProbeExecFn } = {},
): Promise<SudoProbeResult> {
  const execFn = deps.execFn ?? exec;
  const result = await execFn(profile, sudoProbeCommand(), { stdin: `${password}\n` });
  return classifySudoProbe(result);
}
