import { describe, expect, it } from 'vitest';
import { buildDumpCommand, dumpFileName, mysqlDumpArgs, pgDumpArgs } from '../src/services/db-dump.js';
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

describe('pgDumpArgs', () => {
  it('pipes pg_dump through gzip with inner-shell quoting, no pipefail', () => {
    // Без `set -o pipefail`: dash 0.5.11 (ubuntu/mariadb-образы) абортит
    // скрипт на неизвестной опции — дамп умирал бы целиком. Ошибки ловит
    // роут буферизацией головы stdout (см. routes/db.ts).
    expect(pgDumpArgs(PG, 'appdb')).toEqual([
      'exec', 'abc123', 'sh', '-c',
      `pg_dump -U 'app' 'appdb' | gzip`,
    ]);
  });
});

describe('mysqlDumpArgs', () => {
  it('expands password inside container and uses single transaction', () => {
    expect(mysqlDumpArgs(MYSQL, 'shop')).toEqual([
      'exec', 'def456', 'sh', '-c',
      `[ -n "$MYSQL_ROOT_PASSWORD" ] && MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; mysqldump -u 'root' ` +
        `--single-transaction --default-character-set=utf8mb4 'shop' | gzip`,
    ]);
  });

  it('no password value in argv', () => {
    expect(mysqlDumpArgs(MYSQL, 'shop').join(' ')).not.toContain('secret');
  });

  it('probe candidate without credentials: no MYSQL_PWD prefix, no -u', () => {
    const bare = { ...MYSQL, user: '', passwordEnv: undefined };
    expect(mysqlDumpArgs(bare, 'shop')[4]).toBe(
      `mysqldump --single-transaction --default-character-set=utf8mb4 'shop' | gzip`,
    );
  });
});

describe('buildDumpCommand', () => {
  it('full command: outer shq by dockerCommand, inner quotes survive', () => {
    expect(buildDumpCommand(PROFILE, PG, 'appdb')).toBe(
      `docker 'exec' 'abc123' 'sh' '-c' 'pg_dump -U '\\''app'\\'' '\\''appdb'\\'' | gzip'`,
    );
  });
});

describe('dumpFileName', () => {
  it('is <db>-<date>.sql.gz', () => {
    expect(dumpFileName('shop')).toMatch(/^shop-\d{4}-\d{2}-\d{2}\.sql\.gz$/);
  });
});
