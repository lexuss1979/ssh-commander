import { describe, expect, it } from 'vitest';
import {
  buildChannelStdin,
  buildQueryCommand,
  buildStdinSql,
  ensureTerminator,
  mysqlArgs,
  parseColumnDetail,
  parseColumnList,
  parseCsvTable,
  parseDatabaseList,
  parseIndexColumnsFromDef,
  parseIndexDetail,
  parseTableList,
  parseTsvTable,
  mysqlTableDetailColumnsSql,
  mysqlTableDetailIndexesSql,
  pgTableDetailColumnsSql,
  pgTableDetailIndexesSql,
  psqlArgs,
  unescapeMysql,
  isSystemDatabase,
  type ParsedTable,
  type DbExecTarget,
} from '../src/services/db-query.js';
import type { Profile } from '../src/types.js';

const PROFILE: Profile = {
  id: 'p1',
  name: 'Test',
  host: 'h',
  port: 22,
  username: 'u',
  authType: 'password',
};

const PG: DbExecTarget = {
  engine: 'postgres',
  containerId: 'abc123',
  username: 'app',
  password: 'pgsecret',
  defaultDatabase: 'appdb',
};

const MYSQL: DbExecTarget = {
  engine: 'mysql',
  containerId: 'def456',
  username: 'root',
  password: 'mysecret',
  defaultDatabase: 'shop',
  flavor: 'mysql',
};

const MARIA: DbExecTarget = {
  engine: 'mysql',
  containerId: 'ghi789',
  username: 'root',
  password: '',
  defaultDatabase: null,
  flavor: 'mariadb',
};

describe('psqlArgs / buildQueryCommand (postgres)', () => {
  it('reads password from stdin first line, PGOPTIONS env, CSV output', () => {
    expect(psqlArgs(PG, 'appdb')).toEqual([
      'exec', '-i',
      '-e', 'PGOPTIONS=-c statement_timeout=115s',
      'abc123',
      'sh', '-c',
      `IFS= read -r PGPASSWORD; export PGPASSWORD; exec psql -U 'app' -d 'appdb' -X -v ON_ERROR_STOP=1 --csv`,
    ]);
  });

  it('empty password: no read prologue (PG local trust)', () => {
    expect(psqlArgs({ ...PG, password: '' }, 'appdb')[7]).toBe(
      `exec psql -U 'app' -d 'appdb' -X -v ON_ERROR_STOP=1 --csv`,
    );
  });

  it('IFS= and -r guard spaces and backslashes in the password', () => {
    // IFS= — не обрезать пробелы по краям, -r — не съедать бэкслеши.
    const inner = psqlArgs({ ...PG, password: ' pass\\word ' }, 'appdb')[7];
    expect(inner.startsWith('IFS= read -r PGPASSWORD; export PGPASSWORD; ')).toBe(true);
  });

  it('renders the full command with shq-escaped args (double escaping)', () => {
    // Внутренние кавычки билдера переживают внешний shq; bare-аргументы
    // psql -v/--csv — часть одного sh -c-аргумента, внешне не квотятся.
    expect(buildQueryCommand(PROFILE, PG, 'appdb')).toBe(
      "docker 'exec' '-i' '-e' 'PGOPTIONS=-c statement_timeout=115s' 'abc123' " +
      "'sh' '-c' 'IFS= read -r PGPASSWORD; export PGPASSWORD; " +
      "exec psql -U '\\''app'\\'' -d '\\''appdb'\\'' -X -v ON_ERROR_STOP=1 --csv'",
    );
  });

  it('no password value anywhere in the command', () => {
    expect(buildQueryCommand(PROFILE, PG, 'appdb')).not.toContain('pgsecret');
  });

  it('uses custom dockerCommand of the profile', () => {
    expect(buildQueryCommand({ ...PROFILE, dockerCommand: 'podman' }, PG, 'appdb')).toContain(
      "podman 'exec'",
    );
  });

  it('escapes quotes in username for the inner shell', () => {
    // Имя с кавычкой не пройдёт валидацию подключения — тест фиксирует
    // устойчивость билдера к произвольным строкам.
    const args = psqlArgs({ ...PG, username: "we'ird" }, 'appdb');
    expect(args[7]).toContain(`-U 'we'\\''ird'`);
  });
});

