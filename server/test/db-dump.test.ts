import { describe, expect, it } from 'vitest';
import { buildDumpCommand, dumpFileName, mysqlDumpArgs, pgDumpArgs } from '../src/services/db-dump.js';
import type { DbExecTarget } from '../src/services/db-query.js';
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

describe('pgDumpArgs', () => {
  it('reads password from stdin first line, pipes through gzip, no pipefail', () => {
    // Без `set -o pipefail`: dash 0.5.11 (ubuntu/mariadb-образы) абортит
    // скрипт на неизвестной опции — дамп умирал бы целиком. Ошибки ловит
    // роут буферизацией головы stdout (см. routes/db.ts).
    expect(pgDumpArgs(PG, 'appdb')).toEqual([
      'exec', '-i', 'abc123', 'sh', '-c',
      `IFS= read -r PGPASSWORD; export PGPASSWORD; pg_dump -U 'app' 'appdb' | gzip`,
    ]);
  });

  it('empty password: no read prologue', () => {
    expect(pgDumpArgs({ ...PG, password: '' }, 'appdb')[5]).toBe(
      `pg_dump -U 'app' 'appdb' | gzip`,
    );
  });
});

describe('mysqlDumpArgs', () => {
  it('reads password from stdin first line, single transaction', () => {
    expect(mysqlDumpArgs(MYSQL, 'shop')).toEqual([
      'exec', '-i', 'def456', 'sh', '-c',
      `IFS= read -r MYSQL_PWD; export MYSQL_PWD; mysqldump -u 'root' ` +
        `--single-transaction --default-character-set=utf8mb4 'shop' | gzip`,
    ]);
  });

  it('no password value in argv', () => {
    expect(mysqlDumpArgs(MYSQL, 'shop').join(' ')).not.toContain('mysecret');
  });
});

describe('buildDumpCommand', () => {
  it('full command: outer shq by dockerCommand, inner quotes survive', () => {
    expect(buildDumpCommand(PROFILE, PG, 'appdb')).toBe(
      `docker 'exec' '-i' 'abc123' 'sh' '-c' ` +
        `'IFS= read -r PGPASSWORD; export PGPASSWORD; pg_dump -U '\\''app'\\'' '\\''appdb'\\'' | gzip'`,
    );
  });

  it('uses custom dockerCommand of the profile', () => {
    expect(buildDumpCommand({ ...PROFILE, dockerCommand: 'podman' }, MYSQL, 'shop')).toContain(
      "podman 'exec'",
    );
  });
});

describe('dumpFileName', () => {
  it('is <db>-<date>.sql.gz', () => {
    expect(dumpFileName('shop')).toMatch(/^shop-\d{4}-\d{2}-\d{2}\.sql\.gz$/);
  });
});
