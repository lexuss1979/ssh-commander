import { exec } from '../ssh/manager.js';
import { shq } from '../util/shell.js';
import { classifySudoProbe, sudoProbeCommand } from './sudo.js';
import type { ExecResult, Profile } from '../types.js';

/**
 * Службы systemd (вкладка «Службы», эпик 13).
 *
 * Снимок собирается одним exec с маркерами; детект systemd — по тексту, а не
 * по коду возврата (на не-systemd системах последняя команда падает). Все
 * парсеры/билдеры/валидаторы — чистые экспортируемые функции под unit-тесты.
 *
 * Sudo-механика (инвариант, как в security-audit): пароль — первой строкой
 * stdin канала (`sudo -S -p ''`), в командную строку не попадает, живёт
 * только в памяти запроса. Для systemctl используется прямая форма
 * `sudo -S -p '' -- systemctl <action> -- <unit>` без `sh -c`.
 */

export interface UnitInfo {
  /** Имя unit'а с суффиксом: 'nginx.service'. */
  name: string;
  description: string | null;
  /** loaded / not-found / error / null (не загружен). */
  load: string | null;
  /** active / inactive / activating / failed / null. */
  active: string | null;
  /** running / dead / exited / failed / null. */
  sub: string | null;
  /** enabled / disabled / masked / static / indirect / generated / alias / null. */
  enabled: string | null;
}

export interface ServicesSnapshot {
  /** Момент снимка (мс, серверное время ssh-commander). */
  timestamp: number;
  /** systemd обнаружен. */
  available: boolean;
  /** Причина недоступности — для заглушки UI. */
  reason?: string;
  units: UnitInfo[];
}

export interface ServiceDetail {
  name: string;
  /** Raw-вывод `systemctl status` — для человека, не парсим. */
  status: string;
  /** Значения выбранных полей `systemctl show`; отсутствующие — null. */
  show: Record<string, string | null>;
}

export interface ParsedUnit {
  name: string;
  load: string | null;
  active: string | null;
  sub: string | null;
  description: string | null;
}

export interface ParsedUnitFile {
  name: string;
  enabled: string | null;
}

export interface ParsedSnapshot {
  available: boolean;
  reason?: string;
  units: UnitInfo[];
}

/** Действия `systemctl`. reset-failed сверх роадмапа — осознанно (см. план). */
export const SERVICE_ACTIONS = [
  'start',
  'stop',
  'restart',
  'reload',
  'enable',
  'disable',
  'reset-failed',
] as const;

export type ServiceAction = (typeof SERVICE_ACTIONS)[number];

/** Whitelist-проверка действия (в т.ч. против rm/exec/daemon-reload/пустого). */
export function isServiceAction(value: unknown): value is ServiceAction {
  return typeof value === 'string' && (SERVICE_ACTIONS as readonly string[]).includes(value);
}

