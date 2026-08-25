import { Router } from 'express';
import { z } from 'zod';
import { requireProfile } from '../profiles.js';
import {
  findSource,
  getNginxSnapshot,
  NginxTestFailedError,
  readNginxConfig,
  reloadNginx,
  testNginxConfig,
} from '../services/nginx.js';
import type { NginxSourceRef, Profile } from '../types.js';

/**
 * Вкладка «Nginx» (docs/nginx-plan.md): снапшот сайтов, `nginx -t` и
 * reload с guard'ом. Паттерн cron/ports: GET со снапшотом, POST-мутации.
 */
export const nginxRouter = Router();

const sourceSchema = z.string().min(1).max(300);

function profileFromQuery(req: { query: unknown }, res: import('express').Response): Profile | null {
  const profileId = String((req.query as Record<string, unknown>).profileId ?? '');
  try {
    return requireProfile(profileId);
  } catch {
    res.status(404).json({ error: `Profile ${profileId} not found` });
    return null;
  }
}

/**
 * Валидация source ('native' | 'container:<id>') против актуального
 * discovery — нельзя адресовать произвольный контейнер (решение 2).
 */
async function sourceFromBody(
  profile: Profile,
  raw: string,
  res: import('express').Response,
): Promise<NginxSourceRef | null> {
  const source = await findSource(profile, raw);
  if (!source) {
    res.status(400).json({
      error: 'Источник nginx не найден: nginx не обнаружен или контейнер изменился (обновите страницу)',
    });
    return null;
  }
  return source;
}

function sendExecError(res: import('express').Response, err: unknown): void {
  res.status(502).json({ error: `Сервер недоступен: ${(err as Error).message}` });
}

/**
 * Снапшот: `{timestamp, sources[]}`. nginx не найден нигде → sources: []
 * (200 — пустое состояние решает UI, не 404, решение 2). Упавший источник —
 * секция с error, снапшот в целом не падает.
 */
nginxRouter.get('/', async (req, res) => {
  const profile = profileFromQuery(req, res);
  if (!profile) return;
  try {
    res.json(await getNginxSnapshot(profile));
  } catch (err) {
    sendExecError(res, err);
  }
});

// Чтение одного конфиг-файла (кнопка «Открыть»): `{content}`.
nginxRouter.get('/config', async (req, res) => {
  const profile = profileFromQuery(req, res);
  if (!profile) return;
  const q = req.query as Record<string, unknown>;
  const rawSource = String(q.source ?? '');
  const rawPath = String(q.path ?? '');
  if (!rawPath.startsWith('/') || rawPath.includes('\n')) {
    res.status(400).json({ error: 'Некорректный путь к конфигу' });
    return;
  }
  try {
    const source = await sourceFromBody(profile, rawSource, res);
    if (!source) return;
    res.json(await readNginxConfig(profile, source, rawPath));
  } catch (err) {
    sendExecError(res, err);
  }
});

/** `nginx -t` по источнику: `{ok, output}` (вывод — stderr + stdout). */nginxRouter.post('/test', async (req, res) => {
  const profile = profileFromQuery(req, res);
  if (!profile) return;
  const parsed = sourceSchema.safeParse((req.body as Record<string, unknown> | undefined)?.source);
  if (!parsed.success) {
    res.status(400).json({ error: 'Укажите source: "native" или "container:<id>"' });
    return;
  }
  try {
    const source = await sourceFromBody(profile, parsed.data, res);
    if (!source) return;
    res.json(await testNginxConfig(profile, source));
  } catch (err) {
    sendExecError(res, err);
  }
});

/**
 * Reload с guard'ом (решение 4): `nginx -t` обязателен; тест красный →
 * reload не выполняется, 409 с выводом теста. Сигнал мастеру `nginx -s
 * reload` (native) / `docker exec <id> nginx -s reload` (контейнер) — без
 * systemctl и без sudo-обёрток: непривилегированный пользователь получит
 * Permission denied как есть.
 */
nginxRouter.post('/reload', async (req, res) => {
  const profile = profileFromQuery(req, res);
  if (!profile) return;
  const parsed = sourceSchema.safeParse((req.body as Record<string, unknown> | undefined)?.source);
  if (!parsed.success) {
    res.status(400).json({ error: 'Укажите source: "native" или "container:<id>"' });
    return;
  }
  try {
    const source = await sourceFromBody(profile, parsed.data, res);
    if (!source) return;
    res.json(await reloadNginx(profile, source));
  } catch (err) {
    if (err instanceof NginxTestFailedError) {
      res.status(409).json({ error: err.message, output: err.output });
      return;
    }
    sendExecError(res, err);
  }
});
