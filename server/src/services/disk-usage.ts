import { exec, getSftp } from '../ssh/manager.js';
import { stat as sftpStat } from '../ssh/sftp.js';
import { shq } from '../util/shell.js';
import { basename } from '../util/path.js';
import { aiStr } from '../ai/strings.js';
import type { PromptLang } from '../ai/prompts.js';
import type { ExecResult, Profile } from '../types.js';

/**
 * "What eats the disk" — a du navigator (epic 16).
 *
 * One level of the tree per request: `du -x -d 1 -k` (the directory itself is
 * the last line in post-order, plus direct subdirectories) and the top largest
 * files via `find`. Everything is read-only, commands are assembled by the
 * service (the guard does not see them — the security_audit precedent). stderr
 * is not silenced but caught: access denials produce an honest `incomplete`
 * marker so the numbers do not look like lies.
 *
 * Deviations from the roadmap: `-k` instead of `-B1` (BusyBox does not know
 * `-B`, same as `df -P -k` in metrics.ts; the parser multiplies by 1024),
 * `2>/dev/null` is not used (see above).
 */

export const DU_TIMEOUT_MS = 60000;
/** Max files in the "Files" mode response. */
export const DU_MAX_LIMIT = 500;
export const DU_DEFAULT_LIMIT = 100;
export const AGENT_DEFAULT_LIMIT = 10;
export const AGENT_MAX_LIMIT = 50;
/** Cache for the heavy du snapshot only; find is cheaper — not cached. */
const DISK_USAGE_CACHE_TTL_MS = 2000;

export interface DiskUsageChild {
  name: string;
  path: string;
  bytes: number;
  /** Share of the directory's subtree total (one decimal place). */
  pctOfParent: number;
}

export interface DiskUsageSnapshot {
  path: string;
  totalBytes: number;
  /** Size of files directly inside the directory (du -d 1 does not print them). */
  directBytes: number;
  children: DiskUsageChild[];
  /** Access denials during traversal (du/find stderr lines). */
  incomplete: { unreadable: number } | null;
  /** du output truncated by the exec limit — the total line was lost. */
  truncated: boolean;
}

export interface DiskUsageFile {
  path: string;
  bytes: number;
}

export interface TopFilesResult {
  path: string;
  files: DiskUsageFile[];
  incomplete: { unreadable: number } | null;
}

/**
 * A user-facing error (path, permissions, utilities) — the route answers 400.
 * Transport errors (exec reject, SSH connection failure) are not wrapped —
 * the route answers 502.
 */
export class DiskUsageError extends Error {}

/** exec wrapper with injection for tests (the systemd.ts pattern: `deps.execFn`). */
export type ExecFn = (
  profile: Profile,
  command: string,
  opts?: { timeoutMs?: number; stdin?: string },
) => Promise<ExecResult>;

export interface DiskUsageDeps {
  execFn?: ExecFn;
  /** Directory precheck. Injection is needed by tests (no real SFTP) and by
   * the agent: it checks the path once for both calls (see skipPrecheck). */
  precheckFn?: (profile: Profile, path: string) => Promise<void>;
  /** Skip the precheck — the caller has already made sure the path is a directory. */
  skipPrecheck?: boolean;
}

// ---------------------------------------------------------------------------
// Path validation. assertSafePath does not fit: it forbids `/`, while a mount
// point may be the navigation root.
// ---------------------------------------------------------------------------

/** Normalization: trim, collapse `//`, strip the trailing `/` (except the root). */
export function normalizeDiskPath(p: string): string {
  const trimmed = p.trim();
  if (!trimmed.startsWith('/')) return trimmed;
  return trimmed.replace(/\/+/g, '/').replace(/\/+$/, '') || '/';
}

/** An absolute path (`/` is fine) without `..` segments; otherwise an error. */
export function assertNavigablePath(p: string): string {
  if (!p.startsWith('/')) {
    throw new DiskUsageError('Путь должен быть абсолютным (начинаться с /)');
  }
  if (p.split('/').some((part) => part === '..')) {
    throw new DiskUsageError("'..' не допускается в пути");
  }
  return p;
}

// ---------------------------------------------------------------------------
// Command assembly (pure builders). Pipelines and redirects are fine here —
// commands are assembled by the service, the guard.ts allow-list never sees them.
// ---------------------------------------------------------------------------

