// Manual integration test: requires a running ssh-commander (APP_PASSWORD=test123, port 8090)
// and a test SSH server (linuxserver/openssh-server on 127.0.0.1:2222, user test / pass test123).
// Run: node test/integration.manual.mjs
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
  exec) sleep 60 ;;
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

  console.log('== terminal tabs (epic 15) ==');
  // Simulating the UI behavior: every tab is its own WS with a stable tabId.
  // The manual UI items (F5 in the browser, localStorage clearing, closing the
  // window and the 60 s grace) are covered by the same server scenarios below.
  const openTerminalTab = (extra) => {
    const params = new URLSearchParams({ profileId: pid, cols: 80, rows: 24, ...extra });
    return wsConnect(`/ws/terminal?${params}`, { cookie }).then((ws) => {
      const state = { out: '', frames: [] };
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        state.frames.push(msg);
        if (msg.type === 'output' && msg.data) state.out += msg.data;
      });
      const waitFrame = (pred, timeout = 15000) =>
        new Promise((resolve, reject) => {
          const hit = state.frames.find(pred);
          if (hit) {
            resolve(hit);
            return;
          }
          const timer = setTimeout(
            () => reject(new Error(`timeout: ${state.out.slice(-300)}`)),
            timeout,
          );
          const on = (raw) => {
            const msg = JSON.parse(String(raw));
            if (pred(msg)) {
              clearTimeout(timer);
              ws.off('message', on);
              resolve(msg);
            }
          };
          ws.on('message', on);
        });
      const input = (data) => ws.send(JSON.stringify({ type: 'input', data }));
      const closeFrame = () => ws.send(JSON.stringify({ type: 'close' }));
      return { ws, state, waitFrame, input, closeFrame };
    });
  };
  const connected = (m) => m.type === 'connected';
  const sessionsNow = () => req(`/api/terminal/sessions?${P()}`);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Two tabs: independent input/output, the streams do not cross.
  const t1 = await openTerminalTab({ tabId: '10' });
  const t2 = await openTerminalTab({ tabId: '20' });
  await t1.waitFrame(connected);
  await t2.waitFrame(connected);
  t1.input('echo LEAK_7f3\n');
  t2.input('echo LEAK_9c1\n');
  await t1.waitFrame((m) => m.type === 'output' && t1.state.out.includes('LEAK_7f3'));
  await t2.waitFrame((m) => m.type === 'output' && t2.state.out.includes('LEAK_9c1'));
  check(
    'tabs: the tab outputs do not cross',
    !t1.state.out.includes('LEAK_9c1') && !t2.state.out.includes('LEAK_7f3'),
  );

  const sess1 = await sessionsNow();
  check(
    'tabs: /sessions lists the tabs with the limit',
    sess1.limit === 4 &&
      sess1.sessions
        .filter((s) => !s.container)
        .map((s) => s.tabId)
        .sort((a, b) => a - b)
        .join(',') === '10,20',
    JSON.stringify(sess1),
  );

  // Closing the middle one of three by a close frame (the ✕ button): the neighbors survive.
  const t3 = await openTerminalTab({ tabId: '30' });
  await t3.waitFrame(connected);
  t2.closeFrame();
  await sleep(500);
  const sess2 = await sessionsNow();
  check('tabs: a close frame removes the session', !sess2.sessions.some((s) => s.tabId === 20), JSON.stringify(sess2));
  t1.input('echo ALIVE_4b2\n');
  await t1.waitFrame((m) => m.type === 'output' && t1.state.out.includes('ALIVE_4b2'));
  check('tabs: the neighboring tabs survived the middle one closing', true);

  // "F5": a drop without a close frame and a re-connect of the same tab —
  // the session is reused (grace), no duplicates in /sessions.
  t1.ws.close();
  const t1b = await openTerminalTab({ tabId: '10' });
  await t1b.waitFrame(connected);
  const sess3 = await sessionsNow();
  check(
    'tabs: a re-connect reuses the session',
    sess3.sessions.filter((s) => s.tabId === 10).length === 1,
    JSON.stringify(sess3),
  );

  // A container tab (docker exec through the fake docker with sleep):
  // it coexists with the system shell and is visible in /sessions with the container name.
  const t4 = await openTerminalTab({ tabId: '40', container: 'abc123', containerName: 'web' });
  await t4.waitFrame(connected);
  const sess4 = await sessionsNow();
  const cs = sess4.sessions.find((s) => s.tabId === 40);
  check(
    'tabs: a container tab in the list with containerName',
    !!cs && cs.container === 'abc123' && cs.containerName === 'web',
    JSON.stringify(sess4),
  );
  check('tabs: the system shell lives next to the container', sess4.sessions.some((s) => s.tabId === 10 && !s.container));
  t4.closeFrame();
  await sleep(300);

  // The limit: 4 alive (10, 30, 50, 60) — the fifth gets an error frame + close 1013.
  const t5 = await openTerminalTab({ tabId: '50' });
  const t6 = await openTerminalTab({ tabId: '60' });
  await t5.waitFrame(connected);
  await t6.waitFrame(connected);
  const t7 = await openTerminalTab({ tabId: '70' });
  const errFrame = await t7.waitFrame((m) => m.type === 'error');
  const closedCode = new Promise((resolve) => t7.ws.once('close', (code) => resolve(code)));
  check('tabs: the limit — an error frame with the text', String(errFrame.data).includes('Слишком много терминалов'), JSON.stringify(errFrame));
  check('tabs: the limit — close 1013', (await closedCode) === 1013);
  t6.closeFrame();
  await sleep(300);
  const t7b = await openTerminalTab({ tabId: '70' });
  await t7b.waitFrame(connected);
  check('tabs: the slot is free — a new session passes', true);

  // exit inside the shell: "the session is finished", the record is removed,
  // re-connecting the same tab ("Refresh session") raises a fresh shell.
  t7b.input('exit\n');
  await t7b.waitFrame((m) => m.type === 'close');
  await sleep(300);
  const sess5 = await sessionsNow();
  check('tabs: exit removes the record from /sessions', !sess5.sessions.some((s) => s.tabId === 70), JSON.stringify(sess5));
  const t7c = await openTerminalTab({ tabId: '70' });
  await t7c.waitFrame(connected);
  t7c.input('echo REFRESH_2d9\n');
  await t7c.waitFrame((m) => m.type === 'output' && t7c.state.out.includes('REFRESH_2d9'));
  check('tabs: a re-connect after exit raises a fresh shell', true);

  for (const t of [t1b, t3, t5, t7c]) t.closeFrame();

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
        check('cron conflict on stale expectedRaw', false, 'a 409 was expected');
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
  // The stand (linuxserver/openssh-server) usually has no systemd — the snapshot
  // is adaptive: we check the response shape; detail/journal/actions — only if
  // systemd is available.
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

      // Actions — only on the safe test unit (sshd survives a restart on the stand).
      const sshd = services0.units.find((u) => u.name === 'sshd.service' || u.name === 'ssh.service');
      if (sshd) {
        const act = await req(`/api/services/${encodeURIComponent(sshd.name)}/action?${P()}`, {
          method: 'POST',
          body: JSON.stringify({ action: 'restart' }),
        });
        check('services restart sshd', act.ok === true, JSON.stringify(act));
      } else {
        console.log('  skip: the stand has no sshd.service/ssh.service — the action is not checked');
      }
    }
  } else {
    check('services unavailable reason', typeof services0.reason === 'string', JSON.stringify(services0));
  }

  // A separate polkit case (a Debian/Ubuntu stand with a user without rights):
  //   SERVICES_POLKIT=1 node test/integration.manual.mjs
  // Requires a real systemd and a unit that cannot be restarted without root.
  if (process.env.SERVICES_POLKIT === '1' && services0.available) {
    const target = process.env.SERVICES_UNIT ?? 'nginx.service';
    try {
      await req(`/api/services/${encodeURIComponent(target)}/action?${P()}`, {
        method: 'POST',
        body: JSON.stringify({ action: 'restart' }),
      });
      check('polkit: without a sudo password → 400 "specify the sudo password"', false, 'the action went through without a password');
    } catch (err) {
      check('polkit: without a sudo password → 400 "specify the sudo password"', String(err).includes('400'), String(err));
    }
    if (process.env.SUDO_PASSWORD) {
      const ok = await req(`/api/services/${encodeURIComponent(target)}/action?${P()}`, {
        method: 'POST',
        body: JSON.stringify({ action: 'restart', sudoPassword: process.env.SUDO_PASSWORD }),
      });
      check('polkit: with a sudo password → success', ok.ok === true, JSON.stringify(ok));
    } else {
      console.log('  skip: SUDO_PASSWORD is not set — the "with password" case is skipped');
    }
    // A nonexistent/masked unit → 400 with the systemd text (the service state, not transport).
    const maskedUnit = process.env.SERVICES_MASKED_UNIT ?? 'foo.service';
    try {
      await req(`/api/services/${encodeURIComponent(maskedUnit)}/action?${P()}`, {
        method: 'POST',
        body: JSON.stringify({ action: 'stop' }),
      });
      check('polkit: a masked/not-found unit → 400', false, 'stop went through');
    } catch (err) {
      check('polkit: a masked/not-found unit → 400', String(err).includes('400'), String(err));
    }
  } else if (process.env.SERVICES_POLKIT === '1') {
    console.log('  skip: SERVICES_POLKIT=1, but systemd is unavailable on the stand');
  }

  console.log('== disk usage (epic 16) ==');
  // A known tree: /tmp/sc-du/big.bin (1 MB) + /tmp/sc-du/sub/small.txt.
  await req('/api/files/mkdir', { method: 'POST', body: JSON.stringify({ profileId: pid, path: '/tmp/sc-du/sub' }) });
  await req('/api/files/write', {
    method: 'POST',
    body: JSON.stringify({ profileId: pid, path: '/tmp/sc-du/big.bin', content: 'x'.repeat(1024 * 1024) }),
  });
  await req('/api/files/write', {
    method: 'POST',
    body: JSON.stringify({ profileId: pid, path: '/tmp/sc-du/sub/small.txt', content: 'hello' }),
  });

  const du1 = await req(`/api/disk-usage?${P({ path: '/tmp/sc-du' })}`);
  check('du snapshot has total >= 1 MB', du1.totalBytes >= 1024 * 1024, JSON.stringify(du1).slice(0, 200));
  const subDir = du1.children.find((c) => c.name === 'sub');
  check('du lists subdir with pct', !!subDir && subDir.pctOfParent >= 0 && subDir.pctOfParent <= 100, JSON.stringify(du1.children));

  // Drill-down by click: the same request on a child directory. The tree is known —
  // /tmp/sc-du/sub holds only the small.txt file, no subdirectories.
  const du2 = await req(`/api/disk-usage?${P({ path: '/tmp/sc-du/sub' })}`);
  check('du descends into subdir', du2.totalBytes >= 5 && du2.children.length === 0, JSON.stringify(du2));

  // A repeated request for the same path — the 2 s cache: a consistent answer without a crash.
  const du1b = await req(`/api/disk-usage?${P({ path: '/tmp/sc-du' })}`);
  check('du cache hit consistent', du1b.totalBytes === du1.totalBytes && du1b.children.length === du1.children.length);

  // The "Files" mode: the top by size, the limit is respected, truncated is honest.
  const files1 = await req(`/api/disk-usage/files?${P({ path: '/tmp/sc-du', limit: 5 })}`);
  check(
    'top files lists big.bin first',
    files1.files[0]?.path === '/tmp/sc-du/big.bin' && files1.files[0]?.bytes >= 1024 * 1024,
    JSON.stringify(files1.files),
  );
  check('top files truncated=false', files1.truncated === false, `truncated=${files1.truncated}`);

  // A file instead of a directory → "Это не директория" (400).
  try {
    await req(`/api/disk-usage?${P({ path: '/tmp/sc-du/big.bin' })}`);
    check('du on file → 400', false);
  } catch (err) {
    check('du on file → 400', String(err).includes('400'), String(err));
  }

  // A nonexistent path → a clear error (400).
  try {
    await req(`/api/disk-usage?${P({ path: '/tmp/sc-du/nope' })}`);
    check('du on missing path → 400', false);
  } catch (err) {
    check('du on missing path → 400', String(err).includes('400'), String(err));
  }

  // Path validation: non-absolute and `..` → 400.
  try {
    await req(`/api/disk-usage?${P({ path: 'tmp' })}`);
    check('du rejects relative path', false);
  } catch (err) {
    check('du rejects relative path', String(err).includes('400'), String(err));
  }
  try {
    await req(`/api/disk-usage?${P({ path: '/tmp/../etc' })}`);
    check('du rejects ..', false);
  } catch (err) {
    check('du rejects ..', String(err).includes('400'), String(err));
  }

  // The mount point: du over /tmp does not crash and yields a meaningful total.
  const duTmp = await req(`/api/disk-usage?${P({ path: '/tmp' })}`);
  check('du on /tmp works', duTmp.totalBytes > 0 && Array.isArray(duTmp.children), JSON.stringify(duTmp).slice(0, 200));

  console.log('== processes (epic 17) ==');
  // A background process via the terminal; `setsid` detaches it from the session
  // and the controlling terminal, so the process survives the session close.
  // **A busy loop, not `sleep`**: metrics.processes is the CPU top-10
  // (`ps aux --sort=-%cpu | head -n 11`); a sleeping process with 0% CPU would
  // only hit the slice on an empty stand. The `# sc-burn` marker inside -c is
  // for finding the pid by the command line of the snapshot (not the terminal output).
  const pws = await wsConnect(`/ws/terminal?profileId=${pid}&cols=80&rows=24`, { cookie });
  let pwsReady = false;
  const spawnCmd = "setsid sh -c 'while :; do :; done # sc-burn' & exit\n";
  pws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.type === 'connected') {
      pwsReady = true;
      pws.send(JSON.stringify({ type: 'input', data: spawnCmd }));
    }
  });
  if (pwsReady) pws.send(JSON.stringify({ type: 'input', data: spawnCmd }));
  await new Promise((resolve) => setTimeout(() => { pws.close(); resolve(); }, 2000));

  let burnPid = null;
  for (let i = 0; i < 5 && !burnPid; i++) {
    const snap = await req(`/api/metrics?${P()}`);
    burnPid = snap.processes.find((pr) => pr.command.includes('sc-burn'))?.pid ?? null;
    if (!burnPid) await new Promise((r) => setTimeout(r, 1500));
  }
  check('process: the background process is running (the pid found in the snapshot)', !!burnPid, `pid=${burnPid}`);
  if (burnPid) {
    // renice +5 of an own process — without sudo; the renice output in the response.
    const rn = await req(`/api/processes/${burnPid}/renice?${P()}`, {
      method: 'POST',
      body: JSON.stringify({ nice: 5 }),
    });
    check(
      'process: renice +5 of an own process → ok with output',
      rn.ok === true && typeof rn.output === 'string' && rn.output.trim() !== '',
      JSON.stringify(rn),
    );
    const afterRenice = await req(`/api/metrics?${P()}`);
    check('process: the process is alive after renice', afterRenice.processes.some((pr) => pr.pid === burnPid));

    // A priority decrease (−5) of an own process — EPERM without root → 400.
    try {
      await req(`/api/processes/${burnPid}/renice?${P()}`, {
        method: 'POST',
        body: JSON.stringify({ nice: -5 }),
      });
      check('process: renice −5 without a password → 400 "specify the sudo password"', false, 'a 400 was expected');
    } catch (err) {
      check(
        'process: renice −5 without a password → 400 "specify the sudo password"',
        String(err).includes('400') && String(err).includes('укажите sudo-пароль'),
        String(err),
      );
    }

    // With a sudo password (a SUDO_ACCESS stand) the decrease goes through.
    if (process.env.SUDO_PASSWORD) {
      const rnSudo = await req(`/api/processes/${burnPid}/renice?${P()}`, {
        method: 'POST',
        body: JSON.stringify({ nice: -5, sudoPassword: process.env.SUDO_PASSWORD }),
      });
      check('process: renice −5 with sudo → ok', rnSudo.ok === true, JSON.stringify(rnSudo));
    } else {
      console.log('  skip: SUDO_PASSWORD is not set — the "with sudo" case is skipped');
    }

    // TERM of an own process — without sudo; after the mutation the metrics cache
    // is dropped, the process vanishes from the snapshot immediately (no 2 s cache wait).
    const sig = await req(`/api/processes/${burnPid}/signal?${P()}`, {
      method: 'POST',
      body: JSON.stringify({ signal: 'TERM' }),
    });
    check('process: TERM of an own process → ok', sig.ok === true, JSON.stringify(sig));
    let gone = false;
    for (let i = 0; i < 5 && !gone; i++) {
      const snap = await req(`/api/metrics?${P()}`);
      gone = !snap.processes.some((pr) => pr.pid === burnPid);
      if (!gone) await new Promise((r) => setTimeout(r, 1000));
    }
    check('process: the process vanished from the snapshot', gone);

    // A nonexistent pid → 400 "no longer exists" (the ESRCH category).
    try {
      await req('/api/processes/4194304/signal?' + P(), {
        method: 'POST',
        body: JSON.stringify({ signal: 'TERM' }),
      });
      check('process: a nonexistent pid → 400', false, 'a 400 was expected');
    } catch (err) {
      check(
        'process: a nonexistent pid → 400',
        String(err).includes('400') && String(err).includes('больше не существует'),
        String(err),
      );
    }

    // An invalid pid (1 — kill -1 hits process groups) → 400 even before the command.
    try {
      await req('/api/processes/1/signal?' + P(), {
        method: 'POST',
        body: JSON.stringify({ signal: 'KILL' }),
      });
      check('process: pid=1 → 400', false, 'a 400 was expected');
    } catch (err) {
      check('process: pid=1 → 400', String(err).includes('400'), String(err));
    }

    // A signal outside the whitelist → 400.
    try {
      await req(`/api/processes/${burnPid}/signal?${P()}`, {
        method: 'POST',
        body: JSON.stringify({ signal: 'SIGKILL' }),
      });
      check('process: a signal outside the whitelist → 400', false, 'a 400 was expected');
    } catch (err) {
      check('process: a signal outside the whitelist → 400', String(err).includes('400'), String(err));
    }
  }

  console.log('== snippets (epic 18) ==');
  // Clean the leftovers of previous runs and create a snippet.
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
    'snippet run: duplicate targets are deduplicated, code 0',
    run.results.length === 1 && run.results[0].ok && run.results[0].code === 0,
    JSON.stringify(run),
  );
  check('snippet run: the command echo', run.command === 'cat /etc/os-release | head -1');
  check('snippet run: the os-release output', /PRETTY_NAME|ID=/.test(run.results[0].stdout), run.results[0].stdout);

  const badRun = await req('/api/snippets/run', {
    method: 'POST',
    body: JSON.stringify({ command: 'no-such-command-sc-test', profileIds: [pid] }),
  });
  check(
    'adhoc run: a non-zero code — ok:false, not a request error',
    badRun.results[0].ok === false && badRun.results[0].code === 127,
    JSON.stringify(badRun),
  );

  const bigRun = await req('/api/snippets/run', {
    method: 'POST',
    body: JSON.stringify({ command: 'yes | head -c 200000', profileIds: [pid] }),
  });
  check(
    'big output: truncated to 100,000 characters with truncated',
    bigRun.results[0].truncated === true && bigRun.results[0].stdout.length === 100000,
    `truncated=${bigRun.results[0].truncated} len=${bigRun.results[0].stdout.length}`,
  );

  try {
    await req('/api/snippets/run', {
      method: 'POST',
      body: JSON.stringify({ snippetId: snippet.id, command: 'echo x', profileIds: [pid] }),
    });
    check('run XOR (both fields) → 400', false, 'went through');
  } catch (err) {
    check('run XOR (both fields) → 400', String(err).includes('400'), String(err));
  }
  try {
    await req('/api/snippets/run', {
      method: 'POST',
      body: JSON.stringify({ command: 'true', profileIds: ['no-such-profile'] }),
    });
    check('run: a nonexistent profile → 400', false, 'went through');
  } catch (err) {
    check('run: a nonexistent profile → 400', String(err).includes('Профили не найдены'), String(err));
  }

  const updated = await req(`/api/snippets/${snippet.id}`, {
    method: 'PUT',
    body: JSON.stringify({ name: 'sc-test-uptime', command: 'uptime', profileIds: [pid] }),
  });
  check('snippet update: a full field replacement', updated.name === 'sc-test-uptime' && updated.profileIds[0] === pid);
  await req(`/api/snippets/${snippet.id}`, { method: 'DELETE' });
  const snippetsAfter = await req('/api/snippets');
  check('snippet deleted', !snippetsAfter.snippets.some((x) => x.id === snippet.id));

  console.log('== packages (updates, epic 19) ==');
  const pkg0 = await req(`/api/packages/updates?${P()}`);
  check(
    'packages snapshot shape',
    typeof pkg0.timestamp === 'number' &&
      (pkg0.pm === null || ['apt', 'dnf', 'yum', 'apk'].includes(pkg0.pm)) &&
      Array.isArray(pkg0.updates) &&
      typeof pkg0.rebootRequired === 'boolean' &&
      Array.isArray(pkg0.rebootPackages) &&
      (typeof pkg0.indexAgeMs === 'number' || pkg0.indexAgeMs === null),
    JSON.stringify(pkg0).slice(0, 200),
  );
  if (pkg0.pm !== null) {
    // The 60 s cache: a repeated request shares the same promise (the timestamps match).
    const pkg1 = await req(`/api/packages/updates?${P()}`);
    check(
      'packages snapshot cached (60 s)',
      pkg1.pm === pkg0.pm && pkg1.timestamp === pkg0.timestamp,
      JSON.stringify(pkg1).slice(0, 200),
    );
    const entry = pkg0.updates[0];
    if (entry) {
      check(
        'packages update entry shape',
        typeof entry.name === 'string' && typeof entry.available === 'string' && 'current' in entry && 'source' in entry,
        JSON.stringify(entry),
      );
    } else {
      console.log('  skip: no updates on the stand — the entry shape is not checked');
    }
  } else {
    console.log(`  skip: no package manager on the stand (${pkg0.error ?? '?'}) — the list is not checked`);
  }

  // Applying — only by an explicit flag: a mutation that can really update the
  // packages on the stand. PACKAGES_APPLY=1 node test/integration.manual.mjs
  if (process.env.PACKAGES_APPLY === '1' && pkg0.pm !== null) {
    const applyRes = await fetch(`${BASE}/api/packages/apply?${P()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({}),
    });
    const applyText = await applyRes.text();
    check(
      'packages apply stream (no sudo)',
      applyRes.status === 200 && typeof applyText === 'string' && applyText.length > 0,
      `${applyRes.status}: ${applyText.slice(0, 200)}`,
    );
    const pkgAfter = await req(`/api/packages/updates?${P()}`);
    check('packages refetch after apply', pkgAfter.pm === pkg0.pm, JSON.stringify(pkgAfter).slice(0, 200));
    if (process.env.SUDO_PASSWORD) {
      const bad = await fetch(`${BASE}/api/packages/apply?${P()}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        body: JSON.stringify({ sudoPassword: 'definitely-wrong' }),
      });
      check('packages apply wrong sudo → 400 (the probe before the stream)', bad.status === 400, String(bad.status));
    } else {
      console.log('  skip: SUDO_PASSWORD is not set — the probe case (a wrong password) is skipped');
    }
  } else {
    console.log('  skip: PACKAGES_APPLY=1 is not set — applying is not checked');
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
