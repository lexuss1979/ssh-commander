import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';
import type { DbEngine, MysqlFlavor } from './db-discovery.js';

/**
 * Хранилище подключений БД (итерация 2 эпика 12): подключение — сохранённая
 * сущность с явными креденшалами, как в DBeaver/TablePlus. Паттерн
 * `profiles.ts`: zod-валидация, атомарная запись tmp+rename, corrupt-guard,
 * пароль открытым текстом — тот же trust domain, что у SSH-паролей в
 * `profiles.json` (осознанный компромисс локального инструмента).
 */

/** Имя базы — идентификатор без спецсимволов (latin/цифры/подчёркивание);
 * кавычек mysql/PG идентификаторы с иными символами и не создают. */
export const dbNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9_$-]+$/, 'Некорректное имя базы');

/** Имя схемы/таблицы для деталей таблицы: узкий набор — безопасно для
 * интерполяции в SQL (кавычки/точки с запятой невозможны). */
export const dbTableComponentSchema = z
  .string()
  .regex(/^[A-Za-z0-9_$-]+$/, 'Некорректное имя схемы/таблицы');

/** Пароль передаётся первой строкой stdin — перевод строки внутри пароля
 * протокол не переносит, отказываем на входе, а не посреди команды. */
const passwordSchema = z
  .string()
  .refine((v) => !/[\r\n]/.test(v), 'Пароль не может содержать перевод строки');

/** Цель подключения. kind:'host' — модель для v2.x (CLI-клиент на хосте);
 * рабочий путь v1 — контейнер: клиент гарантирован внутри образа. */
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
  // Непереданный при update пароль сохраняется из существующей записи
  // (частичный update секрета, как у профилей).
  password: passwordSchema.optional(),
  defaultDatabase: dbNameSchema.optional(),
  // MariaDB отличается от MySQL именем переменной SET-таймаута; снапшот с
  // образа при создании (фронт получает из discovery), absence → 'mysql'.
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

/** Подключение без пароля — форма для API наружу. */
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
  // 0600: файл хранит пароли подключений к БД открытым текстом.
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

/** Валидирует поля подключения без сохранения (route test-connection). */
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
  // Непереданный пароль сохраняется из существующей записи; смена профиля
  // у подключения не предусмотрена (id привязан к домашнему профилю).
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
