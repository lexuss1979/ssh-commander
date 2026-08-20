import { exec } from '../ssh/manager.js';
import { dockerCommand } from './docker.js';
import type { DbInstance } from './db-discovery.js';
import type { Profile } from '../types.js';

/**
 * Билдеры команд и парсеры вывода SQL-консоли (эпик 12). Всё чистое —
 * под unit-тесты; SSH-exec делает тонкая обёртка `runDbQuery`.
 *
 * Схема экранирования: аргументы docker шэкуются один раз (`dockerCommand`
 * → удалённый shell передаёт их docker verbatim), а имена пользователя/базы
 * внутри `sh -c '...'` — второй раз (внутренний shell контейнера). SQL идёт
 * в stdin канала и в shell не попадает вовсе.
 */

/** Таймаут statement'а внутри БД (с); канал страхует 120 с (см. routes). */
export const DB_STATEMENT_TIMEOUT_S = 115;
/** Таймаут SSH-канала — страховка от зависшего docker exec. */
export const DB_CHANNEL_TIMEOUT_MS = 120000;
/** Лимит строк грида; излишек режется с пометкой в UI. */
export const DB_ROW_LIMIT = 1000;
/** Максимальный размер SQL (zod-лимит роута должен совпадать). */
export const DB_SQL_MAX_BYTES = 64 * 1024;
/** Свёртка полного stdout для UI (моно-блок со скроллом). */
export const RAW_OUTPUT_LIMIT = 64 * 1024;

/** Системные базы, скрываемые из списков (план эпика 12). */
export const SYSTEM_DATABASES = new Set([
  'information_schema',
  'performance_schema',
  'sys',
  'template0',
  'template1',
]);

/** Системные схемы PG, скрываемые из списка таблиц. */
export const PG_SYSTEM_SCHEMAS = new Set(['pg_catalog', 'information_schema']);

// ---------------------------------------------------------------------------
// Билдеры команд
// ---------------------------------------------------------------------------

/**
 * Аргументы `docker exec` для psql. SQL — в stdin канала (нет лимита argv);
 * таймаут — через PGOPTIONS env: применяется до любого statement'а и не
 * зависит от read-only-переключателя в тексте запроса.
 */
export function psqlArgs(instance: DbInstance, database: string): string[] {
  return [
    'exec', '-i',
    '-e', `PGOPTIONS=-c statement_timeout=${DB_STATEMENT_TIMEOUT_S}s`,
    instance.id,
    'psql', '-U', instance.user, '-d', database,
    '-X', '-v', 'ON_ERROR_STOP=1', '--csv',
  ];
}

/**
 * Аргументы `docker exec` для mysql. Пароль разворачивается из env самого
 * контейнера — но только если он там непустой (`[ -n "$VAR" ] &&`): пустой
 * MYSQL_PWD отправлял бы «using password: NO» и затирал пароль из ~/.my.cnf
 * контейнера (ручные сетапы хранят креденшлы там). `user: ''` — не
 * передавать `-u`, клиент возьмёт пользователя из своего конфига.
 * `database: null` — подключение без схемы по умолчанию (служебные запросы):
 * dedicated user без MYSQL_DATABASE не имеет прав на чужую системную базу.
 */
export function mysqlArgs(instance: DbInstance, database: string | null): string[] {
  const pwdPrefix = instance.passwordEnv
    ? `[ -n "$${instance.passwordEnv}" ] && MYSQL_PWD="$${instance.passwordEnv}"; `
    : '';
  const userArg = instance.user ? ` -u ${shellQuote(instance.user)}` : '';
  const dbArg = database ? ` ${shellQuote(database)}` : '';
  const inner =
    `${pwdPrefix}exec mysql${userArg} --batch --default-character-set=utf8mb4${dbArg}`;
  return ['exec', '-i', instance.id, 'sh', '-c', inner];
}

