import { exec } from '../ssh/manager.js';
import { shq } from '../util/shell.js';
import { classifySudoProbe, sudoProbeCommand } from './sudo.js';
import type { ExecResult, Profile } from '../types.js';

/**
 * systemd services (the "Services" tab, epic 13).
 *
 * The snapshot is a single exec with markers; systemd is detected by text,
 * not by exit code (on non-systemd systems the last command fails). All
 * parsers/builders/validators are pure exported functions for unit tests.
 *
 * Sudo mechanics (invariant, same as security-audit): the password is the
 * first line of the channel stdin (`sudo -S -p ''`), never lands in the
 * command line, lives only in request memory. For systemctl the direct form
 * `sudo -S -p '' -- systemctl <action> -- <unit>` is used, without `sh -c`.
 */

export interface UnitInfo {
  /** Unit name with the suffix: 'nginx.service'. */
  name: string;
  description: string | null;
  /** loaded / not-found / error / null (not loaded). */
  load: string | null;
  /** active / inactive / activating / failed / null. */
  active: string | null;
  /** running / dead / exited / failed / null. */
  sub: string | null;
  /** enabled / disabled / masked / static / indirect / generated / alias / null. */
  enabled: string | null;
}

export interface ServicesSnapshot {
  /** Snapshot time (ms, ssh-commander server clock). */
  timestamp: number;
  /** systemd detected. */
  available: boolean;
  /** Unavailability reason — for the UI placeholder. */
  reason?: string;
  units: UnitInfo[];
}

