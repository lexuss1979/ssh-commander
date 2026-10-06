import { exec, withSftp } from '../ssh/manager.js';
import { stat as sftpStat } from '../ssh/sftp.js';
import type { ExecResult, Profile } from '../types.js';

/**
 * Package updates (epic 19).
 *
 * The read-only part: manager detection (`command -v apt-get || dnf || yum ||
 * apk`), the update list and reboot indicators in a single exec with markers,
 * the apt index age via SFTP-stat. Applying updates is a separate route
 * (`POST /api/packages/apply`) with a sudo probe before the stream (see
 * `routes/packages.ts`); no agent tool is introduced for packages (updates
 * are already covered by the audit's `updates` section).
 *
 * The list exit code is taken from the `@@LIST_CODE@@` marker, not from
 * `result.code`: the snapshot is a single command of two parts, and the code
 * of the whole line belongs to the last part (the reboot check). For
 * dnf/yum, `check-update` returns 100 = updates available — not an error.
 */

export type PackageManager = 'apt' | 'dnf' | 'yum' | 'apk';

export interface PackageUpdate {
  /** Package name (for dnf — `name.arch`, as in check-update). */
  name: string;
  /** Installed version; null if the manager does not show it. */
  current: string | null;
  /** Available version. */
  available: string;
  /** Suite/repo (apt) or repository (dnf); null for apk. */
  source: string | null;
}

export interface PackagesSnapshot {
  /** Snapshot time (ms, ssh-commander server clock). */
  timestamp: number;
  /** Detected manager; null — not found (not an error, a UI placeholder). */
  pm: PackageManager | null;
  updates: PackageUpdate[];
  rebootRequired: boolean;
  rebootPackages: string[];
  /** apt index age (ms); null — no convention or no file. */
  indexAgeMs: number | null;
  /** Reason the manager is missing — for the UI card. */
  error?: string;
}

export type ExecFn = (
  profile: Profile,
  command: string,
  opts?: { timeoutMs?: number; maxOutput?: number; stdin?: string },
) => Promise<ExecResult>;

export const PACKAGES_CACHE_TTL_MS = 60000;
/** Timeout for quick execs (manager detection). */
export const PROBE_TIMEOUT_MS = 15000;
/**
 * Timeout of the update-list snapshot: dnf check-update goes to the network
 * and the dpkg lock may be busy — without an explicit limit the exec would
 * hang for the default 60 s, holding the SSH channel. 30 s is a compromise
 * between "not instant" and "not forever" (the 60 s cache absorbs retries).
 */
export const SNAPSHOT_TIMEOUT_MS = 30000;

const LIST_CODE_MARKER = '@@LIST_CODE@@';
const REBOOT_MARKER = '@@REBOOT@@';
const RESTART_CODE_MARKER = '@@RESTART_CODE@@';
const APT_INDEX_STAMP = '/var/lib/apt/periodic/update-success-stamp';

// ---------------------------------------------------------------------------
// Pure functions: detection, commands, parsers
// ---------------------------------------------------------------------------

/** Manager detection in a single exec: the first command found. */
export function detectPmCommand(): string {
  return 'command -v apt-get || command -v dnf || command -v yum || command -v apk';
}

/** First non-empty line → path basename → manager (unfamiliar → null). */
export function parsePmDetection(text: string): PackageManager | null {
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const base = (t.split(/[\\/]/).pop() ?? t).trim();
    if (base === 'apt-get') return 'apt';
    if (base === 'dnf' || base === 'yum' || base === 'apk') return base;
    return null;
  }
  return null;
}

export function listUpdatesCommand(pm: PackageManager): string {
  switch (pm) {
    case 'apt':
      return 'apt list --upgradable';
    case 'dnf':
      return 'dnf -q check-update';
    case 'yum':
      return 'yum -q check-update';
    case 'apk':
      // Static string — the shell consumes the quotes itself, apk accepts the literal '<'.
      return "apk version -l '<'";
  }
}

/** Code 100 for dnf/yum = updates available, not an error (roadmap). null — no code received. */
export function isUpdatesExitCode(pm: PackageManager, code: number | null): boolean {
  if (code === null) return false;
  if (pm === 'dnf' || pm === 'yum') return code === 0 || code === 100;
  return code === 0;
}

/** List code from the `@@LIST_CODE@@N` marker; no marker → null (failure). */
export function parseListCode(text: string): number | null {
  const m = new RegExp(`${LIST_CODE_MARKER}(\\d+)`).exec(text);
  return m ? Number(m[1]) : null;
}

/** List text — everything before the code marker (after it — the code and the reboot section). */
export function splitListSection(text: string): string {
  const idx = text.indexOf(LIST_CODE_MARKER);
  return idx >= 0 ? text.slice(0, idx) : text;
}

