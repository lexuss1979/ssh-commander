import { exec } from '../ssh/manager.js';
import { dockerExec, parseDockerJsonOutput } from './docker.js';
import { imageRepository } from './db-discovery.js';
import { shq } from '../util/shell.js';
import {
  certInfoFromPem,
  parseCertBatch,
  parseNginxDump,
  toSiteEntry,
} from './nginx-parser.js';
import type {
  ExecResult,
  NginxSourceRef,
  NginxSourceSnapshot,
  NginxSnapshot,
  Profile,
} from '../types.js';

/**
 * The I/O layer of the "Nginx" tab: discovery (decision 2), the `nginx -T`
 * snapshot + `nginx -t` + certificates (decisions 1, 5, 10), guarded reload
 * (decision 4). The cron.ts/ports.ts pattern: a 2 s snapshot cache per
 * profile, certificates in a separate 10 min cache.
 */

/** Image repositories with nginx (via imageRepository from db-discovery.ts). */
const NGINX_IMAGE_REPOS = new Set([
  'nginx',
  'nginxproxy/nginx-proxy',
  'jc21/nginx-proxy-manager',
  'openresty/openresty',
]);

/** `nginx -T` output limit: a real dump with hundreds of sites exceeds the default 2 MB. */
const DUMP_MAX_OUTPUT = 8 * 1024 * 1024;

const SNAPSHOT_CACHE_TTL_MS = 2000;
const CERT_CACHE_TTL_MS = 10 * 60 * 1000;

const snapshotCache = new Map<string, { at: number; promise: Promise<NginxSnapshot> }>();
/** Key: `<profileId>:<source>` → path → {at, pem}. */
const certCache = new Map<string, Map<string, { at: number; pem: string }>>();

// ---------------------------------------------------------------------------
// Command builders (pure, for unit tests)
// ---------------------------------------------------------------------------

/** The command for native is a shell string; for a container — docker args
 * (dockerCommand escaping + shq are applied by `dockerExec` inside docker.ts). */
export type NginxCmd = string | string[];

export function buildDumpCmd(source: NginxSourceRef): NginxCmd {
  if (source.type === 'native') return `${shq(source.bin)} -T`;
  return ['exec', source.containerId, 'nginx', '-T'];
}

export function buildTestCmd(source: NginxSourceRef): NginxCmd {
  if (source.type === 'native') return `${shq(source.bin)} -t`;
  return ['exec', source.containerId, 'nginx', '-t'];
}

export function buildReloadCmd(source: NginxSourceRef): NginxCmd {
  if (source.type === 'native') return `${shq(source.bin)} -s reload`;
  return ['exec', source.containerId, 'nginx', '-s', 'reload'];
}

/** `nginx -v` writes the version to stderr. */
export function buildVersionCmd(source: NginxSourceRef): NginxCmd {
  if (source.type === 'native') return `${shq(source.bin)} -v`;
  return ['exec', source.containerId, 'nginx', '-v'];
}

/**
 * Batch reading of PEM files in one command with `=== <path>` markers
 * (the `/etc/cron.d` pattern, decision 5). The `[ -f ]` guard: an unreadable
 * file yields no section in stdout — the collector marks it "unavailable"
 * rather than garbage.
 */
export function buildCertBatchCmd(source: NginxSourceRef, paths: string[]): NginxCmd {
  const loop =
    `for f in ${paths.map(shq).join(' ')}; do ` +
    `if [ -f "$f" ]; then echo "=== $f"; cat -- "$f"; fi; done`;
  if (source.type === 'native') return loop;
  return ['exec', source.containerId, 'sh', '-c', loop];
}

/** Single config read limit: a real config rarely exceeds a couple hundred KB. */
const CONFIG_MAX_OUTPUT = 2 * 1024 * 1024;

/** Read one config file: native — `cat` on the host, container — `docker exec … cat`. */
export function buildReadConfigCmd(source: NginxSourceRef, path: string): NginxCmd {
  const cat = `cat -- ${shq(path)}`;
  if (source.type === 'native') return cat;
  return ['exec', source.containerId, 'sh', '-c', cat];
}

