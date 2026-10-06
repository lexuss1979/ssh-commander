import { Router } from 'express';
import { z } from 'zod';
import { requireProfile } from '../profiles.js';
import { invalidateMetricsCache } from '../services/metrics.js';
import {
  NICE_MAX,
  NICE_MIN,
  PROCESS_SIGNALS,
  ProcessActionError,
  parsePid,
  runProcessRenice,
  runProcessSignal,
} from '../services/processes.js';
import type { Profile } from '../types.js';

/**
 * Process actions (epic 17): `POST /api/processes/:pid/signal` and
 * `POST /api/processes/:pid/renice`. The check order follows the
 * routes/services.ts pattern: profileId → 404, pid from URL → 400, zod body
 * → 400, action → ProcessActionError status (400/502), everything else → 502.
 */
export const processesRouter = Router();

function profileFrom(req: { query: unknown }, res: import('express').Response): Profile | null {
  const profileId = String((req.query as Record<string, unknown>).profileId ?? '');
  try {
    return requireProfile(profileId);
  } catch {
    res.status(404).json({ error: `Profile ${profileId} not found` });
    return null;
  }
}

/** Validate the pid from the URL before anything else (failure → 400). */
function pidFrom(req: { params: Record<string, string> }, res: import('express').Response): number | null {
  const pid = parsePid(String(req.params.pid ?? ''));
  if (pid === null) {
    res.status(400).json({ error: 'Недопустимый pid' });
    return null;
  }
  return pid;
}

// Schemas exported for unit tests (signal and nice validation).
export const signalSchema = z.object({
  signal: z.enum(PROCESS_SIGNALS),
  // The password is not logged, not persisted — only stdin for `sudo -S`,
  // for the duration of a single request.
  sudoPassword: z.string().max(1024).optional(),
});

export const reniceSchema = z.object({
  nice: z.number().int().min(NICE_MIN).max(NICE_MAX),
  sudoPassword: z.string().max(1024).optional(),
});

// Signal a process: TERM | KILL | HUP
processesRouter.post('/:pid/signal', async (req, res) => {
  const profile = profileFrom(req, res);
  if (!profile) return;
  const pid = pidFrom(req, res);
  if (pid === null) return;
  const parsed = signalSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Недопустимый сигнал' });
    return;
  }
  try {
    const result = await runProcessSignal(
      profile,
      pid,
      parsed.data.signal,
      parsed.data.sudoPassword,
    );
    // The mutation has been applied — invalidate the metrics cache so an
    // immediate overview refetch does not get a snapshot with the killed
    // process (2 s cache).
    invalidateMetricsCache(profile.id);
    res.json(result);
  } catch (err) {
    if (err instanceof ProcessActionError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    res.status(502).json({ error: `Сервер недоступен: ${(err as Error).message}` });
  }
});

// Lower the process priority: nice −20..19
processesRouter.post('/:pid/renice', async (req, res) => {
  const profile = profileFrom(req, res);
  if (!profile) return;
  const pid = pidFrom(req, res);
  if (pid === null) return;
  const parsed = reniceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Недопустимое значение nice' });
    return;
  }
  try {
    const result = await runProcessRenice(
      profile,
      pid,
      parsed.data.nice,
      parsed.data.sudoPassword,
    );
    invalidateMetricsCache(profile.id);
    res.json(result);
  } catch (err) {
    if (err instanceof ProcessActionError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    res.status(502).json({ error: `Сервер недоступен: ${(err as Error).message}` });
  }
});
