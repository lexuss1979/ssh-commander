import { exec } from '../ssh/manager.js';
import type { Profile } from '../types.js';
import { appendSample } from './metrics-history.js';

export interface CpuMetrics {
  /** CPU load in percent (0–100, 1 decimal place) or null if it could not be computed. */
  percent: number | null;
  cores: number | null;
}

export interface MemoryMetrics {
  totalBytes: number | null;
  availableBytes: number | null;
  usedBytes: number | null;
  usedPercent: number | null;
}

export interface DiskMetrics {
  filesystem: string;
  mount: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  usedPercent: number | null;
}

export interface ProcessInfo {
  user: string;
  pid: number;
  cpuPercent: number | null;
  memPercent: number | null;
  command: string;
}

export interface ServerMetrics {
  /** Snapshot time (ms, ssh-commander server clock). */
  timestamp: number;
  cpu: CpuMetrics;
  memory: MemoryMetrics;
  disks: DiskMetrics[];
  uptimeSeconds: number | null;
  loadAverage: [number, number, number] | null;
  processes: ProcessInfo[];
}

// One exec for the whole snapshot. Sections are separated by @@NAME@@
// markers so that utility outputs do not mix. Sources are read from /proc
// rather than from localizable commands (uptime, free): the /proc format
// does not depend on the server locale.
// CPU is computed from two /proc/stat reads with a 0.5 s pause inside the
// same exec — the snapshot is self-contained and does not depend on polling
// history.
// df: -P forces one line per filesystem (no wrapping of long names), -k —
// kilobytes (portable, including busybox). -x excludes pseudo-filesystems
// where df understands it; the parser additionally filters them by device
// name.
const COLLECT_CMD = [
  `printf '@@STAT1@@\\n'; head -n 1 /proc/stat`,
  `sleep 0.5`,
  `printf '@@STAT2@@\\n'; head -n 1 /proc/stat`,
  `printf '@@CORES@@\\n'; grep -c '^cpu[0-9]' /proc/stat`,
  `printf '@@MEM@@\\n'; cat /proc/meminfo`,
  `printf '@@DF@@\\n'; df -P -k -x tmpfs -x devtmpfs -x overlay -x squashfs 2>/dev/null || df -P -k`,
  `printf '@@UPTIME@@\\n'; cat /proc/uptime`,
  `printf '@@LOAD@@\\n'; cat /proc/loadavg`,
  `printf '@@PS@@\\n'; (ps aux --sort=-%cpu 2>/dev/null || ps aux) | head -n 11`,
].join('; ');

function toNum(s: string | undefined): number | null {
  if (!s) return null;
  // Numbers with a comma occur in localized output (e.g. ps in ru_RU).
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function cpuLineFields(text: string): number[] | null {
  const line = text.split('\n').find((l) => /^cpu\s/.test(l));
  if (!line) return null;
  const fields = line
    .trim()
    .split(/\s+/)
    .slice(1)
    .map((f) => Number(f));
  if (fields.length < 4 || fields.some((n) => !Number.isFinite(n))) return null;
  return fields;
}

/**
 * CPU load percent from two snapshots of the aggregated `cpu` line of
 * /proc/stat: the share of non-idle time between the snapshots. idle
 * includes iowait.
 */
export function parseCpuPercent(before: string, after: string): number | null {
  const a = cpuLineFields(before);
  const b = cpuLineFields(after);
  if (!a || !b) return null;
  const len = Math.min(a.length, b.length);
  let totalDelta = 0;
  for (let i = 0; i < len; i++) totalDelta += b[i] - a[i];
  const idleDelta = (b[3] - a[3]) + ((b[4] ?? 0) - (a[4] ?? 0));
  if (totalDelta <= 0) return null;
  const pct = ((totalDelta - idleDelta) / totalDelta) * 100;
  return Math.round(Math.min(100, Math.max(0, pct)) * 10) / 10;
}

/** The core count — the output of `grep -c '^cpu[0-9]' /proc/stat`. */
export function parseCores(grepCount: string): number | null {
  const n = Number(grepCount.trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function parseMeminfo(text: string): MemoryMetrics {
  const get = (name: string): number | null => {
    const m = text.match(new RegExp(`^${name}:\\s+(\\d+)\\s*kB`, 'm'));
    return m ? Number(m[1]) * 1024 : null;
  };
  const total = get('MemTotal');
  let available = get('MemAvailable');
  if (available === null) {
    // Old kernels without MemAvailable: the free + buffers + cached estimate.
    const free = get('MemFree');
    if (free !== null) {
      available = free + (get('Buffers') ?? 0) + (get('Cached') ?? 0);
    }
  }
  const used =
    total !== null && available !== null ? Math.max(0, total - available) : null;
  const usedPercent =
    used !== null && total ? Math.round((used / total) * 1000) / 10 : null;
  return {
    totalBytes: total,
    availableBytes: available,
    usedBytes: used,
    usedPercent,
  };
}

// Pseudo-filesystems: not disks, not needed in the list (duplicates the -x
// flags of df — a safeguard for systems where df does not understand -x and
// the fallback ran).
const SKIP_FS = /^(tmpfs|devtmpfs|overlay|squashfs|shm|none)$/;

/** The output of `df -P -k`: one line per filesystem, sizes in kilobytes. */
export function parseDf(text: string): DiskMetrics[] {
  const disks: DiskMetrics[] = [];
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) continue;
    const [fs, totalKb, usedKb, availKb, cap] = parts;
    // The mount point may contain spaces — the line tail is assembled.
    const mount = parts.slice(5).join(' ');
    const total = Number(totalKb);
    const used = Number(usedKb);
    const avail = Number(availKb);
    // The header (in any locale) and garbage lines are dropped by the numbers.
    if (![total, used, avail].every((n) => Number.isFinite(n))) continue;
    if (!/%$/.test(cap)) continue;
    if (SKIP_FS.test(fs)) continue;
    let pct = toNum(cap.replace('%', ''));
    if (pct === null && total > 0) pct = (used / total) * 100;
    disks.push({
      filesystem: fs,
      mount,
      totalBytes: total * 1024,
      usedBytes: used * 1024,
      availableBytes: avail * 1024,
      usedPercent: pct !== null ? Math.round(pct * 10) / 10 : null,
    });
  }
  return disks;
}

/** /proc/uptime: "uptime_seconds idle_seconds". */
export function parseProcUptime(text: string): number | null {
  const n = toNum(text.trim().split(/\s+/)[0]);
  return n !== null ? Math.floor(n) : null;
}

/** /proc/loadavg: "1min 5min 15min running/total last_pid". */
export function parseLoadavg(text: string): [number, number, number] | null {
  const parts = text.trim().split(/\s+/);
  const a = toNum(parts[0]);
  const b = toNum(parts[1]);
  const c = toNum(parts[2]);
  return a !== null && b !== null && c !== null ? [a, b, c] : null;
}

/** The output of `ps aux` (with the header), up to 10 processes. */
export function parsePsAux(text: string): ProcessInfo[] {
  const out: ProcessInfo[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(
      /^\s*(\S+)\s+(\d+)\s+(\S+)\s+(\S+)\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.*)$/,
    );
    if (!m || m[1] === 'USER') continue;
    out.push({
      user: m[1],
      pid: Number(m[2]),
      cpuPercent: toNum(m[3]),
      memPercent: toNum(m[4]),
      command: m[5].trim(),
    });
    if (out.length >= 10) break;
  }
  return out;
}

