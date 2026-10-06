import { exec } from '../ssh/manager.js';
import { dockerCommand } from './docker.js';
import type { DbEngine, MysqlFlavor } from './db-discovery.js';
import type { Profile } from '../types.js';

/**
 * Command builders and SQL console output parsers (epic 12, iteration 2).
 * Everything is pure — for unit tests; the thin `runDbQuery` wrapper does
 * the SSH exec.
 *
 * Escaping scheme: docker arguments are shell-quoted once (`dockerCommand`
 * → the remote shell passes them to docker verbatim), while user/database
 * names inside `sh -c '...'` are quoted a second time (the container's inner
 * shell). SQL goes to the channel stdin and never touches a shell at all.
 *
 * The user password must not come from the container env (it is not there or
 * is stale — the reason iteration 1 was rolled back), and
 * `docker exec -e PGPASSWORD=...` exposes it in the host's argv/ps. The
 * solution is the first line of stdin:
 *
 *   docker exec -i <c> sh -c 'IFS= read -r PGPASSWORD; export PGPASSWORD;
 *   exec psql -U <user> -d <db> -X -v ON_ERROR_STOP=1 --csv'
 *
 * Channel stdin: `<password>\n<SQL>`. `read` consumes the first line, the
 * client gets the rest. `IFS=` and `-r` are mandatory (edge spaces and
 * backslashes in the password). The password never lands in argv, the host
 * env, or logs.
 */

/** Statement timeout inside the DB (s); the channel backstop is 120 s (see routes). */
export const DB_STATEMENT_TIMEOUT_S = 115;
/** SSH channel timeout — a backstop against a hung docker exec. */
export const DB_CHANNEL_TIMEOUT_MS = 120000;
/** Connection check timeout (SELECT 1) — fast, no data queries. */
export const DB_TEST_TIMEOUT_MS = 15000;
/** Grid row limit; the excess is cut with a marker in the UI. */
export const DB_ROW_LIMIT = 1000;
/** Max SQL size (the route's zod limit must match). */
export const DB_SQL_MAX_BYTES = 64 * 1024;
/** Collapsed full stdout for the UI (a scrollable mono block). */
export const RAW_OUTPUT_LIMIT = 64 * 1024;

/** System databases hidden from the lists (the epic 12 plan). */
export const SYSTEM_DATABASES = new Set([
  'information_schema',
  'performance_schema',
  'sys',
  'template0',
  'template1',
]);

/** PG system schemas hidden from the table list. */
export const PG_SYSTEM_SCHEMAS = new Set(['pg_catalog', 'information_schema']);

/**
 * An allowed execution target: a store connection reduced to the builders'
 * shape. Container is the working v1 path; host is v2.x.
 */
export interface DbExecTarget {
  engine: DbEngine;
  containerId: string;
  username: string;
  /** '' — no password (PG in the official image: local trust); non-empty —
   * passed as the first stdin line. */
  password: string;
  /** MariaDB family — a different SET-timeout syntax. */
  flavor?: MysqlFlavor;
  /** Default database from the connection; null — none. */
  defaultDatabase: string | null;
}

// ---------------------------------------------------------------------------
// Command builders
// ---------------------------------------------------------------------------

/** Prologue reading the password from the first stdin line (no line feed: `read`
 * takes the line up to `\n`, the tail is already SQL). */
function passwordPrologue(envVar: 'PGPASSWORD' | 'MYSQL_PWD', password: string): string {
  return password ? `IFS= read -r ${envVar}; export ${envVar}; ` : '';
}

/**
 * `docker exec` arguments for psql. SQL goes to the channel stdin after the
 * password (no argv size limit); the timeout is passed via the PGOPTIONS env:
 * it applies before any statement and does not depend on the read-only
 * switch in the query text.
 */
export function psqlArgs(target: DbExecTarget, database: string): string[] {
  const inner =
    `${passwordPrologue('PGPASSWORD', target.password)}` +
    `exec psql -U ${shellQuote(target.username)} -d ${shellQuote(database)} ` +
    `-X -v ON_ERROR_STOP=1 --csv`;
  return [
    'exec', '-i',
    '-e', `PGOPTIONS=-c statement_timeout=${DB_STATEMENT_TIMEOUT_S}s`,
    target.containerId,
    'sh', '-c', inner,
  ];
}

