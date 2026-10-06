import { exec } from '../ssh/manager.js';
import type { Profile } from '../types.js';

export interface PortListener {
  proto: 'tcp' | 'udp';
  /** Listen address without the port: 0.0.0.0, 127.0.0.1, ::, a specific IP. */
  host: string;
  port: number;
  pid: number | null;
  /** Process name (for ss — a comma-separated list when there are several listeners). */
  process: string | null;
  /** public — 0.0.0.0/::/* (exposed outward), loopback — 127.x/::1, interface — a specific IP. */
  scope: 'public' | 'loopback' | 'interface';
  /** Annotation: the listener belongs to a docker container (published port). */
  container?: { id: string; name: string };
}

export interface PortsSnapshot {
  /** Snapshot time (ms, ssh-commander server clock). */
  timestamp: number;
  ports: PortListener[];
}

// ss (iproute2) is present almost everywhere; netstat is the fallback for
// old/minimal systems. Without root, -p shows only the current user's
// processes — this is expected, the missing processes simply stay empty.
const COLLECT_CMD = 'ss -tulpn 2>/dev/null || netstat -tulpn 2>/dev/null';

function normalizeHost(host: string): string {
  // ss writes IPv6 in brackets ([::]:80) — strip them; %iface (127.0.0.53%lo) is kept.
  return host.replace(/^\[(.*)\]$/, '$1');
}

function scopeOf(host: string): PortListener['scope'] {
  const h = host.replace(/%.*$/, '');
  if (h === '' || h === '*' || h === '0.0.0.0' || h === '::') return 'public';
  if (h === '::1' || h.startsWith('127.')) return 'loopback';
  return 'interface';
}

function splitHostPort(addr: string): { host: string; port: number } | null {
  const idx = addr.lastIndexOf(':');
  if (idx < 0) return null;
  const port = Number(addr.slice(idx + 1));
  if (!Number.isInteger(port) || port < 0 || port > 65535) return null;
  return { host: normalizeHost(addr.slice(0, idx)), port };
}

/** Processes from the ss column `users:(("sshd",pid=1234,fd=3),(...))`. */
function parseSsUsers(tail: string): { pid: number | null; process: string | null } {
  const pairs = [...tail.matchAll(/"([^"]+)",pid=(\d+)/g)];
  if (pairs.length === 0) return { pid: null, process: null };
  const names = [...new Set(pairs.map((p) => p[1]))];
  return { pid: Number(pairs[0][2]), process: names.join(', ') };
}

/** The netstat tail `1234/sshd` (or `-` when there are no permissions/data). */
function parseNetstatProc(field: string | undefined): { pid: number | null; process: string | null } {
  const m = field?.match(/^(\d+)\/(.+)$/);
  if (!m) return { pid: null, process: null };
  return { pid: Number(m[1]), process: m[2] };
}

/**
 * Parses the output of `ss -tulpn` or `netstat -tulpn` (the format is
 * detected per line: for ss the second field is the state, for netstat a
 * number). Headers and lines without a port (e.g. local `*:*`) are
 * skipped.
 */
export function parseListeners(raw: string): PortListener[] {
  const out: PortListener[] = [];
  for (const line of raw.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 6) continue;
    const protoRaw = fields[0];
    if (!/^(tcp|udp)6?$/.test(protoRaw)) continue;
    const proto = (protoRaw.startsWith('tcp') ? 'tcp' : 'udp') as 'tcp' | 'udp';

    let local: string;
    let pid: number | null;
    let process: string | null;
    if (/^\d+$/.test(fields[1])) {
      // netstat: proto recv-q send-q local foreign [state] pid/prog
      if (proto === 'tcp' && fields[5] !== 'LISTEN') continue;
      local = fields[3];
      ({ pid, process } = parseNetstatProc(fields[fields.length - 1]));
    } else {
      // ss: proto state recv-q send-q local peer [users:(...)]
      if (proto === 'tcp' && fields[1] !== 'LISTEN') continue;
      local = fields[4];
      ({ pid, process } = parseSsUsers(fields.slice(6).join(' ')));
    }

    const hp = splitHostPort(local);
    if (!hp) continue;
    out.push({ proto, host: hp.host, port: hp.port, pid, process, scope: scopeOf(hp.host) });
  }
  out.sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto) || a.host.localeCompare(b.host));
  return out;
}

const CACHE_TTL_MS = 2000;
const cache = new Map<string, { at: number; promise: Promise<PortsSnapshot> }>();

/**
 * The list of server listening ports. Cache 2 s per profile (parallel
 * calls share one exec) — like metrics, so that tab polling does not spawn
 * SSH commands. A rejected promise is removed from the cache.
 */
export function collectPorts(profile: Profile): Promise<PortsSnapshot> {
  const now = Date.now();
  const hit = cache.get(profile.id);
  if (hit && now - hit.at < CACHE_TTL_MS) {
    return hit.promise;
  }
  const promise = exec(profile, COLLECT_CMD).then((result) => {
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim();
      throw new Error(
        `команда завершилась с кодом ${result.code}${detail ? `: ${detail}` : ''} (ни ss, ни netstat не найдены?)`,
      );
    }
    return { timestamp: Date.now(), ports: parseListeners(result.stdout) };
  });
  cache.set(profile.id, { at: now, promise });
  promise.catch(() => {
    if (cache.get(profile.id)?.promise === promise) {
      cache.delete(profile.id);
    }
  });
  return promise;
}
