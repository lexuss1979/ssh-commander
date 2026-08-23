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
 * Действия над процессами (эпик 17): `POST /api/processes/:pid/signal` и
 * `POST /api/processes/:pid/renice`. Порядок проверок — паттерн
 * routes/services.ts: profileId → 404, pid из URL → 400, zod-body → 400,
 * действие → статус ProcessActionError (400/502), прочее → 502.
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

/** Валидация pid из URL до всего остального (отказ → 400). */
function pidFrom(req: { params: Record<string, string> }, res: import('express').Response): number | null {
  const pid = parsePid(String(req.params.pid ?? ''));
  if (pid === null) {
    res.status(400).json({ error: 'Недопустимый pid' });
    return null;
  }
  return pid;
}

// Экспорт схем — под unit-тесты (валидация сигнала и nice).
export const signalSchema = z.object({
  signal: z.enum(PROCESS_SIGNALS),
  // Пароль не логируется, не сохраняется — только stdin для `sudo -S`
  // в пределах одного запроса.
  sudoPassword: z.string().max(1024).optional(),
});

export const reniceSchema = z.object({
  nice: z.number().int().min(NICE_MIN).max(NICE_MAX),
  sudoPassword: z.string().max(1024).optional(),
});

// Сигнал процессу: TERM | KILL | HUP
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
    // Мутация выполнилась — сброс кэша метрик, чтобы немедленный refetch
    // «Обзора» не вернул снимок с убитым процессом (кэш 2 с).
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

// Понижение приоритета процесса: nice −20..19
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
