import { Router } from 'express';
import { z } from 'zod';
import { requireProfile } from '../profiles.js';
import { discoverDbContainers } from '../services/db-discovery.js';
import {
  createDbConnection,
  dbNameSchema,
  dbConnectionInputSchema,
  deleteDbConnection,
  listDbConnections,
  parseDbConnectionInput,
  requireDbConnection,
  toSafeDbConnection,
  updateDbConnection,
  type DbConnection,
  type DbConnectionInput,
} from '../services/db-connections.js';
import {
  DB_COLUMNS_LIMIT,
  DB_SQL_MAX_BYTES,
  DbQueryError,
  fetchDbColumns,
  fetchDbDatabases,
  fetchDbOverview,
  fetchDbTables,
  runDbQuery,
  testDbConnection,
  type DbExecTarget,
} from '../services/db-query.js';
import { dumpFileName, openDumpChannel, EMPTY_GZIP_MAX_BYTES } from '../services/db-dump.js';
import type { Profile } from '../types.js';

export const dbRouter = Router();

function profileFromQuery(req: { query: Record<string, unknown> }): Profile {
  return requireProfile(String(req.query.profileId ?? ''));
}

/**
 * Подключение → цель выполнения. Host-цель в модели есть, но реализация —
 * v2.x: нужен CLI-клиент на хосте, сейчас честно отказываем.
 */
function toExecTarget(
  conn: Pick<DbConnection, 'engine' | 'target' | 'username' | 'password' | 'flavor' | 'defaultDatabase'>,
): DbExecTarget {
  if (conn.target.kind === 'host') {
    throw new Error('Подключения к СУБД вне Docker (на хосте) появятся в v2; пока поддерживаются только контейнеры');
  }
  return {
    engine: conn.engine,
    containerId: conn.target.containerId,
    username: conn.username,
    password: conn.password,
    flavor: conn.flavor,
    defaultDatabase: conn.defaultDatabase ?? null,
  };
}

function connectionFromQuery(
  req: { query: Record<string, unknown> },
): { profile: Profile; connection: DbConnection; target: DbExecTarget } {
  const profile = profileFromQuery(req);
  const connectionId = String(req.query.connectionId ?? '');
  if (!connectionId) {
    throw new Error('Укажите connectionId');
  }
  const connection = requireDbConnection(connectionId);
  if (connection.profileId !== profile.id) {
    throw new Error(`Подключение ${connectionId} не найдено`);
  }
  return { profile, connection, target: toExecTarget(connection) };
}

/** 404 — профиль/подключение не найдены, 400 — ошибка клиента БД и
 * неподдерживаемая цель, 504 — таймаут канала, 502 — прочие SSH/docker сбои. */
function errorStatus(err: unknown): number {
  if (err instanceof DbQueryError) return 400;
  const message = (err as Error).message ?? '';
  if (/Profile .* not found|не найдено/.test(message)) return 404;
  if (/в v2|Укажите connectionId/.test(message)) return 400;
  if (/timed out/i.test(message)) return 504;
  return 502;
}

// ---------------------------------------------------------------------------
// Подключения (CRUD + проверка)
// ---------------------------------------------------------------------------

/** Список подключений профиля (без паролей). */
dbRouter.get('/connections', (req, res) => {
  let profileId: string;
  try {
    profileId = profileFromQuery(req).id;
  } catch {
    res.status(404).json({ error: 'Profile not found' });
    return;
  }
  res.json({ connections: listDbConnections(profileId).map(toSafeDbConnection) });
});

/** Создание подключения (креденшалы задаются явно, как в SQL-клиенте). */
dbRouter.post('/connections', (req, res) => {
  const parsed = dbConnectionInputSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Некорректное подключение' });
    return;
  }
  try {
    requireProfile(parsed.data.profileId);
    res.status(201).json(toSafeDbConnection(createDbConnection(parsed.data)));
  } catch (err) {
    res.status(errorStatus(err)).json({ error: (err as Error).message });
  }
});

/** Изменение подключения; непереданный пароль сохраняется из хранилища. */
dbRouter.put('/connections/:id', (req, res) => {
  const parsed = dbConnectionInputSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Некорректное подключение' });
    return;
  }
  try {
    res.json(toSafeDbConnection(updateDbConnection(req.params.id, parsed.data)));
  } catch (err) {
    res.status(errorStatus(err)).json({ error: (err as Error).message });
  }
});

