import { Router, type Response } from 'express';
import { z } from 'zod';
import { requireProfile } from '../profiles.js';
import {
  DiskUsageError,
  DU_DEFAULT_LIMIT,
  DU_MAX_LIMIT,
  assertNavigablePath,
  diskUsageSnapshot,
  normalizeDiskPath,
  topFiles,
} from '../services/disk-usage.js';
import type { Profile } from '../types.js';

/**
 * "What ate the disk" (epic 16): drilling into directories with du + the top
 * largest files. All read-only; errors: 404 — no profile, 400 — user-facing
 * causes (path, permissions, missing utilities), 502 — transport only
 * (SSH unreachable) — the same split as routes/metrics.ts.
 */
export const diskUsageRouter = Router();

const snapshotQuerySchema = z.object({
  profileId: z.string().min(1, 'Укажите профиль'),
  path: z.string().min(1).default('/'),
});

const filesQuerySchema = z.object({
  profileId: z.string().min(1, 'Укажите профиль'),
  path: z.string().min(1).default('/'),
  limit: z.coerce.number().int().min(1).max(DU_MAX_LIMIT).default(DU_DEFAULT_LIMIT),
});

function findProfileOr404(profileId: string, res: Response): Profile | null {
  try {
    return requireProfile(profileId);
  } catch {
    res.status(404).json({ error: `Profile ${profileId} not found` });
    return null;
  }
}

diskUsageRouter.get('/', async (req, res) => {
  const parsed = snapshotQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Некорректные параметры' });
    return;
  }
  const q = parsed.data;
  const profile = findProfileOr404(q.profileId, res);
  if (!profile) return;
  try {
    const path = assertNavigablePath(normalizeDiskPath(q.path));
    const snapshot = await diskUsageSnapshot(profile, path);
    res.json({
      timestamp: Date.now(),
      path: snapshot.path,
      totalBytes: snapshot.totalBytes,
      directBytes: snapshot.directBytes,
      children: snapshot.children,
      incomplete: snapshot.incomplete ?? undefined,
      truncated: snapshot.truncated || undefined,
    });
  } catch (err) {
    if (err instanceof DiskUsageError) {
      res.status(400).json({ error: err.message });
    } else {
      res.status(502).json({ error: `Сервер недоступен: ${(err as Error).message}` });
    }
  }
});

diskUsageRouter.get('/files', async (req, res) => {
  const parsed = filesQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Некорректные параметры' });
    return;
  }
  const q = parsed.data;
  const profile = findProfileOr404(q.profileId, res);
  if (!profile) return;
  try {
    const path = assertNavigablePath(normalizeDiskPath(q.path));
    const result = await topFiles(profile, path, q.limit);
    res.json({
      timestamp: Date.now(),
      path: result.path,
      files: result.files,
      incomplete: result.incomplete ?? undefined,
      truncated: result.files.length === q.limit,
    });
  } catch (err) {
    if (err instanceof DiskUsageError) {
      res.status(400).json({ error: err.message });
    } else {
      res.status(502).json({ error: `Сервер недоступен: ${(err as Error).message}` });
    }
  }
});
