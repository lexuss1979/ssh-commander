import { exec } from '../ssh/manager.js';
import type { ExecResult, Profile } from '../types.js';

/**
 * Общий sudo-зонд (эпик 17; его же ждёт эпик 19 — применение обновлений).
 * Вынесен из `services/systemd.ts`, чтобы подсистемы не зависели друг от
 * друга: systemd.ts реэкспортирует эти функции (публичный API модуля не
 * меняется), processes.ts импортирует напрямую.
 *
 * Инвариант (как в security-audit и эпике 13): пароль — первой строкой
 * stdin канала (`sudo -S -p ''`), в командную строку не попадает, живёт
 * только в памяти одного запроса, не логируется и не сохраняется.
 */

/** Команда зонда: `sudo -S -p '' -- true` (без `sh -c`, stdin — пароль). */
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

export type SudoProbeExecFn = (
  profile: Profile,
  command: string,
  opts?: { timeoutMs?: number; stdin?: string },
) => Promise<ExecResult>;

/**
 * Зонд sudo-пароля: exec `sudo -S -p '' -- true` с паролем первой строкой
 * stdin + классификация результата. Обёртка для исполнителей мутаций
 * (действия над процессами; позже — применение обновлений, эпик 19).
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
