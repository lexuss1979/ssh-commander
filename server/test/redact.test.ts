import { describe, expect, it } from 'vitest';
import {
  isSensitivePath,
  redactDockerEnv,
  redactSecrets,
  sensitivePathsIn,
} from '../src/ai/redact.js';

const PRIVATE_KEY = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gt',
  'ZWQyNTUxOQAAACDq3F0aXNlY3JldGtleW1hdGVyaWFsZm9ydGVzdGluZw==',
  '-----END OPENSSH PRIVATE KEY-----',
].join('\n');

describe('redactSecrets', () => {
  it('вырезает PEM-блок приватного ключа целиком', () => {
    const out = redactSecrets(`ключ:\n${PRIVATE_KEY}\nконец`);
    expect(out).not.toContain('b3BlbnNzaC1rZXktdjEA');
    expect(out).not.toContain('BEGIN OPENSSH PRIVATE KEY');
    expect(out).toContain('конец');
  });

  it('вырезает оборванный PEM-блок (файл прочитан не до конца)', () => {
    const cut = PRIVATE_KEY.split('\n').slice(0, 2).join('\n');
    const out = redactSecrets(`before\n${cut}`);
    expect(out).not.toContain('b3BlbnNzaC1rZXktdjEA');
    expect(out).toContain('before');
  });

  it('вырезает значения по говорящему имени, сохраняя само имя', () => {
    const out = redactSecrets('MARIADB_ROOT_PASSWORD=chpass123 DB_HOST=db');
    expect(out).toContain('MARIADB_ROOT_PASSWORD=');
    expect(out).not.toContain('chpass123');
    expect(out).toContain('DB_HOST=db');
  });

  it('работает и для JSON-формы записи', () => {
    const out = redactSecrets('{"api_key": "abcdef123456", "port": 5432}');
    expect(out).not.toContain('abcdef123456');
    expect(out).toContain('"port": 5432');
  });

  it('ловит токены известного вида без имени рядом', () => {
    const out = redactSecrets('ключ sk-abcdefghijklmnopqrstuvwxyz012345 и AKIAIOSFODNN7EXAMPLE');
    expect(out).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345');
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('вырезает только пароль из URL с учётными данными', () => {
    const out = redactSecrets('postgres://appuser:s3cr3tpw@db.internal:5432/app');
    expect(out).not.toContain('s3cr3tpw');
    expect(out).toContain('appuser');
    expect(out).toContain('db.internal:5432/app');
  });

  it('не трогает конфиги, где имя отделено пробелом (sshd_config)', () => {
    const conf = 'PasswordAuthentication yes\nPermitRootLogin prohibit-password';
    expect(redactSecrets(conf)).toBe(conf);
  });

  it('маркер локализован по языку сессии', () => {
    expect(redactSecrets('TOKEN=abcdef', 'en')).toMatch(/secret hidden by the app/);
    expect(redactSecrets('TOKEN=abcdef', 'ru')).toMatch(/секрет скрыт приложением/);
  });
});

describe('redactDockerEnv', () => {
  it('скрывает значения Env, оставляя имена переменных', () => {
    const inspected = [
      {
        Name: '/app',
        Config: {
          Image: 'app:latest',
          Env: ['PATH=/usr/bin', 'NODE_ENV=production', 'LLM_API_KEY=sk-verysecretvalue', 'ADMIN=hunter2'],
        },
      },
    ];
    const out = redactDockerEnv(inspected) as typeof inspected;
    const env = out[0].Config.Env;
    expect(env[0]).toBe('PATH=/usr/bin');
    expect(env[1]).toBe('NODE_ENV=production');
    expect(env[2]).toContain('LLM_API_KEY=');
    expect(env[2]).not.toContain('sk-verysecretvalue');
    // Секрет под безобидным именем тоже скрыт: по значению угадать нельзя.
    expect(env[3]).not.toContain('hunter2');
    expect(out[0].Config.Image).toBe('app:latest');
  });

  it('находит Env на любой глубине и не ломает остальную структуру', () => {
    const out = redactDockerEnv({ a: { b: { ContainerConfig: { Env: ['SECRET=x1'] } } }, n: 1 }) as {
      a: { b: { ContainerConfig: { Env: string[] } } };
      n: number;
    };
    expect(out.a.b.ContainerConfig.Env[0]).not.toContain('x1');
    expect(out.n).toBe(1);
  });
});

describe('isSensitivePath / sensitivePathsIn', () => {
  it('опознаёт файлы секретов', () => {
    for (const p of [
      '/srv/app/.env',
      '/srv/app/.env.production',
      '/root/.ssh/id_rsa',
      '/home/u/.ssh/id_ed25519',
      '/etc/ssl/private/site.key',
      '/etc/ssl/certs/site.pem',
      '/root/.pgpass',
      '/root/.aws/credentials',
      '/etc/shadow',
      '/opt/app/secrets.yml',
    ]) {
      expect(isSensitivePath(p), p).toBe(true);
    }
  });

  it('не мешает обычным путям', () => {
    for (const p of [
      '/var/log/syslog',
      '/etc/nginx/nginx.conf',
      '/root/.ssh/authorized_keys',
      '/root/.ssh/known_hosts',
      '/home/u/.ssh/id_ed25519.pub',
      '/etc/passwd',
    ]) {
      expect(isSensitivePath(p), p).toBe(false);
    }
  });

  it('находит путь к секрету среди аргументов команды', () => {
    expect(sensitivePathsIn('cat /root/.ssh/id_rsa')).toEqual(['/root/.ssh/id_rsa']);
    expect(sensitivePathsIn('grep -r pass /srv/app/.env')).toEqual(['/srv/app/.env']);
    expect(sensitivePathsIn('tail -n 50 /var/log/syslog')).toEqual([]);
  });
});
