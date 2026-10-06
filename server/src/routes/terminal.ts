import { Router } from 'express';
import { z } from 'zod';
import { requireProfile } from '../profiles.js';
import { DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT, fetchHistory } from '../services/history.js';
import { listTerminalSessions, MAX_TERMINAL_SESSIONS_PER_PROFILE } from '../ws/terminal.js';

export const terminalRouter = Router();

const historyQuerySchema = z.object({
  profileId: z.string().min(1, 'Укажите профиль'),
  limit: z.coerce.number().int().min(1).max(MAX_HISTORY_LIMIT).default(DEFAULT_HISTORY_LIMIT),
});

// Server shell command history (~/.bash_history, fallback ~/.zsh_history).
// Empty history is not an error: { commands: [] }.
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
    // SSH/command failed — the server is unreachable; the frontend shows a notice in the palette.
    res.status(502).json({ error: `Сервер недоступен: ${(err as Error).message}` });
  }
});

const sessionsQuerySchema = z.object({
  profileId: z.string().min(1, 'Укажите профиль'),
});

// Live terminal sessions of a profile (epic 15): after F5/localStorage
// cleanup the frontend restores tabs from them (tabId + container) instead
// of spawning new ones. limit — to disable "+" in the UI (the server limit).
terminalRouter.get('/sessions', (req, res) => {
  const parsed = sessionsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Некорректные параметры' });
    return;
  }
  const profileId = parsed.data.profileId;
  try {
    requireProfile(profileId);
  } catch {
    res.status(404).json({ error: `Profile ${profileId} not found` });
    return;
  }
  res.json({ sessions: listTerminalSessions(profileId), limit: MAX_TERMINAL_SESSIONS_PER_PROFILE });
});
