import { describe, expect, it } from 'vitest';
import {
  extractEnv,
  imageRepository,
  matchDbEngine,
  matchMysqlFlavor,
  toDbHint,
  toDbSuggestion,
} from '../src/services/db-discovery.js';

describe('imageRepository', () => {
  it('strips tag and keeps repository', () => {
    expect(imageRepository('postgres:16-alpine')).toBe('postgres');
    expect(imageRepository('mysql:8')).toBe('mysql');
  });

  it('strips digest', () => {
    expect(imageRepository('postgres@sha256:abc123')).toBe('postgres');
  });

  it('strips registry host with dot', () => {
    expect(imageRepository('registry.example.com:5000/postgres:16')).toBe('postgres');
    expect(imageRepository('docker.io/postgres')).toBe('postgres');
  });

  it('keeps namespace without registry', () => {
    expect(imageRepository('timescale/timescaledb:latest-pg16')).toBe('timescale/timescaledb');
    expect(imageRepository('postgis/postgis:16-3.4')).toBe('postgis/postgis');
  });

  it('treats localhost as registry', () => {
    expect(imageRepository('localhost:5000/mydb:1')).toBe('mydb');
  });

  it('does not strip plain word prefix as registry', () => {
    expect(imageRepository('bitnami/postgresql')).toBe('bitnami/postgresql');
  });

  it('is case-insensitive', () => {
    expect(imageRepository('Docker.io/Postgres:16')).toBe('postgres');
  });
});

describe('matchDbEngine', () => {
  it('matches official postgres/mysql/mariadb', () => {
    expect(matchDbEngine('postgres:16-alpine')).toBe('postgres');
    expect(matchDbEngine('postgres')).toBe('postgres');
    expect(matchDbEngine('mysql:8')).toBe('mysql');
    expect(matchDbEngine('mariadb:11')).toBe('mysql');
  });

  it('matches pg-compatible images', () => {
    expect(matchDbEngine('timescale/timescaledb:latest-pg16')).toBe('postgres');
    expect(matchDbEngine('timescale/timescaledb-ha:pg16')).toBe('postgres');
    expect(matchDbEngine('postgis/postgis:16-3.4')).toBe('postgres');
  });

  it('matches bitnami images', () => {
    expect(matchDbEngine('bitnami/postgresql:16')).toBe('postgres');
    expect(matchDbEngine('bitnami/mysql:8')).toBe('mysql');
    expect(matchDbEngine('bitnami/mariadb:11')).toBe('mysql');
  });

  it('matches with registry prefix', () => {
    expect(matchDbEngine('registry.example.com:5000/postgres:16')).toBe('postgres');
    expect(matchDbEngine('docker.io/library/mysql:8')).toBe('mysql');
  });

  it('returns null for unrelated images', () => {
    expect(matchDbEngine('nginx:alpine')).toBeNull();
    expect(matchDbEngine('myapp/postgres-gui:2')).toBeNull();
    expect(matchDbEngine('postgres-gui:2')).toBeNull();
    expect(matchDbEngine('')).toBeNull();
  });
});

describe('matchMysqlFlavor', () => {
  it('distinguishes mariadb from mysql', () => {
    expect(matchMysqlFlavor('mariadb:11')).toBe('mariadb');
    expect(matchMysqlFlavor('bitnami/mariadb:11')).toBe('mariadb');
    expect(matchMysqlFlavor('mysql:8')).toBe('mysql');
    expect(matchMysqlFlavor('bitnami/mysql:8')).toBe('mysql');
  });
});

describe('extractEnv', () => {
  it('parses KEY=VALUE with equals inside value', () => {
    expect(extractEnv(['A=1', 'B=x=y', 'POSTGRES_USER=app'])).toEqual({
      A: '1',
      B: 'x=y',
      POSTGRES_USER: 'app',
    });
  });

  it('skips malformed lines', () => {
    expect(extractEnv(['NOEQ', '=X', 'C=3'])).toEqual({ C: '3' });
  });

  it('handles undefined env', () => {
    expect(extractEnv(undefined)).toEqual({});
  });
});

function inspectFixture(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    Id: 'abc123',
    Name: '/pg',
    Config: {
      Image: 'postgres:16-alpine',
      Env: ['POSTGRES_USER=app', 'POSTGRES_DB=appdb', 'PATH=/usr/bin'],
    },
    ...overrides,
  };
}