function splitSections(raw: string): Map<string, string> {
  const sections = new Map<string, string>();
  let current: string | null = null;
  for (const line of raw.split('\n')) {
    const m = line.match(/^@@([A-Z0-9]+)@@\s*$/);
    if (m) {
      current = m[1];
      sections.set(current, '');
      continue;
    }
    if (current !== null) {
      sections.set(current, (sections.get(current) ?? '') + line + '\n');
    }
  }
  return sections;
}

/** Parse the full COLLECT_CMD output into a typed snapshot. */
export function parseMetricsOutput(raw: string): ServerMetrics {
  const s = splitSections(raw);
  return {
    timestamp: Date.now(),
    cpu: {
      percent: parseCpuPercent(s.get('STAT1') ?? '', s.get('STAT2') ?? ''),
      cores: parseCores(s.get('CORES') ?? ''),
    },
    memory: parseMeminfo(s.get('MEM') ?? ''),
    disks: parseDf(s.get('DF') ?? ''),
    uptimeSeconds: parseProcUptime(s.get('UPTIME') ?? ''),
    loadAverage: parseLoadavg(s.get('LOAD') ?? ''),
    processes: parsePsAux(s.get('PS') ?? ''),
  };
}

const CACHE_TTL_MS = 2000;
const cache = new Map<string, { at: number; promise: Promise<ServerMetrics> }>();

/**
 * Server metrics snapshot. The last result is cached for 2 s per profile
 * (and parallel calls share one exec), so frequent polling from several
 * tabs does not multiply SSH commands. A failed promise is evicted from the
 * cache — the next poll will try again.
 */
export function collectMetrics(profile: Profile): Promise<ServerMetrics> {
  const now = Date.now();
  const hit = cache.get(profile.id);
  if (hit && now - hit.at < CACHE_TTL_MS) {
    return hit.promise;
  }
  const promise = exec(profile, COLLECT_CMD).then((result) => {
    if (result.code !== 0 && !result.stdout.includes('@@STAT2@@')) {
      const detail = (result.stderr || result.stdout).trim();
      throw new Error(`metrics command exited with code ${result.code}${detail ? `: ${detail}` : ''}`);
    }
    const snapshot = parseMetricsOutput(result.stdout);
    // Every real metrics collection (by any of the polling routes) feeds the
    // load history; appendSample filters out timestamp duplicates.
    appendSample(profile.id, snapshot);
    return snapshot;
  });
  cache.set(profile.id, { at: now, promise });
  promise.catch(() => {
    if (cache.get(profile.id)?.promise === promise) {
      cache.delete(profile.id);
    }
  });
  return promise;
}

/**
 * Snapshot cache invalidation after a mutation (process actions, epic 17) —
 * an immediate refetch of "Overview" and the sidebar (`/api/overview`)
 * returns fresh data, not the 2 s cache. The `invalidateServicesCache`
 * pattern from systemd.ts.
 */
export function invalidateMetricsCache(profileId: string): void {
  cache.delete(profileId);
}
