import { describe, expect, it } from 'vitest';
import {
  buildQueryCommand,
  buildStdinSql,
  credCandidates,
  ensureTerminator,
  isAccessDenied,
  mysqlArgs,
  parseCsvTable,
  parseColumnList,
  parseDatabaseList,
  parseTableList,
  parseTsvTable,
  psqlArgs,
  unescapeMysql,
  withAccessDeniedHint,
  isSystemDatabase,
  type ParsedTable,
} from '../src/services/db-query.js';
import type { DbInstance } from '../src/services/db-discovery.js';
import type { Profile } from '../src/types.js';

const PROFILE: Profile = {
  id: 'p1',
  name: 'Test',
  host: 'h',
  port: 22,
  username: 'u',
  authType: 'password',
};

const PG: DbInstance = {
  id: 'abc123',
  name: 'pg',
  engine: 'postgres',
  image: 'postgres:16-alpine',
  user: 'app',
  database: 'appdb',
};

const MYSQL: DbInstance = {
  id: 'def456',
  name: 'my',
  engine: 'mysql',
  image: 'mysql:8',
  user: 'root',
  database: 'shop',
  passwordEnv: 'MYSQL_ROOT_PASSWORD',
  flavor: 'mysql',
};

const MARIA: DbInstance = {
  id: 'ghi789',
  name: 'maria',
  engine: 'mysql',
  image: 'mariadb:11',
  user: 'root',
  database: null,
  passwordEnv: 'MYSQL_ROOT_PASSWORD',
  flavor: 'mariadb',
};

describe('psqlArgs / buildQueryCommand (postgres)', () => {
  it('builds docker exec with PGOPTIONS env and CSV output', () => {
    expect(psqlArgs(PG, 'appdb')).toEqual([
      'exec', '-i',
      '-e', 'PGOPTIONS=-c statement_timeout=115s',
      'abc123',
      'psql', '-U', 'app', '-d', 'appdb',
      '-X', '-v', 'ON_ERROR_STOP=1', '--csv',
    ]);
  });

  it('renders the full command with shq-escaped args', () => {
    expect(buildQueryCommand(PROFILE, PG, 'appdb')).toBe(
      "docker 'exec' '-i' '-e' 'PGOPTIONS=-c statement_timeout=115s' 'abc123' " +
      "'psql' '-U' 'app' '-d' 'appdb' '-X' '-v' 'ON_ERROR_STOP=1' '--csv'",
    );
  });

  it('uses custom dockerCommand of the profile', () => {
    expect(buildQueryCommand({ ...PROFILE, dockerCommand: 'podman' }, PG, 'appdb')).toContain(
      "podman 'exec'",
    );
  });
});

describe('mysqlArgs / buildQueryCommand (mysql)', () => {
  it('expands password from container env — no password in argv', () => {
    const args = mysqlArgs(MYSQL, 'shop');
    expect(args[0]).toBe('exec');
    // Пароль — только условная ссылка на env контейнера; значение не покидает его.
    expect(args.join(' ')).not.toContain('secret');
    expect(args[5]).toContain('[ -n "$MYSQL_ROOT_PASSWORD" ] && MYSQL_PWD="$MYSQL_ROOT_PASSWORD"');
  });

  it('batch mode with utf8mb4 and double shell escaping', () => {
    expect(buildQueryCommand(PROFILE, MYSQL, 'shop')).toBe(
      "docker 'exec' '-i' 'def456' 'sh' '-c' " +
      "'[ -n \"$MYSQL_ROOT_PASSWORD\" ] && MYSQL_PWD=\"$MYSQL_ROOT_PASSWORD\"; " +
      "exec mysql -u '\\''root'\\'' --batch --default-character-set=utf8mb4 '\\''shop'\\'''",
    );
  });

  it('empty password env is not passed — ~/.my.cnf stays in effect', () => {
    // Пустой MYSQL_PWD отправлял бы «using password: NO» и затирал клиентский
    // конфиг; кандидат без пароля вообще не подставляет переменную.
    const bare: DbInstance = { ...MYSQL, passwordEnv: undefined };
    expect(mysqlArgs(bare, 'shop')[5]).toBe(
      "exec mysql -u 'root' --batch --default-character-set=utf8mb4 'shop'",
    );
  });

  it('probe candidate without user: no -u, client config decides', () => {
    const anonymous: DbInstance = { ...MYSQL, user: '', passwordEnv: undefined };
    expect(mysqlArgs(anonymous, null)[5]).toBe('exec mysql --batch --default-character-set=utf8mb4');
  });

  it('uses MYSQL_PASSWORD env for dedicated user', () => {
    const instance: DbInstance = { ...MYSQL, user: 'app', passwordEnv: 'MYSQL_PASSWORD' };
    expect(mysqlArgs(instance, 'shop')[5]).toContain('[ -n "$MYSQL_PASSWORD" ] && MYSQL_PWD="$MYSQL_PASSWORD"');
  });

  it('dedicated user meta connection: no database arg (no default schema)', () => {
    const dedicated: DbInstance = { ...MYSQL, database: null };
    const inner = mysqlArgs(dedicated, null)[5];
    expect(inner).not.toContain("'mysql'");
    expect(inner.endsWith('--default-character-set=utf8mb4')).toBe(true);
  });

  it('escapes quotes in database name for the inner shell', () => {
    // Имя базы с кавычкой не может прийти из dbNameSchema роута — тест
    // фиксирует устойчивость билдера к произвольным строкам.
    const args = mysqlArgs(MYSQL, "we'ird");
    expect(args[5]).toContain(`'we'\\''ird'`);
  });
});

