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
 * Nginx tab (docs/nginx-plan.md): site snapshot, `nginx -t` and guarded
 * reload. The cron/ports pattern: GET returns a snapshot, POST mutations.
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
 * Validate source ('native' | 'container:<id>') against fresh discovery —
 * an arbitrary container cannot be addressed (decision 2).
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
 * Snapshot: `{timestamp, sources[]}`. No nginx found anywhere → sources: []
 * (200 — the empty state is for the UI to solve, not 404, decision 2). A
 * failed source becomes a section with error; the snapshot as a whole does
 * not fail.
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

// Read a single config file (the "Open" button): `{content}`.
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

/** `nginx -t` for a source: `{ok, output}` (the output is stderr + stdout). */nginxRouter.post('/test', async (req, res) => {
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
 * Guarded reload (decision 4): `nginx -t` is mandatory; a red test →
 * no reload, 409 with the test output. The signal to the master is `nginx -s
 * reload` (native) / `docker exec <id> nginx -s reload` (container) — no
 * systemctl, no sudo wrappers: an unprivileged user gets Permission denied
 * as is.
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
