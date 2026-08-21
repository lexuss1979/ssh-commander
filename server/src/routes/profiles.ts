import { Router } from 'express';
import { z } from 'zod';
import {
  createProfile,
  deleteProfile,
  listProfiles,
  parseProfileInput,
  updateProfile,
  updateProfileLogPaths,
} from '../profiles.js';
import { BootstrapError, bootstrapServer } from '../services/bootstrap.js';
import { ProfileTransferError, buildExport, importBackup } from '../services/profile-transfer.js';
import { clearHistory } from '../services/metrics-history.js';
import { clearNginxCaches } from '../services/nginx.js';
import { closeProfileConnection, testConnection } from '../ssh/manager.js';

export const profilesRouter = Router();

profilesRouter.get('/', (_req, res) => {
  res.json(listProfiles());
});

/**
 * Checks connectivity with the given (possibly unsaved) profile fields:
 * opens a throwaway SSH connection and closes it. Never touches the
 * connection cache. 200 {ok, banner} on success, 400 with a readable
 * error otherwise.
 */
profilesRouter.post('/test-connection', async (req, res) => {
  try {
    const data = parseProfileInput(req.body);
    const banner = await testConnection({ ...data, id: 'probe' });
    res.json({ ok: true, banner });
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
 * Экспорт всех профилей в файл бэкапа (POST, чтобы пароль шифрования не
 * попадал в URL/логи). Секреты включаются только при includeSecrets=true;
 * с passphrase бэкап шифруется (scrypt + AES-256-GCM). Ключи из KEYS_DIR,
 * на которые ссылаются профили, вкладываются вместе с секретами.
 */
profilesRouter.post('/export', (req, res) => {
  try {
    const includeSecrets = req.body?.includeSecrets !== false;
    const passphrase = typeof req.body?.passphrase === 'string' && req.body.passphrase
      ? req.body.passphrase
      : undefined;
    const body = buildExport({ includeSecrets, passphrase });
    res.setHeader('content-disposition', 'attachment; filename="ssh-commander-profiles.json"');
    res.type('application/json').send(body);
  } catch (err) {
    const status = err instanceof ProfileTransferError ? err.status : 500;
    res.status(status).json({ error: (err as Error).message });
  }
});

/**
 * Импорт бэкапа: { backup: <текст файла>, passphrase? }. Профили и ключи
 * валидируются до первой записи; конфликты имён разрешаются суффиксом
 * « (2)», существующие ключи не затираются. Ответ — ImportSummary.
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
 * Bootstrap свежего сервера (root + пароль → ключ): генерирует отдельный
 * ed25519-ключ, прописывает его на сервере, опционально закрывает парольный
 * вход SSH и создаёт профиль с authType=key. Запрос живёт десятки секунд
 * (3 SSH-подключения + exec'и) — таймаутов меньше ~120 с в цепочке нет.
 * Пароль не логируется и не persist'ится (живёт только в памяти запроса).
 * Ошибки возвращают {error, steps} с отчётом по шагам.
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
    res.status(201).json(result);
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
    res.status(201).json(createProfile(req.body));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

profilesRouter.put('/:id', (req, res) => {
  try {
    closeProfileConnection(req.params.id);
    res.json(updateProfile(req.params.id, req.body));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/**
 * Замена списка закреплённых путей логов (эпик 14). Отдельный маршрут, а не
 * PUT /:id: полный апдейт вызывает closeProfileConnection и оборвал бы тот
 * самый tail-стрим, из которого пользователь жмёт «Закрепить». Подключение
 * не трогает — меняется только поле в profiles.json.
 */
const logPathsSchema = z.object({ paths: z.array(z.string()).max(50) });

profilesRouter.put('/:id/log-paths', (req, res) => {
  try {
    const parsed = logPathsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'paths должен быть массивом строк (до 50)' });
      return;
    }
    res.json(updateProfileLogPaths(req.params.id, parsed.data.paths));
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