describe('buildStdinSql', () => {
  it('prepends read-only SET for postgres', () => {
    expect(buildStdinSql('postgres', 'SELECT 1;', { readOnly: true })).toBe(
      'SET default_transaction_read_only = on;\nSELECT 1;\n',
    );
  });

  it('no prepend when readOnly off', () => {
    expect(buildStdinSql('postgres', 'SELECT 1;', { readOnly: false })).toBe('SELECT 1;\n');
  });

  it('mysql: timeout in ms + read-only session', () => {
    expect(buildStdinSql('mysql', 'SELECT 1;', { readOnly: true, flavor: 'mysql' })).toBe(
      'SET SESSION max_execution_time=115000;\nSET SESSION TRANSACTION READ ONLY;\nSELECT 1;\n',
    );
  });

  it('mariadb: timeout in seconds', () => {
    expect(buildStdinSql('mysql', 'SELECT 1;', { readOnly: true, flavor: 'mariadb' })).toBe(
      'SET SESSION max_statement_time=115;\nSET SESSION TRANSACTION READ ONLY;\nSELECT 1;\n',
    );
  });

  it('postgres timeout lives in PGOPTIONS, not in SQL', () => {
    expect(buildStdinSql('postgres', 'SELECT 1;', { readOnly: true })).not.toContain('statement_timeout');
  });

  it('appends terminator: psql silently drops an unfinished statement on EOF', () => {
    expect(buildStdinSql('postgres', 'SELECT 1', { readOnly: false })).toBe('SELECT 1\n;\n');
  });

  it('terminator on its own line survives a trailing line comment', () => {
    // `;` в той же строке поглотился бы комментарием и statement остался бы
    // незавершённым.
    expect(buildStdinSql('postgres', 'SELECT 1 -- done', { readOnly: false })).toBe(
      'SELECT 1 -- done\n;\n',
    );
  });

  it('does not double the terminator or touch psql meta-commands', () => {
    expect(buildStdinSql('postgres', 'SELECT 1;', { readOnly: false })).toBe('SELECT 1;\n');
    expect(buildStdinSql('postgres', 'SELECT 1 \\g', { readOnly: false })).toBe('SELECT 1 \\g\n');
    expect(buildStdinSql('mysql', 'SELECT 1', { readOnly: false })).toBe(
      'SET SESSION max_execution_time=115000;\nSELECT 1\n;\n',
    );
  });
});

