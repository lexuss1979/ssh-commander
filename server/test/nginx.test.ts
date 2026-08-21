import { X509Certificate } from 'node:crypto';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  buildCertBatchCmd,
  buildDumpCmd,
  buildReloadCmd,
  buildTestCmd,
  buildVersionCmd,
  getNginxSnapshot,
  isNginxContainer,
  NginxTestFailedError,
  parseSourceRef,
  parseVersion,
  reloadNginx,
} from '../src/services/nginx.js';
import {
  certInfoFromPem,
  parseCertBatch,
  parseListen,
  parseNginxDump,
  splitDumpFrames,
  toSiteEntry,
} from '../src/services/nginx-parser.js';
import { exec } from '../src/ssh/manager.js';
import type { NginxSourceRef, Profile } from '../src/types.js';

vi.mock('../src/ssh/manager.js', () => ({ exec: vi.fn() }));
const mockedExec = vi.mocked(exec);

const profile: Profile = {
  id: 'p1',
  name: 'test',
  host: '127.0.0.1',
  port: 2222,
  username: 'test',
  authType: 'password',
  password: 'secret',
};

const native: NginxSourceRef = { type: 'native', bin: '/usr/sbin/nginx' };
const container: NginxSourceRef = {
  type: 'container',
  containerId: 'abc123def',
  containerName: 'web-nginx',
};

/** Снапшот кэшируется 2 с на профиль — каждый тест снапшота берёт свой id. */
function profileOf(id: string): Profile {
  return { ...profile, id };
}

// ---------------------------------------------------------------------------
// Фикстуры
// ---------------------------------------------------------------------------

/** Реалистичный дамп `nginx -T` в стиле Debian (план: nginx.conf +
 * conf.d/* + sites-enabled/* через маркеры файлов; proxy и static сайты;
 * IPv4+IPv6, 443 ssl, default_server; wildcard; upstream/map/if/stream). */
const DUMP = `# configuration file /etc/nginx/nginx.conf:
user www-data;
worker_processes auto;
pid /run/nginx.pid;
include /etc/nginx/modules-enabled/*.conf;

events {
	worker_connections 768;
}

http {
	sendfile on;
	tcp_nopush on;
	include /etc/nginx/mime.types;
	default_type application/octet-stream;
	ssl_protocols TLSv1.2 TLSv1.3;
	access_log /var/log/nginx/access.log;
	error_log /var/log/nginx/error.log;
	gzip on;
	include /etc/nginx/conf.d/*.conf;
	include /etc/nginx/sites-enabled/*;
}

# configuration file /etc/nginx/conf.d/ssl-common.conf:
# общий сертификат на http-уровне — дефолт для server-блоков без своего
ssl_certificate /etc/nginx/ssl/common.pem;
ssl_certificate_key /etc/nginx/ssl/common.key;

# configuration file /etc/nginx/sites-enabled/example.com:
server {
	listen 80;
	listen [::]:80;
	server_name example.com www.example.com;
	root /var/www/example;
	location / {
		proxy_pass http://127.0.0.1:3000;
		proxy_set_header Host $host;
	}
	location /static/ {
		alias /var/www/example/static;
	}
}

# configuration file /etc/nginx/sites-enabled/secure.example.com:
server {
	listen 443 ssl default_server;
	listen [::]:443 ssl default_server;
	server_name secure.example.com;
	ssl_certificate /etc/letsencrypt/live/secure.example.com/fullchain.pem;
	root /srv/secure;
	location / {
		try_files $uri $uri/ =404;
	}
}

# configuration file /etc/nginx/sites-enabled/app.internal.conf:
upstream backend {
	server 127.0.0.1:8080;
	server 127.0.0.1:8081;
}
map $http_upgrade $connection_upgrade {
	default upgrade;
	'' close;
}
server {
	listen 8080;
	server_name app.internal;
	location / {
		if ($request_method = POST) {
			return 405;
		}
		proxy_pass http://backend;
	}
}

# configuration file /etc/nginx/sites-enabled/wildcard.conf:
server {
	listen 80;
	server_name *.example.org;
	location / {
		proxy_pass http://10.0.0.1:9000;
	}
}
`;