describe('mysqlArgs / buildQueryCommand (mysql)', () => {
  it('reads password from stdin first line, batch mode with utf8mb4', () => {
    expect(mysqlArgs(MYSQL, 'shop')).toEqual([
      'exec', '-i', 'def456', 'sh', '-c',
      `IFS= read -r MYSQL_PWD; export MYSQL_PWD; exec mysql -u 'root' --batch --default-character-set=utf8mb4 'shop'`,
    ]);
  });

  it('meta connection without database: no database arg', () => {
    const inner = mysqlArgs(MARIA, null)[5];
    expect(inner).not.toContain("'mysql'");
    expect(inner.endsWith('--default-character-set=utf8mb4')).toBe(true);
  });

  it('empty password: no read prologue, ~/.my.cnf stays in effect', () => {
    // Пустой MYSQL_PWD отправлял бы «using password: NO» и затирал клиентский
    // конфиг — без пароля переменную вообще не подставляем.
    expect(mysqlArgs({ ...MYSQL, password: '' }, 'shop')[5]).toBe(
      `exec mysql -u 'root' --batch --default-character-set=utf8mb4 'shop'`,
    );
  });

  it('double shell escaping survives the full command', () => {
    expect(buildQueryCommand(PROFILE, MYSQL, 'shop')).toBe(
      "docker 'exec' '-i' 'def456' 'sh' '-c' " +
      "'IFS= read -r MYSQL_PWD; export MYSQL_PWD; " +
      "exec mysql -u '\\''root'\\'' --batch --default-character-set=utf8mb4 '\\''shop'\\'''",
    );
  });
});