/** `du -x -d 1 -k`: one filesystem, depth level 1, kibibytes (portable). */
export function buildDuCommand(path: string): string {
  return `du -x -d 1 -k -- ${shq(path)}`;
}

/** Top files: GNU find with `-printf` (find expands the `\t` escape itself). */
export function buildTopFilesCommand(path: string, limit: number): string {
  return `find ${shq(path)} -xdev -type f -printf '%s\\t%p\\n' | sort -rn | head -n ${limit}`;
}

/**
 * Fallback without `-printf` (BusyBox): `stat -c '%s\t%n'`, where `\t` is a
 * literal tab character (0x09) inside single quotes, not an escape
 * sequence: GNU stat expands `\t` itself, BusyBox does not, and the parser
 * would get lines without a separator. With a literal tab both behave
 * identically (the shell passes the byte inside single quotes as is).
 */
export function buildTopFilesStatCommand(path: string, limit: number): string {
  return `find ${shq(path)} -xdev -type f -exec stat -c '%s${'\t'}%n' {} + | sort -rn | head -n ${limit}`;
}

/**
 * A sign that find did not understand an option (`-printf` and `-exec … +`
 * share the same class). The wordings differ more than one would expect:
 * BusyBox —
 * `find: unrecognized: -printf`, GNU — `find: unknown predicate `-printf'`,
 * BSD — `find: -printf: unknown primary or operator`.
 */
export function needsStatFallback(stderr: string): boolean {
  return /unrecognized|unknown (primary|predicate|option)|invalid option|not supported/i.test(stderr);
}

// ---------------------------------------------------------------------------
// Parsers (pure, tolerant to 2 MB-truncated output).
// ---------------------------------------------------------------------------

const DU_LINE_RE = /^\s*(\d+)\t(.+)$/;

/**
 * Output of `du -x -d 1 -k` (`size\tpath` lines, the separator is the first
 * tab; a path with spaces/tabs is the line tail). The directory's total entry
 * is found by path match, not by position: both GNU and BusyBox print the
 * directory itself on the last line (post-order), but relying on the order
 * is fragile. No entry → `totalKb: null` — a sign of truncated output, not
 * an error.
 */
export function parseDuKb(
  text: string,
  basePath: string,
): { totalKb: number | null; children: { path: string; kb: number }[] } {
  let totalKb: number | null = null;
  const children: { path: string; kb: number }[] = [];
  const prefix = basePath === '/' ? '/' : `${basePath}/`;
  for (const line of text.split('\n')) {
    const m = line.match(DU_LINE_RE);
    if (!m) continue;
    const kb = Number(m[1]);
    if (!Number.isFinite(kb)) continue;
    const p = m[2];
    if (p === basePath) {
      totalKb = kb;
    } else if (p.startsWith(prefix)) {
      children.push({ path: p, kb });
    }
  }
  return { totalKb, children };
}

function pctOf(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 1000) / 10;
}

/**
 * Response assembly: children sorted descending, `directBytes` — the size of
 * files directly in the directory (clamped ≥ 0: du and df disagree on open
 * deleted files etc.). With `totalKb === null` and non-empty children —
 * degradation: the sum over children, `truncated: true`; with no children —
 * an error (there is truly nothing to parse).
 */
export function toDuSnapshot(
  path: string,
  totalKb: number | null,
  children: { path: string; kb: number }[],
): { totalBytes: number; directBytes: number; children: DiskUsageChild[]; truncated: boolean } {
  if (totalKb === null) {
    if (children.length === 0) {
      throw new DiskUsageError('du не вернул размер каталога (вывод обрезан)');
    }
    const totalBytes = children.reduce((s, c) => s + c.kb * 1024, 0);
    const out = children
      .map((c) => ({
        name: basename(c.path),
        path: c.path,
        bytes: c.kb * 1024,
        pctOfParent: pctOf(c.kb * 1024, totalBytes),
      }))
      .sort((a, b) => b.bytes - a.bytes);
    return { totalBytes, directBytes: 0, children: out, truncated: true };
  }
  const totalBytes = totalKb * 1024;
  const sumChildren = children.reduce((s, c) => s + c.kb * 1024, 0);
  const out = children
    .map((c) => ({
      name: basename(c.path),
      path: c.path,
      bytes: c.kb * 1024,
      pctOfParent: pctOf(c.kb * 1024, totalBytes),
    }))
    .sort((a, b) => b.bytes - a.bytes);
  return {
    totalBytes,
    directBytes: Math.max(0, totalBytes - sumChildren),
    children: out,
    truncated: false,
  };
}

