import { Router } from 'express';
import { z } from 'zod';
import { requireProfile } from '../profiles.js';
import {
  collectCron,
  fetchCronUsers,
  isValidCronUser,
  mutateUserCrontab,
  validateCronFields,
  CronConflictError,
  type CronOp,
} from '../services/cron.js';
import type { Profile } from '../types.js';

export const cronRouter = Router();

function profileFrom(req: { query: unknown }, res: import('express').Response): Profile | null {
  const profileId = String((req.query as Record<string, unknown>).profileId ?? '');
  try {
    return requireProfile(profileId);
  } catch {
    res.status(404).json({ error: `Profile ${profileId} not found` });
    return null;
  }
}

function sendOpError(res: import('express').Response, err: unknown): void {
  const e = err as Error & { code?: string };
  if (e instanceof CronConflictError || e.code === 'CONFLICT') {
    res.status(409).json({ error: e.message });
  } else if (e.message.includes('crontab отклонил')) {
    res.status(400).json({ error: e.message });
  } else {
    res.status(502).json({ error: `Сервер недоступен: ${e.message}` });
  }
}

const scheduleSchema = z.string().min(1).max(100);
const commandSchema = z.string().min(1).max(1000);
const expectedRawSchema = z.string().max(2000);

const addSchema = z.object({ schedule: scheduleSchema, command: commandSchema });
const updateSchema = z.object({
  expectedRaw: expectedRawSchema,
  schedule: scheduleSchema,
  command: commandSchema,
});
const rawOnlySchema = z.object({ expectedRaw: expectedRawSchema });

function parseIndex(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function checkSchedule(schedule: string, res: import('express').Response): boolean {
  const err = validateCronFields(schedule);
  if (err) {
    res.status(400).json({ error: err });
    return false;
  }
  return true;
}

cronRouter.get('/', async (req, res) => {
  const profile = profileFrom(req, res);
  if (!profile) return;
  const rawUser = String((req.query as Record<string, unknown>).user ?? '');
  const user = rawUser || undefined;
  if (user && !isValidCronUser(user)) {
    res.status(400).json({ error: 'Некорректное имя пользователя' });
    return;
  }
  try {
    res.json(await collectCron(profile, user));
  } catch (err) {
    res.status(502).json({ error: `Сервер недоступен: ${(err as Error).message}` });
  }
});

// Список пользователей для селектора (пусто, если чтение чужих crontab невозможно).
cronRouter.get('/users', async (req, res) => {
  const profile = profileFrom(req, res);
  if (!profile) return;
  try {
    res.json({ users: await fetchCronUsers(profile) });
  } catch (err) {
    res.status(502).json({ error: `Сервер недоступен: ${(err as Error).message}` });
  }
});

cronRouter.post('/entries', async (req, res) => {
  const profile = profileFrom(req, res);
  if (!profile) return;
  const parsed = addSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Нужны непустые schedule и command' });
    return;
  }
  if (!checkSchedule(parsed.data.schedule, res)) return;
  const op: CronOp = { type: 'add', schedule: parsed.data.schedule, command: parsed.data.command };
  try {
    await mutateUserCrontab(profile, op);
    res.status(201).json(await collectCron(profile));
  } catch (err) {
    sendOpError(res, err);
  }
});

cronRouter.put('/entries/:index', async (req, res) => {
  const profile = profileFrom(req, res);
  if (!profile) return;
  const index = parseIndex(String(req.params.index));
  const parsed = updateSchema.safeParse(req.body);
  if (index === null || !parsed.success) {
    res.status(400).json({ error: 'Нужны index, expectedRaw и непустые schedule и command' });
    return;
  }
  if (!checkSchedule(parsed.data.schedule, res)) return;
  const op: CronOp = { type: 'update', index, ...parsed.data };
  try {
    await mutateUserCrontab(profile, op);
    res.json(await collectCron(profile));
  } catch (err) {
    sendOpError(res, err);
  }
});

cronRouter.delete('/entries/:index', async (req, res) => {
  const profile = profileFrom(req, res);
  if (!profile) return;
  const index = parseIndex(String(req.params.index));
  const parsed = rawOnlySchema.safeParse(req.body);
  if (index === null || !parsed.success) {
    res.status(400).json({ error: 'Нужны index и expectedRaw' });
    return;
  }
  try {
    await mutateUserCrontab(profile, { type: 'delete', index, expectedRaw: parsed.data.expectedRaw });
    res.json(await collectCron(profile));
  } catch (err) {
    sendOpError(res, err);
  }
});

cronRouter.post('/entries/:index/toggle', async (req, res) => {
  const profile = profileFrom(req, res);
  if (!profile) return;
  const index = parseIndex(String(req.params.index));
  const parsed = rawOnlySchema.safeParse(req.body);
  if (index === null || !parsed.success) {
    res.status(400).json({ error: 'Нужны index и expectedRaw' });
    return;
  }
  try {
    await mutateUserCrontab(profile, { type: 'toggle', index, expectedRaw: parsed.data.expectedRaw });
    res.json(await collectCron(profile));
  } catch (err) {
    sendOpError(res, err);
  }
});
