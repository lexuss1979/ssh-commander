import { Router } from 'express';
import { z } from 'zod';
import {
  createProfile,
  deleteProfile,
  getProfile,
  listProfiles,
  parseProfileInput,
  toSafeProfile,
  updateProfile,
  updateProfileLogPaths,
} from '../profiles.js';
import { BootstrapError, bootstrapServer } from '../services/bootstrap.js';
import { ProfileTransferError, buildExport, importBackup } from '../services/profile-transfer.js';
import { clearHistory } from '../services/metrics-history.js';
import { clearNginxCaches } from '../services/nginx.js';
import { getProfilePrivileges } from '../services/privileges.js';
import { closeProfileConnection, testConnection } from '../ssh/manager.js';

export const profilesRouter = Router();

/**
 * Profile list **without secrets** (`toSafeProfile`): the SSH password and
 * key passphrase are never sent out — they used to travel to the browser on
 * every list load and be pre-filled into the form. `hasPassword`/
 * `hasKeyPassphrase` is enough for the client: an empty form field means
 * "unchanged", and the server keeps the previous value.
 */
profilesRouter.get('/', (_req, res) => {
  res.json(listProfiles().map(toSafeProfile));
});

/**
 * Checks connectivity with the given (possibly unsaved) profile fields:
 * opens a throwaway SSH connection and closes it. Never touches the
 * connection cache. 200 {ok, banner} on success, 400 with a readable
 * error otherwise.
 */
profilesRouter.post('/test-connection', async (req, res) => {
  try {
    // The secret is no longer pre-filled into the form (toSafeProfile), so
    // when testing a saved profile it is taken from the store by savedId —
    // the same trick as for DB connections (routes/db.ts).
    const body = { ...(req.body as Record<string, unknown>) };
    const savedId = typeof body.savedId === 'string' ? body.savedId : '';
    const saved = savedId ? getProfile(savedId) : undefined;
    if (saved) {
      if (!body.password) body.password = saved.password;
      if (!body.keyPassphrase) body.keyPassphrase = saved.keyPassphrase;
      if (!body.keyPath) body.keyPath = saved.keyPath;
    }
    const data = parseProfileInput(body);
    const result = await testConnection({ ...data, id: 'probe' });
    // Host key fingerprint: the user has something to verify against
    // `ssh-keyscan`, and on the first connection can see exactly what gets
    // remembered (TOFU).
    res.json({ ok: true, ...result });
  } catch (err) {
    const message =
      err instanceof z.ZodError
        ? err.issues.map((issue) => issue.message).join('; ')
        : (err as Error).message;
    res.status(400).json({ error: message });
  }
});

/**
 * Closes the cached SSH connection for the profile. The next request
 * (terminal, SFTP, docker, agent) opens a fresh connection, so changes
 * applied at login time — e.g. new group memberships — take effect.
 */
profilesRouter.post('/:id/reconnect', (req, res) => {
  closeProfileConnection(req.params.id);
  res.json({ ok: true });
});

/**
 * Privileges of the profile's SSH user (root / sudo) — the agent access
 * level UI probes it lazily to pick the warning strength when enabling the
 * 'never' mode (docs/agent-access-levels-plan.md). The probe influences only
 * the warning, never the availability of the mode; a transport failure → 502
 * (the routes/metrics.ts pattern) and the frontend falls back to the strong
 * warning (fail-closed UX).
 */
profilesRouter.get('/:id/privileges', async (req, res) => {
  const profile = getProfile(req.params.id);
  if (!profile) {
    res.status(404).json({ error: `Profile ${req.params.id} not found` });
    return;
  }
  try {
    res.json(await getProfilePrivileges(profile));
  } catch (err) {
    res.status(502).json({ error: `Сервер недоступен: ${(err as Error).message}` });
  }
});

/**
 * Export all profiles to a backup file (POST so the encryption passphrase
 * never lands in URLs/logs). Secrets are included only with
 * includeSecrets=true; with a passphrase the backup is encrypted
 * (scrypt + AES-256-GCM). Keys from KEYS_DIR referenced by profiles are
 * embedded together with the secrets.
 */
