import type { Profile } from '../types.js';
import { dockerExec, parseDockerJsonOutput, type DockerEntity } from './docker.js';

export interface ContainerPortBinding {
  containerPort: number;
  proto: 'tcp' | 'udp';
  /** null — порт не опубликован наружу (только сеть контейнера). */
  hostIp: string | null;
  hostPort: number | null;
}

export interface ContainerPortEntry {
  containerId: string;
  name: string;
  /** HostConfig.NetworkMode: bridge, host, none, custom network name. */
  networkMode: string;
  /** IP-адрес контейнера в основной сети (null для host-network). */
  ip: string | null;
  ports: ContainerPortBinding[];
}

/**
 * Извлекает runtime-биндинги портов из `NetworkSettings.Ports` inspect'а.
 * Формат: `{ "80/tcp": [{"HostIp": "0.0.0.0", "HostPort": "8080"}], "5432/tcp": null }`.
 * null-значение — порт exposed, но не опубликован.
 */
export function parseInspectPorts(entity: DockerEntity): ContainerPortBinding[] {
  const portsObj = (entity.NetworkSettings as DockerEntity | undefined)?.Ports as
    Record<string, DockerEntity[] | null> | undefined;
  if (!portsObj || typeof portsObj !== 'object') return [];

  const bindings: ContainerPortBinding[] = [];
  for (const [key, bindings_] of Object.entries(portsObj)) {
    const m = key.match(/^(\d+)\/(tcp|udp)$/);
    if (!m) continue;
    const containerPort = Number(m[1]);
    const proto = m[2] as 'tcp' | 'udp';

    if (!Array.isArray(bindings_)) {
      // Exposed but not published.
      bindings.push({ containerPort, proto, hostIp: null, hostPort: null });
      continue;
    }
    for (const b of bindings_) {
      const hostIp = (b.HostIp as string) || null;
      const hostPortStr = b.HostPort as string;
      const hostPort = hostPortStr ? Number(hostPortStr) : null;
      bindings.push({ containerPort, proto, hostIp, hostPort });
    }
  }
  bindings.sort((a, b) => a.containerPort - b.containerPort || a.proto.localeCompare(b.proto));
  return bindings;
}

/** IP-адрес контейнера из основной сети (первая запись в Networks). */
function extractIp(entity: DockerEntity): string | null {
  const networks = (entity.NetworkSettings as DockerEntity | undefined)?.Networks as
    Record<string, DockerEntity> | undefined;
  if (!networks || typeof networks !== 'object') return null;
  for (const net of Object.values(networks)) {
    const ip = net.IPAddress as string;
    if (ip) return ip;
  }
  return null;
}

/**
 * Маппинг inspect-объекта в `ContainerPortEntry`. Чистая функция — удобна
 * для тестирования без моков SSH.
 */
export function toContainerPortEntry(entity: DockerEntity): ContainerPortEntry {
  const networkMode = ((entity.HostConfig as DockerEntity | undefined)?.NetworkMode as string) || 'bridge';
  return {
    containerId: (entity.Id as string) || '',
    name: ((entity.Name as string) || '').replace(/^\//, ''),
    networkMode,
    ip: networkMode === 'host' ? null : extractIp(entity),
    ports: parseInspectPorts(entity),
  };
}

const CACHE_TTL_MS = 2000;
const cache = new Map<string, { at: number; promise: Promise<ContainerPortEntry[]> }>();

/**
 * Список портов запущенных контейнеров. Два exec'а: `docker ps` (id-шки
 * running-контейнеров) + батч-`docker inspect` по всем id разом. Кэш 2 с
 * на профиль (параллельные вызовы делят один exec). Docker недоступен →
 * промис.reject'ится, вызывающий код решает, деградировать или нет.
 */
export function collectContainerPorts(profile: Profile): Promise<ContainerPortEntry[]> {
  const now = Date.now();
  const hit = cache.get(profile.id);
  if (hit && now - hit.at < CACHE_TTL_MS) {
    return hit.promise;
  }
  const promise = fetchContainerPorts(profile);
  cache.set(profile.id, { at: now, promise });
  promise.catch(() => {
    if (cache.get(profile.id)?.promise === promise) {
      cache.delete(profile.id);
    }
  });
  return promise;
}

async function fetchContainerPorts(profile: Profile): Promise<ContainerPortEntry[]> {
  const psResult = await dockerExec(profile, ['ps', '--format', '{{json .}}']);
  if (psResult.code !== 0) {
    throw new Error(psResult.stderr.trim() || 'docker ps failed');
  }
  const containers = parseDockerJsonOutput(psResult.stdout);
  if (containers.length === 0) return [];

  const ids = containers.map((c) => String(c.ID ?? c.Id ?? '')).filter(Boolean);
  if (ids.length === 0) return [];

  const inspectResult = await dockerExec(profile, ['inspect', ...ids]);
  if (inspectResult.code !== 0) {
    throw new Error(inspectResult.stderr.trim() || 'docker inspect failed');
  }
  const inspected = parseDockerJsonOutput(inspectResult.stdout);
  return inspected.map(toContainerPortEntry);
}
