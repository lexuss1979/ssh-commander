import { exec } from '../ssh/manager.js';
import { probeSudo } from './sudo.js';
import type { ExecResult, Profile } from '../types.js';

/**
 * Действия над процессами (вкладка «Обзор», эпик 17): сигналы из whitelist и
 * renice с sudo-ретраем по EPERM.
 *
 * Инварианты:
 * - pid — каноничное целое 2..4194304 (`parsePid`): `0`, `1` и отрицательные
 *   запрещены — `kill -TERM -1` / `-0` бьют по группам и всему, до чего
 *   дотянется;
 * - сигнал — элемент whitelist-enum (TERM|KILL|HUP), произвольная строка не
 *   принимается ни в какой форме;
 * - команды собираются без `shq`: сигнал — элемент enum, pid — валидированное
 *   целое, строковых аргументов нет (в отличие от имени unit'а в эпике 13);
 * - `kill -<sig> <pid>` без `--`: команда исполняется builtin'ом login-shell
 *   (bash/dash/busybox), поддержка `--` у них различается, а pid после
 *   валидации опцией быть не может;
 * - sudo-механика — общий `services/sudo.ts` (вынесен из systemd.ts): пароль
 *   первой строкой stdin канала, в argv/логах не появляется, живёт в памяти
 *   одного запроса;
 * - после мутации роут сбрасывает кэш метрик (`invalidateMetricsCache`), иначе
 *   «Обзор» до 2 с показывал бы убитый процесс.
 *
 * Инструмент агента сознательно не заводится: `kill`/`pkill`/`killall` в
 * deny-листе `ai/guard.ts`, ослаблять его не будем.
 */

export const PROCESS_SIGNALS = ['TERM', 'KILL', 'HUP'] as const;
export type ProcessSignal = (typeof PROCESS_SIGNALS)[number];

export const NICE_MIN = -20;
export const NICE_MAX = 19;

export interface ProcessActionResult {
  ok: true;
  output: string;
}

/** Ошибка действия над процессом с HTTP-статусом (400 — пользовательские причины, 502 — транспорт). */
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

/** Верхняя граница pid — pid_max по умолчанию (cat /proc/sys/kernel/pid_max). */
const PID_MAX = 4194304;

/**
 * Валидация pid из URL-параметра: строка из цифр, без ведущих нулей и
 * экспоненты (`raw === String(Number(raw))`), значение 2..4194304.
 * Возвращает число или null → роут отвечает 400.
 */
export function parsePid(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (raw !== String(n)) return null;
  if (!Number.isSafeInteger(n)) return null;
  if (n < 2 || n > PID_MAX) return null;
  return n;
}

/** `kill -<sig> <pid>` — builtin login-shell (без `--`, см. шапку модуля). */
export function killCommand(signal: ProcessSignal, pid: number): string {
  return `kill -${signal} ${pid}`;
}

/** Прямая sudo-форма без `sh -c`: исполняет `/bin/kill` напрямую (не builtin). */
export function sudoKillCommand(signal: ProcessSignal, pid: number): string {
  return `sudo -S -p '' -- kill -${signal} ${pid}`;
}

/** `renice -n <nice> -p <pid>`; отрицательное nice — законное значение опции. */
export function reniceCommand(nice: number, pid: number): string {
  return `renice -n ${nice} -p ${pid}`;
}

/** Прямая sudo-форма: `sudo -S -p '' -- renice -n <nice> -p <pid>`. */
export function sudoReniceCommand(nice: number, pid: number): string {
  return `sudo -S -p '' -- renice -n ${nice} -p ${pid}`;
}

export type ProcessActionFailureCategory = 'ok' | 'sudo-needed' | 'gone' | 'no-tool' | 'transport';

/**
 * Классификация результата kill/renice:
 * - `ok` — код 0;
 * - `sudo-needed` — EPERM (чужой процесс, понижение nice, kernel-thread);
 *   текст может быть у util-linux (`kill: (1234) - Operation not permitted`)
 *   и у builtin bash (`bash: line 1: kill: (1234) - Operation not permitted`);
 * - `gone` — ESRCH (процесс завершился между снимком и кликом);
 * - `no-tool` — утилиты нет на сервере (BusyBox без `renice`, минимальный
 *   образ без `/bin/kill` под `sudo --`) → 400, а не 502 «Сервер недоступен»:
 *   сервер-то в порядке, недоступна утилита;
 * - `transport` — всё остальное.
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
 * Общий поток мутации с sudo-ретраем (паттерн `runServiceAction` из systemd.ts):
 * 1. пробуем без sudo;
 * 2. `gone` → 400 «процесс больше не существует»;
 * 3. `no-tool` → 400 «команда недоступна»;
 * 4. sudo-needed + передан пароль → зонд `sudo -S -p '' -- true` (stdin),
 *    явные ошибки зонда → 400, иное → 502; зонд прошёл → повтор через sudo;
 * 5. sudo-needed без пароля → 400 «укажите sudo-пароль»;
 * 6. транспорт/неизвестное → 502.
 *
 * Ретрай безопасен: EPERM означает, что сигнал не отправлен/приоритет не
 * менялся. Таймаут — дефолт exec 60 с (kill/renice мгновенны).
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
    throw new ProcessActionError(
      502,
      (retry.stderr || retry.stdout).trim() || `Команда не выполнена (код ${retry.code ?? 'unknown'})`,
    );
  }
  // transport / неизвестное
  throw new ProcessActionError(
    502,
    (first.stderr || first.stdout).trim() || `Команда не выполнена (код ${first.code ?? 'unknown'})`,
  );
}

/** Сигнал процессу (TERM|KILL|HUP). Успех — kill молчит, output пустой. */
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

/** Изменение приоритета процесса (nice −20..19). Вывод renice — в notice. */
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