/** Output of `find … | sort -rn | head`: path and size, descending. */
export function parseFindOutput(text: string): DiskUsageFile[] {
  const out: DiskUsageFile[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(DU_LINE_RE);
    if (!m) continue;
    const bytes = Number(m[1]);
    if (!Number.isFinite(bytes)) continue;
    out.push({ path: m[2], bytes });
  }
  out.sort((a, b) => b.bytes - a.bytes);
  return out;
}

/** Number of access-denial lines in stderr — for the "not everything was readable" marker. */
export function countUnreadable(stderr: string): number {
  let n = 0;
  for (const line of stderr.split('\n')) {
    if (/cannot (read|access)|Permission denied|Operation not permitted/i.test(line)) {
      n += 1;
    }
  }
  return n;
}

/** An integer 1..50 for the agent tool; garbage/missing — the default of 10. */
export function clampAgentLimit(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return AGENT_DEFAULT_LIMIT;
  return Math.min(AGENT_MAX_LIMIT, Math.round(n));
}

function humanSize(bytes: number, lang: PromptLang = 'ru'): string {
  const units = lang === 'en'
    ? ['B', 'KB', 'MB', 'GB', 'TB']
    : ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Text report for the disk_usage agent tool (the language is the agent session's language). */
export function formatAgentDiskUsage(
  path: string,
  snapshot: DiskUsageSnapshot,
  files: DiskUsageFile[],
  limit: number,
  filesNote?: string,
  lang: PromptLang = 'ru',
): string {
  const lines: string[] = [];
  lines.push(aiStr(lang, 'duSize', { path, bytes: snapshot.totalBytes, human: humanSize(snapshot.totalBytes, lang) }));
  lines.push(aiStr(lang, 'duLargestDirs'));
  if (snapshot.children.length === 0) {
    lines.push(`  ${aiStr(lang, 'duNoSubdirs')}`);
  }
  for (const [i, c] of snapshot.children.slice(0, limit).entries()) {
    lines.push(`  ${i + 1}. ${c.name} — ${aiStr(lang, 'duBytes', { bytes: c.bytes })} (${c.pctOfParent}%)`);
  }
  lines.push(aiStr(lang, 'duLargestFiles'));
  if (filesNote) {
    lines.push(`  ${filesNote}`);
  } else if (files.length === 0) {
    lines.push(`  ${aiStr(lang, 'duNoFiles')}`);
  }
  for (const [i, f] of files.slice(0, limit).entries()) {
    lines.push(`  ${i + 1}. ${f.path} — ${aiStr(lang, 'duBytes', { bytes: f.bytes })}`);
  }
  if (snapshot.incomplete) {
    lines.push(aiStr(lang, 'duUnreadable', { n: snapshot.incomplete.unreadable }));
  }
  if (snapshot.truncated) {
    lines.push(aiStr(lang, 'duTruncatedTotal'));
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Precheck before the heavy command: the path exists and is a directory.
 * Error separation as in routes/metrics.ts: a stat failure (no path, no
 * permissions) is a user-facing error (400), while a getSftp failure (the
 * connection) is rethrown as is — transport (502). Previously the whole
 * withSftp error was wrapped into DiskUsageError, and a dead SSH looked like
 * "Path unavailable: …" with a "Retry" button instead of an honest "Server
 * unavailable".
 */
export async function precheckNavigableDir(profile: Profile, path: string): Promise<void> {
  // getSftp outside try: a dropped connection is transport.
  const sftp = await getSftp(profile);
  let st;
  try {
    st = await sftpStat(sftp, path);
  } catch (err) {
    throw new DiskUsageError(`Путь недоступен: ${(err as Error).message}`);
  }
  if ((st.mode & 0o170000) !== 0o040000) {
    throw new DiskUsageError('Это не директория');
  }
}

/**
 * exec du/find with a timeout. The plan names a slow du risk #1 and promises
 * a "clear 'Превышено время ожидания' error": ssh/manager.ts throws the
 * English "Command timed out…", which would otherwise end up in a 502
 * "Server unavailable" — the server is fine, it is the command that ran too
 * long. The agent goes through here as well: its degraded "largest files
 * unavailable" line would get the same English text. Transport errors
 * (non-timeout) are rethrown as is.
 */
async function runDuExec(profile: Profile, command: string, execFn: ExecFn): Promise<ExecResult> {
  try {
    return await execFn(profile, command, { timeoutMs: DU_TIMEOUT_MS });
  } catch (err) {
    const msg = String((err as Error).message ?? err);
    if (/timed out/i.test(msg)) {
      throw new DiskUsageError('Превышено время ожидания (60 с) — попробуйте начать с подкаталога');
    }
    throw err;
  }
}

interface CacheEntry {
  at: number;
  promise: Promise<DiskUsageSnapshot>;
}

// The key is "<profileId>\0<path>" (NUL cannot occur in a path).
const duCache = new Map<string, CacheEntry>();

/**
 * du snapshot of a single directory. A 2 s cache per (profile, path) — du is
 * the heaviest command in the app; a repeated click on the same directory
 * must not run it again. A failed promise is evicted from the cache (the
 * collectMetrics pattern).
 */
export function diskUsageSnapshot(
  profile: Profile,
  path: string,
  deps: DiskUsageDeps = {},
): Promise<DiskUsageSnapshot> {
  const key = `${profile.id}\0${path}`;
  const now = Date.now();
  const hit = duCache.get(key);
  if (hit && now - hit.at < DISK_USAGE_CACHE_TTL_MS) {
    return hit.promise;
  }
  const execFn = deps.execFn ?? exec;
  const precheckFn = deps.precheckFn ?? precheckNavigableDir;
  const promise = (async () => {
    if (!deps.skipPrecheck) {
      await precheckFn(profile, path);
    }
    const result = await runDuExec(profile, buildDuCommand(path), execFn);
    if (result.code !== 0) {
      // no permissions on the path itself, or the path vanished between stat and du
      throw new DiskUsageError(result.stderr.trim() || `du завершился с кодом ${result.code}`);
    }
    const { totalKb, children } = parseDuKb(result.stdout, path);
    const snapshot = toDuSnapshot(path, totalKb, children);
    const unreadable = countUnreadable(result.stderr);
    return {
      ...snapshot,
      path,
      incomplete: unreadable > 0 ? { unreadable } : null,
    };
  })();
  duCache.set(key, { at: now, promise });
  promise.catch(() => {
    if (duCache.get(key)?.promise === promise) {
      duCache.delete(key);
    }
  });
  return promise;
}

/**
 * Top largest files of a directory. Strategy: try the `-printf` variant;
 * on a sign of an unknown option (BusyBox) or empty stdout with non-empty
 * stderr (the pipeline's exit code belongs to head — a find failure is not
 * visible in the code), retry with the stat variant. The "empty stdout"
 * heuristic is narrowed by `countUnreadable === 0`: a legitimately empty
 * directory with access denials in subdirectories must not run the second
 * (the longest) tree walk in vain. One extra exec on BusyBox servers only;
 * the decision is not cached — the request is manual and rare.
 */
export async function topFiles(
  profile: Profile,
  path: string,
  limit: number,
  deps: DiskUsageDeps = {},
): Promise<TopFilesResult> {
  const execFn = deps.execFn ?? exec;
  const precheckFn = deps.precheckFn ?? precheckNavigableDir;
  if (!deps.skipPrecheck) {
    await precheckFn(profile, path);
  }
  let result = await runDuExec(profile, buildTopFilesCommand(path, limit), execFn);
  if (result.code !== 0 && !needsStatFallback(result.stderr)) {
    throw new DiskUsageError(result.stderr.trim() || `find завершился с кодом ${result.code}`);
  }
  if (
    needsStatFallback(result.stderr) ||
    (result.stdout.trim() === '' && result.stderr.trim() !== '' && countUnreadable(result.stderr) === 0)
  ) {
    const statResult = await runDuExec(profile, buildTopFilesStatCommand(path, limit), execFn);
    if (needsStatFallback(statResult.stderr)) {
      // -exec … + is unsupported as well (exotic): the "Files" mode degrades with an explanation
      throw new DiskUsageError('find не поддерживает -printf и -exec stat — режим «Файлы» недоступен на этом сервере');
    }
    if (statResult.code !== 0) {
      throw new DiskUsageError(statResult.stderr.trim() || `find завершился с кодом ${statResult.code}`);
    }
    result = statResult;
  }
  const unreadable = countUnreadable(result.stderr);
  return {
    path,
    files: parseFindOutput(result.stdout),
    incomplete: unreadable > 0 ? { unreadable } : null,
  };
}
