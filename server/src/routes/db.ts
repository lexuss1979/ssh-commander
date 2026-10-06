import { Router } from 'express';
import { z } from 'zod';
import { requireProfile } from '../profiles.js';
import { discoverDbContainers } from '../services/db-discovery.js';
import {
  createDbConnection,
  dbNameSchema,
  dbTableComponentSchema,
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
  fetchDbTableDetail,
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
 * Connection → exec target. The model does have a host target, but the
 * implementation is v2.x: it needs a CLI client on the host itself, so for
 * now we honestly refuse.
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

/** 404 — profile/connection not found, 400 — DB client error and
 * unsupported target, 504 — channel timeout, 502 — other SSH/docker failures. */
function errorStatus(err: unknown): number {
  if (err instanceof DbQueryError) return 400;
  const message = (err as Error).message ?? '';
  if (/Profile .* not found|не найдено/.test(message)) return 404;
  if (/в v2|Укажите connectionId/.test(message)) return 400;
  if (/timed out/i.test(message)) return 504;
  return 502;
}

// ---------------------------------------------------------------------------
// Connections (CRUD + test)
// ---------------------------------------------------------------------------

/** List of a profile's connections (no passwords). */
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

/** Create a connection (credentials are entered explicitly, as in an SQL client). */
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

/** Update a connection; an omitted password is kept from the store. */
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
 * Test credentials without saving (a one-off SELECT 1, the
 * `profiles/test-connection` pattern). Optional `id` — an existing
 * connection: when the password field in the form is empty, the saved one
 * is used (edit without retyping). A DB client error is returned verbatim —
 * "Access denied" is visible before saving.
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
    // When editing an existing connection, an empty password field means
    // "unchanged" — test against the saved one (the edit form passes the id).
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
// Discovery — hints for the connection form
// ---------------------------------------------------------------------------

/** DB containers on a profile: autofill for the connection form. */
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
// Working with a DB through a saved connection
// ---------------------------------------------------------------------------

/** Connection overview: server version and databases with sizes/table counts. */
dbRouter.get('/overview', async (req, res) => {
  try {
    const { profile, target } = connectionFromQuery(req);
    res.json(await fetchDbOverview(profile, target));
  } catch (err) {
    res.status(errorStatus(err)).json({ error: (err as Error).message });
  }
});

/** List of the connection's database names. */
dbRouter.get('/databases', async (req, res) => {
  try {
    const { profile, target } = connectionFromQuery(req);
    res.json({ databases: await fetchDbDatabases(profile, target) });
  } catch (err) {
    res.status(errorStatus(err)).json({ error: (err as Error).message });
  }
});

/** List of tables in the selected database. */
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

/** Table columns of a database (schema for the "Ask the agent" prompt). */
dbRouter.get('/columns', async (req, res) => {
  const check = dbNameSchema.safeParse(String(req.query.database ?? ''));
  if (!check.success) {
    res.status(400).json({ error: check.error.issues[0]?.message ?? 'Некорректное имя базы' });
    return;
  }
  try {
    const { profile, target } = connectionFromQuery(req);
    const columns = await fetchDbColumns(profile, target, check.data);
    // Limit reached — the schema in the prompt is truncated, the frontend shows a notice.
    res.json({ columns, truncated: columns.length >= DB_COLUMNS_LIMIT });
  } catch (err) {
    res.status(errorStatus(err)).json({ error: (err as Error).message });
  }
});

/** Table detail: columns (name, type, nullable, default, key) + indexes (name,
 * columns, unique, primary). Requires schema + table (for PG — the table
 * schema, for MySQL — the same as the database name). */
dbRouter.get('/table-detail', async (req, res) => {
  const db = dbNameSchema.safeParse(String(req.query.database ?? ''));
  const schema = dbTableComponentSchema.safeParse(String(req.query.schema ?? ''));
  const table = dbTableComponentSchema.safeParse(String(req.query.table ?? ''));
  if (!db.success) {
    res.status(400).json({ error: db.error.issues[0]?.message ?? 'Некорректное имя базы' });
    return;
  }
  if (!schema.success) {
    res.status(400).json({ error: schema.error.issues[0]?.message ?? 'Некорректная схема' });
    return;
  }
  if (!table.success) {
    res.status(400).json({ error: table.error.issues[0]?.message ?? 'Некорректное имя таблицы' });
    return;
  }
  try {
    const { profile, target } = connectionFromQuery(req);
    res.json(await fetchDbTableDetail(profile, target, db.data, schema.data, table.data));
  } catch (err) {
    res.status(errorStatus(err)).json({ error: (err as Error).message });
  }
});

const querySchema = dbConnectionInputSchema.pick({ profileId: true }).extend({
  connectionId: z.string({ required_error: 'Укажите подключение' }).min(1, 'Укажите подключение'),
  database: dbNameSchema,
  // Limit in bytes, not characters: zod .max() counts UTF-16 code points and
  // would let a multibyte query longer than 64 KB through.
  sql: z
    .string()
    .min(1, 'Пустой запрос')
    .refine((v) => Buffer.byteLength(v, 'utf8') <= DB_SQL_MAX_BYTES, 'Запрос больше 64 КБ'),
  readOnly: z.boolean().default(true),
});

/**
 * Run SQL. A DB client error (non-zero exit code) is not a 5xx: the body is
 * `{error: {message, stderr, exitCode}}` with status 400, and the UI shows
 * stderr as a mono block.
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

/** Database dump: stream .sql.gz (never assembled in memory). */
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

    // Buffer the stdout head instead of piping right away: without pipefail
    // the exit code is always gzip's (0), so a failed pg_dump would look
    // successful. The failure is caught on 'close' by the signature
    // "stdout < threshold + non-empty stderr" (pg_dump/mysqldump write errors
    // to stderr themselves and produce no stdout) — and the buffer guarantees
    // the response headers have not been sent yet. A real dump exceeds the
    // threshold with its first chunk (hundreds of bytes of SQL headers) and
    // then streams as usual. Known limitation: a failure AFTER the head is
    // sent (mid-dump) yields a truncated archive.
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
        // end: false — we finish the response ourselves on 'close'.
        channel.pipe(res, { end: false });
      }
    });
    channel.on('close', (code: number | null) => {
      if (!streaming) {
        // gzip of empty input is a valid ~20-byte empty archive: threshold +
        // stderr distinguish it from a real dump.
        const emptyDump = received < EMPTY_GZIP_MAX_BYTES && stderr.trim() !== '';
        if (code !== 0 || emptyDump) {
          res
            .status(500)
            .json({ error: stderr.trim() || `dump exited with code ${code ?? 'unknown'}` });
          return;
        }
        // Tiny valid output with no stderr — serve as is.
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
