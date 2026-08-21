import { Router } from 'express';
import { z } from 'zod';
import { getProfile, listProfiles, requireProfile } from '../profiles.js';
import {
  createDialogue,
  deleteDialogue,
  getDialogue,
  listDialogues,
} from '../ai/dialogues.js';
import { usageReport, usageTotalsByDialogue } from '../ai/usage.js';

export const aiRouter = Router();

aiRouter.get('/dialogues', (req, res) => {
  try {
    const profileId = String(req.query.profileId ?? '');
    if (!profileId) {
      res.status(400).json({ error: 'profileId is required' });
      return;
    }
    requireProfile(profileId);
    // Enrichment на уровне роута (docs/ai-costs-plan.md): сторы друг о друге
    // не знают. Диалог без записей usage — null.
    const totals = usageTotalsByDialogue();
    const dialogues = listDialogues(profileId).map((d) => ({
      ...d,
      usage: totals.get(d.id) ?? null,
    }));
    res.json({ dialogues });
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
  const totals = usageTotalsByDialogue();
  res.json({ dialogue: { ...dialogue, usage: totals.get(dialogue.id) ?? null } });
});

aiRouter.delete('/dialogues/:id', (req, res) => {
  try {
    deleteDialogue(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});

// Период отчёта: положительное число дней или 'all' (всё).
const daysSchema = z.union([z.literal('all'), z.coerce.number().int().min(1).max(3650)]);

/**
 * Отчёт по расходам AI: дни desc × профили + итоги. Имена профилей — join
 * с profiles.ts; удалённый профиль — `<id> (удалён)`.
 */
aiRouter.get('/usage', (req, res) => {
  const parsed = daysSchema.safeParse(req.query.days ?? '30');
  if (!parsed.success) {
    res.status(400).json({ error: 'days must be a positive integer or "all"' });
    return;
  }
  const report = usageReport(parsed.data);
  const profileIds = new Set<string>();
  for (const day of report.days) {
    for (const id of Object.keys(day.byProfile)) profileIds.add(id);
  }
  const profileNames = new Map(listProfiles().map((p) => [p.id, p.name]));
  const profiles = [...profileIds]
    .map((id) => ({ id, name: profileNames.get(id) ?? `${id} (удалён)` }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  res.json({ profiles, days: report.days, totals: report.totals });
});