describe('buildChannelStdin (пароль первой строкой)', () => {
  it('password occupies exactly the first line, SQL follows', () => {
    const stdin = buildChannelStdin(MYSQL, 'SELECT 1;', { readOnly: true });
    const firstLineEnd = stdin.indexOf('\n');
    expect(stdin.slice(0, firstLineEnd)).toBe('mysecret');
    // Дальше — обычный SQL-блок итерации 1 (таймаут + read-only + запрос).
    expect(stdin.slice(firstLineEnd + 1)).toBe(
      'SET SESSION max_execution_time=115000;\nSET SESSION TRANSACTION READ ONLY;\nSELECT 1;\n',
    );
  });

  it('postgres: read-only SET right after the password line', () => {
    expect(buildChannelStdin(PG, 'SELECT 1;', { readOnly: true })).toBe(
      'pgsecret\nSET default_transaction_read_only = on;\nSELECT 1;\n',
    );
  });

  it('empty password: stdin starts with SQL, no blank line', () => {
    expect(buildChannelStdin({ ...PG, password: '' }, 'SELECT 1;', { readOnly: false })).toBe(
      'SELECT 1;\n',
    );
  });

  it('password with special characters stays a single verbatim line', () => {
    const tricky = "p@ss 'quote'\\slash\tand\ttabs ; DROP";
    const stdin = buildChannelStdin({ ...MYSQL, password: tricky }, 'SELECT 1', { readOnly: false });
    expect(stdin.split('\n')[0]).toBe(tricky);
    expect(stdin.slice(tricky.length + 1)).toBe(
      'SET SESSION max_execution_time=115000;\nSELECT 1\n;\n',
    );
  });

  it('mariadb flavor: timeout in seconds', () => {
    const stdin = buildChannelStdin(MARIA, 'SELECT 1;', { readOnly: false });
    expect(stdin.startsWith('\n')).toBe(false); // пустой пароль — без пустой строки
    expect(stdin).toBe('SET SESSION max_statement_time=115;\nSELECT 1;\n');
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

describe('parseColumnDetail / parseIndexDetail / table-detail SQL', () => {
  it('parses PG column detail (types, nullable, default, key)', () => {
    const parsed = parseCsvTable(
      'name,type,nullable,default,constraints\n' +
        'id,integer,NO,,PRIMARY KEY\n' +
        'review_id,integer,YES,,FOREIGN KEY\n' +
        'lang,character varying,YES,,UNIQUE\n' +
        'description,text,YES,,\n',
    );
    expect(parseColumnDetail(parsed, 'postgres')).toEqual([
      { name: 'id', type: 'integer', nullable: false, default: null, key: 'pk' },
      { name: 'review_id', type: 'integer', nullable: true, default: null, key: 'fk' },
      { name: 'lang', type: 'character varying', nullable: true, default: null, key: 'uq' },
      { name: 'description', type: 'text', nullable: true, default: null, key: null },
    ]);
  });

  it('parses MySQL column detail (COLUMN_KEY → key)', () => {
    const parsed = parseTsvTable(
      'name\ttype\tnullable\tdefault\tkey\n' +
        'id\tint\tNO\tNULL\tPRI\n' +
        'lang\tvarchar(5)\tYES\tNULL\tUNI\n' +
        'review_id\tint\tYES\tNULL\tMUL\n' +
        'description\ttext\tYES\tNULL\t\n',
    );
    expect(parseColumnDetail(parsed, 'mysql')).toEqual([
      { name: 'id', type: 'int', nullable: false, default: null, key: 'pk' },
      { name: 'lang', type: 'varchar(5)', nullable: true, default: null, key: 'uq' },
      { name: 'review_id', type: 'int', nullable: true, default: null, key: 'fk' },
      { name: 'description', type: 'text', nullable: true, default: null, key: null },
    ]);
  });

  it('parses PG index detail (columns from indexdef)', () => {
    const parsed = parseCsvTable(
      'index_name,is_primary,is_unique,def\n' +
        'PK_users,t,t,"CREATE UNIQUE INDEX PK_users ON public.users USING btree (id)"\n' +
        'idx_email,f,t,"CREATE UNIQUE INDEX idx_email ON public.users USING btree (email)"\n' +
        'idx_name,f,f,"CREATE INDEX idx_name ON public.users USING btree (last_name, first_name)"\n',
    );
    expect(parseIndexDetail(parsed, 'postgres')).toEqual([
      { name: 'PK_users', columns: ['id'], unique: true, primary: true },
      { name: 'idx_email', columns: ['email'], unique: true, primary: false },
      { name: 'idx_name', columns: ['last_name', 'first_name'], unique: false, primary: false },
    ]);
  });

  it('parses MySQL index detail grouped by index name', () => {
    const parsed = parseTsvTable(
      'name\tcol\tnon_unique\n' +
        'PRIMARY\tid\t0\n' +
        'idx_review\treview_id\t1\n' +
        'uq_lang\tlang\t0\n' +
        'uq_lang\ttitle\t0\n',
    );
    expect(parseIndexDetail(parsed, 'mysql')).toEqual([
      { name: 'PRIMARY', columns: ['id'], unique: true, primary: true },
      { name: 'idx_review', columns: ['review_id'], unique: false, primary: false },
      { name: 'uq_lang', columns: ['lang', 'title'], unique: true, primary: false },
    ]);
  });

  it('index column list from indexdef handles nested parens (function index)', () => {
    expect(parseIndexColumnsFromDef('CREATE INDEX i ON t USING btree (lower(email))')).toEqual(['lower(email)']);
    expect(parseIndexColumnsFromDef('CREATE INDEX i ON t USING btree (a, b)')).toEqual(['a', 'b']);
    expect(parseIndexColumnsFromDef('CREATE INDEX i ON t')).toEqual([]);
  });

  it('builds table-detail SQL with escaped literals', () => {
    expect(pgTableDetailColumnsSql('public', 'users')).toContain("table_schema = 'public'");
    expect(pgTableDetailColumnsSql('public', 'users')).toContain("table_name = 'users'");
    expect(pgTableDetailColumnsSql("p''x", 't')).toContain("'p''''x'");
    expect(pgTableDetailIndexesSql('public', 'users')).toContain("nspname = 'public'");
    expect(pgTableDetailIndexesSql('public', 'users')).toContain("relname = 'users'");
    expect(mysqlTableDetailColumnsSql('users')).toContain(
      "table_schema = DATABASE() AND table_name = 'users'",
    );
    expect(mysqlTableDetailIndexesSql('orders')).toContain(
      "table_schema = DATABASE() AND table_name = 'orders'",
    );
  });
});
