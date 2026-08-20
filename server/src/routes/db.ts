import { Router } from 'express';
import { z } from 'zod';
import { requireProfile } from '../profiles.js';
import {
  discoverDbInstances,
  requireDbInstance,
  type DbInstance,
} from '../services/db-discovery.js';
import {
  DB_COLUMNS_LIMIT,
  DB_SQL_MAX_BYTES,
  DbQueryError,
  fetchDbColumns,
  fetchDbDatabases,
  fetchDbOverview,
  fetchDbTables,
  runDbQuery,
} from '../services/db-query.js';
import { dumpFileName, openDumpChannel, EMPTY_GZIP_MAX_BYTES } from '../services/db-dump.js';
import type { Profile } from '../types.js';

export const dbRouter = Router();

function profileFromQuery(req: { query: Record<string, unknown> }): Profile {
  return requireProfile(String(req.query.profileId ?? ''));
}

function instanceFromQuery(req: { query: Record<string, unknown> }): Promise<{ profile: Profile; instance: DbInstance }> {
  const profile = profileFromQuery(req);
  const instanceId = String(req.query.instanceId ?? '');
  if (!instanceId) {
    throw new Error('Укажите instanceId');
  }
  return requireDbInstance(profile, instanceId).then((instance) => ({ profile, instance }));
}

// Имя базы — только идентификатор: latin/цифры/подчёркивания (без кавычек
// mysql/PG идентификаторы с иными символами и не создать без экранирования).
const dbNameSchema = z.string().regex(/^[A-Za-z0-9_$-]+$/, 'Некорректное имя базы');

const querySchema = z.object({
  profileId: z.string().min(1, 'Укажите профиль'),
  instanceId: z.string().min(1, 'Укажите инстанс'),
  database: dbNameSchema,
  // Лимит в байтах, не символах: zod .max() считает UTF-16-кодпоинты и
  // пропустил бы multibyte-запрос длиннее 64 КБ.
  sql: z
    .string()
    .min(1, 'Пустой запрос')
    .refine((v) => Buffer.byteLength(v, 'utf8') <= DB_SQL_MAX_BYTES, 'Запрос больше 64 КБ'),
  readOnly: z.boolean().default(true),
});

/** Инстансы БД на профиле (вкладка «Базы данных»). */
dbRouter.get('/instances', async (req, res) => {
  let profile: Profile;
  try {
    profile = profileFromQuery(req);
  } catch {
    res.status(404).json({ error: 'Profile not found' });
    return;
  }
  try {
    const { instances, hints } = await discoverDbInstances(profile);
    // Креденшалы наружу не отдаём — только id/имя/движок/образ.
    res.json({
      instances: instances.map(({ id, name, engine, image }) => ({ id, name, engine, image })),
      hints,
    });
  } catch (err) {
    res.status(502).json({ error: `Docker недоступен: ${(err as Error).message}` });
  }
});

/** Обзор инстанса: версия и базы с размерами/числом таблиц. */
dbRouter.get('/overview', async (req, res) => {
  try {
    const { profile, instance } = await instanceFromQuery(req);
    res.json(await fetchDbOverview(profile, instance));
  } catch (err) {
    res.status(errorStatus(err)).json({ error: (err as Error).message });
  }
});

/** Список имён баз инстанса. */
dbRouter.get('/databases', async (req, res) => {
  try {
    const { profile, instance } = await instanceFromQuery(req);
    res.json({ databases: await fetchDbDatabases(profile, instance) });
  } catch (err) {
    res.status(errorStatus(err)).json({ error: (err as Error).message });
  }
});

/** Список таблиц выбранной базы. */
dbRouter.get('/tables', async (req, res) => {
  const database = String(req.query.database ?? '');
  const check = dbNameSchema.safeParse(database);
  if (!check.success) {
    res.status(400).json({ error: check.error.issues[0]?.message ?? 'Некорректное имя базы' });
    return;
  }
  try {
    const { profile, instance } = await instanceFromQuery(req);
    res.json({ tables: await fetchDbTables(profile, instance, check.data) });
  } catch (err) {
    res.status(errorStatus(err)).json({ error: (err as Error).message });
  }
});

/** Колонки таблиц базы (схема для промпта «Спросить агента»). */
dbRouter.get('/columns', async (req, res) => {
  const database = String(req.query.database ?? '');
  const check = dbNameSchema.safeParse(database);
  if (!check.success) {
    res.status(400).json({ error: check.error.issues[0]?.message ?? 'Некорректное имя базы' });
    return;
  }
  try {
    const { profile, instance } = await instanceFromQuery(req);
    const columns = await fetchDbColumns(profile, instance, check.data);
    // Достигли лимита — схема в промпте обрезана, фронт показывает пометку.
    res.json({ columns, truncated: columns.length >= DB_COLUMNS_LIMIT });
  } catch (err) {
    res.status(errorStatus(err)).json({ error: (err as Error).message });
  }
});

/** 404 — профиль/инстанс не найдены, 400 — ошибка клиента БД, 504 — таймаут
 * канала, 502 — прочие SSH/docker сбои. */
function errorStatus(err: unknown): number {
  if (err instanceof DbQueryError) return 400;
  const message = (err as Error).message ?? '';
  if (/Profile .* not found|не найден среди инстансов/.test(message)) return 404;
  if (/timed out/i.test(message)) return 504;
  return 502;
}

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
  let profile: Profile;
  try {
    profile = requireProfile(q.profileId);
  } catch {
    res.status(404).json({ error: `Profile ${q.profileId} not found` });
    return;
  }
  try {
    const instance = await requireDbInstance(profile, q.instanceId);
    const result = await runDbQuery(profile, instance, q.database, q.sql, q.readOnly);
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
  const database = String(req.query.database ?? '');
  const check = dbNameSchema.safeParse(database);
  if (!check.success) {
    res.status(400).json({ error: check.error.issues[0]?.message ?? 'Некорректное имя базы' });
    return;
  }
  let profile: Profile;
  let instance: DbInstance;
  try {
    profile = profileFromQuery(req);
    const instanceId = String(req.query.instanceId ?? '');
    if (!instanceId) throw new Error('Укажите instanceId');
    instance = await requireDbInstance(profile, instanceId);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }
  try {
    const channel = await openDumpChannel(profile, instance, check.data);
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