export interface ServiceDetail {
  name: string;
  /** Raw `systemctl status` output — for humans, not parsed. */
  status: string;
  /** Values of the selected `systemctl show` fields; missing ones are null. */
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

/** `systemctl` actions. reset-failed goes beyond the roadmap — deliberate (see the plan). */
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

/** Allow-list check of the action (also against rm/exec/daemon-reload/empty). */
export function isServiceAction(value: unknown): value is ServiceAction {
  return typeof value === 'string' && (SERVICE_ACTIONS as readonly string[]).includes(value);
}

/** Service action error carrying an HTTP status (400 — user-caused reasons, 502 — transport). */
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

/** Journal tail bounds: 1..5000, default 500 (the same ones epic 14 will use). */
export const DEFAULT_TAIL = 500;
export const MAX_TAIL = 5000;

/** exec output limit (manager.ts) — for an honest journal truncation marker. */
const EXEC_OUTPUT_LIMIT = 2 * 1024 * 1024;

const CACHE_TTL_MS = 2000;

/**
 * A single snapshot exec: version, list-units, list-unit-files. `2>&1` puts
 * detection errors into stdout; `LC_ALL=C` gives stable headers/statuses.
 * The exit code is ignored — the parser decides from the text.
 */
const SNAPSHOT_CMD =
  `LC_ALL=C systemctl --version 2>&1 | head -1\n` +
  `echo '${UNITS_MARKER}'\n` +
  `LC_ALL=C systemctl list-units --type=service --all --no-pager --plain --no-legend 2>&1\n` +
  `echo '${UNITFILES_MARKER}'\n` +
  `LC_ALL=C systemctl list-unit-files --type=service --no-pager --plain --no-legend 2>&1`;

// ---------------------------------------------------------------------------
// Pure parsers/validators/builders
// ---------------------------------------------------------------------------

/** Unit name validation: safe characters plus a ban on «.» and «..». */
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
 * First line of `systemctl --version`: `systemd 252 (252.26-1~deb12u2)` →
 * the version; `not found` / `command not found` → systemctl missing (null).
 */
export function parseVersionLine(line: string): string | null {
  const t = line.trim();
  if (!t) return null;
  if (/not found|command not found/i.test(t)) return null;
  if (/^systemd\s+\d+/.test(t)) return t;
  return null;
}

/**
 * Search for the systemd version line across the whole snapshot output, not
 * just the first line: ssh-exec may source ~/.bashrc/rc and print noise
 * before `systemctl --version` (custom rc, conda etc.) — then the first line
 * would give a false "systemctl not found" placeholder.
 */
function findVersionLine(raw: string): string | null {
  for (const line of raw.split('\n')) {
    const v = parseVersionLine(line);
    if (v !== null) return v;
  }
  return null;
}

/**
 * `systemctl list-units --type=service --all --plain --no-legend`: columns
 * `UNIT LOAD ACTIVE SUB DESCRIPTION`; `--plain` removes the `●` bullet of
 * failed units (otherwise it would shift the columns); `-` in LOAD/ACTIVE/SUB
 * → null; a description with spaces is everything after the 4th column;
 * garbage lines are dropped.
 *
 * Old systemd builds may not remove the bullet (● predates --plain hiding it
 * for list-units) — we strip the leading token ourselves, otherwise columns
 * shift and a failed unit's line silently disappears.
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
 * `systemctl list-unit-files --type=service --plain --no-legend`. The format
 * is version-dependent: systemd ≥ 245 has three columns (`UNIT FILE / STATE /
 * PRESET`), before that — two (`UNIT FILE / STATE`). STATE is **always the
 * second field (`fields[1]`)**: in the three-column format, reading the last
 * field would store the preset value in `enabled`. PRESET is ignored.
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
 * Merge of list-units and list-unit-files: the name comes from either list;
 * `enabled` from unit-files (missing → null, e.g. transient units);
 * load/active/sub from list-units (not loaded → null). Sorted by name.
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
 * Parse the full snapshot output. Decisions are made from text, not code:
 * - the version does not look like systemd → unavailable;
 * - `has not been booted with systemd` → unavailable (container);
 * - a flag error at the start of a section (`Unknown option` /
 *   `Invalid option` / `Failed to`) → unavailable with the error text
 *   (otherwise the parser would silently drop the error line as garbage and
 *   the UI would show a half-filled table).
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

/** Parse `systemctl show` output: `KEY=VALUE` lines, first occurrence wins. */
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

/** The `systemctl <action> -- <unit>` command (unit via shq; `--` guards against options). */
export function systemctlCommand(action: string, unit: string): string {
  return `systemctl ${action} -- ${shq(unit)}`;
}

/** Direct sudo form without `sh -c`: `sudo -S -p '' -- systemctl <action> -- <unit>`. */
export function sudoSystemctlCommand(action: string, unit: string): string {
  return `sudo -S -p '' -- systemctl ${action} -- ${shq(unit)}`;
}

/** The unit's journal command; `-f` only for a follow stream. The unit name is the
 * `-u` argument (getopt consumes the next argv as the option value), so a leading
 * `-` in the name cannot be parsed as an option; `--` is not needed here. */
export function journalctlCommand(unit: string, tail: number, follow: boolean): string {
  return `journalctl -u ${shq(unit)} --no-pager -n ${tail}${follow ? ' -f' : ''}`;
}

/** tail 1..5000, default 500; non-numeric/NaN → the default. */
export function clampTail(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_TAIL;
  return Math.min(MAX_TAIL, Math.max(1, Math.floor(n)));
}

// ---------------------------------------------------------------------------
// Action failure classification
// ---------------------------------------------------------------------------

export type ActionFailureCategory =
  | 'ok'
  | 'sudo-needed'
  | 'masked'
  | 'not-found'
  | 'job-failed'
  | 'transport';

/**
 * Classification of a `systemctl <action>` result: the polkit wording
 * `Interactive authentication required` is typical for Debian/Ubuntu/RHEL/
 * Fedora (that is systemctl talking without a TTY); `Access denied` — systems
 * without polkit. masked/not-found/job-failed is service state, not
 * transport; a sudo retry is useless for them.
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
// Executors (exec wrappers with deps injection for tests)
// ---------------------------------------------------------------------------

/**
 * Services snapshot. A 2 s cache per profile (the ports.ts pattern): parallel
 * calls share one exec; a failed promise is evicted from the cache.
 * `available: false` is not an error but a normal detection result.
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

/** Invalidate the snapshot cache after an action mutation — refetch gets fresh data. */
export function invalidateServicesCache(profileId: string): void {
  cache.delete(profileId);
}

/** The unit detail command: raw status + selected show fields (marker-separated).
 * `--` before the name guards against options (the name regex allows a leading `-`). */
export function serviceDetailCommand(unit: string): string {
  const fields = SHOW_FIELDS.map((f) => `-p ${f}`).join(' ');
  return (
    `LC_ALL=C systemctl status --no-pager -n 0 -- ${shq(unit)} 2>&1\n` +
    `echo '${SHOW_MARKER}'\n` +
    `LC_ALL=C systemctl show ${fields} -- ${shq(unit)} 2>&1`
  );
}

/**
 * Unit detail. The exit code is ignored: for `systemctl status` it is not
 * an error signal (3 = inactive, 4 = not-found — normal states).
 * `-n 0` — no journal dump, `--no-pager` — no pagination.
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
 * Explicit timeout for action execs: systemd's default TimeoutStartSec/StopSec
 * can exceed the 60 s of manager.ts (and a process not reacting to SIGTERM
 * will certainly exceed them). Without an explicit timeout such a mutation
 * would turn into a generic 502 "Server unavailable" — although it may have
 * been applied in time.
 */
const ACTION_TIMEOUT_MS = 120000;

function isExecTimeout(err: unknown): boolean {
  return err instanceof Error && /timed out after \d+ms/.test(err.message);
}

/** Action exec with an explicit timeout: a timeout is not transport but a sign
 * to "check the status" (the mutation may have gone all the way). */
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
 * Unit action with a sudo retry on access-denied:
 * 1. try without sudo;
 * 2. sudo-needed + a password supplied → probe `sudo -S -p '' -- true` (stdin);
 *    explicit probe failures (wrong password / not in sudoers / sudo not
 *    installed) → 400, anything else → 502; probe passed → retry via sudo;
 * 3. sudo-needed without a password → 400 "provide the sudo password";
 * 4. masked/not-found/job-failed → 400 with the systemd text as is;
 * 5. action exec timeout → 400 "check the status" (not 502);
 * 6. transport/unknown → 502.
 *
 * The retry is safe: access-denied/interactive-auth means the mutation has
 * not started. The password lives only in the stdin of a single request.
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
  // transport / unknown
  throw new ServiceActionError(
    502,
    (first.stderr || first.stdout).trim() || `Команда не выполнена (код ${first.code ?? 'unknown'})`,
  );
}

/**
 * One-shot unit journal (no follow), 30 s timeout. The exec limit is 2 MB:
 * a chatty unit can hit it — when the limit is reached an honest tail
 * marker is appended (silent truncation is worse).
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
