import { listProfiles } from '../profiles.js';
import type { Profile } from '../types.js';
import { withTimeout } from '../util/async.js';
import { listContainers, type DockerEntity } from './docker.js';
import { getExternalIp } from './external-ip.js';
import { collectMetrics, type ServerMetrics } from './metrics.js';

export interface DockerSummary {
  containersTotal: number;
  containersRunning: number;
}

export interface OverviewEntry {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  ok: boolean;
  error?: string;
  /** The server's external (public) IP; absent if it could not be determined. */
  externalIp?: string;
  metrics?: ServerMetrics;
  docker?: DockerSummary;
}

export interface OverviewResponse {
  /** Snapshot time (ms, ssh-commander server clock). */
  timestamp: number;
  servers: OverviewEntry[];
}

/** Probe result of one profile before mapping into the response. */
export interface ProfileProbe {
  metrics: ServerMetrics;
  externalIp?: string;
  docker?: DockerSummary;
}

const PROFILE_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 4000;

/** Container counters from the `docker ps -a --format json` output. */
export function countContainers(entities: DockerEntity[]): DockerSummary {
  const running = entities.filter(
    (e) => String(e.State ?? '').toLowerCase() === 'running',
  ).length;
  return { containersTotal: entities.length, containersRunning: running };
}

/**
 * Pure mapping of a profile probe result (Promise.allSettled) into an
 * /api/overview entry. A failed profile becomes ok:false with the error
 * text; the response as a whole does not fail.
 */
export function toOverviewEntry(
  profile: Profile,
  result: PromiseSettledResult<ProfileProbe>,
): OverviewEntry {
  const base = {
    id: profile.id,
    name: profile.name,
    host: profile.host,
    port: profile.port,
    username: profile.username,
  };
  if (result.status === 'rejected') {
    const reason = result.reason;
    return {
      ...base,
      ok: false,
      error: reason instanceof Error ? reason.message : String(reason),
    };
  }
  return {
    ...base,
    ok: true,
    ...(result.value.externalIp ? { externalIp: result.value.externalIp } : {}),
    metrics: result.value.metrics,
    ...(result.value.docker ? { docker: result.value.docker } : {}),
  };
}

async function probeProfile(profile: Profile): Promise<ProfileProbe> {
  // The external IP is probed in parallel with metrics and caches itself.
  const [metrics, externalIp] = await Promise.all([
    collectMetrics(profile),
    getExternalIp(profile),
  ]);
  // Docker is optional: the daemon may not be installed — then the counters
  // are simply left out of the response, metrics remain.
  let docker: DockerSummary | undefined;
  try {
    docker = countContainers(await listContainers(profile));
  } catch {
    docker = undefined;
  }
  return { metrics, externalIp: externalIp ?? undefined, docker };
}

let cache: { at: number; promise: Promise<OverviewResponse> } | null = null;

/**
 * Summary snapshot across all profiles. Profiles are probed in parallel
 * (Promise.allSettled) with a shared guard timeout of 8 s per profile, so
 * that one dead server does not hang the whole response. The whole
 * response is cached for 4 s (parallel requests share one poll), and the
 * metrics inside additionally use their own 2 s cache.
 */
export function collectOverview(): Promise<OverviewResponse> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) {
    return cache.promise;
  }
  const promise = buildOverview();
  cache = { at: now, promise };
  promise.catch(() => {
    if (cache?.promise === promise) {
      cache = null;
    }
  });
  return promise;
}

async function buildOverview(): Promise<OverviewResponse> {
  const profiles = listProfiles();
  const results = await Promise.allSettled(
    profiles.map((p) =>
      withTimeout(
        probeProfile(p),
        PROFILE_TIMEOUT_MS,
        `Превышено время ожидания (${PROFILE_TIMEOUT_MS / 1000} с)`,
      ),
    ),
  );
  return {
    timestamp: Date.now(),
    servers: profiles.map((p, i) => toOverviewEntry(p, results[i])),
  };
}
