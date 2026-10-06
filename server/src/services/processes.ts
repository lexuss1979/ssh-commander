import { exec } from '../ssh/manager.js';
import { probeSudo } from './sudo.js';
import type { ExecResult, Profile } from '../types.js';

/**
 * Process actions (the "Overview" tab, epic 17): signals from an allow-list
 * and renice with a sudo retry on EPERM.
 *
 * Invariants:
 * - pid is a canonical integer 2..4194304 (`parsePid`): `0`, `1` and negative
 *   values are banned — `kill -TERM -1` / `-0` hit process groups and
 *   everything they can reach;
 * - the signal is a member of the allow-list enum (TERM|KILL|HUP); an
 *   arbitrary string is not accepted in any form;
 * - commands are built without `shq`: the signal is an enum member, pid is a
 *   validated integer, there are no string arguments (unlike the unit name
 *   in epic 13);
 * - `kill -<sig> <pid>` without `--`: the command is executed by the
 *   login-shell builtin (bash/dash/busybox), their `--` support differs, and
 *   after validation a pid cannot be an option;
 * - the sudo mechanics are the shared `services/sudo.ts` (extracted from
 *   systemd.ts): the password is the first line of the channel stdin, never
 *   appears in argv/logs, lives in the memory of a single request;
 * - after the mutation the route invalidates the metrics cache
 *   (`invalidateMetricsCache`), otherwise "Overview" would show the killed
 *   process for up to 2 s.
 *
 * An agent tool is deliberately not introduced: `kill`/`pkill`/`killall` stay
 * outside the `ai/guard.ts` allow-list, and it will not be weakened.
 */

export const PROCESS_SIGNALS = ['TERM', 'KILL', 'HUP'] as const;
export type ProcessSignal = (typeof PROCESS_SIGNALS)[number];

export const NICE_MIN = -20;
export const NICE_MAX = 19;

export interface ProcessActionResult {
  ok: true;
  output: string;
}

/** Process action error carrying an HTTP status (400 — user-caused reasons, 502 — transport). */
export class ProcessActionError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type ExecFn = (
  profile: Profile,
  command: string,
  opts?: { timeoutMs?: number; stdin?: string },
) => Promise<ExecResult>;

/** The pid upper bound — the default pid_max (cat /proc/sys/kernel/pid_max). */
const PID_MAX = 4194304;

/**
 * pid validation from a URL parameter: a string of digits, without leading
 * zeros or an exponent (`raw === String(Number(raw))`), value 2..4194304.
 * Returns the number or null → the route answers 400.
 */
export function parsePid(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (raw !== String(n)) return null;
  if (!Number.isSafeInteger(n)) return null;
  if (n < 2 || n > PID_MAX) return null;
  return n;
}

/** `kill -<sig> <pid>` — the login-shell builtin (no `--`, see the module header). */
export function killCommand(signal: ProcessSignal, pid: number): string {
  return `kill -${signal} ${pid}`;
}

/** Direct sudo form without `sh -c`: executes `/bin/kill` directly (not the builtin). */
export function sudoKillCommand(signal: ProcessSignal, pid: number): string {
  return `sudo -S -p '' -- kill -${signal} ${pid}`;
}

/** `renice -n <nice> -p <pid>`; a negative nice is a legitimate option value. */
export function reniceCommand(nice: number, pid: number): string {
  return `renice -n ${nice} -p ${pid}`;
}

/** Direct sudo form: `sudo -S -p '' -- renice -n <nice> -p <pid>`. */
export function sudoReniceCommand(nice: number, pid: number): string {
  return `sudo -S -p '' -- renice -n ${nice} -p ${pid}`;
}

export type ProcessActionFailureCategory = 'ok' | 'sudo-needed' | 'gone' | 'no-tool' | 'transport';

/**
 * Classification of a kill/renice result:
 * - `ok` — code 0;
 * - `sudo-needed` — EPERM (someone else's process, a nice decrease, a kernel
 *   thread); the text may come from util-linux
 *   (`kill: (1234) - Operation not permitted`) or from the bash builtin
 *   (`bash: line 1: kill: (1234) - Operation not permitted`);
 * - `gone` — ESRCH (the process exited between the snapshot and the click);
 * - `no-tool` — the utility is missing on the server (BusyBox without
 *   `renice`, a minimal image without `/bin/kill` under `sudo --`) → 400,
 *   not 502 «Сервер недоступен»: the server itself is fine, it is the
 *   utility that is unavailable;
 * - `transport` — everything else.
 */
export function classifyProcessActionFailure(result: ExecResult): ProcessActionFailureCategory {
  if (result.code === 0) return 'ok';
  const err = `${result.stderr}\n${result.stdout}`;
  if (/No such process/i.test(err)) return 'gone';
  if (/Operation not permitted|Permission denied/i.test(err)) return 'sudo-needed';
  if (/command not found|not found|No such file or directory/i.test(err)) return 'no-tool';
  return 'transport';
}