/**
 * `apt list --upgradable`: `name/suite version arch [upgradable from: cur]`.
 * The name is up to the first `/` (may contain `+`/`-`/digits), the suite has
 * no spaces (`stable-security`, `jammy-updates`), version is the second
 * token (available), current comes from the brackets (no brackets → null).
 * The `Listing…` header and garbage without `/` are skipped. apt's WARNING
 * about the unstable CLI goes to stderr — the stdout parser does not see it.
 */
export function parseAptList(text: string): PackageUpdate[] {
  const out: PackageUpdate[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const m = /^([^\s/]+)\/(\S+)\s+(\S+)\s+(\S+)(?:\s+\[upgradable from:\s*(.*)\])?\s*$/.exec(t);
    if (!m) continue;
    out.push({
      name: m[1],
      current: m[5] ?? null,
      available: m[3],
      source: m[2],
    });
  }
  return out;
}

/**
 * `dnf -q check-update`: `name.arch version repo` (3 tokens). name.arch is
 * not split — the "Package" column reads fine as is. The current version is
 * not available from check-update (a deviation from the roadmap line — the
 * "— → version" column). After the update list comes the `Obsoleting
 * Packages` block: its header (2 tokens) stops parsing, otherwise the
 * block's entries (the same shape) would inflate the counter. Lines shorter
 * than 3 tokens before the list starts are garbage (headers), skipped.
 */
export function parseDnfCheckUpdate(text: string): PackageUpdate[] {
  const out: PackageUpdate[] = [];
  let started = false;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    const fields = trimmed.split(/\s+/);
    if (fields.length < 3) {
      // After the first entry, a short line is the end of the update list
      // (an empty line or the "Obsoleting Packages" header).
      if (started || /^obsoleting packages$/i.test(trimmed)) return out;
      continue;
    }
    out.push({ name: fields[0], current: null, available: fields[1], source: fields[2] });
    started = true;
  }
  return out;
}

/**
 * `apk version -l '<'`: `name-version < version` (only a version can be on
 * the right). The name is up to the last hyphen with a digit tail
 * (`alpine-baselayout-3.4.3-r1` → `alpine-baselayout` / `3.4.3-r1`).
 * Multi-line wrapping (apk cuts to the terminal width): a line without `<`
 * after an entry is a continuation of its available; before the first entry
 * it is garbage (an APKINDEX WARNING), skipped.
 */
const APK_RE = /^(.+)-(\d[^\s<]*)\s*<\s*(.*)$/;

export function parseApkVersionLt(text: string): PackageUpdate[] {
  const out: PackageUpdate[] = [];
  let last: PackageUpdate | null = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = APK_RE.exec(line);
    if (m) {
      const entry: PackageUpdate = {
        name: m[1],
        current: m[2],
        available: m[3].trim(),
        source: null,
      };
      out.push(entry);
      last = entry;
    } else if (last !== null) {
      last.available += line;
    }
  }
  return out;
}

/**
 * The reboot check at the end of the snapshot command (each variant starts
 * with `'; '` — glued back to back to the list command). apt: the marker is
 * printed only if `/var/run/reboot-required` exists (+ the `.pkgs` list);
 * dnf/yum: `needs-restarting -r`, code 1 = reboot needed; apk: no convention.
 */
export function rebootCheckSuffix(pm: PackageManager): string {
  switch (pm) {
    case 'apt':
      return (
        `; if [ -f /var/run/reboot-required ]; then echo '${REBOOT_MARKER}'; ` +
        `cat /var/run/reboot-required.pkgs 2>/dev/null; fi`
      );
    case 'dnf':
    case 'yum':
      return (
        `; if command -v needs-restarting >/dev/null 2>&1; then echo '${REBOOT_MARKER}'; ` +
        `needs-restarting -r; echo "${RESTART_CODE_MARKER}$?"; fi`
      );
    case 'apk':
      return '';
  }
}

/** Full snapshot command: list + code marker + reboot check. */
export function snapshotCommand(pm: PackageManager): string {
  return `${listUpdatesCommand(pm)}; echo "${LIST_CODE_MARKER}$?"${rebootCheckSuffix(pm)}`;
}

/** Parse the reboot section (the text after `@@REBOOT@@`): the needs-restarting code and the `.pkgs` packages. */
export function parseRebootSection(text: string): { code: number | null; packages: string[] } {
  const idx = text.indexOf(REBOOT_MARKER);
  if (idx < 0) return { code: null, packages: [] };
  const section = text.slice(idx + REBOOT_MARKER.length);
  const codeMatch = new RegExp(`${RESTART_CODE_MARKER}(\\d+)`).exec(section);
  const code = codeMatch ? Number(codeMatch[1]) : null;
  const packages = section
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.includes(RESTART_CODE_MARKER));
  return { code, packages };
}

function parseUpdates(pm: PackageManager, text: string): PackageUpdate[] {
  switch (pm) {
    case 'apt':
      return parseAptList(text);
    case 'dnf':
    case 'yum':
      return parseDnfCheckUpdate(text);
    case 'apk':
      return parseApkVersionLt(text);
  }
}

