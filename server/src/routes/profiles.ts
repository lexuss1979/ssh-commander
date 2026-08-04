import { Router } from 'express';
import { z } from 'zod';
import { createProfile, deleteProfile, listProfiles, parseProfileInput, updateProfile } from '../profiles.js';
import { closeProfileConnection, testConnection } from '../ssh/manager.js';

export const profilesRouter = Router();

profilesRouter.get('/', (_req, res) => {
  res.json(listProfiles());
});

/**
 * Checks connectivity with the given (possibly unsaved) profile fields:
 * opens a throwaway SSH connection and closes it. Never touches the
 * connection cache. 200 {ok, banner} on success, 400 with a readable
 * error otherwise.
 */
profilesRouter.post('/test-connection', async (req, res) => {
  try {
    const data = parseProfileInput(req.body);
    const banner = await testConnection({ ...data, id: 'probe' });
    res.json({ ok: true, banner });
  } catch (err) {
    const message =
      err instanceof z.ZodError
        ? err.issues.map((issue) => issue.message).join('; ')
        : (err as Error).message;
    res.status(400).json({ error: message });
  }
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
