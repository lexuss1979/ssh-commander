import { listProfiles } from '../profiles.js';
import type { Profile } from '../types.js';
import { listContainers, type DockerEntity } from './docker.js';
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
  metrics?: ServerMetrics;
  docker?: DockerSummary;
}

export interface OverviewResponse {
  /** Момент снимка (мс, серверное время ssh-commander). */
  timestamp: number;
  servers: OverviewEntry[];
}

/** Результат опроса одного профиля до маппинга в ответ. */
export interface ProfileProbe {
  metrics: ServerMetrics;
  docker?: DockerSummary;
}

const PROFILE_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 4000;

/** Счётчики контейнеров по выводу `docker ps -a --format json`. */
export function countContainers(entities: DockerEntity[]): DockerSummary {
  const running = entities.filter(
    (e) => String(e.State ?? '').toLowerCase() === 'running',
  ).length;
  return { containersTotal: entities.length, containersRunning: running };
}

/**
 * Чистый маппинг результата опроса профиля (Promise.allSettled) в элемент
 * ответа /api/overview. Отказ профиля — ok:false с текстом ошибки, ответ
 * в целом не падает.
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
    metrics: result.value.metrics,
    ...(result.value.docker ? { docker: result.value.docker } : {}),
  };
}

async function probeProfile(profile: Profile): Promise<ProfileProbe> {
  const metrics = await collectMetrics(profile);
  // Docker необязателен: демон может быть не установлен — тогда счётчики
  // просто не включаем в ответ, метрики остаются.
  let docker: DockerSummary | undefined;
  try {
    docker = countContainers(await listContainers(profile));
  } catch {
    docker = undefined;
  }
  return { metrics, docker };
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

let cache: { at: number; promise: Promise<OverviewResponse> } | null = null;

/**
 * Сводный снимок по всем профилям. Профили опрашиваются параллельно
 * (Promise.allSettled), на профиль — общий guard-таймаут 8 с, чтобы один
 * мёртвый сервер не вешал весь ответ. Весь ответ кэшируется на 4 с
 * (параллельные запросы делят один опрос), а метрики внутри дополнительно
 * используют свой кэш 2 с.
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