dbRouter.delete('/connections/:id', (req, res) => {
  try {
    deleteDbConnection(req.params.id);
    res.status(204).end();
  } catch (err) {
    res.status(errorStatus(err)).json({ error: (err as Error).message });
  }
});

/**
 * Проверка креденшалов без сохранения (разовый SELECT 1, паттерн
 * `profiles/test-connection`). Опциональный `id` — существующее подключение:
 * при пустом пароле в форме берётся сохранённый (правка без перепечатки).
 * Ошибка клиента БД возвращается текстом как есть — «Access denied» виден
 * до сохранения.
 */
dbRouter.post('/connections/test', async (req, res) => {
  let input: DbConnectionInput;
  try {
    input = parseDbConnectionInput(req.body);
  } catch (err) {
    res.status(400).json({
      error: err instanceof z.ZodError
        ? err.issues[0]?.message ?? 'Некорректное подключение'
        : (err as Error).message,
    });
    return;
  }
  try {
    const profile = requireProfile(input.profileId);
    // При правке существующего подключения пустой пароль в форме означает
    // «не менялся» — проверяем сохранённый (id передаёт форма редактирования).
    const savedId = typeof req.body?.id === 'string' ? req.body.id : null;
    const password = input.password ?? (savedId ? requireDbConnection(savedId).password : '');
    await testDbConnection(profile, toExecTarget({ ...input, password }));
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof DbQueryError) {
      res.status(400).json({ error: { message: err.message, stderr: err.stderr, exitCode: err.exitCode } });
      return;
    }
    res.status(errorStatus(err)).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// Discovery — подсказки для формы подключения
// ---------------------------------------------------------------------------

/** Контейнеры СУБД на профиле: автозаполнение формы подключения. */
dbRouter.get('/discovery', async (req, res) => {
  let profile: Profile;
  try {
    profile = profileFromQuery(req);
  } catch {
    res.status(404).json({ error: 'Profile not found' });
    return;
  }
  try {
    res.json(await discoverDbContainers(profile));
  } catch (err) {
    res.status(502).json({ error: `Docker недоступен: ${(err as Error).message}` });
  }
});

// ---------------------------------------------------------------------------
// Работа с БД через сохранённое подключение
// ---------------------------------------------------------------------------

/** Обзор подключения: версия и базы с размерами/числом таблиц. */
dbRouter.get('/overview', async (req, res) => {
  try {
    const { profile, target } = connectionFromQuery(req);
    res.json(await fetchDbOverview(profile, target));
  } catch (err) {
    res.status(errorStatus(err)).json({ error: (err as Error).message });
  }
});

/** Список имён баз подключения. */
dbRouter.get('/databases', async (req, res) => {
  try {
    const { profile, target } = connectionFromQuery(req);
    res.json({ databases: await fetchDbDatabases(profile, target) });
  } catch (err) {
    res.status(errorStatus(err)).json({ error: (err as Error).message });
  }
});

/** Список таблиц выбранной базы. */
dbRouter.get('/tables', async (req, res) => {
  const check = dbNameSchema.safeParse(String(req.query.database ?? ''));
  if (!check.success) {
    res.status(400).json({ error: check.error.issues[0]?.message ?? 'Некорректное имя базы' });
    return;
  }
  try {
    const { profile, target } = connectionFromQuery(req);
    res.json({ tables: await fetchDbTables(profile, target, check.data) });
  } catch (err) {
    res.status(errorStatus(err)).json({ error: (err as Error).message });
  }
});

/** Колонки таблиц базы (схема для промпта «Спросить агента»). */
dbRouter.get('/columns', async (req, res) => {
  const check = dbNameSchema.safeParse(String(req.query.database ?? ''));
  if (!check.success) {
    res.status(400).json({ error: check.error.issues[0]?.message ?? 'Некорректное имя базы' });
    return;
  }
  try {
    const { profile, target } = connectionFromQuery(req);
    const columns = await fetchDbColumns(profile, target, check.data);
    // Достигли лимита — схема в промпте обрезана, фронт показывает пометку.
    res.json({ columns, truncated: columns.length >= DB_COLUMNS_LIMIT });
  } catch (err) {
    res.status(errorStatus(err)).json({ error: (err as Error).message });
  }
});

const querySchema = dbConnectionInputSchema.pick({ profileId: true }).extend({
  connectionId: z.string({ required_error: 'Укажите подключение' }).min(1, 'Укажите подключение'),
  database: dbNameSchema,
  // Лимит в байтах, не символах: zod .max() считает UTF-16-кодпоинты и
  // пропустил бы multibyte-запрос длиннее 64 КБ.
  sql: z
    .string()
    .min(1, 'Пустой запрос')
    .refine((v) => Buffer.byteLength(v, 'utf8') <= DB_SQL_MAX_BYTES, 'Запрос больше 64 КБ'),
  readOnly: z.boolean().default(true),
});

/**
 * Выполнение SQL. Ошибка клиента БД (ненулевой exit code) — не 5xx: тело
 * `{error: {message, stderr, exitCode}}` со статусом 400, UI показывает
 * stderr mono-блоком.
 */
dbRouter.post('/query', async (req, res) => {
  const parsed = querySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Некорректный запрос' });
    return;
  }
  const q = parsed.data;
  try {
    const profile = requireProfile(q.profileId);
    const connection = requireDbConnection(q.connectionId);
    if (connection.profileId !== profile.id) {
      throw new Error(`Подключение ${q.connectionId} не найдено`);
    }
    const result = await runDbQuery(profile, toExecTarget(connection), q.database, q.sql, q.readOnly);
    res.json(result);
  } catch (err) {
    if (err instanceof DbQueryError) {
      res.status(400).json({ error: { message: err.message, stderr: err.stderr, exitCode: err.exitCode } });
      return;
    }
    res.status(errorStatus(err)).json({ error: (err as Error).message });
  }
});

/** Дамп базы: стрим .sql.gz (в память не собирается). */
dbRouter.get('/dump', async (req, res) => {
  const check = dbNameSchema.safeParse(String(req.query.database ?? ''));
  if (!check.success) {
    res.status(400).json({ error: check.error.issues[0]?.message ?? 'Некорректное имя базы' });
    return;
  }
  let target: DbExecTarget;
  let profile: Profile;
  try {
    ({ profile, target } = connectionFromQuery(req));
  } catch (err) {
    res.status(errorStatus(err)).json({ error: (err as Error).message });
    return;
  }
  try {
    const channel = await openDumpChannel(profile, target, check.data);
    let stderr = '';
    let received = 0;
    let head: Buffer[] = [];
    let streaming = false;

    // Голову stdout буферизуем, не пайпим сразу: без pipefail exit code —
    // всегда код gzip (0), и упавший pg_dump выглядел бы успешным. Ошибка
    // ловится на 'close' по признаку «stdout < порога + непустой stderr»
    // (pg_dump/mysqldump сами пишут ошибки в stderr и не пишут stdout) —
    // а буфер гарантирует, что заголовки ответа ещё не отправлены. Реальный
    // дамп превышает порог первым же куском (сотни байт SQL-заголовков) и
    // дальше стримится как обычно. Известное ограничение: сбой ПОСЛЕ
    // отправки головы (середина дампа) отдаёт обрезанный архив.
    const startStreaming = () => {
      streaming = true;
      res.setHeader('Content-Type', 'application/gzip');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(dumpFileName(check.data))}"`,
      );
      res.write(Buffer.concat(head));
      head = [];
    };

    channel.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 65536) stderr += d.toString();
    });
    channel.on('data', (d: Buffer) => {
      received += d.length;
      if (streaming) return;
      head.push(d);
      if (received >= EMPTY_GZIP_MAX_BYTES) {
        startStreaming();
        // end: false — ответ завершаем сами по 'close'.
        channel.pipe(res, { end: false });
      }
    });
    channel.on('close', (code: number | null) => {
      if (!streaming) {
        // gzip пустого входа — валидный ~20-байтный пустой архив: порог +
        // stderr отделяют его от настоящего дампа.
        const emptyDump = received < EMPTY_GZIP_MAX_BYTES && stderr.trim() !== '';
        if (code !== 0 || emptyDump) {
          res
            .status(500)
            .json({ error: stderr.trim() || `dump exited with code ${code ?? 'unknown'}` });
          return;
        }
        // Крошечный валидный вывод без stderr — отдаём как есть.
        startStreaming();
      }
      res.end();
    });
    channel.on('error', () => {
      if (!streaming) res.status(500).json({ error: 'Ошибка SSH-канала' });
      else res.end();
    });
    req.on('close', () => {
      try {
        channel.close();
      } catch {
        /* noop */
      }
    });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});