describe('parseCsvTable', () => {
  it('parses plain rows with CRLF (psql --csv follows COPY CSV)', () => {
    expect(parseCsvTable('a,b\r\n1,2\r\n3,4\r\n')).toEqual({
      columns: ['a', 'b'],
      rows: [['1', '2'], ['3', '4']],
      truncated: false,
      stoppedEarly: false,
    });
  });

  it('parses LF-only rows', () => {
    expect(parseCsvTable('a,b\n1,2\n')).toEqual({
      columns: ['a', 'b'],
      rows: [['1', '2']],
      truncated: false,
      stoppedEarly: false,
    });
  });

  it('quoted commas and newlines inside values', () => {
    const out = 'name,note\n"Doe, John","line1\nline2"\n';
    expect(parseCsvTable(out)).toEqual({
      columns: ['name', 'note'],
      rows: [['Doe, John', 'line1\nline2']],
      truncated: false,
      stoppedEarly: false,
    });
  });

  it('doubled quotes become one quote', () => {
    expect(parseCsvTable('a\n"say ""hi"""\n').rows).toEqual([['say "hi"']]);
  });

  it('empty string value keeps the cell', () => {
    expect(parseCsvTable('a,b\n,"x"\n').rows).toEqual([['', 'x']]);
  });

  it('drops incomplete last row and sets truncated (maxOutput cut)', () => {
    const out = 'a,b\n1,2\n3,';
    const parsed = parseCsvTable(out);
    expect(parsed).toEqual({
      columns: ['a', 'b'],
      rows: [['1', '2']],
      truncated: true,
      stoppedEarly: false,
    });
  });

  it('sets truncated when cut inside quoted value', () => {
    const out = 'a\n"x\nmor';
    const parsed = parseCsvTable(out);
    expect(parsed.rows).toEqual([]);
    expect(parsed.truncated).toBe(true);
  });

  it('stops at column-count mismatch (multi-statement output)', () => {
    const out = 'a,b\n1,2\nINSERT 0 5\n5,6\n';
    const parsed = parseCsvTable(out);
    expect(parsed.rows).toEqual([['1', '2']]);
    expect(parsed.stoppedEarly).toBe(true);
  });

  it('header-only output is zero rows, not truncated', () => {
    const parsed = parseCsvTable('a,b\n');
    expect(parsed.columns).toEqual(['a', 'b']);
    expect(parsed.rows).toEqual([]);
    expect(parsed.truncated).toBe(false);
  });

  it('empty output has no columns', () => {
    expect(parseCsvTable('')).toEqual({
      columns: [],
      rows: [],
      truncated: false,
      stoppedEarly: false,
    });
  });
});

describe('credCandidates / access denied helpers', () => {
  it('lists credential variants deduplicated, primary first', () => {
    const dedicated: DbInstance = { ...MYSQL, user: 'app', passwordEnv: 'MYSQL_PASSWORD' };
    const cands = credCandidates(dedicated);
    expect(cands.map((c) => [c.user, c.passwordEnv ?? null])).toEqual([
      ['app', 'MYSQL_PASSWORD'],
      ['root', 'MYSQL_ROOT_PASSWORD'],
      ['app', 'MYSQL_ROOT_PASSWORD'],
      ['app', null],
      ['root', null],
      ['', null],
    ]);
    // Остальные поля инстанса сохраняются.
    expect(cands[1]).toMatchObject({ id: MYSQL.id, engine: 'mysql', flavor: 'mysql' });
  });

  it('deduplicates identical primary/root variants', () => {
    const cands = credCandidates(MYSQL); // root + MYSQL_ROOT_PASSWORD — первичный
    expect(cands.map((c) => [c.user, c.passwordEnv ?? null])).toEqual([
      ['root', 'MYSQL_ROOT_PASSWORD'],
      ['root', null],
      ['', null],
    ]);
  });

  it('isAccessDenied matches mysql 1045 and pg 28P01', () => {
    expect(isAccessDenied("ERROR 1045 (28000): Access denied for user 'root'@'localhost'")).toBe(true);
    expect(isAccessDenied('FATAL: password authentication failed for user "app"')).toBe(true);
    expect(isAccessDenied('ERROR 1064 (42000): You have an error in your SQL syntax')).toBe(false);
  });

  it('withAccessDeniedHint appends hint only for access denied', () => {
    const denied = withAccessDeniedHint('denied', "ERROR 1045: Access denied");
    expect(denied).toContain('denied');
    expect(denied).toContain('MYSQL_ROOT_PASSWORD');
    expect(withAccessDeniedHint('syntax error', 'ERROR 1064')).toBe('syntax error');
  });
});

describe('ensureTerminator', () => {
  it('leaves empty and already-terminated sql untouched', () => {
    expect(ensureTerminator('')).toBe('');
    expect(ensureTerminator('  SELECT 1;  ')).toBe('SELECT 1;');
  });

  it('leaves psql line continuation alone', () => {
    expect(ensureTerminator('SELECT 1,\\')).toBe('SELECT 1,\\');
  });

  it('leaves mysql \\G (uppercase) alone — it executes the statement', () => {
    expect(ensureTerminator('SELECT * FROM t \\G')).toBe('SELECT * FROM t \\G');
  });
});

