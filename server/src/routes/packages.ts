import { Router } from 'express';
import { z } from 'zod';
import { requireProfile } from '../profiles.js';
import { execStream } from '../ssh/manager.js';
import { createChunkGate } from '../services/chunk-gate.js';
import { acquireFollowSlot, releaseFollowSlot } from '../services/stream-limits.js';
import {
  buildApplyCommand,
  collectPackagesSnapshot,
  detectPackageManager,
  invalidatePackagesCache,
  type PackageManager,
} from '../services/packages.js';
import { probeSudo } from '../services/sudo.js';
import type { Profile } from '../types.js';

/**
 * Package updates (epic 19).
 *
 * `GET /updates` — read-only snapshot (cached 60 s per server).
 * `POST /apply` — mutation: a sudo probe before the channel opens (explicit
 * 400 on wrong password/permissions), then the output is streamed through
 * the shared follow-stream limiter (`stream-limits.ts`, 429) and a
 * backpressure gate; the password travels only as channel stdin and never
 * appears in argv/logs.
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

const applySchema = z.object({
  // The password is not logged, not persisted — only stdin for `sudo -S`,
  // for the duration of a single request.
  sudoPassword: z.string().max(1024).optional(),
});

// Read-only snapshot: package manager, update list, reboot indicators, apt
// index age. `pm: null` — no package manager, a normal empty state (not an error).
packagesRouter.get('/updates', async (req, res) => {
  const profile = profileFrom(req, res);
  if (!profile) return;
  try {
    res.json(await collectPackagesSnapshot(profile));
  } catch (err) {
    res.status(502).json({ error: `Сервер недоступен: ${(err as Error).message}` });
  }
});

// Applying updates: confirmed in the UI, the output streams into a viewer.
packagesRouter.post('/apply', async (req, res) => {
  const profile = profileFrom(req, res);
  if (!profile) return;
  const parsed = applySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Некорректное тело запроса' });
    return;
  }
  const sudoPassword = parsed.data.sudoPassword;

  // Fresh manager detection — not from the snapshot cache; applying without
  // a manager is impossible (400, not 502 — a user-facing cause).
  let pm: PackageManager | null = null;
  try {
    pm = await detectPackageManager(profile);
    if (pm === null) {
      res.status(400).json({ error: 'Менеджер пакетов не найден (apt/dnf/yum/apk)' });
      return;
    }
    if (sudoPassword !== undefined) {
      // Probe before the stream: an explicit 400 instead of a stream of sudo errors in the body.
      const probe = await probeSudo(profile, sudoPassword);
      if (probe === 'wrong-password') {
        res.status(400).json({ error: 'Неверный sudo-пароль' });
        return;
      }
      if (probe === 'not-in-sudoers') {
        res.status(400).json({
          error: `У пользователя ${profile.username} нет прав sudo на этом сервере`,
        });
        return;
      }
      if (probe === 'sudo-not-found') {
        res.status(400).json({ error: 'sudo не установлен' });
        return;
      }
      if (probe === 'other') {
        res.status(502).json({ error: 'sudo-проверка не прошла' });
        return;
      }
    }
  } catch (err) {
    res.status(502).json({ error: `Сервер недоступен: ${(err as Error).message}` });
    return;
  }

  // Applying is a long-lived channel, like a follow-stream: one slot of the
  // shared per-profile limiter (stream-limits.ts). The slot is released
  // idempotently on every completion path — req close and settled handle.code.
  if (!acquireFollowSlot(profile.id)) {
    res.status(429).json({
      error: 'Достигнут лимит одновременных потоков на сервер — закройте часть просмотрщиков и повторите',
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
  // Backpressure — the shared chunk-gate.ts gate (mid-stream drop with a
  // marker when the socket overflows), same as tail/journalctl.
  const write = createChunkGate(res);
  let closed = false;
  let handle: ReturnType<typeof execStream>;
  try {
    handle = execStream(
      profile,
      buildApplyCommand(pm, sudoPassword !== undefined),
      (chunk) => {
        if (!closed) write(chunk);
      },
      { stdin: sudoPassword !== undefined ? `${sudoPassword}\n` : undefined },
    );
  } catch (err) {
    release();
    res.end(`${String((err as Error).message ?? err)}\n`);
    return;
  }
  void handle.code
    .then(() => {
      if (!closed) {
        write.finish();
        res.end();
      }
      release();
      // The update list is stale after applying — invalidate the snapshot cache.
      invalidatePackagesCache(profile.id);
    })
    .catch(() => {
      if (!closed) res.end();
      release();
      invalidatePackagesCache(profile.id);
    });
  req.on('close', () => {
    closed = true;
    handle.close();
    release();
  });
});
