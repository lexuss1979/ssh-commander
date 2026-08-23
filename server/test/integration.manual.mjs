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

  console.log('== processes (эпик 17) ==');
  // Фоновый `sleep 600` через терминал; `setsid` отвязывает от сессии и
  // управляющего терминала, поэтому процесс переживает закрытие сессии.
  // pid берём из снимка метрик (поиск по командной строке), а не из вывода
  // терминала — надёжнее.
  const pws = await wsConnect(`/ws/terminal?profileId=${pid}&cols=80&rows=24`, { cookie });
  let pwsReady = false;
  const spawnCmd = 'setsid sleep 600 >/dev/null 2>&1 </dev/null & exit\n';
  pws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.type === 'connected') {
      pwsReady = true;
      pws.send(JSON.stringify({ type: 'input', data: spawnCmd }));
    }
  });
  if (pwsReady) pws.send(JSON.stringify({ type: 'input', data: spawnCmd }));
  await new Promise((resolve) => setTimeout(() => { pws.close(); resolve(); }, 2000));

  let sleepPid = null;
  for (let i = 0; i < 5 && !sleepPid; i++) {
    const snap = await req(`/api/metrics?${P()}`);
    sleepPid = snap.processes.find((pr) => pr.command.includes('sleep 600'))?.pid ?? null;
    if (!sleepPid) await new Promise((r) => setTimeout(r, 1500));
  }
  check('process: sleep 600 запущен (pid найден в снимке)', !!sleepPid, `pid=${sleepPid}`);
  if (sleepPid) {
    // renice +5 своего процесса — без sudo; вывод renice в ответе.
    const rn = await req(`/api/processes/${sleepPid}/renice?${P()}`, {
      method: 'POST',
      body: JSON.stringify({ nice: 5 }),
    });
    check(
      'process: renice +5 своего процесса → ok с выводом',
      rn.ok === true && typeof rn.output === 'string' && rn.output.trim() !== '',
      JSON.stringify(rn),
    );
    const afterRenice = await req(`/api/metrics?${P()}`);
    check('process: процесс жив после renice', afterRenice.processes.some((pr) => pr.pid === sleepPid));

    // Понижение приоритета (−5) своему процессу — EPERM без root → 400.
    try {
      await req(`/api/processes/${sleepPid}/renice?${P()}`, {
        method: 'POST',
        body: JSON.stringify({ nice: -5 }),
      });
      check('process: renice −5 без пароля → 400 «укажите sudo-пароль»', false, 'ожидался 400');
    } catch (err) {
      check(
        'process: renice −5 без пароля → 400 «укажите sudo-пароль»',
        String(err).includes('400') && String(err).includes('укажите sudo-пароль'),
        String(err),
      );
    }

    // С sudo-паролем (SUDO_ACCESS-стенд) понижение проходит.
    if (process.env.SUDO_PASSWORD) {
      const rnSudo = await req(`/api/processes/${sleepPid}/renice?${P()}`, {
        method: 'POST',
        body: JSON.stringify({ nice: -5, sudoPassword: process.env.SUDO_PASSWORD }),
      });
      check('process: renice −5 с sudo → ok', rnSudo.ok === true, JSON.stringify(rnSudo));
    } else {
      console.log('  skip: SUDO_PASSWORD не задан — кейс «с sudo» пропущен');
    }

    // TERM своего процесса — без sudo; после мутации кэш метрик сброшен,
    // процесс исчезает из снимка сразу (без ожидания кэша 2 с).
    const sig = await req(`/api/processes/${sleepPid}/signal?${P()}`, {
      method: 'POST',
      body: JSON.stringify({ signal: 'TERM' }),
    });
    check('process: TERM своего процесса → ok', sig.ok === true, JSON.stringify(sig));
    let gone = false;
    for (let i = 0; i < 5 && !gone; i++) {
      const snap = await req(`/api/metrics?${P()}`);
      gone = !snap.processes.some((pr) => pr.pid === sleepPid);
      if (!gone) await new Promise((r) => setTimeout(r, 1000));
    }
    check('process: процесс исчез из снимка', gone);

    // Несуществующий pid → 400 «больше не существует» (ESRCH-категория).
    try {
      await req('/api/processes/4194304/signal?' + P(), {
        method: 'POST',
        body: JSON.stringify({ signal: 'TERM' }),
      });
      check('process: несуществующий pid → 400', false, 'ожидался 400');
    } catch (err) {
      check(
        'process: несуществующий pid → 400',
        String(err).includes('400') && String(err).includes('больше не существует'),
        String(err),
      );
    }

    // Недопустимый pid (1 — kill -1 бьёт по группам) → 400 ещё до команды.
    try {
      await req('/api/processes/1/signal?' + P(), {
        method: 'POST',
        body: JSON.stringify({ signal: 'KILL' }),
      });
      check('process: pid=1 → 400', false, 'ожидался 400');
    } catch (err) {
      check('process: pid=1 → 400', String(err).includes('400'), String(err));
    }

    // Сигнал вне whitelist → 400.
    try {
      await req(`/api/processes/${sleepPid}/signal?${P()}`, {
        method: 'POST',
        body: JSON.stringify({ signal: 'SIGKILL' }),
      });
      check('process: сигнал вне whitelist → 400', false, 'ожидался 400');
    } catch (err) {
      check('process: сигнал вне whitelist → 400', String(err).includes('400'), String(err));
    }
  }

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
