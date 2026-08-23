import { Router } from 'express';
import { requireProfile } from '../profiles.js';
import type { Profile } from '../types.js';
import {
  createSnippet,
  deleteSnippet,
  listSnippets,
  requireSnippet,
  runSnippetOnProfiles,
  snippetInputSchema,
  snippetRunBodySchema,
  updateSnippet,
} from '../services/snippets.js';

export const snippetsRouter = Router();

function parseError(err: unknown): string {
  return (err as Error).message ?? 'Некорректные данные';
}

// ---------------------------------------------------------------------------
// Запуск (до CRUD-маршрутов: POST /:id нет, но /run читается явнее)
// ---------------------------------------------------------------------------

/**
 * Запуск сниппета или разовой команды на выбранных серверах. Команда идёт в
 * exec как есть (уровень терминала); все цели валидируются до первого exec —
 * запуск не начинается «наполовину». Ответ всегда 200: отказ отдельного
 * сервера — элемент results с ok:false, а не ошибка запроса.
 */
snippetsRouter.post('/run', async (req, res) => {
  const parsed = snippetRunBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Некорректный запуск' });
    return;
  }
  const { snippetId, command, profileIds } = parsed.data;

  let resolvedCommand: string | undefined = command;
  if (snippetId) {
    try {
      resolvedCommand = requireSnippet(snippetId).command;
    } catch {
      res.status(400).json({ error: `Сниппет ${snippetId} не найден` });
      return;
    }
  }
  // XOR гарантируется схемой; проверка закрывает тип и страхует рефайн.
  if (!resolvedCommand) {
    res.status(400).json({ error: 'Укажите сниппет или команду' });
    return;
  }

  const profiles: Profile[] = [];
  const missing: string[] = [];
  for (const id of new Set(profileIds)) {
    try {
      profiles.push(requireProfile(id));
    } catch {
      missing.push(id);
    }
  }
  if (missing.length > 0) {
    res.status(400).json({ error: `Профили не найдены: ${missing.join(', ')}` });
    return;
  }

  try {
    const results = await runSnippetOnProfiles(resolvedCommand, profiles);
    res.json({ command: resolvedCommand, results });
  } catch (err) {
    res.status(502).json({ error: parseError(err) });
  }
});

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/** Все сниппеты (глобальный стор, цели — по id профилей). */
snippetsRouter.get('/', (_req, res) => {
  res.json({ snippets: listSnippets() });
});

snippetsRouter.post('/', (req, res) => {
  const parsed = snippetInputSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Некорректная команда' });
    return;
  }
  try {
    res.status(201).json(createSnippet(parsed.data));
  } catch (err) {
    res.status(500).json({ error: parseError(err) });
  }
});

snippetsRouter.put('/:id', (req, res) => {
  const parsed = snippetInputSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Некорректная команда' });
    return;
  }
  try {
    res.json(updateSnippet(req.params.id, parsed.data));
  } catch (err) {
    const status = /не найден/.test(parseError(err)) ? 404 : 500;
    res.status(status).json({ error: parseError(err) });
  }
});

snippetsRouter.delete('/:id', (req, res) => {
  try {
    deleteSnippet(req.params.id);
    res.status(204).end();
  } catch (err) {
    const status = /не найден/.test(parseError(err)) ? 404 : 500;
    res.status(status).json({ error: parseError(err) });
  }
});
