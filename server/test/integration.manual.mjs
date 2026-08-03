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
