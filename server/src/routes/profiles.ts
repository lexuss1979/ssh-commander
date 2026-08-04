import { Router } from 'express';
import { createProfile, deleteProfile, listProfiles, updateProfile } from '../profiles.js';
import { closeProfileConnection } from '../ssh/manager.js';

export const profilesRouter = Router();

profilesRouter.get('/', (_req, res) => {
  res.json(listProfiles());
});

/**
 * Closes the cached SSH connection for the profile. The next request
 * (terminal, SFTP, docker, agent) opens a fresh connection, so changes
 * applied at login time — e.g. new group memberships — take effect.
 */
profilesRouter.post('/:id/reconnect', (req, res) => {
  closeProfileConnection(req.params.id);
  res.json({ ok: true });
});

profilesRouter.post('/', (req, res) => {
  try {
    res.status(201).json(createProfile(req.body));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

profilesRouter.put('/:id', (req, res) => {
  try {
    closeProfileConnection(req.params.id);
    res.json(updateProfile(req.params.id, req.body));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

profilesRouter.delete('/:id', (req, res) => {
  try {
    closeProfileConnection(req.params.id);
    deleteProfile(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});