/**
 * `docker exec` arguments for mysql. The password comes from the first line
 * of stdin (MYSQL_PWD), not from env or argv. `database: null` — connect
 * without a default schema (service queries): a dedicated user without
 * rights on someone else's system database must not fail with "Access
 * denied" before its own query.
 */
export function mysqlArgs(target: DbExecTarget, database: string | null): string[] {
  const inner =
    `${passwordPrologue('MYSQL_PWD', target.password)}` +
    `exec mysql -u ${shellQuote(target.username)} ` +
    `--batch --default-character-set=utf8mb4${database ? ` ${shellQuote(database)}` : ''}`;
  return ['exec', '-i', target.containerId, 'sh', '-c', inner];
}

/**
 * Guarantees a statement terminator: psql silently drops an unfinished
 * buffer at EOF — `SELECT 1` without `;` would return empty output with
 * exit 0. The semicolon goes on its own line: a trailing `-- comment`
 * swallows the `;` in its own line, while on a new line it properly
 * terminates the statement. Trailing meta-commands (`… \g` psql, `… \G`
 * mysql — they execute the buffer) and a `\` continuation are left as is.
 */
export function ensureTerminator(sql: string): string {
  const t = sql.trim();
  if (!t || t.endsWith(';') || t.endsWith('\\') || /(?:^|\s)\\[a-z]+$/i.test(t)) return t;
  return `${t}\n;`;
}

/**
 * SQL part of stdin: the statement timeout (MySQL — in SQL, PG has it in
 * PGOPTIONS), the read-only switch and the query itself. Read-only is a
 * guard against accidents, not intent: a user's `SET … = off` lifts it
 * (documented in the UI and AGENTS.md).
 */
export function buildStdinSql(
  engine: DbEngine,
  sql: string,
  opts: { readOnly: boolean; flavor?: 'mysql' | 'mariadb' },
): string {
  const parts: string[] = [];
  if (engine === 'mysql') {
    parts.push(
      opts.flavor === 'mariadb'
        ? `SET SESSION max_statement_time=${DB_STATEMENT_TIMEOUT_S};`
        : `SET SESSION max_execution_time=${DB_STATEMENT_TIMEOUT_S * 1000};`,
    );
  }
  if (opts.readOnly) {
    parts.push(
      engine === 'postgres'
        ? 'SET default_transaction_read_only = on;'
        : 'SET SESSION TRANSACTION READ ONLY;',
    );
  }
  parts.push(ensureTerminator(sql));
  return `${parts.join('\n')}\n`;
}

/**
 * Full channel stdin: with a non-empty password it goes first (consumed by
 * `read` in the command prologue), then SQL. An empty password writes
 * nothing — no prologue in the command, SQL starts right away.
 */
export function buildChannelStdin(
  target: DbExecTarget,
  sql: string,
  opts: { readOnly: boolean },
): string {
  const body = buildStdinSql(target.engine, sql, { readOnly: opts.readOnly, flavor: target.flavor });
  return target.password ? `${target.password}\n${body}` : body;
}

/** Quoting for the container's inner shell (`sh -c`). */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// Output parsers
// ---------------------------------------------------------------------------

export interface ParsedTable {
  columns: string[];
  rows: string[][];
  /** Output truncated by the limit (maxOutput) — the last line was dropped. */
  truncated: boolean;
  /** Lines after a column mismatch (multi-statement output) — not for the grid. */
  stoppedEarly: boolean;
}

/**
 * Parser of psql's CSV output (`--csv`, RFC 4180: quotes, commas and line
 * feeds inside values). The first line is the header; on a column-count
 * mismatch (a second result set / command tag) further lines are not taken —
 * the full stdout stays in rawOutput. Output without a trailing `\n` means
 * the limit cut it: the last incomplete line is dropped, truncated=true.
 */
