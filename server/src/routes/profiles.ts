import { Router } from 'express';
import { createProfile, deleteProfile, listProfiles, updateProfile } from '../profiles.js';
import { closeProfileConnection } from '../ssh/manager.js';

export const profilesRouter = Router();

profilesRouter.get('/', (_req, res) => {
  res.json(listProfiles());
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

