import { Router } from 'express';
import { requireProfile } from '../profiles.js';
import { collectPorts } from '../services/ports.js';

export const portsRouter = Router();

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
    res.json(await collectPorts(profile));
  } catch (err) {
    // SSH/команда не сработали — сервер недоступен; фронт показывает заглушку.
    res.status(502).json({ error: `Сервер недоступен: ${(err as Error).message}` });
  }
});