// Самоподписанный сертификат (CN=test.example.com), действителен до
// 2126-07-27 — фикстура не протухнет за время жизни тестов.
const TEST_PEM = `-----BEGIN CERTIFICATE-----
MIIDNjCCAh6gAwIBAgIUAkZzs+L8jtPwqD/GdDTu8x9J7SEwDQYJKoZIhvcNAQEL
BQAwGzEZMBcGA1UEAwwQdGVzdC5leGFtcGxlLmNvbTAgFw0yNjA4MjAxOTA3NDla
GA8yMTI2MDcyNzE5MDc0OVowGzEZMBcGA1UEAwwQdGVzdC5leGFtcGxlLmNvbTCC
ASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAK3j0yKSR5DYzACUlw48frT+
GvNaUDZToQ5Cc1t+3cMde6gaLBhH1E1ZglAYuHzPVbAo1aCc76S3wvcPXHT10cI7
agzQZJO+rn5g/JAs06FDeHZAOI65+jDzncvvTGw/YLmrSu2SuBy0xu3Yag7CFM48
JYN5XSyhcCGuX7IeG5ITd2rTw2VLhYeAqTXApN2+QfrZHIYYNYMaii5DVbo2QFxn
5mQ7ywiflziQEnS1YgvJ9h7RL/0FM+ZchFeOZMVABuEzWQRYa+V7WRqPLoABx0L7
s1PpbYcbqy+fUFFBwF2T9b8sikxagSWUYe7ekHnOZqw6QFxhkuTJtemnK3hcBhEC
AwEAAaNwMG4wHQYDVR0OBBYEFM6U7yHf7sqCkoGR0Y/attCVoignMB8GA1UdIwQY
MBaAFM6U7yHf7sqCkoGR0Y/attCVoignMA8GA1UdEwEB/wQFMAMBAf8wGwYDVR0R
BBQwEoIQdGVzdC5leGFtcGxlLmNvbTANBgkqhkiG9w0BAQsFAAOCAQEAII9Rd0Q4
3uR9mP6yqL+z0ps9a87Hgp86QsPsM3RkVfMIAaE3eRqHBhOn1aH7Y2lCz2KRpB77
oSOyt67vu7KpPBb9beS9n42Xslm5Q6y/wqhbpAIrszw6IFVDuDBMINJ4/9xpjAXP
gWAeVp9oPv6xJ7/odp5KPSyQjYACamoj+labeEHM6On+a6qk1gSq2huvxaYoSx2u
kY+e9BGo+qAC2mUmJOY1YRJwJDmyuisH71r5vTUFNIhR2xTTGcVwlp8IxRbv7Wyf
/zS+IdzCCNSWHr06KMGl9ogTa8uKu6XjvcH5zjISHwRD8BJsOOsr749/Isng75bs
hdLNZGqrZW09KA==
-----END CERTIFICATE-----
`;

const BATCH_OUTPUT = `=== /etc/nginx/ssl/common.pem
${TEST_PEM}
=== /etc/letsencrypt/live/secure.example.com/fullchain.pem
${TEST_PEM}
`;

// ---------------------------------------------------------------------------
// Парсер дампа
// ---------------------------------------------------------------------------

