import { Router } from 'express';
import { requireProfile } from '../profiles.js';
import { collectPorts, type PortListener } from '../services/ports.js';
import { collectContainerPorts, type ContainerPortEntry } from '../services/container-ports.js';

export const portsRouter = Router();

/**
 * Связывает хостовые слушатели с опубликованными портами контейнеров.
 * Совпадение по порту, протоколу и hostIp: контейнер может слушать
 * 192.168.1.5:3000, а хостовый процесс — 127.0.0.1:3000, конфликта нет.
 * 0.0.0.0/:: в контейнерном биндинге матчится с любым хостовым адресом.
 */
export function annotateHostListeners(
  hostPorts: PortListener[],
  containers: ContainerPortEntry[],
): void {
  // Индекс: (proto, hostPort, hostIp) → {id, name}. 0.0.0.0/:: → wildcard.
  const published = new Map<string, { id: string; name: string }>();
  for (const c of containers) {
    for (const b of c.ports) {
      if (b.hostPort !== null) {
        const ip = b.hostIp ?? '0.0.0.0';
        // Ключ: proto:hostPort:hostIp (для 0.0.0.0/:: — wildcard, матчит любой адрес).
        published.set(`${b.proto}:${b.hostPort}:${ip}`, { id: c.containerId, name: c.name });
      }
    }
  }
  for (const p of hostPorts) {
    // Пробуем точный матч по hostIp, затем wildcard.
    const hostIp = p.host === '0.0.0.0' || p.host === '::' ? p.host : p.host;
    const match = published.get(`${p.proto}:${p.port}:${hostIp}`)
      ?? published.get(`${p.proto}:${p.port}:0.0.0.0`)
      ?? published.get(`${p.proto}:${p.port}:::`);
    if (match) {
      p.container = match;
    }
  }
}

portsRouter.get('/', async (req, res) => {
  const profileId = String(req.query.profileId ?? '');
  let profile;
  try {
    profile = requireProfile(profileId);
  } catch {
    res.status(404).json({ error: `Profile ${profileId} not found` });
    return;
  }
  try {
    // Хостовые и контейнерные порты собираются параллельно; docker недоступен
    // → поля containers просто нет (деградация как у docker-счётчиков overview).
    const [hostSnapshot, containers] = await Promise.all([
      collectPorts(profile),
      collectContainerPorts(profile).catch(() => null),
    ]);

    if (containers) {
      annotateHostListeners(hostSnapshot.ports, containers);
    }

    res.json({
      timestamp: hostSnapshot.timestamp,
      ports: hostSnapshot.ports,
      ...(containers ? { containers } : {}),
    });
  } catch (err) {
    // SSH/команда не сработали — сервер недоступен; фронт показывает заглушку.
    res.status(502).json({ error: `Сервер недоступен: ${(err as Error).message}` });
  }
});
