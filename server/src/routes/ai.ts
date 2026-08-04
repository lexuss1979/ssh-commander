import { Router } from 'express';
import { requireProfile } from '../profiles.js';
import {
  createDialogue,
  deleteDialogue,
  getDialogue,
  listDialogues,
} from '../ai/dialogues.js';

export const aiRouter = Router();

aiRouter.get('/dialogues', (req, res) => {
  try {
    const profileId = String(req.query.profileId ?? '');
    if (!profileId) {
      res.status(400).json({ error: 'profileId is required' });
      return;
    }
    requireProfile(profileId);
    res.json({ dialogues: listDialogues(profileId) });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

aiRouter.post('/dialogues', (req, res) => {
  try {
    const profileId = String(req.body?.profileId ?? '');
    if (!profileId) {
      res.status(400).json({ error: 'profileId is required' });
      return;
    }
    requireProfile(profileId);
    res.json({ dialogue: createDialogue(profileId) });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

aiRouter.get('/dialogues/:id', (req, res) => {
  const dialogue = getDialogue(req.params.id);
  if (!dialogue) {
    res.status(404).json({ error: 'Dialogue not found' });
    return;
  }
  res.json({ dialogue });
});

aiRouter.delete('/dialogues/:id', (req, res) => {
  try {
    deleteDialogue(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});