describe('parseNginxDump', () => {
  it('раскадровывает дамп по маркерам файлов', () => {
    const frames = splitDumpFrames(DUMP);
    expect(frames.map((f) => f.file)).toEqual([
      '/etc/nginx/nginx.conf',
      '/etc/nginx/conf.d/ssl-common.conf',
      '/etc/nginx/sites-enabled/example.com',
      '/etc/nginx/sites-enabled/secure.example.com',
      '/etc/nginx/sites-enabled/app.internal.conf',
      '/etc/nginx/sites-enabled/wildcard.conf',
    ]);
  });

  it('парсит server-блоки с file из маркеров', () => {
    const parsed = parseNginxDump(DUMP);
    expect(parsed.sites).toHaveLength(4);
    expect(parsed.sites.map((s) => s.file)).toEqual([
      '/etc/nginx/sites-enabled/example.com',
      '/etc/nginx/sites-enabled/secure.example.com',
      '/etc/nginx/sites-enabled/app.internal.conf',
      '/etc/nginx/sites-enabled/wildcard.conf',
    ]);
  });

  it('читает общий ssl_certificate с http-уровня (в conf.d-фрейме без http-обёртки)', () => {
    const parsed = parseNginxDump(DUMP);
    expect(parsed.httpSslCertificate).toBe('/etc/nginx/ssl/common.pem');
  });

  it('собирает server_name и wildcard как есть', () => {
    const parsed = parseNginxDump(DUMP);
    const example = parsed.sites.find((s) => s.file?.includes('example.com'));
    expect(example?.serverNames).toEqual(['example.com', 'www.example.com']);
    const wildcard = parsed.sites.find((s) => s.file?.includes('wildcard'));
    expect(wildcard?.serverNames).toEqual(['*.example.org']);
  });

  it('парсит несколько listen (IPv4+IPv6, ssl, default_server)', () => {
    const parsed = parseNginxDump(DUMP);
    const example = parsed.sites.find((s) => s.file?.includes('example.com'))!;
    expect(example.listens).toEqual([
      { addr: '', port: 80, ssl: false, defaultServer: false },
      { addr: '[::]', port: 80, ssl: false, defaultServer: false },
    ]);
    const secure = parsed.sites.find((s) => s.file?.includes('secure.example.com'))!;
    expect(secure.listens).toEqual([
      { addr: '', port: 443, ssl: true, defaultServer: true },
      { addr: '[::]', port: 443, ssl: true, defaultServer: true },
    ]);
  });

  it('собирает location-блоки и proxy_pass (в т.ч. поверх if)', () => {
    const parsed = parseNginxDump(DUMP);
    const example = parsed.sites.find((s) => s.file?.includes('example.com'))!;
    expect(example.locations).toHaveLength(2);
    expect(example.locations[0]).toEqual({ match: '/', proxyPass: 'http://127.0.0.1:3000' });
    expect(example.locations[1]).toEqual({ match: '/static/', proxyPass: null });

    const app = parsed.sites.find((s) => s.file?.includes('app.internal'))!;
    expect(app.locations).toEqual([{ match: '/', proxyPass: 'http://backend' }]);
  });

  it('игнорирует upstream/map/if/stream и не падает на них', () => {
    // upstream и map — во фрейме app.internal.conf, stream — в nginx.conf.
    const parsed = parseNginxDump(DUMP);
    // stream-блок не дал сайтов: только 4 http-сайта.
    expect(parsed.sites).toHaveLength(4);
    // map/upstream не попали ни в один сайт.
    for (const site of parsed.sites) {
      expect(site.locations.some((l) => l.proxyPass === undefined)).toBe(false);
    }
  });

  it('не падает на мусорном/пустом вводе', () => {
    expect(parseNginxDump('').sites).toEqual([]);
    expect(parseNginxDump('random garbage\nwithout markers').sites).toEqual([]);
  });

  it('не режет # внутри кавычек (комментарий — только вне кавычек)', () => {
    const dump = `# configuration file /etc/nginx/sites-enabled/quoted.conf:
server {
    listen 80;
    server_name quoted.test;
    add_header X-Tag "a#b";
    proxy_set_header Host "it's #1";
    location / {
        proxy_pass http://127.0.0.1:7000;
    }
    # комментарий после блока — не ломает
}
`;
    const parsed = parseNginxDump(dump);
    expect(parsed.sites).toHaveLength(1);
    const site = parsed.sites[0];
    expect(site.serverNames).toEqual(['quoted.test']);
    expect(site.locations).toEqual([{ match: '/', proxyPass: 'http://127.0.0.1:7000' }]);
  });
});

