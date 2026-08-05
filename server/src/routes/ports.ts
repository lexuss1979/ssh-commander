import { Router } from 'express';
import { requireProfile } from '../profiles.js';
import { collectPorts, type PortListener } from '../services/ports.js';
import { collectContainerPorts, type ContainerPortEntry } from '../services/container-ports.js';

export const portsRouter = Router();

/**
 * Связывает хостовые слушатели с опубликованными портами контейнеров.
 * Совпадение по порту и протоколу: опубликованный hostPort контейнера
 * виден в ss как безымянный docker-proxy (без root имя процесса недоступно) —
 * аннотация закрывает эту дыру.
 */
export function annotateHostListeners(
  hostPorts: PortListener[],
  containers: ContainerPortEntry[],
): void {
  // Индекс: (proto, hostPort) → {id, name}
  const published = new Map<string, { id: string; name: string }>();
  for (const c of containers) {
    for (const b of c.ports) {
      if (b.hostPort !== null) {
        // Ключ: proto:hostPort (без hostIp — один порт не может быть
        // опубликован дважды на разных интерфейсах в рамках одного хоста).
        published.set(`${b.proto}:${b.hostPort}`, { id: c.containerId, name: c.name });
      }
    }
  }
  for (const p of hostPorts) {
    const match = published.get(`${p.proto}:${p.port}`);
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
