import { Router } from 'express';
import { requireProfile } from '../profiles.js';
import { collectPorts, type PortListener } from '../services/ports.js';
import { collectContainerPorts, type ContainerPortEntry } from '../services/container-ports.js';

export const portsRouter = Router();

/**
 * Links host listeners to published container ports. Matching is by port,
 * protocol and hostIp: a container can listen on 192.168.1.5:3000 while a
 * host process listens on 127.0.0.1:3000 — no conflict. 0.0.0.0/:: in a
 * container binding matches any host address.
 */
export function annotateHostListeners(
  hostPorts: PortListener[],
  containers: ContainerPortEntry[],
): void {
  // Index: (proto, hostPort, hostIp) → {id, name}. 0.0.0.0/:: → wildcard.
  const published = new Map<string, { id: string; name: string }>();
  for (const c of containers) {
    for (const b of c.ports) {
      if (b.hostPort !== null) {
        const ip = b.hostIp ?? '0.0.0.0';
        // Key: proto:hostPort:hostIp (0.0.0.0/:: is a wildcard matching any address).
        published.set(`${b.proto}:${b.hostPort}:${ip}`, { id: c.containerId, name: c.name });
      }
    }
  }
  for (const p of hostPorts) {
    // Try an exact hostIp match first, then the wildcard.
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
    // Host and container ports are collected in parallel; docker unavailable
    // → the containers field is simply absent (same degradation as the
    // overview docker counters).
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
    // SSH/command failed — the server is unreachable; the frontend shows a stub.
    res.status(502).json({ error: `Сервер недоступен: ${(err as Error).message}` });
  }
});