describe('toSiteEntry', () => {
  const defaults = { sslCertificate: '/etc/nginx/ssl/common.pem' };

  it('proxy: proxy_pass из location / (root игнорируется)', () => {
    const parsed = parseNginxDump(DUMP);
    const site = toSiteEntry(parsed.sites.find((s) => s.file?.includes('example.com'))!, defaults);
    expect(site.target).toEqual({ kind: 'proxy', value: 'http://127.0.0.1:3000' });
    expect(site.locationsCount).toBe(2);
    expect(site.isDefault).toBe(false);
    expect(site.file).toBe('/etc/nginx/sites-enabled/example.com');
    // своего сертификата нет — применяется http-дефолт.
    expect(site.certPath).toBe('/etc/nginx/ssl/common.pem');
  });

  it('proxy: из первого location с proxy_pass, если location / без него', () => {
    const block = {
      file: '/etc/nginx/sites-enabled/x.conf',
      serverNames: ['x.test'],
      listens: [{ addr: '', port: 80, ssl: false, defaultServer: false }],
      root: '/srv/x',
      sslCertificate: null,
      locations: [
        { match: '/static', proxyPass: null },
        { match: '/api', proxyPass: 'http://api:8000' },
      ],
    };
    const site = toSiteEntry(block, defaults);
    expect(site.target).toEqual({ kind: 'proxy', value: 'http://api:8000' });
  });

  it('static: root, если proxy_pass нет', () => {
    const parsed = parseNginxDump(DUMP);
    const site = toSiteEntry(parsed.sites.find((s) => s.file?.includes('secure.example.com'))!, defaults);
    expect(site.target).toEqual({ kind: 'static', value: '/srv/secure' });
    expect(site.isDefault).toBe(true);
    // свой сертификат перекрывает http-дефолт.
    expect(site.certPath).toBe('/etc/letsencrypt/live/secure.example.com/fullchain.pem');
  });

  it('unknown: ни proxy_pass, ни root', () => {
    const block = {
      file: '/etc/nginx/sites-enabled/u.conf',
      serverNames: ['u.test'],
      listens: [{ addr: '', port: 80, ssl: false, defaultServer: false }],
      root: null,
      sslCertificate: null,
      locations: [],
    };
    const site = toSiteEntry(block, defaults);
    expect(site.target).toEqual({ kind: 'unknown', value: '' });
    expect(site.certPath).toBe('/etc/nginx/ssl/common.pem');
  });
});

