import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';
import type { DbEngine, MysqlFlavor } from './db-discovery.js';

/**
 * Database connections store (iteration 2 of epic 12): a connection is a
 * saved entity with explicit credentials, as in DBeaver/TablePlus. The
 * `profiles.ts` pattern: zod validation, atomic tmp+rename write,
 * corrupt-guard, the password in plain text — the same trust domain as the
 * SSH passwords in `profiles.json` (a deliberate compromise of a local tool).
 */

/** The database name is an identifier without special characters (latin/
 * digits/underscore); mysql/PG do not create identifiers with other
 * characters quoted anyway. */
export const dbNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9_$-]+$/, 'Некорректное имя базы');

/** The schema/table name for table details: a narrow set — safe for SQL
 * interpolation (quotes/semicolons are impossible). */
export const dbTableComponentSchema = z
  .string()
  .regex(/^[A-Za-z0-9_$-]+$/, 'Некорректное имя схемы/таблицы');

/** The password is passed as the first line of stdin — a newline inside the
 * password is not carried by the protocol; we reject at the input, not in
 * the middle of a command. */
const passwordSchema = z
  .string()
  .refine((v) => !/[\r\n]/.test(v), 'Пароль не может содержать перевод строки');

/** The connection target. kind:'host' is a model for v2.x (a CLI client on
 * the host); the working v1 path is a container: the client is guaranteed
 * inside the image. */
const targetSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('container'),
    containerId: z.string().min(1, 'Укажите контейнер'),
  }),
  z.object({
    kind: z.literal('host'),
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
  }),
]);

export type DbConnectionTarget = z.infer<typeof targetSchema>;

export const dbConnectionInputSchema = z.object({
  profileId: z.string().min(1, 'Укажите профиль'),
  name: z.string().min(1, 'Укажите имя подключения').max(100),
  engine: z.enum(['postgres', 'mysql']),
  target: targetSchema,
  username: z.string().min(1, 'Укажите пользователя БД').max(100),
  // A password not passed on update is kept from the existing record
  // (a partial secret update, as with profiles).
  password: passwordSchema.optional(),
  defaultDatabase: dbNameSchema.optional(),
  // MariaDB differs from MySQL in the SET timeout variable name; snapshotted
  // from the image at creation (the front gets it from discovery), absence → 'mysql'.
  flavor: z.enum(['mysql', 'mariadb']).optional(),
});

export type DbConnectionInput = z.infer<typeof dbConnectionInputSchema>;

export interface DbConnection {
  id: string;
  profileId: string;
  name: string;
  engine: DbEngine;
  target: DbConnectionTarget;
  username: string;
  password: string;
  defaultDatabase?: string;
  flavor?: MysqlFlavor;
  createdAt: string;
  updatedAt: string;
}

/** A connection without the password — the API-facing form. */
export interface SafeDbConnection {
  id: string;
  profileId: string;
  name: string;
  engine: DbEngine;
  target: DbConnectionTarget;
  username: string;
  hasPassword: boolean;
  defaultDatabase?: string;
  flavor?: MysqlFlavor;
  createdAt: string;
  updatedAt: string;
}

const dbConnectionSchema = dbConnectionInputSchema.extend({
  id: z.string().min(1),
  password: passwordSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

const storeSchema = z.object({ connections: z.array(dbConnectionSchema).default([]) });

let cache: DbConnection[] | null = null;
// Set when the store file failed to parse: the broken file is moved aside
// (kept for recovery) and persist() refuses to run until a restart with a
// fixed file, so a corrupt store is never silently overwritten.
let corrupt = false;

function storePath(): string {
  return path.join(config.dataDir, 'db-connections.json');
}

function load(): DbConnection[] {
  if (!cache) {
    try {
      const raw = fs.readFileSync(storePath(), 'utf8');
      cache = storeSchema.parse(JSON.parse(raw)).connections;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        cache = [];
      } else {
        const backup = `${storePath()}.corrupt-${Date.now()}`;
        try {
          fs.renameSync(storePath(), backup);
        } catch {
          /* keep the original in place */
        }
        console.warn(`db-connections store is unreadable, moved to ${backup}; refusing to overwrite it until restart:`, err);
        corrupt = true;
        cache = [];
      }
    }
  }
  return cache;
}

function persist(list: DbConnection[]): void {
  if (corrupt) {
    throw new Error('db-connections store was corrupt at startup; refusing to overwrite it — fix or remove the *.corrupt-* file and restart');
  }
  fs.mkdirSync(config.dataDir, { recursive: true });
  const tmp = `${storePath()}.tmp`;
  // 0600: the file stores DB connection passwords in plain text.
  fs.writeFileSync(tmp, JSON.stringify({ connections: list }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, storePath());
  cache = list;
}

export function toSafeDbConnection(conn: DbConnection): SafeDbConnection {
  const { password, ...rest } = conn;
  return { ...rest, hasPassword: password !== '' };
}

export function listDbConnections(profileId?: string): DbConnection[] {
  const all = load();
  return (profileId ? all.filter((c) => c.profileId === profileId) : all)
    .map((c) => ({ ...c }));
}

export function getDbConnection(id: string): DbConnection | undefined {
  return load().find((c) => c.id === id);
}

export function requireDbConnection(id: string): DbConnection {
  const conn = getDbConnection(id);
  if (!conn) {
    throw new Error(`Подключение ${id} не найдено`);
  }
  return conn;
}

/** Validates connection fields without saving (route test-connection). */
export function parseDbConnectionInput(input: unknown): DbConnectionInput {
  return dbConnectionInputSchema.parse(input);
}

export function createDbConnection(input: unknown): DbConnection {
  const data = dbConnectionInputSchema.parse(input);
  const now = new Date().toISOString();
  const conn: DbConnection = {
    ...data,
    password: data.password ?? '',
    id: crypto.randomUUID().slice(0, 8),
    createdAt: now,
    updatedAt: now,
  };
  const list = load();
  list.push(conn);
  persist(list);
  return { ...conn };
}

export function updateDbConnection(id: string, input: unknown): DbConnection {
  const list = load();
  const idx = list.findIndex((c) => c.id === id);
  if (idx < 0) {
    throw new Error(`Подключение ${id} не найдено`);
  }
  const existing = list[idx];
  const data = dbConnectionInputSchema.parse(input);
  // A password not passed is kept from the existing record; changing the
  // profile of a connection is not provided (the id is bound to the home
  // profile).
  const updated: DbConnection = {
    ...data,
    profileId: existing.profileId,
    password: data.password ?? existing.password,
    id,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };
  list[idx] = updated;
  persist(list);
  return { ...updated };
}

export function deleteDbConnection(id: string): void {
  const list = load();
  const next = list.filter((c) => c.id !== id);
  if (next.length === list.length) {
    throw new Error(`Подключение ${id} не найдено`);
  }
  persist(next);
}
