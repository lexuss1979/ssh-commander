import { Router } from 'express';
import { z } from 'zod';
import { requireProfile } from '../profiles.js';
import {
  createTunnel,
  deleteTunnel,
  listTunnels,
  getPortRange,
  type TunnelParams,
} from '../services/tunnels.js';

export const tunnelsRouter = Router();

const createSchema = z.object({
  localPort: z.number().int().min(0).max(65535),
  targetHost: z.string().min(1).max(253),
  targetPort: z.number().int().min(1).max(65535),
});

tunnelsRouter.get('/', (req, res) => {
  const profileId = String(req.query.profileId ?? '');
  let profile;
  try {
    profile = requireProfile(profileId);
  } catch {
    res.status(404).json({ error: `Profile ${profileId} not found` });
    return;
  }

  const allTunnels = listTunnels();
  const profileTunnels = allTunnels.filter((t) => t.profileId === profile.id);

  res.json({
    tunnels: profileTunnels,
    portRange: getPortRange(),
  });
});

tunnelsRouter.post('/', async (req, res) => {
  const profileId = String(req.query.profileId ?? '');
  let profile;
  try {
    profile = requireProfile(profileId);
  } catch {
    res.status(404).json({ error: `Profile ${profileId} not found` });
    return;
  }

  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.errors.map((e) => e.message).join(', ') });
    return;
  }

  const params: TunnelParams = {
    profileId: profile.id,
    localPort: parsed.data.localPort,
    targetHost: parsed.data.targetHost,
    targetPort: parsed.data.targetPort,
  };

  try {
    const tunnel = await createTunnel(profile, params);
    res.status(201).json(tunnel);
  } catch (err) {
    const e = err as Error & { code?: string };
    const msg = e.message;
    // 409 для конфликтов: занятый порт (EADDRINUSE), дубликат, лимит.
    if (e.code === 'EADDRINUSE' || msg.includes('уже существует') || msg.includes('лимит')) {
      res.status(409).json({ error: msg });
    } else if (msg.includes('Недопустимый') || msg.includes('вне диапазона')) {
      res.status(400).json({ error: msg });
    } else {
      res.status(500).json({ error: msg });
    }
  }
});

tunnelsRouter.delete('/:id', async (req, res) => {
  const id = String(req.params.id);
  const tunnel = listTunnels().find((t) => t.id === id);
  if (!tunnel) {
    res.status(404).json({ error: `Tunnel ${id} not found` });
    return;
  }

  await deleteTunnel(id);
  res.json({ ok: true });
});