describe('unescapeMysql / parseTsvTable', () => {
  it('unescapes \\t \\n \\\\ \\0', () => {
    expect(unescapeMysql(String.raw`x\ty\nz\\\0q`)).toBe('x\ty\nz\\\0q');
  });

  it('parses rows and header', () => {
    expect(parseTsvTable('name\tnote\nDoe\thi\n')).toEqual({
      columns: ['name', 'note'],
      rows: [['Doe', 'hi']],
      truncated: false,
      stoppedEarly: false,
    });
  });

  it('unescapes escaped values inside cells', () => {
    expect(parseTsvTable('a\nx\\ty\\nz\n').rows).toEqual([['x\ty\nz']]);
  });

  it('NULL arrives as literal string NULL — known mysql --batch limitation', () => {
    // Значение NULL и строка 'NULL' в batch-режиме неразличимы (эпик 12,
    // фиксируется тестом-документацией).
    expect(parseTsvTable('a\tb\nNULL\tx\n').rows).toEqual([['NULL', 'x']]);
  });

  it('drops incomplete last line and sets truncated', () => {
    const parsed = parseTsvTable('a\tb\n1\t2\n3\t');
    expect(parsed.rows).toEqual([['1', '2']]);
    expect(parsed.truncated).toBe(true);
  });

  it('stops at column-count mismatch', () => {
    const parsed = parseTsvTable('a\tb\n1\t2\n3\n4\t5\n');
    expect(parsed.rows).toEqual([['1', '2']]);
    expect(parsed.stoppedEarly).toBe(true);
  });

  it('empty output has no columns', () => {
    expect(parseTsvTable('')).toEqual({
      columns: [],
      rows: [],
      truncated: false,
      stoppedEarly: false,
    });
  });
});

describe('isSystemDatabase / parseDatabaseList / parseTableList', () => {
  it('system databases are hidden', () => {
    for (const name of ['information_schema', 'performance_schema', 'sys', 'template0', 'template1']) {
      expect(isSystemDatabase(name)).toBe(true);
    }
    expect(isSystemDatabase('TEMPLATE0')).toBe(true);
    expect(isSystemDatabase('shop')).toBe(false);
  });

  it('parses database list from CSV (postgres, no table count)', () => {
    const parsed = parseCsvTable('name,size\napp,16384\ntemplate0,1\npostgres,8192\n');
    expect(parseDatabaseList(parsed, 'postgres')).toEqual([
      { name: 'app', sizeBytes: 16384, tableCount: null },
      { name: 'postgres', sizeBytes: 8192, tableCount: null },
    ]);
  });

  it('parses database list from TSV (mysql, with table count)', () => {
    const parsed = parseTsvTable('name\tsize\ttables\nshop\t100\t5\nsys\t1\t1\n');
    expect(parseDatabaseList(parsed, 'mysql')).toEqual([
      { name: 'shop', sizeBytes: 100, tableCount: 5 },
    ]);
  });

  it('list without size column yields nulls (fallback query)', () => {
    const parsed = parseCsvTable('name\napp\n');
    expect(parseDatabaseList(parsed, 'postgres')).toEqual([
      { name: 'app', sizeBytes: null, tableCount: null },
    ]);
  });

  it('zero is a valid size, not null (empty database)', () => {
    const parsed = parseTsvTable('name\tsize\ttables\nempty\t0\t0\n');
    expect(parseDatabaseList(parsed, 'mysql')).toEqual([
      { name: 'empty', sizeBytes: 0, tableCount: 0 },
    ]);
  });

  it('parses column list and filters system schemas', () => {
    const pg: ParsedTable = parseCsvTable('schema,table,column\npublic,users,id\npublic,users,name\npg_catalog,pg_tables,schemaname\n');
    expect(parseColumnList(pg, 'postgres')).toEqual([
      { schema: 'public', table: 'users', name: 'id' },
      { schema: 'public', table: 'users', name: 'name' },
    ]);

    const my: ParsedTable = parseTsvTable('schema\ttable\tcolumn\nshop\torders\tid\nsys\tfoo\tbar\n');
    expect(parseColumnList(my, 'mysql')).toEqual([{ schema: 'shop', table: 'orders', name: 'id' }]);
  });

  it('parses table list and filters system schemas', () => {
    const pg: ParsedTable = parseCsvTable('schema,name\npublic,users\npg_catalog,pg_tables\ninformation_schema,tables\n');
    expect(parseTableList(pg, 'postgres')).toEqual([{ schema: 'public', name: 'users' }]);

    const my: ParsedTable = parseTsvTable('schema\tname\nshop\torders\nsys\tfoo\n');
    expect(parseTableList(my, 'mysql')).toEqual([{ schema: 'shop', name: 'orders' }]);
  });
});
