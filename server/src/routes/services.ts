import { Router } from 'express';
import { z } from 'zod';
import { requireProfile } from '../profiles.js';
import { execStream } from '../ssh/manager.js';
import { createChunkGate } from '../services/chunk-gate.js';
import { acquireFollowSlot, releaseFollowSlot } from '../services/stream-limits.js';
import {
  SERVICE_ACTIONS,
  ServiceActionError,
  assertValidUnitName,
  clampTail,
  collectServices,
  getServiceDetail,
  invalidateServicesCache,
  journalctlCommand,
  readServiceLogs,
  runServiceAction,
  type ServiceAction,
} from '../services/systemd.js';
import type { Profile } from '../types.js';

export const servicesRouter = Router();

function profileFrom(req: { query: unknown }, res: import('express').Response): Profile | null {
  const profileId = String((req.query as Record<string, unknown>).profileId ?? '');
  try {
    return requireProfile(profileId);
  } catch {
    res.status(404).json({ error: `Profile ${profileId} not found` });
    return null;
  }
}

/** Validate the unit name from the URL before anything else (failure → 400). */
function unitFrom(req: { params: Record<string, string> }, res: import('express').Response): string | null {
  const unit = String(req.params.unit ?? '');
  try {
    return assertValidUnitName(unit);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return null;
  }
}

const actionSchema = z.object({
  action: z.enum(SERVICE_ACTIONS),
  // The password is not logged, not persisted — only stdin for `sudo -S`,
  // for the duration of a single request.
  sudoPassword: z.string().max(1024).optional(),
});

// Services snapshot
servicesRouter.get('/', async (req, res) => {
  const profile = profileFrom(req, res);
  if (!profile) return;
  try {
    res.json(await collectServices(profile));
  } catch (err) {
    res.status(502).json({ error: `Сервер недоступен: ${(err as Error).message}` });
  }
});

// Unit detail
servicesRouter.get('/:unit', async (req, res) => {
  const profile = profileFrom(req, res);
  if (!profile) return;
  const unit = unitFrom(req, res);
  if (unit === null) return;
  try {
    res.json(await getServiceDetail(profile, unit));
  } catch (err) {
    if (err instanceof ServiceActionError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    res.status(502).json({ error: `Сервер недоступен: ${(err as Error).message}` });
  }
});

// Action: start|stop|restart|reload|enable|disable|reset-failed
servicesRouter.post('/:unit/action', async (req, res) => {
  const profile = profileFrom(req, res);
  if (!profile) return;
  const unit = unitFrom(req, res);
  if (unit === null) return;
  const parsed = actionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Недопустимое действие' });
    return;
  }
  try {
    const result = await runServiceAction(
      profile,
      unit,
      parsed.data.action as ServiceAction,
      parsed.data.sudoPassword,
    );
    // The mutation has been applied — invalidate the cache so an immediate
    // snapshot refetch does not get the stale 2 s cache.
    invalidateServicesCache(profile.id);
    res.json(result);
  } catch (err) {
    if (err instanceof ServiceActionError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    res.status(502).json({ error: `Сервер недоступен: ${(err as Error).message}` });
  }
});

// Unit journal: one-shot (text/plain) or follow-stream (chunked)
servicesRouter.get('/:unit/logs', async (req, res) => {
  const profile = profileFrom(req, res);
  if (!profile) return;
  const unit = unitFrom(req, res);
  if (unit === null) return;
  const tail = clampTail(req.query.tail);
  const follow = req.query.follow === '1';

  if (!follow) {
    try {
      const out = await readServiceLogs(profile, unit, tail);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.send(out || '(логов нет)');
    } catch (err) {
      if (err instanceof ServiceActionError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      res.status(502).json({ error: `Сервер недоступен: ${(err as Error).message}` });
    }
    return;
  }

  // Follow-streams go through the shared per-profile limiter (not per
  // subsystem): the systemd journal, docker logs and terminal share the
  // channels of a single SSH connection.
  if (!acquireFollowSlot(profile.id)) {
    res.status(429).json({
      error: 'Достигнут лимит одновременных журналов на сервер — закройте часть просмотрщиков и повторите',
    });
    return;
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseFollowSlot(profile.id);
  };

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();
  let closed = false;
  const write = createChunkGate(res);
  const handle = execStream(profile, journalctlCommand(unit, tail, true), (chunk) => {
    if (!closed) write(chunk);
  });
  void handle.code
    .then(() => {
      if (!closed) {
        // The stream ended in the drop state — emit the loss marker.
        write.finish();
        res.end();
      }
      release();
    })
    .catch(() => {
      if (!closed) res.end();
      release();
    });
  req.on('close', () => {
    closed = true;
    handle.close();
    release();
  });
});