describe('parseListen', () => {
  it('простые формы', () => {
    expect(parseListen(['80'])).toEqual({ addr: '', port: 80, ssl: false, defaultServer: false });
    expect(parseListen(['80', 'default_server'])).toEqual({
      addr: '',
      port: 80,
      ssl: false,
      defaultServer: true,
    });
    expect(parseListen(['443', 'ssl'])).toEqual({ addr: '', port: 443, ssl: true, defaultServer: false });
    expect(parseListen(['127.0.0.1:8080'])).toEqual({
      addr: '127.0.0.1',
      port: 8080,
      ssl: false,
      defaultServer: false,
    });
    expect(parseListen(['[::]:443', 'ssl'])).toEqual({
      addr: '[::]',
      port: 443,
      ssl: true,
      defaultServer: false,
    });
    expect(parseListen(['*:80'])).toEqual({ addr: '', port: 80, ssl: false, defaultServer: false });
  });

  it('unix-сокет и неопознанный формат не ломают', () => {
    expect(parseListen(['unix:/var/run/nginx.sock'])).toEqual({
      addr: 'unix:/var/run/nginx.sock',
      port: null,
      ssl: false,
      defaultServer: false,
    });
    expect(parseListen([])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Сертификаты
// ---------------------------------------------------------------------------

describe('certInfoFromPem', () => {
  it('парсит валидный PEM: notAfter и daysLeft', () => {
    const now = Date.parse('2026-08-20T00:00:00Z');
    const info = certInfoFromPem(TEST_PEM, now);
    expect(info).not.toBeNull();
    const expected = new X509Certificate(TEST_PEM).validTo;
    expect(info!.notAfter.toISOString()).toBe(new Date(expected).toISOString());
    const expectedDays = Math.floor((new Date(expected).getTime() - now) / 86_400_000);
    expect(info!.daysLeft).toBe(expectedDays);
    expect(info!.daysLeft).toBeGreaterThan(0);
  });

  it('битый PEM → null', () => {
    expect(certInfoFromPem('not a pem at all', Date.now())).toBeNull();
    expect(certInfoFromPem('-----BEGIN CERTIFICATE-----\ntruncated', Date.now())).toBeNull();
    expect(certInfoFromPem('', Date.now())).toBeNull();
  });
});

describe('parseCertBatch', () => {
  it('раскадровывает несколько файлов по маркерам ===', () => {
    const map = parseCertBatch(BATCH_OUTPUT);
    expect([...map.keys()]).toEqual([
      '/etc/nginx/ssl/common.pem',
      '/etc/letsencrypt/live/secure.example.com/fullchain.pem',
    ]);
    expect(map.get('/etc/nginx/ssl/common.pem')).toContain('BEGIN CERTIFICATE');
  });

  it('отсутствующий файл секции в stdout не даёт (cat пишет в stderr)', () => {
    const map = parseCertBatch('=== /etc/nginx/ssl/ok.pem\nAAA\n');
    expect(map.has('/etc/nginx/ssl/missing.pem')).toBe(false);
    expect(map.get('/etc/nginx/ssl/ok.pem')).toBe('AAA');
  });

  it('пустой ввод — пустая Map', () => {
    expect(parseCertBatch('').size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Билдеры команд
// ---------------------------------------------------------------------------

describe('билдеры команд', () => {
  it('native: shell-строка с shq на бинаре', () => {
    expect(buildDumpCmd(native)).toBe("'/usr/sbin/nginx' -T");
    expect(buildTestCmd(native)).toBe("'/usr/sbin/nginx' -t");
    expect(buildReloadCmd(native)).toBe("'/usr/sbin/nginx' -s reload");
    expect(buildVersionCmd(native)).toBe("'/usr/sbin/nginx' -v");
  });

  it('container: docker-аргументы через dockerExec', () => {
    expect(buildDumpCmd(container)).toEqual(['exec', 'abc123def', 'nginx', '-T']);
    expect(buildTestCmd(container)).toEqual(['exec', 'abc123def', 'nginx', '-t']);
    expect(buildReloadCmd(container)).toEqual(['exec', 'abc123def', 'nginx', '-s', 'reload']);
    expect(buildVersionCmd(container)).toEqual(['exec', 'abc123def', 'nginx', '-v']);
  });

  it('buildCertBatchCmd: shq на путях с пробелами', () => {
    const cmd = buildCertBatchCmd(native, ['/etc/ssl/a b.pem', '/etc/ssl/c.pem']);
    expect(cmd).toContain("'/etc/ssl/a b.pem'");
    expect(cmd).toContain("'/etc/ssl/c.pem'");
    expect(cmd).toContain('if [ -f "$f" ]');
    expect(cmd).toContain('echo "=== $f"');
    const containerCmd = buildCertBatchCmd(container, ['/etc/ssl/c.pem']);
    expect(containerCmd).toEqual(['exec', 'abc123def', 'sh', '-c', expect.stringContaining('/etc/ssl/c.pem')]);
  });
});

describe('parseVersion', () => {
  it('берёт версию из stderr nginx -v', () => {
    expect(parseVersion('nginx version: nginx/1.25.3\n')).toBe('1.25.3');
    expect(parseVersion('nginx version: nginx/1.27.0 (Ubuntu)\n')).toBe('1.27.0');
    expect(parseVersion('something else')).toBeNull();
  });
});

describe('isNginxContainer', () => {
  it('белый список репозиториев', () => {
    expect(isNginxContainer('nginx:1.25', 'web')).toBe(true);
    expect(isNginxContainer('nginxproxy/nginx-proxy:latest', 'proxy')).toBe(true);
    expect(isNginxContainer('jc21/nginx-proxy-manager:2', 'npm')).toBe(true);
    expect(isNginxContainer('openresty/openresty:alpine', 'gw')).toBe(true);
    expect(isNginxContainer('docker.io/library/nginx:alpine', 'x')).toBe(true);
  });

  it('подстрока nginx в образе или имени', () => {
    expect(isNginxContainer('registry.example.com/web-nginx:1', 'app')).toBe(true);
    expect(isNginxContainer('alpine:3.19', 'web-nginx')).toBe(true);
  });

  it('не nginx — false', () => {
    expect(isNginxContainer('ghcr.io/user/custom-proxy:1', 'gateway')).toBe(false);
    expect(isNginxContainer('postgres:16', 'db')).toBe(false);
    expect(isNginxContainer('', '')).toBe(false);
  });
});

describe('parseSourceRef', () => {
  it('native и container:<id>', () => {
    expect(parseSourceRef('native')).toEqual({ type: 'native', bin: '' });
    expect(parseSourceRef('container:abc')).toEqual({
      type: 'container',
      containerId: 'abc',
      containerName: '',
    });
    expect(parseSourceRef('container:')).toBeNull();
    expect(parseSourceRef('bogus')).toBeNull();
    expect(parseSourceRef('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Снапшот (мок exec) и guard reload
// ---------------------------------------------------------------------------

/** Мок exec, обслуживающий один снапшот: discovery, -T дамп, -t успех,
 * -v версия, прочее — батч сертификатов. */
function mockSnapshotExec(): void {
  mockedExec.mockImplementation((_p, cmd) => {
    const c = String(cmd);
    if (c.includes('command -v nginx')) return Promise.resolve({ code: 0, stdout: '/usr/sbin/nginx\n', stderr: '' });
    if (c.includes('-T')) return Promise.resolve({ code: 0, stdout: DUMP, stderr: '' });
    if (c.includes('-t')) return Promise.resolve({ code: 0, stdout: '', stderr: 'test is successful' });
    if (c.includes('-v')) return Promise.resolve({ code: 0, stdout: '', stderr: 'nginx version: nginx/1.25.3' });
    return Promise.resolve({ code: 0, stdout: BATCH_OUTPUT, stderr: '' });
  });
}

describe('getNginxSnapshot', () => {
  beforeEach(() => {
    mockedExec.mockReset();
  });

  it('собирает сайты, версию и конфиг-тест для native', async () => {
    mockSnapshotExec();
    const snap = await getNginxSnapshot(profileOf('snap-1'));
    expect(snap.sources).toHaveLength(1);
    const s = snap.sources[0];
    expect(s.type).toBe('native');
    expect(s.version).toBe('1.25.3');
    expect(s.configTest).toEqual({ ok: true, output: 'test is successful' });
    expect(s.error).toBeUndefined();
    expect(s.sites).toHaveLength(4);
  });

  it('заполняет сертификаты: свой, http-дефолт, недоступный файл', async () => {
    mockSnapshotExec();
    const snap = await getNginxSnapshot(profileOf('snap-2'));
    const sites = snap.sources[0].sites;

    const secure = sites.find((s) => s.file.includes('secure.example.com'))!;
    expect(secure.cert).toMatchObject({
      path: '/etc/letsencrypt/live/secure.example.com/fullchain.pem',
    });
    expect(secure.cert && 'daysLeft' in secure.cert ? secure.cert.daysLeft : null).toBeGreaterThan(0);
    expect(secure.cert && 'notAfter' in secure.cert ? secure.cert.notAfter : null).toMatch(/^\d{4}-/);

    // Без своего сертификата — http-дефолт.
    const example = sites.find((s) => s.file.includes('example.com'))!;
    expect(example.cert).toMatchObject({ path: '/etc/nginx/ssl/common.pem' });
  });

  it('дедуп путей сертификатов перед батчем', async () => {
    mockSnapshotExec();
    await getNginxSnapshot(profileOf('snap-3'));
    // Батч-вызов — тот, что не -T/-t/-v: пути в команде ровно по одному разу.
    const batchCall = mockedExec.mock.calls.find(([, cmd]) => {
      const c = String(cmd);
      return c.includes('for f in') && c.includes('cat --');
    });
    expect(batchCall).toBeDefined();
    const cmd = String(batchCall![1]);
    for (const p of ['/etc/nginx/ssl/common.pem', '/etc/letsencrypt/live/secure.example.com/fullchain.pem']) {
      expect(cmd.split(`'${p}'`).length - 1).toBe(1);
    }
  });

  it('упавший nginx -T → секция с error, снапшот не падает', async () => {
    mockedExec.mockImplementation((_p, cmd) => {
      const c = String(cmd);
      if (c.includes('command -v nginx'))
        return Promise.resolve({ code: 0, stdout: '/usr/sbin/nginx\n', stderr: '' });
      if (c.includes('-T'))
        return Promise.resolve({
          code: 1,
          stdout: '',
          stderr: 'nginx: [emerg] open() "/etc/nginx/nginx.conf" failed',
        });
      if (c.includes('-t')) return Promise.resolve({ code: 1, stdout: '', stderr: 'nginx: [emerg] bad' });
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    });
    const snap = await getNginxSnapshot(profileOf('snap-4'));
    expect(snap.sources).toHaveLength(1);
    expect(snap.sources[0].error).toContain('nginx -T');
    expect(snap.sources[0].sites).toEqual([]);
  });

  it('nginx не найден → sources: []', async () => {
    mockedExec.mockResolvedValue({ code: 1, stdout: '', stderr: '' });
    const snap = await getNginxSnapshot(profileOf('snap-5'));
    expect(snap.sources).toEqual([]);
  });
});

describe('reloadNginx (guard)', () => {
  beforeEach(() => {
    mockedExec.mockReset();
  });

  it('не вызывает reload при красном nginx -t', async () => {
    mockedExec.mockResolvedValue({
      code: 1,
      stdout: '',
      stderr: 'nginx: [emerg] unknown directive "x" in /etc/nginx/nginx.conf:3',
    });
    const promise = reloadNginx(profile, native);
    await expect(promise).rejects.toBeInstanceOf(NginxTestFailedError);
    await expect(promise).rejects.toMatchObject({ code: 'NGINX_TEST_FAILED' });
    // Только nginx -t — reload (-s reload) не выполнялся.
    expect(mockedExec).toHaveBeenCalledTimes(1);
    expect(String(mockedExec.mock.calls[0][1])).toContain('-t');
  });

  it('выполняет reload после зелёного теста', async () => {
    mockedExec.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const result = await reloadNginx(profile, native);
    expect(result.ok).toBe(true);
    expect(mockedExec).toHaveBeenCalledTimes(2);
    expect(String(mockedExec.mock.calls[1][1])).toContain('-s reload');
  });

  it('контейнерный источник: docker exec nginx -t → nginx -s reload', async () => {
    // dockerCommand шикует аргументы — ищем по кавыченным флагам.
    mockedExec.mockImplementation((_p, cmd) => {
      const c = String(cmd);
      if (c.includes("'-t'"))
        return Promise.resolve({
          code: 0,
          stdout: '',
          stderr: 'nginx: configuration file /etc/nginx/nginx.conf test is successful',
        });
      if (c.includes("'reload'")) return Promise.resolve({ code: 0, stdout: '', stderr: '' });
      return Promise.resolve({ code: 1, stdout: '', stderr: 'unexpected' });
    });
    const result = await reloadNginx(profile, container);
    expect(result.ok).toBe(true);
    expect(mockedExec.mock.calls.map(([, c]) => String(c))).toEqual([
      "docker 'exec' 'abc123def' 'nginx' '-t'",
      "docker 'exec' 'abc123def' 'nginx' '-s' 'reload'",
    ]);
  });
});
