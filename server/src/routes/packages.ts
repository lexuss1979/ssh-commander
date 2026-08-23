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
 * Обновления пакетов (эпик 19).
 *
 * `GET /updates` — read-only снимок (кэш 60 с на сервере).
 * `POST /apply` — мутация: sudo-зонд до открытия канала (явный 400 при
 * неверном пароле/правах), далее стрим вывода через общий лимитер
 * follow-стримов (`stream-limits.ts`, 429) и backpressure-гейт; пароль —
 * только stdin канала, в argv/логах не появляется.
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
  // Пароль не логируется, не сохраняется — только stdin для `sudo -S`
  // в пределах одного запроса.
  sudoPassword: z.string().max(1024).optional(),
});

// Read-only снимок: менеджер, список обновлений, признаки рестарта, возраст
// индекса apt. `pm: null` — менеджера нет, штатная заглушка (не ошибка).
packagesRouter.get('/updates', async (req, res) => {
  const profile = profileFrom(req, res);
  if (!profile) return;
  try {
    res.json(await collectPackagesSnapshot(profile));
  } catch (err) {
    res.status(502).json({ error: `Сервер недоступен: ${(err as Error).message}` });
  }
});

// Применение обновлений: подтверждено в UI, вывод — стримом в просмотрщик.
packagesRouter.post('/apply', async (req, res) => {
  const profile = profileFrom(req, res);
  if (!profile) return;
  const parsed = applySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Некорректное тело запроса' });
    return;
  }
  const sudoPassword = parsed.data.sudoPassword;

  // Свежий детект менеджера — не из кэша снимка; применение без менеджера
  // невозможно (400, не 502 — пользовательская причина).
  let pm: PackageManager | null = null;
  try {
    pm = await detectPackageManager(profile);
    if (pm === null) {
      res.status(400).json({ error: 'Менеджер пакетов не найден (apt/dnf/yum/apk)' });
      return;
    }
    if (sudoPassword !== undefined) {
      // Зонд до стрима: явный 400 вместо потока sudo-ошибок в теле.
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

  // Применение — долгоживущий канал, как follow-стрим: слот общего лимитера
  // на профиль (stream-limits.ts). Слот снимается идемпотентно на любом пути
  // завершения — req close и settle handle.code.
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
  // Backpressure — общий гейт chunk-gate.ts (дроп середины с маркером при
  // переполнении сокета), как у tail/journalctl.
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
      // Список после применения устарел — сброс кэша снимка.
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