describe('toDbSuggestion', () => {
  it('suggests user/database from postgres env', () => {
    const s = toDbSuggestion(inspectFixture({}) as any)!;
    expect(s).toEqual({
      id: 'abc123',
      name: 'pg',
      engine: 'postgres',
      image: 'postgres:16-alpine',
      suggestedUser: 'app',
      suggestedDatabase: 'appdb',
    });
  });

  it('defaults postgres suggestion to postgres/postgres', () => {
    const s = toDbSuggestion(inspectFixture({
      Config: { Image: 'postgres:16', Env: ['PATH=/usr/bin'] },
    }) as any)!;
    expect(s.suggestedUser).toBe('postgres');
    expect(s.suggestedDatabase).toBe('postgres');
  });

  it('mysql suggestion: root unless MYSQL_USER set', () => {
    const s = toDbSuggestion(inspectFixture({
      Name: '/my',
      Config: { Image: 'mysql:8', Env: ['MYSQL_ROOT_PASSWORD=secret', 'MYSQL_DATABASE=shop'] },
    }) as any)!;
    expect(s).toMatchObject({
      engine: 'mysql',
      suggestedUser: 'root',
      suggestedDatabase: 'shop',
      flavor: 'mysql',
    });
  });

  it('mysql dedicated user suggested when MYSQL_USER set', () => {
    const s = toDbSuggestion(inspectFixture({
      Name: '/my',
      Config: {
        Image: 'mysql:8',
        Env: ['MYSQL_ROOT_PASSWORD=rootpw', 'MYSQL_USER=app', 'MYSQL_PASSWORD=apppw', 'MYSQL_DATABASE=shop'],
      },
    }) as any)!;
    expect(s.suggestedUser).toBe('app');
    expect(s.suggestedDatabase).toBe('shop');
  });

  it('mysql without MYSQL_DATABASE: no database suggestion — MySQL не создаёт схему с именем пользователя', () => {
    const s = toDbSuggestion(inspectFixture({
      Name: '/my',
      Config: { Image: 'mysql:8', Env: ['MYSQL_ROOT_PASSWORD=x', 'MYSQL_USER=app', 'MYSQL_PASSWORD=y'] },
    }) as any)!;
    expect(s.suggestedDatabase).toBeNull();
  });

  it('mariadb flavor detected', () => {
    const s = toDbSuggestion(inspectFixture({
      Name: '/maria',
      Config: { Image: 'mariadb:11', Env: ['MYSQL_ROOT_PASSWORD=x'] },
    }) as any)!;
    expect(s.engine).toBe('mysql');
    expect(s.flavor).toBe('mariadb');
  });

  it('returns null for unknown image', () => {
    expect(toDbSuggestion(inspectFixture({
      Config: { Image: 'nginx:alpine', Env: [] },
    }) as any)).toBeNull();
  });
});

describe('toDbHint', () => {
  it('hints container with exposed 5432 but unknown image', () => {
    const hint = toDbHint(inspectFixture({
      Name: '/custom-db',
      Config: { Image: 'mycompany/db:2', Env: [] },
      NetworkSettings: { Ports: { '5432/tcp': null } },
    }) as any);
    expect(hint).toEqual({ id: 'abc123', name: 'custom-db', port: 5432 });
  });

  it('hints published 3306', () => {
    const hint = toDbHint(inspectFixture({
      Name: '/weird',
      Config: { Image: 'some/app:1', Env: [] },
      NetworkSettings: { Ports: { '3306/tcp': [{ HostIp: '0.0.0.0', HostPort: '3306' }] } },
    }) as any);
    expect(hint).toEqual({ id: 'abc123', name: 'weird', port: 3306 });
  });

  it('no hint for recognized db engine', () => {
    expect(toDbHint(inspectFixture({
      NetworkSettings: { Ports: { '5432/tcp': null } },
    }) as any)).toBeNull();
  });

  it('no hint without db ports', () => {
    expect(toDbHint(inspectFixture({
      Config: { Image: 'nginx:alpine', Env: [] },
      NetworkSettings: { Ports: { '80/tcp': null } },
    }) as any)).toBeNull();
  });
});