/**
 * The shared mutation flow with a sudo retry (the `runServiceAction` pattern
 * from systemd.ts):
 * 1. try without sudo;
 * 2. `gone` → 400 «Процесс больше не существует»;
 * 3. `no-tool` → 400 «команда недоступна»;
 * 4. sudo-needed + a password supplied → probe `sudo -S -p '' -- true`
 *    (stdin); explicit probe failures → 400, anything else → 502; probe
 *    passed → retry via sudo;
 * 5. sudo-needed without a password → 400 «укажите sudo-пароль»;
 * 6. transport/unknown → 502.
 *
 * The retry is safe: EPERM means the signal was not sent / the priority was
 * not changed. Timeout — the exec default of 60 s (kill/renice are instant).
 */
async function withSudoRetry(
  profile: Profile,
  pid: number,
  toolName: string,
  plainCommand: string,
  sudoCommand: string,
  sudoPassword: string | undefined,
  deps: { execFn?: ExecFn },
  onSuccess: (result: ExecResult) => ProcessActionResult,
): Promise<ProcessActionResult> {
  const execFn = deps.execFn ?? exec;
  const first = await execFn(profile, plainCommand);
  const category = classifyProcessActionFailure(first);
  if (category === 'ok') return onSuccess(first);
  if (category === 'gone') {
    throw new ProcessActionError(400, 'Процесс больше не существует (уже завершился?)');
  }
  if (category === 'no-tool') {
    throw new ProcessActionError(400, `Команда \`${toolName}\` недоступна на этом сервере`);
  }
  if (category === 'sudo-needed') {
    if (!sudoPassword) {
      throw new ProcessActionError(
        400,
        `Требуются права root для ${toolName} ${pid}: укажите sudo-пароль`,
      );
    }
    const probeCat = await probeSudo(profile, sudoPassword, deps);
    if (probeCat === 'wrong-password') {
      throw new ProcessActionError(400, 'Неверный sudo-пароль');
    }
    if (probeCat === 'not-in-sudoers') {
      throw new ProcessActionError(400, `У пользователя ${profile.username} нет прав sudo на этом сервере`);
    }
    if (probeCat === 'sudo-not-found') {
      throw new ProcessActionError(400, 'sudo не установлен');
    }
    if (probeCat === 'other') {
      throw new ProcessActionError(502, 'sudo-проверка не прошла');
    }

    const retry = await execFn(profile, sudoCommand, { stdin: `${sudoPassword}\n` });
    const retryCat = classifyProcessActionFailure(retry);
    if (retryCat === 'ok') return onSuccess(retry);
    // The same ladder as for the first attempt — that matters exactly here:
    // the sudo form calls `/bin/kill`/`/bin/renice` directly (no shell), so
    // a missed binary (`sudo: kill: command not found`) is only possible on
    // the retry; the process may also have died during the sudo probe.
    if (retryCat === 'gone') {
      throw new ProcessActionError(400, 'Процесс больше не существует (уже завершился?)');
    }
    if (retryCat === 'no-tool') {
      throw new ProcessActionError(400, `Команда \`${toolName}\` недоступна на этом сервере`);
    }
    throw new ProcessActionError(
      502,
      (retry.stderr || retry.stdout).trim() || `Команда не выполнена (код ${retry.code ?? 'unknown'})`,
    );
  }
  // transport / unknown
  throw new ProcessActionError(
    502,
    (first.stderr || first.stdout).trim() || `Команда не выполнена (код ${first.code ?? 'unknown'})`,
  );
}

/** Signal a process (TERM|KILL|HUP). On success kill is silent, output is empty. */
export function runProcessSignal(
  profile: Profile,
  pid: number,
  signal: ProcessSignal,
  sudoPassword: string | undefined,
  deps: { execFn?: ExecFn } = {},
): Promise<ProcessActionResult> {
  return withSudoRetry(
    profile,
    pid,
    'kill',
    killCommand(signal, pid),
    sudoKillCommand(signal, pid),
    sudoPassword,
    deps,
    () => ({ ok: true, output: '' }),
  );
}

/** Change a process priority (nice −20..19). renice output goes into the notice. */
export function runProcessRenice(
  profile: Profile,
  pid: number,
  nice: number,
  sudoPassword: string | undefined,
  deps: { execFn?: ExecFn } = {},
): Promise<ProcessActionResult> {
  return withSudoRetry(
    profile,
    pid,
    'renice',
    reniceCommand(nice, pid),
    sudoReniceCommand(nice, pid),
    sudoPassword,
    deps,
    (result) => ({ ok: true, output: (result.stdout || result.stderr).trim() }),
  );
}
