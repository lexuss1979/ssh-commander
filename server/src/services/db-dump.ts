import type { ClientChannel } from 'ssh2';
import { execRawChannel } from '../ssh/manager.js';
import { dockerCommand } from './docker.js';
import type { DbInstance } from './db-discovery.js';
import type { Profile } from '../types.js';

/**
 * Сборка команд дампа (эпик 12): `pg_dump | gzip` / `mysqldump | gzip` внутри
 * контейнера, stdout стримится в HTTP-ответ через `execRawChannel` (паттерн
 * `transfer.ts`) — в память архив не собирается. Восстановление из дампа — v2.
 *
 * Ошибки дампа ловит роут (не exit code): без pipefail код пайпа — код gzip,
 * который успешен всегда. `set -o pipefail` не вариант: dash 0.5.11
 * (ubuntu/mariadb-образы) на неизвестной опции **абортит** скрипт (exit 2) —
 * дамп умирал бы целиком. Вместо этого роут буферизует голову stdout до
 * порога: упавший pg_dump/mysqldump не пишет ничего (gzip пустого входа даёт
 * ~20 байт) и ругается в stderr — ошибка отдаётся до отправки заголовков.
 *
 * Таймаута канала нет сознательно (как у `/api/files/download-dir`): большой
 * дамп может идти минутами; обрыв отслеживает `req.on('close')`.
 */

/** Экранирование для внутреннего shell контейнера (`sh -c`). */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Порог «пустого» архива: gzip пустого входа даёт ~20 байт; реальный дамп
 * (хоть пустой базы) — сотни байт заголовков SQL. */
export const EMPTY_GZIP_MAX_BYTES = 64;

/** Аргументы `docker exec` дампа PG (транзакционный снапшот по умолчанию). */
export function pgDumpArgs(instance: DbInstance, database: string): string[] {
  const inner = `pg_dump -U ${shellQuote(instance.user)} ${shellQuote(database)} | gzip`;
  return ['exec', instance.id, 'sh', '-c', inner];
}

/** Аргументы `docker exec` дампа MySQL (пароль — из env контейнера). */
export function mysqlDumpArgs(instance: DbInstance, database: string): string[] {
  const pwd = instance.passwordEnv ?? 'MYSQL_ROOT_PASSWORD';
  const inner =
    `MYSQL_PWD="$${pwd}" mysqldump -u ${shellQuote(instance.user)} ` +
    `--single-transaction --default-character-set=utf8mb4 ${shellQuote(database)} | gzip`;
  return ['exec', instance.id, 'sh', '-c', inner];
}

/** Полная shell-команда дампа (отдельно — под тесты двойного экранирования). */
export function buildDumpCommand(profile: Profile, instance: DbInstance, database: string): string {
  const args = instance.engine === 'postgres'
    ? pgDumpArgs(instance, database)
    : mysqlDumpArgs(instance, database);
  return dockerCommand(profile, args);
}

/** Имя файла дампа: `<база>-<ГГГГ-ММ-ДД>.sql.gz`. */
export function dumpFileName(database: string): string {
  const date = new Date().toISOString().slice(0, 10);
  return `${database}-${date}.sql.gz`;
}

/**
 * Открывает канал дампа: stdout — gzip-стрим. Вызывающий (роут) пайпит его
 * в ответ; exit code ≠ 0 до первого байта → JSON-ошибка (паттерн
 * `/api/files/download-dir`).
 */
export function openDumpChannel(
  profile: Profile,
  instance: DbInstance,
  database: string,
): Promise<ClientChannel> {
  return execRawChannel(profile, buildDumpCommand(profile, instance, database));
}