/**
 * Reading a single config (the "Open" button in the Nginx panel). The path
 * comes from the `# configuration file <path>:` marker of the `nginx -T`
 * dump, so it is a real file that nginx loaded (for a container — a path
 * inside the container).
 */
export async function readNginxConfig(
  profile: Profile,
  source: NginxSourceRef,
  path: string,
): Promise<{ content: string }> {
  const r = await runSource(profile, buildReadConfigCmd(source, path), { maxOutput: CONFIG_MAX_OUTPUT });
  if (r.code !== 0) {
    const detail = (r.stderr || r.stdout).trim();
    throw new Error(`Не удалось прочитать ${path}${detail ? `: ${detail}` : ''}`);
  }
  return { content: r.stdout };
}

/** Run a source command: a string — exec, an array — dockerExec. */
async function runSource(
  profile: Profile,
  cmd: NginxCmd,
  opts?: { maxOutput?: number },
): Promise<ExecResult> {
  if (Array.isArray(cmd)) return dockerExec(profile, cmd, opts);
  return exec(profile, cmd, opts);
}

/** nginx version from the stderr `nginx version: nginx/1.25.3`; null — unrecognized. */
export function parseVersion(stderr: string): string | null {
  const m = stderr.match(/nginx version: nginx\/(\S+)/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Discovery (decision 2): native first, containers — best-effort
// ---------------------------------------------------------------------------

/** Native binary detection is cached per profile (like compose detection in docker.ts). */
const nativeCache = new Map<string, string | null>();

async function detectNativeNginx(profile: Profile): Promise<string | null> {
  if (nativeCache.has(profile.id)) return nativeCache.get(profile.id) ?? null;
  let bin: string | null = null;
  const which = await exec(profile, 'command -v nginx');
  if (which.code === 0 && which.stdout.trim()) {
    bin = which.stdout.trim().split('\n')[0];
  } else {
    const fallback = await exec(profile, 'test -x /usr/sbin/nginx && echo yes');
    if (fallback.code === 0 && fallback.stdout.trim() === 'yes') bin = '/usr/sbin/nginx';
  }
  nativeCache.set(profile.id, bin);
  return bin;
}

interface NginxContainer {
  id: string;
  name: string;
  image: string;
}

/**
 * Container matching: the image repository in the allow-list plus an `nginx`
 * substring in the image or container name (catches self-built `web-nginx`).
 * A known miss: a container with a completely foreign name/image is not
 * found — documented in the tab's empty state (decision 2).
 */
export function isNginxContainer(image: string, name: string): boolean {
  const repo = imageRepository(image);
  const img = image.toLowerCase();
  const nm = name.toLowerCase();
  return NGINX_IMAGE_REPOS.has(repo) || img.includes('nginx') || nm.includes('nginx');
}

/** docker unavailable → reject; discoverNginx catches it and continues with native. */
async function findNginxContainers(profile: Profile): Promise<NginxContainer[]> {
  const result = await dockerExec(profile, ['ps', '--format', '{{json .}}']);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || 'docker ps failed');
  }
  const containers = parseDockerJsonOutput(result.stdout);
  const out: NginxContainer[] = [];
  for (const c of containers) {
    const id = String(c.ID ?? c.Id ?? '');
    const name = String(c.Names ?? '').replace(/^\//, '');
    const image = String(c.Image ?? '');
    if (!id || !name) continue;
    if (isNginxContainer(image, name)) out.push({ id, name, image });
  }
  return out;
}

/**
 * Discovery: native (detection cached per profile) + containers
 * (kept in the snapshot cache — the container set may change).
 */
export async function discoverNginx(profile: Profile): Promise<NginxSourceRef[]> {
  const sources: NginxSourceRef[] = [];
  const nativeBin = await detectNativeNginx(profile);
  if (nativeBin) sources.push({ type: 'native', bin: nativeBin });
  try {
    for (const c of await findNginxContainers(profile)) {
      sources.push({ type: 'container', containerId: c.id, containerName: c.name });
    }
  } catch {
    // docker unavailable — container nginx is not searched for (best-effort, decision 2).
  }
  return sources;
}

// ---------------------------------------------------------------------------
// Certificates: batch read + a 10 min cache per (profile, source)
// ---------------------------------------------------------------------------

/** Reads PEMs by paths with a cache; only successfully read files get into the Map. */
async function readCerts(
  profile: Profile,
  source: NginxSourceRef,
  paths: string[],
): Promise<Map<string, string>> {
  if (paths.length === 0) return new Map();
  const cacheKey =
    source.type === 'native' ? `${profile.id}:native` : `${profile.id}:container:${source.containerId}`;
  const now = Date.now();
  let cache = certCache.get(cacheKey);
  if (!cache) {
    cache = new Map();
    certCache.set(cacheKey, cache);
  }
  const fresh = new Map<string, string>();
  const missing: string[] = [];
  for (const p of paths) {
    const hit = cache.get(p);
    if (hit && now - hit.at < CERT_CACHE_TTL_MS) fresh.set(p, hit.pem);
    else missing.push(p);
  }
  if (missing.length > 0) {
    const result = await runSource(profile, buildCertBatchCmd(source, missing));
    if (result.code === 0) {
      const parsed = parseCertBatch(result.stdout);
      for (const p of missing) {
        const pem = parsed.get(p);
        if (pem !== undefined) {
          fresh.set(p, pem);
          cache.set(p, { at: now, pem });
        }
      }
    }
    // The command failed as a whole — previously read paths are already in
    // fresh from the cache; unread ones are marked "unavailable" in the
    // collector.
  }
  return fresh;
}

// ---------------------------------------------------------------------------
// Snapshot: discovery → -T/-t/-v per source in parallel → certificates
// ---------------------------------------------------------------------------

function sourceBase(source: NginxSourceRef): NginxSourceSnapshot {
  return source.type === 'native'
    ? { type: 'native', version: null, configTest: { ok: false, output: '' }, sites: [] }
    : {
        type: 'container',
        containerId: source.containerId,
        containerName: source.containerName,
        version: null,
        configTest: { ok: false, output: '' },
        sites: [],
      };
}

async function collectSource(profile: Profile, source: NginxSourceRef): Promise<NginxSourceSnapshot> {
  const [dump, test, version] = await Promise.all([
    runSource(profile, buildDumpCmd(source), { maxOutput: DUMP_MAX_OUTPUT }),
    runSource(profile, buildTestCmd(source)),
    runSource(profile, buildVersionCmd(source)),
  ]);

  const snap = sourceBase(source);
  snap.configTest = { ok: test.code === 0, output: (test.stderr || test.stdout).trim() };
  snap.version = version.code === 0 ? parseVersion(version.stderr) : null;

  if (dump.code !== 0) {
    snap.error = `nginx -T: ${(dump.stderr || dump.stdout).trim() || `код ${dump.code}`}`;
    return snap;
  }
  // Truncation indicator at the output limit: exec silently cuts at
  // maxOutput — an honest error instead of a partial (and misleading) config.
  if (dump.stdout.length >= DUMP_MAX_OUTPUT) {
    snap.error = 'конфиг слишком большой (превышен лимит 8 МБ) — сайты не показаны';
    return snap;
  }

  const parsed = parseNginxDump(dump.stdout);
  const httpDefaults = { sslCertificate: parsed.httpSslCertificate };
  // Dedupe certificate paths before the batch (one certificate shared by many sites).
  const certPaths = [
    ...new Set(
      parsed.sites
        .map((b) => b.sslCertificate ?? parsed.httpSslCertificate)
        .filter((p): p is string => Boolean(p)),
    ),
  ];
  const certs = await readCerts(profile, source, certPaths);

  snap.sites = parsed.sites.map((block) => {
    const { certPath, ...site } = toSiteEntry(block, httpDefaults);
    if (certPath) {
      const pem = certs.get(certPath);
      if (pem === undefined) {
        site.cert = { path: certPath, error: 'файл не прочитан' };
      } else {
        const info = certInfoFromPem(pem);
        site.cert = info
          ? { path: certPath, notAfter: info.notAfter.toISOString(), daysLeft: info.daysLeft }
          : { path: certPath, error: 'не удалось разобрать PEM' };
      }
    }
    return site;
  });
  return snap;
}

async function collectNginxUncached(profile: Profile): Promise<NginxSnapshot> {
  const sources = await discoverNginx(profile);
  const sourceSnaps = await Promise.all(
    sources.map((s) =>
      collectSource(profile, s).catch((err) => {
        // The source failed on exec (timeout, SSH drop) — a section with an
        // error, the snapshot as a whole does not fail (decision 1,
        // allSettled semantics).
        const snap = sourceBase(s);
        snap.error = (err as Error).message;
        return snap;
      }),
    ),
  );
  return { timestamp: Date.now(), sources: sourceSnaps };
}

/**
 * Snapshot of the profile's nginx sites. A 2 s cache per profile (parallel
 * calls share the same execs) — like ports/metrics; a reject evicts the
 * entry from the cache. nginx not found anywhere → `{timestamp,
 * sources: []}` — the empty state is left to the UI, not a 404.
 */
export function getNginxSnapshot(profile: Profile): Promise<NginxSnapshot> {
  const now = Date.now();
  const hit = snapshotCache.get(profile.id);
  if (hit && now - hit.at < SNAPSHOT_CACHE_TTL_MS) {
    return hit.promise;
  }
  const promise = collectNginxUncached(profile);
  snapshotCache.set(profile.id, { at: now, promise });
  promise.catch(() => {
    if (snapshotCache.get(profile.id)?.promise === promise) {
      snapshotCache.delete(profile.id);
    }
  });
  return promise;
}

/** Clear the profile's caches when it is deleted (the clearHistory pattern in metrics-history). */
export function clearNginxCaches(profileId: string): void {
  snapshotCache.delete(profileId);
  nativeCache.delete(profileId);
  for (const key of certCache.keys()) {
    if (key.startsWith(`${profileId}:`)) certCache.delete(key);
  }
}

// ---------------------------------------------------------------------------
// nginx -t / reload with a guard (decision 4)
// ---------------------------------------------------------------------------

export interface NginxTestResult {
  ok: boolean;
  output: string;
}

/** `nginx -t`: output is read from stderr (nginx writes there), plus stdout. */
export async function testNginxConfig(
  profile: Profile,
  source: NginxSourceRef,
): Promise<NginxTestResult> {
  const r = await runSource(profile, buildTestCmd(source));
  return { ok: r.code === 0, output: (r.stderr || r.stdout).trim() };
}

/** Reload guard: a red `nginx -t` means no reload. */
export class NginxTestFailedError extends Error {
  readonly code = 'NGINX_TEST_FAILED';
  readonly output: string;

  constructor(output: string) {
    super('nginx -t не прошёл — перезагрузка отменена');
    this.name = 'NginxTestFailedError';
    this.output = output;
  }
}

/** Reload: `nginx -t` first; a red test → NginxTestFailedError (409 in the route). */
export async function reloadNginx(
  profile: Profile,
  source: NginxSourceRef,
): Promise<NginxTestResult> {
  const test = await testNginxConfig(profile, source);
  if (!test.ok) throw new NginxTestFailedError(test.output);
  const r = await runSource(profile, buildReloadCmd(source));
  return { ok: r.code === 0, output: (r.stderr || r.stdout).trim() };
}

/** Parse the source from the request body: 'native' | 'container:<id>'. */
export function parseSourceRef(raw: string): NginxSourceRef | null {
  if (raw === 'native') return { type: 'native', bin: '' };
  if (raw.startsWith('container:')) {
    const containerId = raw.slice('container:'.length);
    if (containerId) return { type: 'container', containerId, containerName: '' };
  }
  return null;
}

/**
 * Source validation against the actual discovery: an arbitrary container
 * cannot be addressed — only really discovered ones (decision 2). Returns
 * the real source (with bin/name) or null.
 */
export async function findSource(
  profile: Profile,
  raw: string,
): Promise<NginxSourceRef | null> {
  const ref = parseSourceRef(raw);
  if (!ref) return null;
  const sources = await discoverNginx(profile);
  return (
    sources.find((s) => {
      if (s.type === 'container' && ref.type === 'container') {
        return s.containerId === ref.containerId;
      }
      return s.type === 'native' && ref.type === 'native';
    }) ?? null
  );
}