/** Ошибка действия службы с HTTP-статусом (400 — пользовательские причины, 502 — транспорт). */
export class ServiceActionError extends Error {
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

const UNITS_MARKER = '@@UNITS@@';
const UNITFILES_MARKER = '@@UNITFILES@@';
export const SHOW_MARKER = '@@SHOW@@';

export const SHOW_FIELDS = [
  'MainPID',
  'ActiveState',
  'SubState',
  'UnitFileState',
  'FragmentPath',
  'Restart',
  'NRestarts',
  'Result',
  'MemoryCurrent',
  'TasksCurrent',
  'ActiveEnterTimestamp',
];

/** Границы tail журнала: 1..5000, дефолт 500 (те же, что заложит эпик 14). */
export const DEFAULT_TAIL = 500;
export const MAX_TAIL = 5000;

/** Лимит вывода exec (manager.ts) — для честной пометки обрезки журнала. */
const EXEC_OUTPUT_LIMIT = 2 * 1024 * 1024;

const CACHE_TTL_MS = 2000;

/**
 * Один exec со снимком: версия, list-units, list-unit-files. `2>&1` — ошибки
 * детекта попадают в stdout; `LC_ALL=C` — стабильные заголовки/статусы.
 * Код возврата игнорируем — решение принимает парсер по тексту.
 */
const SNAPSHOT_CMD =
  `LC_ALL=C systemctl --version 2>&1 | head -1\n` +
  `echo '${UNITS_MARKER}'\n` +
  `LC_ALL=C systemctl list-units --type=service --all --no-pager --plain --no-legend 2>&1\n` +
  `echo '${UNITFILES_MARKER}'\n` +
  `LC_ALL=C systemctl list-unit-files --type=service --no-pager --plain --no-legend 2>&1`;

// ---------------------------------------------------------------------------
// Чистые парсеры/валидаторы/билдеры
// ---------------------------------------------------------------------------

/** Валидация имени unit'а: безопасные символы + запрет «.» и «..». */
const UNIT_NAME_RE = /^[A-Za-z0-9@._:\-]+$/;

export function unitNameValid(name: string): boolean {
  if (!UNIT_NAME_RE.test(name)) return false;
  if (name === '.' || name === '..') return false;
  return true;
}

export function assertValidUnitName(name: string): string {
  if (!unitNameValid(name)) {
    throw new ServiceActionError(400, 'Недопустимое имя unit');
  }
  return name;
}

/**
 * Первая строка `systemctl --version`: `systemd 252 (252.26-1~deb12u2)` →
 * версия; `not found` / `command not found` → systemctl отсутствует (null).
 */
export function parseVersionLine(line: string): string | null {
  const t = line.trim();
  if (!t) return null;
  if (/not found|command not found/i.test(t)) return null;
  if (/^systemd\s+\d+/.test(t)) return t;
  return null;
}

/**
 * Поиск строки systemd-версии во всём выводе снимка, а не только в первой
 * строке: ssh-exec может сорсить ~/.bashrc/rc и печатать шум перед
 * `systemctl --version` (кастомные rc, conda и т.п.) — тогда первая строка
 * дала бы ложную заглушку «systemctl не найден».
 */
function findVersionLine(raw: string): string | null {
  for (const line of raw.split('\n')) {
    const v = parseVersionLine(line);
    if (v !== null) return v;
  }
  return null;
}

/**
 * `systemctl list-units --type=service --all --plain --no-legend`: колонки
 * `UNIT LOAD ACTIVE SUB DESCRIPTION`; `--plain` снимает bullet `●` у
 * failed-юнитов (иначе сдвинул бы колонки); `-` в LOAD/ACTIVE/SUB → null;
 * описание с пробелами — всё после 4-й колонки; мусорные строки отбрасываются.
 *
 * Старые сборки systemd могут не снимать bullet (● появился раньше, чем
 * --plain стал убирать его для list-units) — снимаем ведущий токен сами,
 * иначе колонки сдвигаются и строка failed-юнита молча пропадает.
 */
export function parseListUnits(raw: string): ParsedUnit[] {
  const out: ParsedUnit[] = [];
  for (const line of raw.split('\n')) {
    const stripped = line.trim().replace(/^[●*]\s*/, '');
    const fields = stripped.split(/\s+/);
    if (fields.length < 4) continue;
    if (!fields[0].endsWith('.service')) continue;
    out.push({
      name: fields[0],
      load: fields[1] === '-' ? null : fields[1],
      active: fields[2] === '-' ? null : fields[2],
      sub: fields[3] === '-' ? null : fields[3],
      description: fields.slice(4).join(' ') || null,
    });
  }
  return out;
}

/**
 * `systemctl list-unit-files --type=service --plain --no-legend`. Формат
 * зависит от версии: с systemd ≥ 245 колонок три (`UNIT FILE / STATE /
 * PRESET`), до этого — две (`UNIT FILE / STATE`). STATE — **всегда второе
 * поле (`fields[1]`)**: в трёхколоночном формате чтение последнего поля
 * записало бы в `enabled` значение preset'а. PRESET игнорируем.
 */
export function parseListUnitFiles(raw: string): ParsedUnitFile[] {
  const out: ParsedUnitFile[] = [];
  for (const line of raw.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 2) continue;
    if (!fields[0].endsWith('.service')) continue;
    out.push({ name: fields[0], enabled: fields[1] === '-' ? null : fields[1] });
  }
  return out;
}

/**
 * Слияние list-units и list-unit-files: имя — из любого списка; `enabled` —
 * из unit-files (отсутствует → null, напр. transient-юниты); load/active/sub —
 * из list-units (не загружен → null). Сортировка по имени.
 */