profilesRouter.post('/export', (req, res) => {
  try {
    // Secrets only on an explicit request and only in an encrypted file:
    // the "include by default" + optional passphrase combo used to produce a
    // plaintext file with SSH passwords and private key contents on an empty
    // request body.
    const includeSecrets = req.body?.includeSecrets === true;
    const passphrase = typeof req.body?.passphrase === 'string' && req.body.passphrase
      ? req.body.passphrase
      : undefined;
    if (includeSecrets && !passphrase) {
      throw new ProfileTransferError(
        'Экспорт с секретами требует пароль шифрования: без него файл содержал бы пароли SSH и приватные ключи открытым текстом',
      );
    }
    const body = buildExport({ includeSecrets, passphrase });
    res.setHeader('content-disposition', 'attachment; filename="ssh-commander-profiles.json"');
    res.type('application/json').send(body);
  } catch (err) {
    const status = err instanceof ProfileTransferError ? err.status : 500;
    res.status(status).json({ error: (err as Error).message });
  }
});

/**
 * Import a backup: { backup: <file text>, passphrase? }. Profiles and keys
 * are validated before the first write; name conflicts are resolved with the
 * " (2)" suffix, existing keys are not overwritten. Response — ImportSummary.
 */
profilesRouter.post('/import', (req, res) => {
  try {
    const backup = req.body?.backup;
    if (typeof backup !== 'string' || !backup.trim()) {
      throw new ProfileTransferError('Нет данных бэкапа');
    }
    const passphrase = typeof req.body?.passphrase === 'string' && req.body.passphrase
      ? req.body.passphrase
      : undefined;
    res.json(importBackup(backup, passphrase));
  } catch (err) {
    const status = err instanceof ProfileTransferError ? err.status : 400;
    res.status(status).json({ error: (err as Error).message });
  }
});

/**
 * Bootstrap a fresh server (root + password → key): generates a dedicated
 * ed25519 key, installs it on the server, optionally closes SSH password
 * login and creates a profile with authType=key. The request lives for tens
 * of seconds (3 SSH connections + execs) — no timeouts shorter than ~120 s
 * anywhere in the chain. The password is not logged and not persisted
 * (lives only in request memory). Errors return {error, steps} with a
 * per-step report.
 */
const bootstrapInputSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  host: z.string().min(1, 'Host is required'),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required'),
  disablePasswordAuth: z.boolean().default(true),
});

profilesRouter.post('/bootstrap', async (req, res) => {
  try {
    const result = await bootstrapServer(bootstrapInputSchema.parse(req.body));
    res.status(201).json({ ...result, profile: toSafeProfile(result.profile) });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: err.issues.map((issue) => issue.message).join('; ') });
    } else if (err instanceof BootstrapError) {
      res.status(err.status).json({ error: err.message, steps: err.steps });
    } else {
      res.status(500).json({ error: (err as Error).message });
    }
  }
});

profilesRouter.post('/', (req, res) => {
  try {
    res.status(201).json(toSafeProfile(createProfile(req.body)));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

profilesRouter.put('/:id', (req, res) => {
  try {
    closeProfileConnection(req.params.id);
    res.json(toSafeProfile(updateProfile(req.params.id, req.body)));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/**
 * Replace the pinned log paths list (epic 14). A dedicated route instead of
 * PUT /:id: a full update calls closeProfileConnection and would tear down
 * the very tail stream the user pins from. The connection is untouched —
 * only the field in profiles.json changes.
 */
const logPathsSchema = z.object({ paths: z.array(z.string()).max(50) });

profilesRouter.put('/:id/log-paths', (req, res) => {
  try {
    const parsed = logPathsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'paths должен быть массивом строк (до 50)' });
      return;
    }
    res.json(toSafeProfile(updateProfileLogPaths(req.params.id, parsed.data.paths)));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

profilesRouter.delete('/:id', (req, res) => {
  try {
    closeProfileConnection(req.params.id);
    clearHistory(req.params.id);
    clearNginxCaches(req.params.id);
    deleteProfile(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});
