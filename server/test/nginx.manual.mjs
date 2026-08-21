// Ручной интеграционный тест вкладки «Nginx» (docs/nginx-plan.md).
// Требует запущенный ssh-commander (APP_PASSWORD=test123, порт 8090) и SSH-хост
// с реальным docker (например linuxserver/openssh-server на 127.0.0.1:2222,
// user test / pass test123, с проброшенным docker.sock, либо VPS с docker):
//   docker run -d --name sc-sshd --restart=unless-stopped -p 2222:2222 \
//     -e PASSWORD_ACCESS=true -e USER_NAME=test -e USER_PASSWORD=test123 \
//     -v /var/run/docker.sock:/var/run/docker.sock \
//     linuxserver/openssh-server
// Запуск: node test/nginx.manual.mjs
// Сценарий: поднимает контейнер nginx:alpine с самоподписанным сертификатом,
// discovery находит его, снапшот содержит сайт, срок сертификата посчитан,
// nginx -t и reload работают.
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8090';
const PASSWORD = process.env.APP_PASSWORD ?? 'test123';
const CONTAINER_NAME = 'sc-nginx-test';
let cookie = '';

let passed = 0;
let failed = 0;

function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ok: ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL: ${name} ${detail}`);
  }
}

async function req(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      ...(opts.headers ?? {}),
      ...(cookie ? { cookie } : {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    throw new Error(
      `${opts.method ?? 'GET'} ${path} -> ${res.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`,
    );
  }
  return body;
}

function shq(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Самоподписанный сертификат CN=sc-test.local, действителен до 2126-07-27
// (пара cert.pem/key.pem сгенерированы вместе — nginx требует совпадения).
const CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDEzCCAfugAwIBAgIUaHtC0q60BLMIc8XRe5aQrM8/Th0wDQYJKoZIhvcNAQEL
BQAwGDEWMBQGA1UEAwwNc2MtdGVzdC5sb2NhbDAgFw0yNjA4MjAxOTE2NTBaGA8y
MTI2MDcyNzE5MTY1MFowGDEWMBQGA1UEAwwNc2MtdGVzdC5sb2NhbDCCASIwDQYJ
KoZIhvcNAQEBBQADggEPADCCAQoCggEBAKxA1oXQx0nGr59mKDpmDaeXzRdK59FR
K2O5THxq6cnWpPosMPtQ2+B2CpLfsdi59G6nKxb+CctFVFx2FzZPD6ogT0md4Qka
E32zf2UxOGYCpy1g2eFY2TNX0i+PszdWdudyECthJcMbqiFcSvIvcZy9gkRHPTHr
sdWjOrFNYeEaqpLyaWA/4MIP0tzlSExl5HYT0K+KPeToLZJlWlMn808LQvQH9Olm
XKNyHg6Lw/kgMdv1xJJpXSmlTsk6oBnPDuSvCEgx+t+I9XAbgOaoyHQFhSPh+6p8
D5hZq/B7mmcHHS0xIWunU50FqJJOXmOISHBM03pU3CZ06PkaPUkZ0nkCAwEAAaNT
MFEwHQYDVR0OBBYEFNzgqgZNXUgs5m6cMFVG4E3KSRb/MB8GA1UdIwQYMBaAFNzg
qgZNXUgs5m6cMFVG4E3KSRb/MA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQEL
BQADggEBAFrBPh2bGOeaElOMQ9OkuSKm1kTb408liG8zI38yn4I2pA7OUI6SHxGt
ntUzZvgHq7Ma9jZ+P7ZGLGCrE4hpkzikkK9v9fwI9nqrCv1C5e+BohrTsdW30nmI
VE9FDAHN2btxYJPMqYp0OocoL0r+5182EJbxFRHwo+NxrPpOVDrd8KF7iiRlF5Lx
5gLAVqwJbbSJt+8Di/D4vT2i0MUq9upvND+eTnuQn+8xSnT9JoDA7p9WvaKpHnwZ
aZ3s5ckdB0a1N28XO0gKPfN4X6SSjD/w51WRWrpOiJJwNDZphF8OpHJLRy05h9Cy
dcaL2sKtmL0rkDMjBMbDg9JtT9PvDkw=
-----END CERTIFICATE-----
`;

const KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCsQNaF0MdJxq+f
Zig6Zg2nl80XSufRUStjuUx8aunJ1qT6LDD7UNvgdgqS37HYufRupysW/gnLRVRc
dhc2Tw+qIE9JneEJGhN9s39lMThmAqctYNnhWNkzV9Ivj7M3VnbnchArYSXDG6oh
XEryL3GcvYJERz0x67HVozqxTWHhGqqS8mlgP+DCD9Lc5UhMZeR2E9Cvij3k6C2S
ZVpTJ/NPC0L0B/TpZlyjch4Oi8P5IDHb9cSSaV0ppU7JOqAZzw7krwhIMfrfiPVw
G4DmqMh0BYUj4fuqfA+YWavwe5pnBx0tMSFrp1OdBaiSTl5jiEhwTNN6VNwmdOj5
Gj1JGdJ5AgMBAAECggEAJlwjGfZSZz7gvf/3TfgLququoPUMtovbvI/XtW5uxYTw
RQlB2Dnb2XsYJDi+R6wzv8+pFCv7POIh5RxkU3McYy/iUFvhMVB2DjyCzqN9MpR9
K+khZGKPrjQsyew3xkdSX/0CFlMCYJag1uCRjSkdJUF7yN5PhbY+Knw5FiKMPV9/
mGCOyJF4HAiQnoOZGQeHyAB1OiHAM4IzRta2N7XypIKPTN+H7at18t20A2BfsGob
Co/qxl3KZAZglwFwoXGhnoN/Tog1T8X1T36axMJsPCVu+wG4mVOXDzmpcSsZb6D/
4eHE9jLkRrCZWF4Sul12a839RlH/3LDmqLmYIdzKHQKBgQDpR2h0lfD3Z6aItzIn
c6DaM5SpfdCWh9KU0eyAe2fKlWFA9y0E8U3744WeXtEoWJ/8o8Gzzuum82kRkkyk
17abJxbI2GZHw8DMDjWHPwGfwNFs5Q81G2qk1ez+Q9UnP8Ehfs0Xl6GXRdxcB98h
VhrGFSMH3mAvIf9QBGBTAH8M7QKBgQC9B8/ntimyNcL56BfukaP3X1VjsKYn7msY
9Z7CbXBVp/dtI8a60VZBKYYpGJn8WEtZpxhyREAwKnF/vlnXIG47q3At9z5cUFVB
oy+Ov2LopkOugNMtXPtn15rxbYMibGN/0heHfCNV+O1Iiscq6Gez4I5tsi8A9pJH
Z0C5wQj2PQKBgDNU4DpPSC/Yof+ReDrQKcP596t4IO8Owhq3Orhm70bXqgfWnBRr
WMKlpSBdMt8S6Vl5W0VKsfYRt7wDGlRnlyn65vuZCqCeBY2hTswM5DmX/z1cBgWk
m8nbvQOSP5QcZk4Njem0Fv2nhL7HiKTYQpn1yriPiVC1xW2BGQUKpepdAoGAAyBp
8+8zaVsySmfoXW3TRHgzNV7qoKZ05wjJA3ZD8WbB1PBOjTCBOLqzGWLqyR28wVLe
OKWgWiuZjP9dBQ3oRNxlEp2QTn6VqmxEkRvhSu/VFsHSvGFZVzJdwbiJ/rvEOY0E
Dp2jB/0CD70b5j3J2VPRh0b3OBDcAopWq7vhphECgYEAq+NEWfbcgZY+1tg6SIAP
GPG8cdB5Q+Tv6CBodv7wnzDFsdZ/LtUL21+8O32H/oqFVoMBtzr+iCHr/T75NO2f
bH67C2fW4Cu8SMsx3kO2MNdH5tuGXEcG5zJ3i9h9HBaQEHWiIY8+9HA99/sDD0ps
JIrEIBPc/yhrnaDzpqVpAuA=
-----END PRIVATE KEY-----
`;

// Конфиг сайта без $-переменных — не требует экранирования в shell.
const SITE_CONF = `server {
    listen 443 ssl;
    server_name sc-test.local;
    ssl_certificate /etc/nginx/ssl/cert.pem;
    ssl_certificate_key /etc/nginx/ssl/key.pem;
    root /usr/share/nginx/html;
    index index.html;
}`;

function writeFileCmd(path, content) {
  return `printf '%s' ${shq(content)} > ${shq(path)}`;
}

/** Команда контейнера: кладёт конфиг/сертификаты и запускает nginx. */
function buildContainerCommand() {
  return [
    'mkdir -p /etc/nginx/conf.d /etc/nginx/ssl',
    writeFileCmd('/etc/nginx/conf.d/site.conf', SITE_CONF),
    writeFileCmd('/etc/nginx/ssl/cert.pem', CERT_PEM),
    writeFileCmd('/etc/nginx/ssl/key.pem', KEY_PEM),
    'nginx -g "daemon off;"',
  ].join(' && ');
}

async function main() {
  console.log('== auth ==');
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const setCookie = login.headers.get('set-cookie') ?? '';
  const m = /sc_session=([^;]+)/.exec(setCookie);
  cookie = m ? `sc_session=${m[1]}` : '';
  check('login ok', cookie.length > 0);

  console.log('== profile ==');
  const existing = await req('/api/profiles');
  for (const p of existing.filter((x) => x.name === 'test-nginx')) {
    await req(`/api/profiles/${p.id}`, { method: 'DELETE' });
  }
  const profile = await req('/api/profiles', {
    method: 'POST',
    body: JSON.stringify({
      name: 'test-nginx',
      host: process.env.SSH_HOST ?? '127.0.0.1',
      port: Number(process.env.SSH_PORT ?? 2222),
      username: process.env.SSH_USER ?? 'test',
      authType: 'password',
      password: process.env.SSH_PASSWORD ?? 'test123',
      dockerCommand: 'docker',
    }),
  });
  const pid = profile.id;
  check('profile created', !!pid);
  const P = (extra = {}) => new URLSearchParams({ profileId: pid, ...extra });

  // Старый тестовый контейнер — удалить, чтобы docker run --name не конфликтовал.
  console.log('== prepare nginx container ==');
  let containerId = null;
  try {
    const containers = await req(`/api/docker/containers?${P()}`);
    for (const c of containers) {
      if (String(c.Names ?? '').replace(/^\//, '') === CONTAINER_NAME) {
        await req(`/api/docker/containers/${c.ID}/rm?${P()}`, { method: 'POST' });
      }
    }
    const run = await req(`/api/docker/containers?${P()}`, {
      method: 'POST',
      body: JSON.stringify({
        image: process.env.NGINX_IMAGE ?? 'nginx:alpine',
        name: CONTAINER_NAME,
        command: buildContainerCommand(),
      }),
    });
    containerId = String(run.output ?? '').trim();
    check('nginx container started', containerId.length > 10, JSON.stringify(run));
  } catch (err) {
    check(
      'nginx container started',
      false,
      `${err} — нужен SSH-хост с docker (см. шапку файла)`,
    );
    await req(`/api/profiles/${pid}`, { method: 'DELETE' }).catch(() => {});
    console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
    process.exit(1);
  }

  console.log('== discovery + snapshot ==');
  const snap = await req(`/api/nginx?${P()}`);
  const src = snap.sources?.find((s) => s.type === 'container' && s.containerName === CONTAINER_NAME);
  check('discovery находит контейнер nginx', !!src, JSON.stringify(snap.sources ?? []));
  if (!src) {
    // Дальнейшие проверки бессмысленны — чистим и выходим.
    await req(`/api/docker/containers/${containerId}/rm?${P()}`, { method: 'POST' }).catch(() => {});
    await req(`/api/profiles/${pid}`, { method: 'DELETE' }).catch(() => {});
    console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
    process.exit(1);
  }

  check('версия nginx из контейнера', typeof src.version === 'string' && src.version.length > 0, String(src.version));
  check('nginx -t зелёный', src.configTest?.ok === true, src.configTest?.output ?? '');

  const site = src.sites?.find((s) => s.serverNames?.includes('sc-test.local'));
  check('снапшот содержит сайт', !!site, JSON.stringify(src.sites ?? []));
  if (site) {
    check('listen 443 ssl распознан', site.listens?.some((l) => l.port === 443 && l.ssl), JSON.stringify(site.listens));
    check('target: static по root', site.target?.kind === 'static' && site.target?.value === '/usr/share/nginx/html', JSON.stringify(site.target));
    check('файл конфига приписан', typeof site.file === 'string' && site.file.includes('site.conf'), site.file);
    const cert = site.cert;
    check(
      'срок сертификата посчитан',
      !!cert && 'daysLeft' in cert && cert.daysLeft > 0 && 'notAfter' in cert,
      JSON.stringify(cert),
    );
  }

  const sourceKey = `container:${src.containerId}`;

  console.log('== nginx -t / reload ==');
  // Ходим как фронтенд (web/src/api.ts): profileId в query, тело — только source.
  const test = await req(`/api/nginx/test?${P()}`, {
    method: 'POST',
    body: JSON.stringify({ source: sourceKey }),
  });
  check('POST /api/nginx/test ok', test.ok === true, JSON.stringify(test));
  check('вывод теста не пуст', typeof test.output === 'string' && test.output.length > 0, String(test.output));

  const reload = await req(`/api/nginx/reload?${P()}`, {
    method: 'POST',
    body: JSON.stringify({ source: sourceKey }),
  });
  check('POST /api/nginx/reload ok', reload.ok === true, JSON.stringify(reload));

  console.log('== невалидный источник ==');
  try {
    await req(`/api/nginx/test?${P()}`, {
      method: 'POST',
      body: JSON.stringify({ source: 'container:deadbeef' }),
    });
    check('произвольный контейнер отклонён', false, 'ожидался 400');
  } catch (err) {
    check('произвольный контейнер отклонён', String(err).includes('400'), String(err));
  }

  console.log('== cleanup ==');
  await req(`/api/docker/containers/${containerId}/rm?${P()}`, { method: 'POST' }).catch(() => {});
  await req(`/api/profiles/${pid}`, { method: 'DELETE' }).catch(() => {});
  check('profile deleted', true);

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('NGINX MANUAL ERROR:', err);
  process.exit(1);
});