/**
 * Гарантирует терминатор statement'а: psql молча отбрасывает незавершённый
 * буфер на EOF — `SELECT 1` без `;` вернул бы пустой вывод с exit 0.
 * Точка с запятой на отдельной строке: хвостовой `-- комментарий` поглощает
 * `;` в своей строке, а на новой — корректно завершает statement. Хвостовые
 * метакоманды (`… \g` psql, `… \G` mysql — исполняют буфер) и продолжение
 * `\` не трогаем.
 */
export function ensureTerminator(sql: string): string {
  const t = sql.trim();
  if (!t || t.endsWith(';') || t.endsWith('\\') || /(?:^|\s)\\[a-z]+$/i.test(t)) return t;
  return `${t}\n;`;
}

/**
 * Текст, отправляемый в stdin: statement таймаута (MySQL — в SQL, у PG он в
 * PGOPTIONS), read-only-переключатель и сам запрос. Read-only — защита от
 * случайности, не от намеренного: пользовательский `SET … = off` снимает её
 * (документировано в UI и AGENTS.md).
 */
export function buildStdinSql(
  engine: DbInstance['engine'],
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

/** Экранирование для внутреннего shell контейнера (`sh -c`). */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// Креденшалы: env контейнера может протухнуть
// ---------------------------------------------------------------------------

/**
 * Пароль в env — снимок на момент создания контейнера: если его потом меняли
 * в самой БД (ALTER USER, восстановление из дампа), env даёт Access denied
 * (наблюдено на проде: и dedicated user с «password: YES», и root с
 * «password: NO», когда пароля в env нет вовсе). Перед первым использованием
 * инстанса перебираем варианты подключения дешёвым `SELECT 1` и кэшируем
 * сработавший; при 1045 в реальных запросах кэш сбрасывается и следующий
 * запрос перепробует снова. Формы ввода пароля в v1 нет сознательно.
 */
const credCache = new Map<string, DbInstance>();

export function invalidateDbCredentials(profileId: string, instanceId: string): void {
  credCache.delete(`${profileId}:${instanceId}`);
}

/**
 * Варианты подключения по убыванию правдоподобия: как нашли в env; root с
 * его паролем (частый случай протухшего app-юзера); смешанные; без пароля
 * (trust/allow-empty); совсем без аргументов — клиент возьмёт креденшлы из
 * своего конфига (~/.my.cnf в контейнере).
 */
export function credCandidates(instance: DbInstance): DbInstance[] {
  const out: DbInstance[] = [];
  const seen = new Set<string>();
  const add = (user: string, passwordEnv?: string) => {
    const key = `${user}|${passwordEnv ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ...instance, user, passwordEnv });
  };
  add(instance.user, instance.passwordEnv);
  add('root', 'MYSQL_ROOT_PASSWORD');
  add(instance.user, 'MYSQL_ROOT_PASSWORD');
  add(instance.user, undefined);
  add('root', undefined);
  add('', undefined);
  return out;
}

async function probeCred(profile: Profile, candidate: DbInstance): Promise<boolean> {
  const result = await exec(profile, buildQueryCommand(profile, candidate, null), {
    timeoutMs: 15000,
    stdin: buildStdinSql(candidate.engine, 'SELECT 1', {
      readOnly: true,
      flavor: candidate.flavor,
    }),
  });
  return result.code === 0;
}

/**
 * Возвращает инстанс с проверенными креденшалами (клон при необходимости).
 * PG не пробуем: official-образ подключается по локальному сокету без
 * пароля, вариантов нет. Все кандидаты провалились — возвращаем как есть:
 * пользователь увидит честный stderr первичного варианта.
 */
export async function resolveDbCredentials(
  profile: Profile,
  instance: DbInstance,
): Promise<DbInstance> {
  if (instance.engine !== 'mysql') return instance;
  const key = `${profile.id}:${instance.id}`;
  const cached = credCache.get(key);
  if (cached) return cached;
  for (const candidate of credCandidates(instance)) {
    if (await probeCred(profile, candidate)) {
      credCache.set(key, candidate);
      return candidate;
    }
  }
  return instance;
}

/** Access denied у MySQL (1045) / PG (28P01). */
export function isAccessDenied(stderr: string): boolean {
  return /Access denied|ERROR 1045|password authentication failed/i.test(stderr);
}

export const MYSQL_ACCESS_DENIED_HINT =
  'Креденшалы консоль берёт из env контейнера (MYSQL_ROOT_PASSWORD / MYSQL_PASSWORD). ' +
  '«Access denied» — пароль в БД уже другой: его меняли после создания контейнера ' +
  '(ALTER USER, восстановление из дампа) или он лежит не в env. Сравните env ' +
  '(docker inspect) с реальным паролем; варианты с root/без пароля уже попробованы.';

/** Дополняет сообщение ошибки подсказкой при Access denied. */
export function withAccessDeniedHint(message: string, stderr: string): string {
  return isAccessDenied(stderr) ? `${message}\n\n${MYSQL_ACCESS_DENIED_HINT}` : message;
}

// ---------------------------------------------------------------------------
// Парсеры вывода
// ---------------------------------------------------------------------------

export interface ParsedTable {
  columns: string[];
  rows: string[][];
  /** Вывод обрезан по лимиту (maxOutput) — последняя строка выброшена. */
  truncated: boolean;
  /** Строки после расхождения колонок (многоstatement'ный вывод) — не для грида. */
  stoppedEarly: boolean;
}

/**
 * Парсер CSV-вывода psql (`--csv`, RFC 4180: кавычки, запятые и переводы
 * строк в значениях). Первая строка — заголовок; при расхождении числа
 * колонок (второй result set / command tag) строки дальше не берём —
 * полный stdout остаётся в rawOutput. Выход без хвостового `\n` — вывод
 * обрезан лимитом: последняя неполную строку выбрасываем, truncated=true.
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

  // Хвост без перевода строки: psql завершает каждую строку `\n` (или
  // `\r\n`), значит вывод отрезан лимитом — строку выбрасываем.
  let truncated = false;
  if (cell || row.length > 0 || inQuotes) {
    truncated = true;
  }

  return finishTable(rows, truncated);
}

/**
 * Парсер TSV-вывода mysql (`--batch`): колонки — реальные табы; `\t`, `\n`,
 * `\\` и `\0` внутри значений экранированы — разэкранируем. NULL приходит
 * строкой `NULL` и от значения 'NULL' неотличим — известное ограничение
 * (фиксируется тестом-документацией). Неполная последняя строка (без
 * хвостового `\n`) выбрасывается, truncated=true.
 */
export function parseTsvTable(out: string): ParsedTable {
  const lines = out.split('\n');
  // split оставляет пустой хвост после финального `\n`; непустой хвост —
  // вывод отрезан лимитом, последнюю неполную строку выбрасываем.
  const trailing = lines.pop();
  const truncated = trailing !== undefined && trailing !== '';
  const rows = lines.map((line) => line.split('\t').map(unescapeMysql));
  return finishTable(rows, truncated);
}

/** `\t`/`\n`/`\\`/`\0` → реальные символы (batch-экранирование mysql). */
export function unescapeMysql(s: string): string {
  return s.replace(/\\(.)/g, (m, c: string) => {
    switch (c) {
      case 'n': return '\n';
      case 't': return '\t';
      case '0': return '\0';
      default: return c; // `\\` → `\`, прочие `\x` — как есть
    }
  });
}

/** Заголовок + строки до первого расхождения колонок. */
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
// Выполнение
// ---------------------------------------------------------------------------

export interface DbQueryResult {
  columns: string[];
  rows: string[][];
  /** Число строк в гриде (≤ DB_ROW_LIMIT). */
  rowCount: number;
  /** Полное число строк результата до обрезки лимитом. */
  totalRows: number;
  durationMs: number;
  truncated: boolean;
  /** Полный stdout, когда грид не вместил всё (многоstatement'ный вывод). */
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

/** Полная shell-команда для запроса (отдельно — под тесты двойного экранирования). */
export function buildQueryCommand(
  profile: Profile,
  instance: DbInstance,
  database: string | null,
): string {
  const args = instance.engine === 'postgres'
    ? psqlArgs(instance, database ?? 'postgres')
    : mysqlArgs(instance, database);
  return dockerCommand(profile, args);
}

/**
 * Выполняет SQL через CLI-клиент в контейнере: SQL — в stdin канала, вывод
 * до 2 МБ (стандартный лимит exec). Ненулевой exit code → DbQueryError со
 * stderr клиента и кодом — UI показывает их mono-блоком.
 */
export async function runDbQuery(
  profile: Profile,
  instance: DbInstance,
  database: string,
  sql: string,
  readOnly: boolean,
): Promise<DbQueryResult> {
  const command = buildQueryCommand(profile, instance, database);
  const stdin = buildStdinSql(instance.engine, sql, {
    readOnly,
    flavor: instance.flavor,
  });
  const startedAt = Date.now();
  const result = await exec(profile, command, {
    timeoutMs: DB_CHANNEL_TIMEOUT_MS,
    stdin,
  });
  const durationMs = Date.now() - startedAt;
  if (result.code !== 0) {
    // Протухший пароль из env: кэш креденшалов сбрасываем — следующий
    // запрос перепробует варианты заново.
    if (isAccessDenied(result.stderr)) invalidateDbCredentials(profile.id, instance.id);
    const message = withAccessDeniedHint(
      result.stderr.trim() || result.stdout.trim() || `Клиент БД завершился с кодом ${result.code}`,
      result.stderr,
    );
    throw new DbQueryError(message, result.stderr.trim(), result.code);
  }

  const parsed = instance.engine === 'postgres'
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
  // Полный stdout нужен, когда грид не показывает всё: нет result set,
  // обрезка или несколько statement'ов.
  if (parsed.stoppedEarly || parsed.columns.length === 0 || limited || parsed.truncated) {
    response.rawOutput = result.stdout.slice(0, RAW_OUTPUT_LIMIT);
  }
  return response;
}

// ---------------------------------------------------------------------------
// Служебные запросы (списки, обзор)
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

/** Список баз PG с размерами (системные скрыты); null при отказе в правах. */
export const PG_DATABASES_SQL =
  `SELECT datname AS name, pg_database_size(datname) AS size\n` +
  `FROM pg_database\n` +
  `WHERE datallowconn AND datname <> ALL (ARRAY['template0','template1'])\n` +
  `ORDER BY 1`;

/** Список таблиц PG по всем несистемным схемам подключённой базы. */
export const PG_TABLES_SQL =
  `SELECT table_schema AS schema, table_name AS name\n` +
  `FROM information_schema.tables\n` +
  `WHERE table_schema <> ALL (ARRAY['pg_catalog','information_schema'])\n` +
  `ORDER BY 1, 2`;

/** Число таблиц подключённой базы PG. */
export const PG_TABLE_COUNT_SQL =
  `SELECT count(*) FROM information_schema.tables\n` +
  `WHERE table_schema <> ALL (ARRAY['pg_catalog','information_schema'])`;

/** Список баз MySQL с размерами и числом таблиц одной командой. */
export const MYSQL_DATABASES_SQL =
  `SELECT table_schema AS name, COALESCE(SUM(data_length + index_length), 0) AS size, COUNT(*) AS tables\n` +
  `FROM information_schema.tables\n` +
  `GROUP BY table_schema\n` +
  `ORDER BY 1`;

/** Список таблиц выбранной базы MySQL (DATABASE() — защита от интерполяции). */
export const MYSQL_TABLES_SQL =
  `SELECT table_schema AS schema, table_name AS name\n` +
  `FROM information_schema.tables\n` +
  `WHERE table_schema = DATABASE()\n` +
  `ORDER BY 1, 2`;

/** Колонки таблиц PG по всем несистемным схемам (для схемы в промпте агента). */
export const PG_COLUMNS_SQL =
  `SELECT table_schema AS schema, table_name AS "table", column_name AS "column"\n` +
  `FROM information_schema.columns\n` +
  `WHERE table_schema <> ALL (ARRAY['pg_catalog','information_schema'])\n` +
  `ORDER BY table_schema, table_name, ordinal_position`;

/** Колонки таблиц выбранной базы MySQL (DATABASE() — без интерполяции имени). */
export const MYSQL_COLUMNS_SQL =
  'SELECT table_schema AS `schema`, table_name AS `table`, column_name AS `column`\n' +
  'FROM information_schema.columns\n' +
  'WHERE table_schema = DATABASE()\n' +
  'ORDER BY table_schema, table_name, ordinal_position';

/** Верхняя граница колонок в ответе /columns (границит промпт схемы). */
export const DB_COLUMNS_LIMIT = 4000;

export function isSystemDatabase(name: string): boolean {
  return SYSTEM_DATABASES.has(name.toLowerCase());
}

/** Число или null; 0 — валидное значение (размер пустой базы), не null. */
function toNumberOrNull(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Разбирает вывод запроса баз в `DbDatabaseInfo[]` (общий для CSV и TSV:
 * колонки name[, size][, tables]). Системные базы фильтруются.
 */
export function parseDatabaseList(
  parsed: ParsedTable,
  engine: DbInstance['engine'],
): DbDatabaseInfo[] {
  const list: DbDatabaseInfo[] = [];
  for (const row of parsed.rows) {
    const name = row[parsed.columns.indexOf('name')] ?? '';
    if (!name || isSystemDatabase(name)) continue;
    const tablesRaw = row[parsed.columns.indexOf('tables')];
    list.push({
      name,
      sizeBytes: toNumberOrNull(row[parsed.columns.indexOf('size')]),
      // У PG счётчик таблиц приходит отдельным запросом на базу — здесь null.
      tableCount: engine === 'mysql' ? toNumberOrNull(tablesRaw) : null,
    });
  }
  return list;
}

/** Разбирает вывод запроса таблиц (колонки schema, name). */
export function parseTableList(parsed: ParsedTable, engine: DbInstance['engine']): DbTableInfo[] {
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

/** Разбирает вывод запроса колонок (schema, table, column) — для промпта агента. */
export function parseColumnList(parsed: ParsedTable, engine: DbInstance['engine']): DbColumnInfo[] {
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

/** Список баз PG без размеров (фолбэк при отказе в правах на pg_database_size). */
export const PG_DATABASES_FALLBACK_SQL =
  `SELECT datname AS name FROM pg_database WHERE datallowconn ORDER BY 1`;

/** Все схемы MySQL (включая пустые базы — в sizes-запросе их нет). */
export const MYSQL_SCHEMATA_SQL =
  `SELECT schema_name AS name FROM information_schema.schemata ORDER BY 1`;

/** Выполняет служебный SELECT и возвращает разобранную таблицу. */
export async function runDbMetaQuery(
  profile: Profile,
  instance: DbInstance,
  database: string | null,
  sql: string,
): Promise<ParsedTable> {
  const command = buildQueryCommand(profile, instance, database);
  const result = await exec(profile, command, {
    timeoutMs: DB_CHANNEL_TIMEOUT_MS,
    stdin: buildStdinSql(instance.engine, sql, { readOnly: true, flavor: instance.flavor }),
  });
  if (result.code !== 0) {
    if (isAccessDenied(result.stderr)) invalidateDbCredentials(profile.id, instance.id);
    const message = withAccessDeniedHint(
      result.stderr.trim() || result.stdout.trim() || `Клиент БД завершился с кодом ${result.code}`,
      result.stderr,
    );
    throw new DbQueryError(message, result.stderr.trim(), result.code);
  }
  return instance.engine === 'postgres'
    ? parseCsvTable(result.stdout)
    : parseTsvTable(result.stdout);
}

/**
 * База для служебных запросов без выбранной пользователем базы. MySQL:
 * схема по умолчанию не нужна и может быть недоступна dedicated user'у без
 * MYSQL_DATABASE (права только на свою схему, «Access denied» на чужой) —
 * подключаемся без базы (null). PG без -d не умеет — дефолт 'postgres'
 * (в official-образе POSTGRES_USER — суперпользователь).
 */
function metaDatabase(instance: DbInstance): string | null {
  return instance.database ?? (instance.engine === 'postgres' ? 'postgres' : null);
}

/** Версия сервера (`SELECT version()` / `SELECT @@version`). */
export async function fetchDbVersion(profile: Profile, instance: DbInstance): Promise<string> {
  const sql = instance.engine === 'postgres'
    ? 'SELECT version() AS version'
    : 'SELECT @@version AS version';
  const table = await runDbMetaQuery(profile, instance, metaDatabase(instance), sql);
  return table.rows[0]?.[0] ?? '';
}

export interface DbOverview {
  engine: DbInstance['engine'];
  version: string;
  databases: DbDatabaseInfo[];
}

/** Верхний порог баз, по которым PG считает таблицы (по одному exec на базу). */
export const PG_TABLE_COUNT_DB_LIMIT = 25;

/**
 * Обзор инстанса: версия, базы с размерами и числом таблиц. У PG счётчик
 * таблиц — отдельный запрос в каждую базу (кросс-БД-запросов нет), размер
 * недоступен без прав → фолбэк на список имён. У MySQL пустые базы берутся
 * из schemata и сливаются с sizes-запросом.
 */
export async function fetchDbOverview(profile: Profile, instance: DbInstance): Promise<DbOverview> {
  const version = await fetchDbVersion(profile, instance);
  const meta = metaDatabase(instance);

  if (instance.engine === 'postgres') {
    let list: DbDatabaseInfo[];
    try {
      list = parseDatabaseList(
        await runDbMetaQuery(profile, instance, meta, PG_DATABASES_SQL), 'postgres');
    } catch {
      list = parseDatabaseList(
        await runDbMetaQuery(profile, instance, meta, PG_DATABASES_FALLBACK_SQL), 'postgres');
    }
    for (const db of list.slice(0, PG_TABLE_COUNT_DB_LIMIT)) {
      try {
        const t = await runDbMetaQuery(profile, instance, db.name, PG_TABLE_COUNT_SQL);
        db.tableCount = Number(t.rows[0]?.[0]) || 0;
      } catch {
        /* без прав на базу — счётчик остаётся null */
      }
    }
    return { engine: instance.engine, version, databases: list };
  }

  const byName = new Map(
    parseDatabaseList(await runDbMetaQuery(profile, instance, meta, MYSQL_DATABASES_SQL), 'mysql')
      .map((d) => [d.name, d]),
  );
  const list = parseDatabaseList(
    await runDbMetaQuery(profile, instance, meta, MYSQL_SCHEMATA_SQL), 'mysql');
  return {
    engine: instance.engine,
    version,
    databases: list.map((d) => byName.get(d.name) ?? { ...d, sizeBytes: 0, tableCount: 0 }),
  };
}

/** Список имён баз (без размеров — дешёвая альтернатива обзору). */
export async function fetchDbDatabases(profile: Profile, instance: DbInstance): Promise<string[]> {
  const sql = instance.engine === 'postgres' ? PG_DATABASES_FALLBACK_SQL : MYSQL_SCHEMATA_SQL;
  const list = parseDatabaseList(
    await runDbMetaQuery(profile, instance, metaDatabase(instance), sql), instance.engine);
  return list.map((d) => d.name);
}

/** Список таблиц базы (schema + name; системные схемы отфильтрованы). */
export async function fetchDbTables(
  profile: Profile,
  instance: DbInstance,
  database: string,
): Promise<DbTableInfo[]> {
  const sql = instance.engine === 'postgres' ? PG_TABLES_SQL : MYSQL_TABLES_SQL;
  return parseTableList(
    await runDbMetaQuery(profile, instance, database, sql), instance.engine);
}

/** Колонки таблиц базы (для схемы в промпте «Спросить агента»). */
export async function fetchDbColumns(
  profile: Profile,
  instance: DbInstance,
  database: string,
): Promise<DbColumnInfo[]> {
  const sql = instance.engine === 'postgres' ? PG_COLUMNS_SQL : MYSQL_COLUMNS_SQL;
  return parseColumnList(
    await runDbMetaQuery(profile, instance, database, sql), instance.engine);
}
