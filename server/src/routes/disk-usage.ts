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
 * «Что съело диск» (эпик 16): проваливание по каталогам через du + топ
 * крупнейших файлов. Всё read-only, ошибки: 404 — нет профиля, 400 —
 * пользовательские причины (путь, права, утилиты), 502 — только транспорт
 * (SSH недоступен) — разделение как в routes/metrics.ts.
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
