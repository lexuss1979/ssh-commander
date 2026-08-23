import { exec } from '../ssh/manager.js';
import type { ExecResult, Profile } from '../types.js';

/**
 * Общий sudo-зонд (эпик 19, прецедент выноса `stream-limits` в эпике 14).
 *
 * Третьему потребителю паттерна «зонд до мутации» (systemd-действия, действия
 * над процессами, обновление пакетов) не следует импортировать чужую
 * подсистему — зонд живёт в своём модуле. Инвариант (как в security-audit):
 * пароль — первой строкой stdin канала (`sudo -S -p ''`), в командную строку
 * не попадает, живёт только в памяти запроса.
 */

/** Зонд sudo-пароля: `sudo -S -p '' -- true` (паттерн security-audit.ts:330). */
export function sudoProbeCommand(): string {
  return `sudo -S -p '' -- true`;
}

export type SudoProbeResult = 'ok' | 'wrong-password' | 'not-in-sudoers' | 'sudo-not-found' | 'other';

/** Классификация зонда `sudo -S -p '' -- true`: явные причины вместо 502. */
export function classifySudoProbe(result: ExecResult): SudoProbeResult {
  if (result.code === 0) return 'ok';
  const err = `${result.stderr}\n${result.stdout}`;
  if (/Sorry, try again/.test(err)) return 'wrong-password';
  if (/is not in the sudoers file|not allowed to execute/.test(err)) return 'not-in-sudoers';
  if (/not found/.test(err)) return 'sudo-not-found';
  return 'other';
}

/** Прогон зонда с паролем в stdin канала (не в argv/логах). */
export async function probeSudo(profile: Profile, password: string): Promise<SudoProbeResult> {
  const result = await exec(profile, sudoProbeCommand(), { stdin: `${password}\n` });
  return classifySudoProbe(result);
}
