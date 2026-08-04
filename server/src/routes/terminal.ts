import { Router } from 'express';
import { z } from 'zod';
import { requireProfile } from '../profiles.js';
import { DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT, fetchHistory } from '../services/history.js';

export const terminalRouter = Router();

const historyQuerySchema = z.object({
  profileId: z.string().min(1, 'Укажите профиль'),
  limit: z.coerce.number().int().min(1).max(MAX_HISTORY_LIMIT).default(DEFAULT_HISTORY_LIMIT),
});

// История shell-команд сервера (~/.bash_history, фолбэк ~/.zsh_history).
// Пустая история — не ошибка: { commands: [] }.
terminalRouter.get('/history', async (req, res) => {
  const parsed = historyQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Некорректные параметры' });
    return;
  }
  const q = parsed.data;
  let profile;
  try {
    profile = requireProfile(q.profileId);
  } catch {
    res.status(404).json({ error: `Profile ${q.profileId} not found` });
    return;
  }
  try {
    const commands = await fetchHistory(profile, q.limit);
    res.json({ commands });
  } catch (err) {
    // SSH/команда не сработали — сервер недоступен; фронт показывает плашку в палитре.
    res.status(502).json({ error: `Сервер недоступен: ${(err as Error).message}` });
  }
});