/** Dedupe by name, first occurrence wins. */
export function dedupeByName(updates: PackageUpdate[]): PackageUpdate[] {
  const seen = new Set<string>();
  const out: PackageUpdate[] = [];
  for (const u of updates) {
    if (seen.has(u.name)) continue;
    seen.add(u.name);
    out.push(u);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Applying updates (mutation)
// ---------------------------------------------------------------------------

/**
 * The update-apply command. With sudo — the direct form `sudo -S -p '' --`
 * without `sh -c` (the epic 13 invariant); the password goes as the first
 * line of the channel stdin. `env DEBIAN_FRONTEND=noninteractive` — dpkg
 * prompts take the defaults instead of hanging on the EOF stdin. Static
 * strings — user input is not interpolated anywhere.
 */
export function buildApplyCommand(pm: PackageManager, withSudo: boolean): string {
  const sudo = withSudo ? `sudo -S -p '' -- ` : '';
  switch (pm) {
    case 'apt':
      return `${sudo}env DEBIAN_FRONTEND=noninteractive apt-get -y upgrade`;
    case 'dnf':
      return `${sudo}dnf -y upgrade`;
    case 'yum':
      return `${sudo}yum -y upgrade`;
    case 'apk':
      return `${sudo}apk upgrade`;
  }
}

// ---------------------------------------------------------------------------
// Executors (snapshot + detection, 60 s cache)
// ---------------------------------------------------------------------------

const cache = new Map<string, { at: number; promise: Promise<PackagesSnapshot> }>();

/** Invalidate the cache after applying — refetch gets a fresh list. */
export function invalidatePackagesCache(profileId: string): void {
  cache.delete(profileId);
}

/** Fresh manager detection (for applying — not from the snapshot cache). */
export async function detectPackageManager(
  profile: Profile,
  deps: { execFn?: ExecFn } = {},
): Promise<PackageManager | null> {
  const execFn = deps.execFn ?? exec;
  const r = await execFn(profile, detectPmCommand(), { timeoutMs: PROBE_TIMEOUT_MS });
  return parsePmDetection(r.stdout);
}

/** apt index age via SFTP-stat; no file or a failed stat → a silent null. */
async function aptIndexAge(profile: Profile): Promise<number | null> {
  try {
    const st = await withSftp(profile, (sftp) => sftpStat(sftp, APT_INDEX_STAMP));
    const mtime = st.mtime;
    if (mtime == null) return null;
    return Math.max(0, Date.now() - mtime * 1000);
  } catch {
    return null;
  }
}

/**
 * Updates snapshot. A 60 s cache per profile (the `collectMetrics` pattern):
 * the list changes rarely and the command is not instant; parallel calls
 * share one exec, a failed promise is evicted from the cache. `pm: null` is
 * not an error: it is a normal detection result of "no manager" (a UI
 * placeholder).
 */
export function collectPackagesSnapshot(
  profile: Profile,
  deps: { execFn?: ExecFn } = {},
): Promise<PackagesSnapshot> {
  const now = Date.now();
  const hit = cache.get(profile.id);
  if (hit && now - hit.at < PACKAGES_CACHE_TTL_MS) {
    return hit.promise;
  }
  const execFn = deps.execFn ?? exec;
  const promise = buildSnapshot(profile, execFn);
  cache.set(profile.id, { at: now, promise });
  promise.catch(() => {
    if (cache.get(profile.id)?.promise === promise) {
      cache.delete(profile.id);
    }
  });
  return promise;
}

async function buildSnapshot(profile: Profile, execFn: ExecFn): Promise<PackagesSnapshot> {
  const detection = await execFn(profile, detectPmCommand(), { timeoutMs: PROBE_TIMEOUT_MS });
  const pm = parsePmDetection(detection.stdout);
  if (pm === null) {
    return {
      timestamp: Date.now(),
      pm: null,
      updates: [],
      rebootRequired: false,
      rebootPackages: [],
      indexAgeMs: null,
      error: 'Менеджер пакетов не найден (apt/dnf/yum/apk)',
    };
  }
  const result = await execFn(profile, snapshotCommand(pm), { timeoutMs: SNAPSHOT_TIMEOUT_MS });
  const listCode = parseListCode(result.stdout);
  if (!isUpdatesExitCode(pm, listCode)) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(`${pm}: ${detail || `код ${listCode ?? 'unknown'}`}`);
  }
  const updates = dedupeByName(parseUpdates(pm, splitListSection(result.stdout)));
  const reboot = parseRebootSection(result.stdout);
  const rebootRequired =
    pm === 'apt' ? result.stdout.includes(REBOOT_MARKER) : reboot.code === 1;
  const indexAgeMs = pm === 'apt' ? await aptIndexAge(profile) : null;
  return {
    timestamp: Date.now(),
    pm,
    updates,
    rebootRequired,
    rebootPackages: reboot.packages,
    indexAgeMs,
  };
}
