// Ручной интеграционный тест: требует запущенный ssh-commander (APP_PASSWORD=test123, порт 8090)
// и тестовый SSH-сервер (linuxserver/openssh-server на 127.0.0.1:2222, user test / pass test123).
// Запуск: node test/integration.manual.mjs
import WebSocket from 'ws';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8090';
const PASSWORD = process.env.APP_PASSWORD ?? 'test123';
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

function wsConnect(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace('http', 'ws')}${path}`, { headers });
    let gotResponse = false;
    ws.once('open', () => resolve(ws));
    ws.once('error', (err) => {
      if (!gotResponse) reject(err);
    });
    ws.once('unexpected-response', (_req, res) => {
      gotResponse = true;
      const err = new Error(`unexpected response ${res.statusCode}`);
      err.statusCode = res.statusCode;
      reject(err);
    });
  });
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

  console.log('== ws auth guard ==');
  try {
    await wsConnect('/ws/terminal?profileId=none');
    check('ws without cookie rejected', false);
  } catch (err) {
    check('ws without cookie rejected', err.statusCode === 401, String(err));
  }

  console.log('== profile ==');
  const existing = await req('/api/profiles');
  for (const p of existing.filter((x) => x.name === 'test-sshd')) {
    await req(`/api/profiles/${p.id}`, { method: 'DELETE' });
  }
  const profile = await req('/api/profiles', {
    method: 'POST',
    body: JSON.stringify({
      name: 'test-sshd',
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

  console.log('== files (SFTP) ==');
  const root = await req(`/api/files/list?${P()}`);
  check('list /', Array.isArray(root.entries));

  await req('/api/files/mkdir', { method: 'POST', body: JSON.stringify({ profileId: pid, path: '/tmp/sc-test' }) });
  await req('/api/files/write', {
    method: 'POST',
    body: JSON.stringify({ profileId: pid, path: '/tmp/sc-test/a.txt', content: 'hello world' }),
  });
  const read = await req(`/api/files/read?${P({ path: '/tmp/sc-test/a.txt' })}`);
  check('write+read file', read.content === 'hello world', JSON.stringify(read));

  await req('/api/files/chmod', {
    method: 'POST',
    body: JSON.stringify({ profileId: pid, path: '/tmp/sc-test/a.txt', mode: '644' }),
  });
  const listed = await req(`/api/files/list?${P({ path: '/tmp/sc-test' })}`);
  check('chmod + list', listed.entries[0]?.mode?.startsWith('-rw-r--r--'), JSON.stringify(listed.entries));

  const down = await fetch(`${BASE}/api/files/download?${P({ path: '/tmp/sc-test/a.txt' })}`, {
    headers: { cookie },
  });
  check('download', (await down.text()) === 'hello world');

  await req(`/api/files/upload?${P({ dir: '/tmp/sc-test', name: 'up.bin' })}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: Buffer.from([1, 2, 3, 4]),
  });
  const listed2 = await req(`/api/files/list?${P({ path: '/tmp/sc-test' })}`);
  check('upload', listed2.entries.some((e) => e.name === 'up.bin'));

  await req('/api/files/rename', {
    method: 'POST',
    body: JSON.stringify({ profileId: pid, from: '/tmp/sc-test/a.txt', to: '/tmp/sc-test/b.txt' }),
  });
  await req('/api/files/delete', {
    method: 'POST',
    body: JSON.stringify({ profileId: pid, path: '/tmp/sc-test/up.bin' }),
  });
  await req('/api/files/delete', {
    method: 'POST',
    body: JSON.stringify({ profileId: pid, path: '/tmp/sc-test/b.txt' }),
  });
  await req('/api/files/delete', {
    method: 'POST',
    body: JSON.stringify({ profileId: pid, path: '/tmp/sc-test' }),
  });
  const afterDelete = await req(`/api/files/list?${P({ path: '/tmp' })}`);
  check('rename+delete', !afterDelete.entries.some((e) => e.name === 'sc-test'));

  console.log('== terminal (WS) ==');
  const ws = await wsConnect(`/ws/terminal?profileId=${pid}&cols=80&rows=24`, { cookie });
  const terminalOut = await new Promise((resolve, reject) => {
    let out = '';
    let ready = false;
    const timer = setTimeout(() => reject(new Error('terminal timeout')), 15000);
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'connected') {
        ready = true;
        ws.send(JSON.stringify({ type: 'input', data: 'echo HELLO_FROM_TERMINAL\n' }));
        return;
      }
      if (msg.type === 'output') {
        out += msg.data;
        if (out.includes('HELLO_FROM_TERMINAL')) {
          clearTimeout(timer);
          ws.send(JSON.stringify({ type: 'input', data: 'exit\n' }));
          setTimeout(() => {
            ws.close();
            resolve(out);
          }, 800);
        }
      }
    });
    ws.on('error', reject);
    if (ready) ws.send(JSON.stringify({ type: 'input', data: 'echo HELLO_FROM_TERMINAL\n' }));
  });
  check('terminal echo', terminalOut.includes('HELLO_FROM_TERMINAL'), terminalOut.slice(0, 200));

  console.log('== docker CLI over SSH ==');
  const dockerScript = `#!/bin/sh
case "$1" in
  ps) echo '{"ID":"abc123","Names":"web","Image":"nginx:latest","Status":"Up 2 hours","Ports":"0.0.0.0:8080->80/tcp"}' ;;
  images) echo '{"ID":"img456","Repository":"nginx","Tag":"latest","Size":"192MB"}' ;;
  volume) if [ "$2" = "ls" ]; then echo '{"Name":"vol1","Driver":"local"}'; fi ;;
  network) if [ "$2" = "ls" ]; then echo '{"Name":"bridge","Driver":"bridge","Scope":"local"}'; fi ;;
  start|stop|rm|rmi) echo "$2" ;;
  inspect) echo '{"Id":"abc123","State":{"Running":true}}' ;;
  logs) echo 'log line 1' ;;
  pull) echo "Pulled $2" ;;
  run) echo "$2" ;;
esac
`;
  await req('/api/files/write', {
    method: 'POST',
    body: JSON.stringify({ profileId: pid, path: '/tmp/docker', content: dockerScript }),
  });
  await req('/api/files/chmod', {
    method: 'POST',
    body: JSON.stringify({ profileId: pid, path: '/tmp/docker', mode: '755' }),
  });
  await req(`/api/profiles/${pid}`, {
    method: 'PUT',
    body: JSON.stringify({
      name: 'test-sshd',
      host: process.env.SSH_HOST ?? '127.0.0.1',
      port: Number(process.env.SSH_PORT ?? 2222),
      username: process.env.SSH_USER ?? 'test',
      authType: 'password',
      password: process.env.SSH_PASSWORD ?? 'test123',
      dockerCommand: '/tmp/docker',
    }),
  });

  const containers = await req(`/api/docker/containers?${P()}`);
  check('docker ps', containers.length === 1 && containers[0].ID === 'abc123', JSON.stringify(containers));
  const images = await req(`/api/docker/images?${P()}`);
  check('docker images', images.length === 1 && images[0].Repository === 'nginx', JSON.stringify(images));
  const volumes = await req(`/api/docker/volumes?${P()}`);
  check('docker volumes', volumes.length === 1 && volumes[0].Name === 'vol1', JSON.stringify(volumes));
  const networks = await req(`/api/docker/networks?${P()}`);
  check('docker networks', networks.length === 1 && networks[0].Name === 'bridge', JSON.stringify(networks));
  await req(`/api/docker/containers/abc123/start?${P()}`, { method: 'POST' });
  check('docker start', true);
  const logs = await fetch(`${BASE}/api/docker/containers/abc123/logs?${P({ tail: '10' })}`, {
    headers: { cookie },
  });
  check('docker logs', (await logs.text()).includes('log line 1'));

  console.log('== cron ==');
  const cron0 = await req(`/api/cron?${P()}`);
  check('cron snapshot', typeof cron0.username === 'string' && 'systemCrontab' in cron0, JSON.stringify(cron0).slice(0, 200));
  const added = await req(`/api/cron/entries?${P()}`, {
    method: 'POST',
    body: JSON.stringify({ schedule: '*/5 * * * *', command: '/bin/true # sc-test' }),
  });
  const entry = added.userCrontab?.entries.find((e) => e.command.includes('sc-test'));
  check('cron add', !!entry && entry.enabled === true, JSON.stringify(added.userCrontab));
  if (entry) {
    const toggled = await req(`/api/cron/entries/${entry.index}/toggle?${P()}`, {
      method: 'POST',
      body: JSON.stringify({ expectedRaw: entry.raw }),
    });
    const off = toggled.userCrontab?.entries.find((e) => e.command.includes('sc-test'));
    check('cron toggle off', !!off && off.enabled === false, JSON.stringify(toggled.userCrontab));
    if (off) {
      try {
        await req(`/api/cron/entries/${off.index}?${P()}`, {
          method: 'DELETE',
          body: JSON.stringify({ expectedRaw: entry.raw }),
        });
        check('cron conflict on stale expectedRaw', false, 'ожидался 409');
      } catch (err) {
        check('cron conflict on stale expectedRaw', String(err).includes('409'), String(err));
      }
      const deleted = await req(`/api/cron/entries/${off.index}?${P()}`, {
        method: 'DELETE',
        body: JSON.stringify({ expectedRaw: off.raw }),
      });
      check(
        'cron delete',
        !deleted.userCrontab?.entries.some((e) => e.command.includes('sc-test')),
        JSON.stringify(deleted.userCrontab),
      );
    }
  }

  console.log('== services (systemd) ==');
  // Стенд (linuxserver/openssh-server) обычно без systemd — снимок адаптивный:
  // проверяем форму ответа; деталь/журнал/действия — только если systemd доступен.
  const services0 = await req(`/api/services?${P()}`);
  check(
    'services snapshot shape',
    typeof services0.available === 'boolean' &&
      Array.isArray(services0.units) &&
      typeof services0.timestamp === 'number',
    JSON.stringify(services0).slice(0, 200),
  );
  if (services0.available) {
    const unit = services0.units[0];
    check('services has units', !!unit?.name, JSON.stringify(services0.units).slice(0, 200));
    if (unit) {
      const detail = await req(`/api/services/${encodeURIComponent(unit.name)}?${P()}`);
      check(
        'services detail',
        detail.name === unit.name && typeof detail.status === 'string' && !!detail.show,
        JSON.stringify(detail).slice(0, 200),
      );
      const logRes = await fetch(
        `${BASE}/api/services/${encodeURIComponent(unit.name)}/logs?${P({ tail: '100' })}`,
        { headers: { cookie } },
      );
      const logText = await logRes.text();
      check('services journal (one-shot)', logRes.status === 200 && typeof logText === 'string', `${logRes.status}: ${logText.slice(0, 120)}`);

      // Действия — только на безопасном тестовом unit'е (sshd на стенде переживает restart).
      const sshd = services0.units.find((u) => u.name === 'sshd.service' || u.name === 'ssh.service');
      if (sshd) {
        const act = await req(`/api/services/${encodeURIComponent(sshd.name)}/action?${P()}`, {
          method: 'POST',
          body: JSON.stringify({ action: 'restart' }),
        });
        check('services restart sshd', act.ok === true, JSON.stringify(act));
      } else {
        console.log('  skip: на стенде нет sshd.service/ssh.service — действие не проверяется');
      }
    }
  } else {
    check('services unavailable reason', typeof services0.reason === 'string', JSON.stringify(services0));
  }

  // Отдельный polkit-кейс (Debian/Ubuntu-стенд с пользователем без прав):
  //   SERVICES_POLKIT=1 node test/integration.manual.mjs
  // Требует реального systemd и unit'а, который без root не перезапускается.
  if (process.env.SERVICES_POLKIT === '1' && services0.available) {
    const target = process.env.SERVICES_UNIT ?? 'nginx.service';
    try {
      await req(`/api/services/${encodeURIComponent(target)}/action?${P()}`, {
        method: 'POST',
        body: JSON.stringify({ action: 'restart' }),
      });
      check('polkit: без sudo-пароля → 400 «укажите sudo-пароль»', false, 'действие прошло без пароля');
    } catch (err) {
      check('polkit: без sudo-пароля → 400 «укажите sudo-пароль»', String(err).includes('400'), String(err));
    }
    if (process.env.SUDO_PASSWORD) {
      const ok = await req(`/api/services/${encodeURIComponent(target)}/action?${P()}`, {
        method: 'POST',
        body: JSON.stringify({ action: 'restart', sudoPassword: process.env.SUDO_PASSWORD }),
      });
      check('polkit: с sudo-паролем → успех', ok.ok === true, JSON.stringify(ok));
    } else {
      console.log('  skip: SUDO_PASSWORD не задан — кейс «с паролем» пропущен');
    }
    // Несуществующий/masked unit → 400 с текстом systemd (состояние сервиса, не транспорт).
    const maskedUnit = process.env.SERVICES_MASKED_UNIT ?? 'foo.service';
    try {
      await req(`/api/services/${encodeURIComponent(maskedUnit)}/action?${P()}`, {
        method: 'POST',
        body: JSON.stringify({ action: 'stop' }),
      });
      check('polkit: masked/not-found unit → 400', false, 'stop прошёл');
    } catch (err) {
      check('polkit: masked/not-found unit → 400', String(err).includes('400'), String(err));
    }
  } else if (process.env.SERVICES_POLKIT === '1') {
    console.log('  skip: SERVICES_POLKIT=1, но systemd на стенде недоступен');
  }

  console.log('== snippets (эпик 18) ==');
  // Чистим остатки прошлых прогонов и создаём сниппет.
  const snippetsBefore = await req('/api/snippets');
  for (const s of snippetsBefore.snippets.filter((x) => x.name.startsWith('sc-test-'))) {
    await req(`/api/snippets/${s.id}`, { method: 'DELETE' });
  }
  const snippet = await req('/api/snippets', {
    method: 'POST',
    body: JSON.stringify({
      name: 'sc-test-версия ОС',
      command: 'cat /etc/os-release | head -1',
      description: 'интеграционный сценарий',
      profileIds: null,
    }),
  });
  check('snippet created', !!snippet.id);

  const run = await req('/api/snippets/run', {
    method: 'POST',
    body: JSON.stringify({ snippetId: snippet.id, profileIds: [pid, pid] }),
  });
  check(
    'snippet run: дубликаты целей дедуплицированы, код 0',
    run.results.length === 1 && run.results[0].ok && run.results[0].code === 0,
    JSON.stringify(run),
  );
  check('snippet run: эхо команды', run.command === 'cat /etc/os-release | head -1');
  check('snippet run: вывод os-release', /PRETTY_NAME|ID=/.test(run.results[0].stdout), run.results[0].stdout);

  const badRun = await req('/api/snippets/run', {
    method: 'POST',
    body: JSON.stringify({ command: 'no-such-command-sc-test', profileIds: [pid] }),
  });
  check(
    'adhoc run: ненулевой код — ok:false, не ошибка запроса',
    badRun.results[0].ok === false && badRun.results[0].code === 127,
    JSON.stringify(badRun),
  );

  const bigRun = await req('/api/snippets/run', {
    method: 'POST',
    body: JSON.stringify({ command: 'yes | head -c 200000', profileIds: [pid] }),
  });
  check(
    'big output: обрезка до 100 000 символов с truncated',
    bigRun.results[0].truncated === true && bigRun.results[0].stdout.length === 100000,
    `truncated=${bigRun.results[0].truncated} len=${bigRun.results[0].stdout.length}`,
  );

  try {
    await req('/api/snippets/run', {
      method: 'POST',
      body: JSON.stringify({ snippetId: snippet.id, command: 'echo x', profileIds: [pid] }),
    });
    check('run XOR (оба поля) → 400', false, 'прошло');
  } catch (err) {
    check('run XOR (оба поля) → 400', String(err).includes('400'), String(err));
  }
  try {
    await req('/api/snippets/run', {
      method: 'POST',
      body: JSON.stringify({ command: 'true', profileIds: ['no-such-profile'] }),
    });
    check('run: несуществующий профиль → 400', false, 'прошло');
  } catch (err) {
    check('run: несуществующий профиль → 400', String(err).includes('Профили не найдены'), String(err));
  }

  const updated = await req(`/api/snippets/${snippet.id}`, {
    method: 'PUT',
    body: JSON.stringify({ name: 'sc-test-uptime', command: 'uptime', profileIds: [pid] }),
  });
  check('snippet update: полная замена полей', updated.name === 'sc-test-uptime' && updated.profileIds[0] === pid);
  await req(`/api/snippets/${snippet.id}`, { method: 'DELETE' });
  const snippetsAfter = await req('/api/snippets');
  check('snippet deleted', !snippetsAfter.snippets.some((x) => x.id === snippet.id));

  console.log('== cleanup ==');
  await req(`/api/profiles/${pid}`, { method: 'DELETE' });
  check('profile deleted', true);

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('INTEGRATION ERROR:', err);
  process.exit(1);
});
