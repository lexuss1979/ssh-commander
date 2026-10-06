import type { ClientChannel } from 'ssh2';
import { execRawChannel } from '../ssh/manager.js';
import { dockerCommand } from './docker.js';
import type { DbExecTarget } from './db-query.js';
import type { Profile } from '../types.js';

/**
 * Dump command assembly (epic 12): `pg_dump | gzip` / `mysqldump | gzip`
 * inside the container, stdout is streamed into the HTTP response via
 * `execRawChannel` (the `transfer.ts` pattern) — the archive is never
 * assembled in memory. Restoring from a dump — v2.
 *
 * The password — as in the console, the first line of stdin (`IFS= read
 * -r`): it does not show up in argv/ps and is not taken from the container's
 * stale env. An `exec` before the pipe is impossible (`exec a | b` is not
 * POSIX), so the prologue and the pipe live in one `sh -c`.
 *
 * Dump errors are caught by the route (not the exit code): without pipefail
 * the pipe code is gzip's, which always succeeds. `set -o pipefail` is not
 * an option: dash 0.5.11 (ubuntu/mariadb images) **aborts** the script on an
 * unknown option (exit 2) — the whole dump would die. Instead the route
 * buffers the head of stdout up to a threshold: a failed pg_dump/mysqldump
 * writes nothing (gzip of empty input yields ~20 bytes) and complains in
 * stderr — the error is returned before the headers are sent.
 *
 * No channel timeout deliberately (like `/api/files/download-dir`): a large
 * dump can run for minutes; `req.on('close')` tracks the disconnect.
 */

/** Escaping for the container's inner shell (`sh -c`). */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The prologue reading the password from the first line of stdin. */
function passwordPrologue(envVar: 'PGPASSWORD' | 'MYSQL_PWD', password: string): string {
  return password ? `IFS= read -r ${envVar}; export ${envVar}; ` : '';
}

/** The "empty" archive threshold: gzip of empty input yields ~20 bytes; a real
 * dump (even of an empty database) — hundreds of bytes of SQL headers. */
export const EMPTY_GZIP_MAX_BYTES = 64;

/** `docker exec` arguments for a PG dump (a transactional snapshot by default). */
export function pgDumpArgs(target: DbExecTarget, database: string): string[] {
  const inner =
    `${passwordPrologue('PGPASSWORD', target.password)}` +
    `pg_dump -U ${shellQuote(target.username)} ${shellQuote(database)} | gzip`;
  return ['exec', '-i', target.containerId, 'sh', '-c', inner];
}

/** `docker exec` arguments for a MySQL/MariaDB dump. */
export function mysqlDumpArgs(target: DbExecTarget, database: string): string[] {
  const inner =
    `${passwordPrologue('MYSQL_PWD', target.password)}` +
    `mysqldump -u ${shellQuote(target.username)} ` +
    `--single-transaction --default-character-set=utf8mb4 ${shellQuote(database)} | gzip`;
  return ['exec', '-i', target.containerId, 'sh', '-c', inner];
}

/** The full dump shell command (kept separate for double-escaping tests). */
export function buildDumpCommand(profile: Profile, target: DbExecTarget, database: string): string {
  const args = target.engine === 'postgres'
    ? pgDumpArgs(target, database)
    : mysqlDumpArgs(target, database);
  return dockerCommand(profile, args);
}

/** Dump file name: `<database>-<YYYY-MM-DD>.sql.gz`. */
export function dumpFileName(database: string): string {
  const date = new Date().toISOString().slice(0, 10);
  return `${database}-${date}.sql.gz`;
}

/**
 * Opens the dump channel: stdout is a gzip stream. The password is written
 * as the first line into the channel stdin and closed on EOF (`end()` — a
 * half-close, stdout keeps being read); without a password the EOF is still
 * needed — the `read` in the command prologue blocks until the end of stdin.
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
