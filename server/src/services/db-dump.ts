import type { ClientChannel } from 'ssh2';
import { execRawChannel } from '../ssh/manager.js';
import { dockerCommand } from './docker.js';
import type { DbExecTarget } from './db-query.js';
import type { Profile } from '../types.js';

/**
 * Сборка команд дампа (эпик 12): `pg_dump | gzip` / `mysqldump | gzip` внутри
 * контейнера, stdout стримится в HTTP-ответ через `execRawChannel` (паттерн
 * `transfer.ts`) — в память архив не собирается. Восстановление из дампа — v2.
 *
 * Пароль — как в консоли, первой строкой stdin (`IFS= read -r`): не светится
 * в argv/ps и не берётся из протухшего env контейнера. `exec` перед пайпом
 * невозможен (`exec a | b` — не POSIX), поэтому пролог и пайп в одном `sh -c`.
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

/** Пролог чтения пароля из первой строки stdin. */
function passwordPrologue(envVar: 'PGPASSWORD' | 'MYSQL_PWD', password: string): string {
  return password ? `IFS= read -r ${envVar}; export ${envVar}; ` : '';
}

/** Порог «пустого» архива: gzip пустого входа даёт ~20 байт; реальный дамп
 * (хоть пустой базы) — сотни байт заголовков SQL. */
export const EMPTY_GZIP_MAX_BYTES = 64;

/** Аргументы `docker exec` дампа PG (транзакционный снапшот по умолчанию). */
export function pgDumpArgs(target: DbExecTarget, database: string): string[] {
  const inner =
    `${passwordPrologue('PGPASSWORD', target.password)}` +
    `pg_dump -U ${shellQuote(target.username)} ${shellQuote(database)} | gzip`;
  return ['exec', '-i', target.containerId, 'sh', '-c', inner];
}

/** Аргументы `docker exec` дампа MySQL/MariaDB. */
export function mysqlDumpArgs(target: DbExecTarget, database: string): string[] {
  const inner =
    `${passwordPrologue('MYSQL_PWD', target.password)}` +
    `mysqldump -u ${shellQuote(target.username)} ` +
    `--single-transaction --default-character-set=utf8mb4 ${shellQuote(database)} | gzip`;
  return ['exec', '-i', target.containerId, 'sh', '-c', inner];
}

/** Полная shell-команда дампа (отдельно — под тесты двойного экранирования). */
export function buildDumpCommand(profile: Profile, target: DbExecTarget, database: string): string {
  const args = target.engine === 'postgres'
    ? pgDumpArgs(target, database)
    : mysqlDumpArgs(target, database);
  return dockerCommand(profile, args);
}

/** Имя файла дампа: `<база>-<ГГГГ-ММ-ДД>.sql.gz`. */
export function dumpFileName(database: string): string {
  const date = new Date().toISOString().slice(0, 10);
  return `${database}-${date}.sql.gz`;
}

/**
 * Открывает канал дампа: stdout — gzip-стрим. Пароль пишется первой строкой
 * в stdin канала и закрывается на EOF (`end()` — половинное закрытие,
 * stdout продолжает читаться); без пароля EOF всё равно нужен — `read` в
 * прологе команды блокируется до конца stdin.
 */
export async function openDumpChannel(
  profile: Profile,
  target: DbExecTarget,
  database: string,
): Promise<ClientChannel> {
  const channel = await execRawChannel(profile, buildDumpCommand(profile, target, database));
  if (target.password) {
    channel.write(`${target.password}\n`);
  }
  channel.end();
  return channel;
}
