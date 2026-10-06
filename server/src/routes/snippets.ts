import { Router } from 'express';
import { requireProfile } from '../profiles.js';
import type { Profile } from '../types.js';
import {
  createSnippet,
  deleteSnippet,
  getSnippet,
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
// Run (before the CRUD routes: there is no POST /:id, but /run reads clearer)
// ---------------------------------------------------------------------------

/**
 * Run a snippet or a one-off command on the selected servers. The command
 * goes into exec as is (terminal level); all targets are validated before
 * the first exec — the run never starts "half-way". The response is always
 * 200: a per-server failure is an entry in results with ok:false, not a
 * request error.
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
  // The XOR is guaranteed by the schema; this check satisfies the type and
  // backs up the refine.
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

/** All snippets (a global store; run targets are referenced by profile ids). */
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
  // Existence is checked explicitly, not by regex over the error text — the
  // HTTP code must not depend on the message wording.
  if (!getSnippet(req.params.id)) {
    res.status(404).json({ error: `Сниппет ${req.params.id} не найден` });
    return;
  }
  try {
    res.json(updateSnippet(req.params.id, parsed.data));
  } catch (err) {
    res.status(500).json({ error: parseError(err) });
  }
});

snippetsRouter.delete('/:id', (req, res) => {
  if (!getSnippet(req.params.id)) {
    res.status(404).json({ error: `Сниппет ${req.params.id} не найден` });
    return;
  }
  try {
    deleteSnippet(req.params.id);
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: parseError(err) });
  }
});