export function parseCsvTable(out: string): ParsedTable {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let i = 0;

  while (i < out.length) {
    const ch = out[i];
    if (inQuotes) {
      if (ch === '"') {
        if (out[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      cell += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ',') {
      row.push(cell);
      cell = '';
      i++;
      continue;
    }
    if (ch === '\r' && out[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i += 2;
      continue;
    }
    if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
      continue;
    }
    cell += ch;
    i++;
  }

  // A tail without a line feed: psql terminates every line with `\n` (or
  // `\r\n`), so the output was cut by the limit — drop the line.
  let truncated = false;
  if (cell || row.length > 0 || inQuotes) {
    truncated = true;
  }

  return finishTable(rows, truncated);
}

/**
 * Parser of mysql's TSV output (`--batch`): columns are real tabs; `\t`, `\n`,
 * `\\` and `\0` inside values are escaped — we unescape them. NULL arrives
 * as the string `NULL` and is indistinguishable from the value 'NULL' — a
 * known limitation (pinned by a documentation test). An incomplete last line
 * (without the trailing `\n`) is dropped, truncated=true.
 */
export function parseTsvTable(out: string): ParsedTable {
  const lines = out.split('\n');
  // split keeps an empty tail after the final `\n`; a non-empty tail —
  // the output was cut by the limit, drop the last incomplete line.
  const trailing = lines.pop();
  const truncated = trailing !== undefined && trailing !== '';
  const rows = lines.map((line) => line.split('\t').map(unescapeMysql));
  return finishTable(rows, truncated);
}

/** `\t`/`\n`/`\\`/`\0` → real characters (mysql batch escaping). */
export function unescapeMysql(s: string): string {
  return s.replace(/\\(.)/g, (m, c: string) => {
    switch (c) {
      case 'n': return '\n';
      case 't': return '\t';
      case '0': return '\0';
      default: return c; // `\\` → `\`, other `\x` — as is
    }
  });
}

/** Header + rows up to the first column-count mismatch. */
function finishTable(rows: string[][], truncated: boolean): ParsedTable {
  if (rows.length === 0) {
    return { columns: [], rows: [], truncated, stoppedEarly: false };
  }
  const columns = rows[0];
  const result: string[][] = [];
  let stoppedEarly = false;
  for (let r = 1; r < rows.length; r++) {
    if (rows[r].length !== columns.length) {
      stoppedEarly = true;
      break;
    }
    result.push(rows[r]);
  }
  return { columns, rows: result, truncated, stoppedEarly };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface DbQueryResult {
  columns: string[];
  rows: string[][];
  /** Row count in the grid (≤ DB_ROW_LIMIT). */
  rowCount: number;
  /** Total result rows before the limit cut. */
  totalRows: number;
  durationMs: number;
  truncated: boolean;
  /** Full stdout when the grid could not fit everything (multi-statement output). */
  rawOutput?: string;
}

export class DbQueryError extends Error {
  stderr: string;
  exitCode: number | null;

  constructor(message: string, stderr: string, exitCode: number | null) {
    super(message);
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

/** DB client error message (stderr first — that is where "Access denied" lives). */
function clientErrorMessage(result: { code: number | null; stdout: string; stderr: string }): string {
  return (
    result.stderr.trim()
    || result.stdout.trim()
    || `Клиент БД завершился с кодом ${result.code}`
  );
}

/** The full shell command for a query (kept separate — for double-escaping tests). */
export function buildQueryCommand(
  profile: Profile,
  target: DbExecTarget,
  database: string | null,
): string {
  const args = target.engine === 'postgres'
    ? psqlArgs(target, database ?? 'postgres')
    : mysqlArgs(target, database);
  return dockerCommand(profile, args);
}

/**
 * Runs SQL via the CLI client inside the container: the password and SQL go
 * to the channel stdin, output up to 2 MB (the standard exec limit). A
 * non-zero exit code → DbQueryError with the client's stderr and the code —
 * the UI shows them in a mono block.
 */
export async function runDbQuery(
  profile: Profile,
  target: DbExecTarget,
  database: string,
  sql: string,
  readOnly: boolean,
): Promise<DbQueryResult> {
  const command = buildQueryCommand(profile, target, database);
  const stdin = buildChannelStdin(target, sql, { readOnly });
  const startedAt = Date.now();
  const result = await exec(profile, command, {
    timeoutMs: DB_CHANNEL_TIMEOUT_MS,
    stdin,
  });
  const durationMs = Date.now() - startedAt;
  if (result.code !== 0) {
    throw new DbQueryError(clientErrorMessage(result), result.stderr.trim(), result.code);
  }

  const parsed = target.engine === 'postgres'
    ? parseCsvTable(result.stdout)
    : parseTsvTable(result.stdout);
  const totalRows = parsed.rows.length;
  const rows = parsed.rows.slice(0, DB_ROW_LIMIT);
  const limited = totalRows > rows.length;
  const response: DbQueryResult = {
    columns: parsed.columns,
    rows,
    rowCount: rows.length,
    totalRows,
    durationMs,
    truncated: parsed.truncated,
  };
  // The full stdout is needed when the grid does not show everything: no
  // result set, truncation, or several statements.
  if (parsed.stoppedEarly || parsed.columns.length === 0 || limited || parsed.truncated) {
    response.rawOutput = result.stdout.slice(0, RAW_OUTPUT_LIMIT);
  }
  return response;
}

/**
 * Credential check without saving (route `/connections/test`, the
 * `profiles/test-connection` pattern): a one-shot `SELECT 1` over the
 * console channel. A client error (Access denied) is passed through as is —
 * visible before saving.
 */
export async function testDbConnection(profile: Profile, target: DbExecTarget): Promise<void> {
  const command = buildQueryCommand(
    profile,
    target,
    target.defaultDatabase ?? (target.engine === 'postgres' ? 'postgres' : null),
  );
  const result = await exec(profile, command, {
    timeoutMs: DB_TEST_TIMEOUT_MS,
    stdin: buildChannelStdin(target, 'SELECT 1', { readOnly: true }),
  });
  if (result.code !== 0) {
    throw new DbQueryError(clientErrorMessage(result), result.stderr.trim(), result.code);
  }
}

// ---------------------------------------------------------------------------
// Service queries (lists, overview)
// ---------------------------------------------------------------------------

export interface DbDatabaseInfo {
  name: string;
  sizeBytes: number | null;
  tableCount: number | null;
}

export interface DbTableInfo {
  schema: string;
  name: string;
}

export interface DbColumnInfo {
  schema: string;
  table: string;
  name: string;
}

/** List of PG databases with sizes (system ones hidden); null on permission denial. */
export const PG_DATABASES_SQL =
  `SELECT datname AS name, pg_database_size(datname) AS size\n` +
  `FROM pg_database\n` +
  `WHERE datallowconn AND datname <> ALL (ARRAY['template0','template1'])\n` +
  `ORDER BY 1`;

/** List of PG tables across all non-system schemas of the connected database. */
export const PG_TABLES_SQL =
  `SELECT table_schema AS schema, table_name AS name\n` +
  `FROM information_schema.tables\n` +
  `WHERE table_schema <> ALL (ARRAY['pg_catalog','information_schema'])\n` +
  `ORDER BY 1, 2`;

/** Table count of the connected PG database. */
export const PG_TABLE_COUNT_SQL =
  `SELECT count(*) FROM information_schema.tables\n` +
  `WHERE table_schema <> ALL (ARRAY['pg_catalog','information_schema'])`;

/** List of MySQL databases with sizes and table counts in one command. */
export const MYSQL_DATABASES_SQL =
  `SELECT table_schema AS name, COALESCE(SUM(data_length + index_length), 0) AS size, COUNT(*) AS tables\n` +
  `FROM information_schema.tables\n` +
  `GROUP BY table_schema\n` +
  `ORDER BY 1`;

/** List of tables of the selected MySQL database (DATABASE() — interpolation-proof). */
export const MYSQL_TABLES_SQL =
  `SELECT table_schema AS schema, table_name AS name\n` +
  `FROM information_schema.tables\n` +
  `WHERE table_schema = DATABASE()\n` +
  `ORDER BY 1, 2`;

/** Columns of PG tables across all non-system schemas (for the agent prompt schema). */
export const PG_COLUMNS_SQL =
  `SELECT table_schema AS schema, table_name AS "table", column_name AS "column"\n` +
  `FROM information_schema.columns\n` +
  `WHERE table_schema <> ALL (ARRAY['pg_catalog','information_schema'])\n` +
  `ORDER BY table_schema, table_name, ordinal_position`;

/** Columns of tables of the selected MySQL database (DATABASE() — no name interpolation). */
export const MYSQL_COLUMNS_SQL =
  'SELECT table_schema AS `schema`, table_name AS `table`, column_name AS `column`\n' +
  'FROM information_schema.columns\n' +
  'WHERE table_schema = DATABASE()\n' +
  'ORDER BY table_schema, table_name, ordinal_position';

/** Upper bound on columns in the /columns response (bounds the schema prompt). */
export const DB_COLUMNS_LIMIT = 4000;

export function isSystemDatabase(name: string): boolean {
  return SYSTEM_DATABASES.has(name.toLowerCase());
}

/** A number or null; 0 is a valid value (an empty database's size), not null. */
function toNumberOrNull(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parses the databases query output into `DbDatabaseInfo[]` (shared by CSV
 * and TSV: columns name[, size][, tables]). System databases are filtered.
 */
export function parseDatabaseList(parsed: ParsedTable, engine: DbEngine): DbDatabaseInfo[] {
  const list: DbDatabaseInfo[] = [];
  for (const row of parsed.rows) {
    const name = row[parsed.columns.indexOf('name')] ?? '';
    if (!name || isSystemDatabase(name)) continue;
    const tablesRaw = row[parsed.columns.indexOf('tables')];
    list.push({
      name,
      sizeBytes: toNumberOrNull(row[parsed.columns.indexOf('size')]),
      // For PG the table count arrives as a separate per-database query — null here.
      tableCount: engine === 'mysql' ? toNumberOrNull(tablesRaw) : null,
    });
  }
  return list;
}

/** Parses the tables query output (columns schema, name). */
export function parseTableList(parsed: ParsedTable, engine: DbEngine): DbTableInfo[] {
  const tables: DbTableInfo[] = [];
  for (const row of parsed.rows) {
    const schema = row[parsed.columns.indexOf('schema')] ?? '';
    const name = row[parsed.columns.indexOf('name')] ?? '';
    if (!name) continue;
    if (engine === 'postgres' && PG_SYSTEM_SCHEMAS.has(schema.toLowerCase())) continue;
    if (engine === 'mysql' && isSystemDatabase(schema)) continue;
    tables.push({ schema, name });
  }
  return tables;
}

/** Parses the columns query output (schema, table, column) — for the agent prompt. */
export function parseColumnList(parsed: ParsedTable, engine: DbEngine): DbColumnInfo[] {
  const columns: DbColumnInfo[] = [];
  for (const row of parsed.rows) {
    const schema = row[parsed.columns.indexOf('schema')] ?? '';
    const table = row[parsed.columns.indexOf('table')] ?? '';
    const name = row[parsed.columns.indexOf('column')] ?? '';
    if (!table || !name) continue;
    if (engine === 'postgres' && PG_SYSTEM_SCHEMAS.has(schema.toLowerCase())) continue;
    if (engine === 'mysql' && isSystemDatabase(schema)) continue;
    columns.push({ schema, table, name });
  }
  return columns.slice(0, DB_COLUMNS_LIMIT);
}

/** List of PG database names without sizes (fallback when pg_database_size is denied). */
export const PG_DATABASES_FALLBACK_SQL =
  `SELECT datname AS name FROM pg_database WHERE datallowconn ORDER BY 1`;

/** All MySQL schemas (empty databases included — the sizes query misses them). */
export const MYSQL_SCHEMATA_SQL =
  `SELECT schema_name AS name FROM information_schema.schemata ORDER BY 1`;

/** Runs a service SELECT and returns the parsed table. */
export async function runDbMetaQuery(
  profile: Profile,
  target: DbExecTarget,
  database: string | null,
  sql: string,
): Promise<ParsedTable> {
  const command = buildQueryCommand(profile, target, database);
  const result = await exec(profile, command, {
    timeoutMs: DB_CHANNEL_TIMEOUT_MS,
    stdin: buildChannelStdin(target, sql, { readOnly: true }),
  });
  if (result.code !== 0) {
    throw new DbQueryError(clientErrorMessage(result), result.stderr.trim(), result.code);
  }
  return target.engine === 'postgres'
    ? parseCsvTable(result.stdout)
    : parseTsvTable(result.stdout);
}

/**
 * Database for service queries when the user has not selected one. MySQL:
 * a default schema is not needed and may be inaccessible to a user without
 * rights on someone else's database — connect without a database (null). PG
 * cannot do without -d — default to 'postgres' (open to all local users in
 * the official image).
 */
function metaDatabase(target: DbExecTarget): string | null {
  return target.defaultDatabase ?? (target.engine === 'postgres' ? 'postgres' : null);
}

/** Server version (`SELECT version()` / `SELECT @@version`). */
export async function fetchDbVersion(profile: Profile, target: DbExecTarget): Promise<string> {
  const sql = target.engine === 'postgres'
    ? 'SELECT version() AS version'
    : 'SELECT @@version AS version';
  const table = await runDbMetaQuery(profile, target, metaDatabase(target), sql);
  return table.rows[0]?.[0] ?? '';
}

export interface DbOverview {
  engine: DbEngine;
  version: string;
  databases: DbDatabaseInfo[];
}

/** Cap on the databases PG counts tables for (one exec per database). */
export const PG_TABLE_COUNT_DB_LIMIT = 25;

/**
 * Connection overview: version, databases with sizes and table counts. PG
 * counts tables per database with a separate query (no cross-DB queries);
 * sizes are unavailable without rights → fallback to the name list. MySQL
 * takes empty databases from schemata and merges them with the sizes query.
 */
export async function fetchDbOverview(profile: Profile, target: DbExecTarget): Promise<DbOverview> {
  const version = await fetchDbVersion(profile, target);
  const meta = metaDatabase(target);

  if (target.engine === 'postgres') {
    let list: DbDatabaseInfo[];
    try {
      list = parseDatabaseList(
        await runDbMetaQuery(profile, target, meta, PG_DATABASES_SQL), 'postgres');
    } catch {
      list = parseDatabaseList(
        await runDbMetaQuery(profile, target, meta, PG_DATABASES_FALLBACK_SQL), 'postgres');
    }
    for (const db of list.slice(0, PG_TABLE_COUNT_DB_LIMIT)) {
      try {
        const t = await runDbMetaQuery(profile, target, db.name, PG_TABLE_COUNT_SQL);
        db.tableCount = Number(t.rows[0]?.[0]) || 0;
      } catch {
        /* no rights on the database — the count stays null */
      }
    }
    return { engine: target.engine, version, databases: list };
  }

  const byName = new Map(
    parseDatabaseList(await runDbMetaQuery(profile, target, meta, MYSQL_DATABASES_SQL), 'mysql')
      .map((d) => [d.name, d]),
  );
  const list = parseDatabaseList(
    await runDbMetaQuery(profile, target, meta, MYSQL_SCHEMATA_SQL), 'mysql');
  return {
    engine: target.engine,
    version,
    databases: list.map((d) => byName.get(d.name) ?? { ...d, sizeBytes: 0, tableCount: 0 }),
  };
}

/** List of database names (no sizes — a cheap alternative to the overview). */
export async function fetchDbDatabases(profile: Profile, target: DbExecTarget): Promise<string[]> {
  const sql = target.engine === 'postgres' ? PG_DATABASES_FALLBACK_SQL : MYSQL_SCHEMATA_SQL;
  const list = parseDatabaseList(
    await runDbMetaQuery(profile, target, metaDatabase(target), sql), target.engine);
  return list.map((d) => d.name);
}

/** List of database tables (schema + name; system schemas filtered out). */
export async function fetchDbTables(
  profile: Profile,
  target: DbExecTarget,
  database: string,
): Promise<DbTableInfo[]> {
  const sql = target.engine === 'postgres' ? PG_TABLES_SQL : MYSQL_TABLES_SQL;
  return parseTableList(
    await runDbMetaQuery(profile, target, database, sql), target.engine);
}

/** Columns of database tables (for the schema in the "Ask the agent" prompt). */
export async function fetchDbColumns(
  profile: Profile,
  target: DbExecTarget,
  database: string,
): Promise<DbColumnInfo[]> {
  const sql = target.engine === 'postgres' ? PG_COLUMNS_SQL : MYSQL_COLUMNS_SQL;
  return parseColumnList(
    await runDbMetaQuery(profile, target, database, sql), target.engine);
}

// ---------------------------------------------------------------------------
// Table details: fields (types, keys) and indexes (name, columns, type)
// ---------------------------------------------------------------------------

export interface DbColumnDetail {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  key: 'pk' | 'fk' | 'uq' | null;
}

export interface DbIndexDetail {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
}

export interface DbTableDetail {
  schema: string;
  table: string;
  columns: DbColumnDetail[];
  indexes: DbIndexDetail[];
}

/** SQL literal with single quotes escaped (goes to stdin, never to a shell). */
function sqlLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** PG table fields: name, type, nullability, default + the column's constraint types. */
export function pgTableDetailColumnsSql(schema: string, table: string): string {
  const s = sqlLiteral(schema);
  const t = sqlLiteral(table);
  return (
    `SELECT c.column_name AS name,\n` +
    `       c.data_type AS type,\n` +
    `       c.is_nullable AS nullable,\n` +
    `       c.column_default AS "default",\n` +
    `       (SELECT string_agg(DISTINCT tc.constraint_type, ',')\n` +
    `          FROM information_schema.key_column_usage kcu\n` +
    `          JOIN information_schema.table_constraints tc\n` +
    `            ON tc.constraint_name = kcu.constraint_name\n` +
    `           AND tc.constraint_schema = kcu.constraint_schema\n` +
    `           AND tc.table_schema = kcu.table_schema\n` +
    `           AND tc.table_name = kcu.table_name\n` +
    `         WHERE kcu.table_schema = c.table_schema\n` +
    `           AND kcu.table_name = c.table_name\n` +
    `           AND kcu.column_name = c.column_name) AS constraints\n` +
    `FROM information_schema.columns c\n` +
    `WHERE c.table_schema = ${s} AND c.table_name = ${t}\n` +
    `ORDER BY c.ordinal_position`
  );
}

/** PG table indexes (name, uniqueness, primarity, definition — columns are parsed from it). */
export function pgTableDetailIndexesSql(schema: string, table: string): string {
  const s = sqlLiteral(schema);
  const t = sqlLiteral(table);
  return (
    `SELECT i.relname AS index_name,\n` +
    `       ix.indisprimary AS is_primary,\n` +
    `       ix.indisunique AS is_unique,\n` +
    `       pg_get_indexdef(i.oid) AS def\n` +
    `FROM pg_index ix\n` +
    `JOIN pg_class i ON i.oid = ix.indexrelid\n` +
    `JOIN pg_class t ON t.oid = ix.indrelid\n` +
    `JOIN pg_namespace ns ON ns.oid = t.relnamespace\n` +
    `WHERE ns.nspname = ${s} AND t.relname = ${t}\n` +
    `ORDER BY ix.indisprimary DESC, i.relname`
  );
}

/** MySQL table fields (COLUMN_KEY: PRI/UNI/MUL). */
export function mysqlTableDetailColumnsSql(table: string): string {
  const t = sqlLiteral(table);
  return (
    `SELECT column_name AS name,\n` +
    `       column_type AS type,\n` +
    `       is_nullable AS nullable,\n` +
    `       column_default AS \`default\`,\n` +
    `       column_key AS \`key\`\n` +
    `FROM information_schema.columns\n` +
    `WHERE table_schema = DATABASE() AND table_name = ${t}\n` +
    `ORDER BY ordinal_position`
  );
}

/** MySQL table indexes/keys (per column; grouped by index name). */
export function mysqlTableDetailIndexesSql(table: string): string {
  const t = sqlLiteral(table);
  return (
    `SELECT index_name AS name, column_name AS col, non_unique AS non_unique\n` +
    `FROM information_schema.statistics\n` +
    `WHERE table_schema = DATABASE() AND table_name = ${t}\n` +
    `ORDER BY index_name, seq_in_index`
  );
}

function columnKeyFromConstraints(constraints: string): DbColumnDetail['key'] {
  const c = constraints.toUpperCase();
  if (c.includes('PRIMARY KEY')) return 'pk';
  if (c.includes('UNIQUE')) return 'uq';
  if (c.includes('FOREIGN KEY')) return 'fk';
  return null;
}

function mysqlKeyFromColumnKey(k: string): DbColumnDetail['key'] {
  if (k === 'PRI') return 'pk';
  if (k === 'UNI') return 'uq';
  if (k === 'MUL') return 'fk';
  return null;
}

/** Index columns from `pg_get_indexdef` — the first balanced parenthesized group. */
export function parseIndexColumnsFromDef(def: string): string[] {
  const open = def.indexOf('(');
  if (open === -1) return [];
  let depth = 0;
  for (let i = open; i < def.length; i++) {
    if (def[i] === '(') depth++;
    else if (def[i] === ')') {
      depth--;
      if (depth === 0) {
        return def
          .slice(open + 1, i)
          .split(',')
          .map((c) => c.trim())
          .filter(Boolean);
      }
    }
  }
  return [];
}

/** Parses the fields query output into `DbColumnDetail[]`. */
export function parseColumnDetail(parsed: ParsedTable, engine: DbEngine): DbColumnDetail[] {
  const cols = parsed.columns;
  const out: DbColumnDetail[] = [];
  for (const row of parsed.rows) {
    const name = row[cols.indexOf('name')] ?? '';
    if (!name) continue;
    const rawType = row[cols.indexOf('type')] ?? '';
    const nullable = (row[cols.indexOf('nullable')] ?? '').toUpperCase() === 'YES';
    const rawDefault = row[cols.indexOf('default')] ?? '';
    const def = rawDefault === '' || rawDefault === 'NULL' || rawDefault === '\\N' ? null : rawDefault;
    const key =
      engine === 'postgres'
        ? columnKeyFromConstraints(row[cols.indexOf('constraints')] ?? '')
        : mysqlKeyFromColumnKey(row[cols.indexOf('key')] ?? '');
    out.push({ name, type: rawType, nullable, default: def, key });
  }
  return out;
}

/** Parses the indexes query output into `DbIndexDetail[]`. */
export function parseIndexDetail(parsed: ParsedTable, engine: DbEngine): DbIndexDetail[] {
  const cols = parsed.columns;
  const out: DbIndexDetail[] = [];
  if (engine === 'postgres') {
    for (const row of parsed.rows) {
      const name = row[cols.indexOf('index_name')] ?? '';
      if (!name) continue;
      const uni = row[cols.indexOf('is_unique')] ?? '';
      const pri = row[cols.indexOf('is_primary')] ?? '';
      out.push({
        name,
        columns: parseIndexColumnsFromDef(row[cols.indexOf('def')] ?? ''),
        unique: uni === 't' || uni === 'true' || uni === '1',
        primary: pri === 't' || pri === 'true' || pri === '1',
      });
    }
    return out;
  }
  // MySQL: group rows by index name
  const byName = new Map<string, DbIndexDetail>();
  for (const row of parsed.rows) {
    const name = row[cols.indexOf('name')] ?? '';
    if (!name) continue;
    let d = byName.get(name);
    if (!d) {
      d = {
        name,
        columns: [],
        unique: row[cols.indexOf('non_unique')] === '0',
        primary: name === 'PRIMARY',
      };
      byName.set(name, d);
    }
    const col = row[cols.indexOf('col')] ?? '';
    if (col) d.columns.push(col);
  }
  return [...byName.values()];
}

/** Table details: fields + indexes (two service queries). */
export async function fetchDbTableDetail(
  profile: Profile,
  target: DbExecTarget,
  database: string,
  schema: string,
  table: string,
): Promise<DbTableDetail> {
  const colsSql =
    target.engine === 'postgres'
      ? pgTableDetailColumnsSql(schema, table)
      : mysqlTableDetailColumnsSql(table);
  const idxSql =
    target.engine === 'postgres'
      ? pgTableDetailIndexesSql(schema, table)
      : mysqlTableDetailIndexesSql(table);
  const [colsTable, idxTable] = await Promise.all([
    runDbMetaQuery(profile, target, database, colsSql),
    runDbMetaQuery(profile, target, database, idxSql),
  ]);
  return {
    schema,
    table,
    columns: parseColumnDetail(colsTable, target.engine),
    indexes: parseIndexDetail(idxTable, target.engine),
  };
}
