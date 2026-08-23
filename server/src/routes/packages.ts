import { Router } from 'express';
import { requireProfile } from '../profiles.js';
import { collectPackagesSnapshot } from '../services/packages.js';
import type { Profile } from '../types.js';

/**
 * Обновления пакетов (эпик 19).
 *
 * `GET /updates` — read-only снимок (кэш 60 с на сервере): менеджер,
 * список обновлений, признаки рестарта, возраст индекса apt. `pm: null` —
 * менеджера нет, штатная заглушка (не ошибка). Применение — отдельный
 * маршрут `POST /apply` (добавляется вместе с мутацией).
 */

export const packagesRouter = Router();

function profileFrom(req: { query: unknown }, res: import('express').Response): Profile | null {
  const profileId = String((req.query as Record<string, unknown>).profileId ?? '');
  try {
    return requireProfile(profileId);
  } catch {
    res.status(404).json({ error: `Profile ${profileId} not found` });
    return null;
  }
}

packagesRouter.get('/updates', async (req, res) => {
  const profile = profileFrom(req, res);
  if (!profile) return;
  try {
    res.json(await collectPackagesSnapshot(profile));
  } catch (err) {
    res.status(502).json({ error: `Сервер недоступен: ${(err as Error).message}` });
  }
});