export function mergeUnits(units: ParsedUnit[], unitFiles: ParsedUnitFile[]): UnitInfo[] {
  const enabledByFile = new Map(unitFiles.map((u) => [u.name, u.enabled]));
  const byName = new Map<string, UnitInfo>();
  for (const u of units) {
    byName.set(u.name, {
      name: u.name,
      description: u.description,
      load: u.load,
      active: u.active,
      sub: u.sub,
      enabled: enabledByFile.get(u.name) ?? null,
    });
  }
  for (const f of unitFiles) {
    if (!byName.has(f.name)) {
      byName.set(f.name, {
        name: f.name,
        description: null,
        load: null,
        active: null,
        sub: null,
        enabled: f.enabled,
      });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function firstNonEmptyLine(text: string): string | null {
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t) return t;
  }
  return null;
}

function sectionBetween(raw: string, startMarker: string, endMarker: string): string {
  const start = raw.indexOf(startMarker);
  if (start < 0) return '';
  const from = start + startMarker.length;
  const end = raw.indexOf(endMarker, from);
  return end >= 0 ? raw.slice(from, end) : raw.slice(from);
}

function sectionAfter(raw: string, marker: string): string {
  const idx = raw.indexOf(marker);
  return idx >= 0 ? raw.slice(idx + marker.length) : '';
}

function splitByMarker(text: string, marker: string): [string, string] {
  const idx = text.indexOf(marker);
  if (idx < 0) return [text, ''];
  return [text.slice(0, idx), text.slice(idx + marker.length)];
}

/**
 * Разбор полного вывода снимка. Решения по тексту, не по коду:
 * - версия не похожа на systemd → недоступно;
 * - `has not been booted with systemd` → недоступно (контейнер);
 * - ошибка флага в начале секции (`Unknown option` / `Invalid option` /
 *   `Failed to`) → недоступно с текстом ошибки (иначе парсер молча отбросил
 *   бы строку ошибки как мусор и UI показал бы половинчатую таблицу).
 */
export function parseSnapshot(raw: string): ParsedSnapshot {
  const version = findVersionLine(raw);
  if (version === null) {
    return {
      available: false,
      reason: 'systemctl не найден (не systemd? Alpine/OpenRC/контейнер)',
      units: [],
    };
  }
  const unitsSection = sectionBetween(raw, UNITS_MARKER, UNITFILES_MARKER);
  const unitFilesSection = sectionAfter(raw, UNITFILES_MARKER);
  if (unitsSection.includes('has not been booted with systemd')) {
    return {
      available: false,
      reason: 'systemd не является PID 1 (контейнер?)',
      units: [],
    };
  }
  const flagError = [firstNonEmptyLine(unitsSection), firstNonEmptyLine(unitFilesSection)].find(
    (l): l is string => l !== null && /Unknown option|Invalid option|Failed to/.test(l),
  );
  if (flagError) {
    return { available: false, reason: flagError, units: [] };
  }
  return {
    available: true,
    units: mergeUnits(parseListUnits(unitsSection), parseListUnitFiles(unitFilesSection)),
  };
}

/** Разбор вывода `systemctl show`: строки `KEY=VALUE`, первое вхождение выигрывает. */
export function parseShowOutput(raw: string, fields: string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const f of fields) out[f] = null;
  const seen = new Set<string>();
  for (const line of raw.split('\n')) {
    const m = /^([A-Za-z0-9_.]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    const key = m[1];
    if (!fields.includes(key) || seen.has(key)) continue;
    seen.add(key);
    out[key] = m[2];
  }
  return out;
}

/** Команда `systemctl <action> -- <unit>` (unit через shq; `--` — защита от опций). */
export function systemctlCommand(action: string, unit: string): string {
  return `systemctl ${action} -- ${shq(unit)}`;
}

/** Прямая sudo-форма без `sh -c`: `sudo -S -p '' -- systemctl <action> -- <unit>`. */
export function sudoSystemctlCommand(action: string, unit: string): string {
  return `sudo -S -p '' -- systemctl ${action} -- ${shq(unit)}`;
}

/** Команда журнала unit'а; `-f` только для follow-стрима. Имя unit'а — аргумент
 * `-u` (getopt потребляет следующий argv как значение опции), поэтому ведущий
 * `-` в имени не может быть распознан как опция; `--` тут не нужен. */
export function journalctlCommand(unit: string, tail: number, follow: boolean): string {
  return `journalctl -u ${shq(unit)} --no-pager -n ${tail}${follow ? ' -f' : ''}`;
}

/** tail 1..5000, дефолт 500; нечисловое/NaN → дефолт. */
export function clampTail(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_TAIL;
  return Math.min(MAX_TAIL, Math.max(1, Math.floor(n)));
}

// ---------------------------------------------------------------------------
// Классификация ошибок действий
// ---------------------------------------------------------------------------

export type ActionFailureCategory =
  | 'ok'
  | 'sudo-needed'
  | 'masked'
  | 'not-found'
  | 'job-failed'
  | 'transport';

/**
 * Классификация результата `systemctl <action>`: polkit-формулировка
 * `Interactive authentication required` — типовая для Debian/Ubuntu/RHEL/
 * Fedora (это systemctl отдаёт без TTY); `Access denied` — системы без
 * polkit. masked/not-found/job-failed — состояние сервиса, не транспорт;
 * ретрай с sudo для них бесполезен.
 */
export function classifyActionFailure(result: ExecResult): ActionFailureCategory {
  if (result.code === 0) return 'ok';
  const err = `${result.stderr}\n${result.stdout}`;
  if (
    /Interactive authentication required|Authentication is required|Access denied|Operation refused|Permission denied/i.test(
      err,
    )
  ) {
    return 'sudo-needed';
  }
  if (/is masked/i.test(err)) return 'masked';
  if (/not found|could not be found/i.test(err)) return 'not-found';
  if (/Job for .* failed/i.test(err)) return 'job-failed';
  return 'transport';
}

// ---------------------------------------------------------------------------
// Исполнители (exec-обёртки с инъекцией deps для тестов)
// ---------------------------------------------------------------------------

/**
 * Снимок служб. Кэш 2 с на профиль (паттерн ports.ts): параллельные вызовы
 * делят один exec; ошибочный промис из кэша удаляется. `available: false` —
 * не ошибка, а штатный результат детекта.
 */
export function collectServices(
  profile: Profile,
  deps: { execFn?: ExecFn } = {},
): Promise<ServicesSnapshot> {
  const now = Date.now();
  const hit = cache.get(profile.id);
  if (hit && now - hit.at < CACHE_TTL_MS) {
    return hit.promise;
  }
  const execFn = deps.execFn ?? exec;
  const promise = execFn(profile, SNAPSHOT_CMD).then((result) => ({
    ...parseSnapshot(result.stdout),
    timestamp: Date.now(),
  }));
  cache.set(profile.id, { at: now, promise });
  promise.catch(() => {
    if (cache.get(profile.id)?.promise === promise) {
      cache.delete(profile.id);
    }
  });
  return promise;
}

const cache = new Map<string, { at: number; promise: Promise<ServicesSnapshot> }>();

/** Сброс кэша снимка после мутации действия — refetch вернёт свежие данные. */
export function invalidateServicesCache(profileId: string): void {
  cache.delete(profileId);
}

/** Команда детали unit'а: raw-статус + выбранные поля show (маркер-разделитель).
 * `--` перед именем — защита от опций (regex имени допускает ведущий `-`). */
export function serviceDetailCommand(unit: string): string {
  const fields = SHOW_FIELDS.map((f) => `-p ${f}`).join(' ');
  return (
    `LC_ALL=C systemctl status --no-pager -n 0 -- ${shq(unit)} 2>&1\n` +
    `echo '${SHOW_MARKER}'\n` +
    `LC_ALL=C systemctl show ${fields} -- ${shq(unit)} 2>&1`
  );
}

/**
 * Деталь unit'а. Код возврата игнорируем: для `systemctl status` он не
 * признак ошибки (3 = inactive, 4 = not-found — нормальные состояния).
 * `-n 0` — без дампа журнала, `--no-pager` — без пагинации.
 */
export async function getServiceDetail(
  profile: Profile,
  unit: string,
  deps: { execFn?: ExecFn } = {},
): Promise<ServiceDetail> {
  const name = assertValidUnitName(unit);
  const execFn = deps.execFn ?? exec;
  const r = await execFn(profile, serviceDetailCommand(name));
  const [status, showRaw] = splitByMarker(r.stdout, SHOW_MARKER);
  return { name, status: status.trim(), show: parseShowOutput(showRaw, SHOW_FIELDS) };
}

export interface ServiceActionResult {
  ok: true;
  output: string;
}

/**
 * Явный таймаут action-экзеков: у systemd дефолтные TimeoutStartSec/StopSec
 * бывают больше 60 с из manager.ts (а процесс, не реагирующий на SIGTERM,
 * гарантированно их превысит). Без явного таймаута такая мутация превращалась
 * бы в общий 502 «Сервер недоступен», хотя могла успеть примениться.
 */
const ACTION_TIMEOUT_MS = 120000;

function isExecTimeout(err: unknown): boolean {
  return err instanceof Error && /timed out after \d+ms/.test(err.message);
}

/** exec действия с явным таймаутом: таймаут — не транспорт, а признак
 * «проверьте статус» (мутация могла дойти до конца). */
async function execAction(
  execFn: ExecFn,
  profile: Profile,
  command: string,
  stdin?: string,
): Promise<ExecResult> {
  try {
    return await execFn(profile, command, {
      timeoutMs: ACTION_TIMEOUT_MS,
      ...(stdin !== undefined ? { stdin } : {}),
    });
  } catch (err) {
    if (isExecTimeout(err)) {
      throw new ServiceActionError(
        400,
        `Команда выполняется дольше ${ACTION_TIMEOUT_MS / 1000} с — проверьте статус службы`,
      );
    }
    throw err;
  }
}

/**
 * Действие над unit'ом с sudo-ретраем по access-denied:
 * 1. пробуем без sudo;
 * 2. sudo-needed + передан пароль → зонд `sudo -S -p '' -- true` (stdin),
 *    явные ошибки зонда (неверный пароль / не в sudoers / sudo не установлен)
 *    → 400, иное → 502; зонд прошёл → повтор через sudo;
 * 3. sudo-needed без пароля → 400 «укажите sudo-пароль»;
 * 4. masked/not-found/job-failed → 400 с текстом systemd как есть;
 * 5. таймаут exec действия → 400 «проверьте статус» (не 502);
 * 6. транспорт/неизвестное → 502.
 *
 * Ретрай безопасен: access-denied/interactive-auth означает, что мутация не
 * началась. Пароль живёт только в stdin одного запроса.
 */
export async function runServiceAction(
  profile: Profile,
  unit: string,
  action: ServiceAction,
  sudoPassword: string | undefined,
  deps: { execFn?: ExecFn } = {},
): Promise<ServiceActionResult> {
  const name = assertValidUnitName(unit);
  const execFn = deps.execFn ?? exec;

  const first = await execAction(execFn, profile, systemctlCommand(action, name));
  const category = classifyActionFailure(first);
  if (category === 'ok') {
    return { ok: true, output: (first.stdout || first.stderr).trim() };
  }
  if (category === 'masked' || category === 'not-found' || category === 'job-failed') {
    throw new ServiceActionError(400, (first.stderr || first.stdout).trim() || `systemctl ${action} не выполнился`);
  }
  if (category === 'sudo-needed') {
    if (!sudoPassword) {
      throw new ServiceActionError(
        400,
        `Требуются права root для ${action} ${name}: укажите sudo-пароль`,
      );
    }
    const probe = await execFn(profile, sudoProbeCommand(), { stdin: `${sudoPassword}\n` });
    const probeCat = classifySudoProbe(probe);
    if (probeCat === 'wrong-password') {
      throw new ServiceActionError(400, 'Неверный sudo-пароль');
    }
    if (probeCat === 'not-in-sudoers') {
      throw new ServiceActionError(400, `У пользователя ${profile.username} нет прав sudo на этом сервере`);
    }
    if (probeCat === 'sudo-not-found') {
      throw new ServiceActionError(400, 'sudo не установлен');
    }
    if (probeCat === 'other') {
      throw new ServiceActionError(502, (probe.stderr || probe.stdout).trim() || 'sudo-проверка не прошла');
    }

    const retry = await execAction(execFn, profile, sudoSystemctlCommand(action, name), `${sudoPassword}\n`);
    const retryCat = classifyActionFailure(retry);
    if (retryCat === 'ok') {
      return { ok: true, output: (retry.stdout || retry.stderr).trim() };
    }
    if (retryCat === 'masked' || retryCat === 'not-found' || retryCat === 'job-failed') {
      throw new ServiceActionError(400, (retry.stderr || retry.stdout).trim() || `systemctl ${action} не выполнился`);
    }
    throw new ServiceActionError(
      502,
      (retry.stderr || retry.stdout).trim() || `Команда не выполнена (код ${retry.code ?? 'unknown'})`,
    );
  }
  // transport / неизвестное
  throw new ServiceActionError(
    502,
    (first.stderr || first.stdout).trim() || `Команда не выполнена (код ${first.code ?? 'unknown'})`,
  );
}

/**
 * Разовый журнал unit'а (без follow), таймаут 30 с. Лимит exec — 2 МБ:
 * болтливый unit может упереться в него — при достижении лимита дописываем
 * честную хвостовую пометку (молчаливая обрезка хуже).
 */
export async function readServiceLogs(
  profile: Profile,
  unit: string,
  tail: number,
  deps: { execFn?: ExecFn } = {},
): Promise<string> {
  const name = assertValidUnitName(unit);
  const execFn = deps.execFn ?? exec;
  const r = await execFn(profile, journalctlCommand(name, tail, false), { timeoutMs: 30000 });
  let out = [r.stdout, r.stderr].filter(Boolean).join('');
  if (r.stdout.length >= EXEC_OUTPUT_LIMIT) {
    out += '\n… (вывод обрезан по лимиту 2 МБ)';
  }
  return out;
}
