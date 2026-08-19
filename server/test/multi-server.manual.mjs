// Тест мульти-серверного режима AI-агента против мокового OpenAI-совместимого
// endpoint'а (mock-openai-manual.mjs, порт 8199) и двух тестовых sshd
// (sc-test-sshd-a на 2222, sc-test-sshd-b на 2223, hostname srv-a/srv-b):
// 1) при подключении WS приходит событие servers (home=A, attached=[A]);
// 2) list_servers (read-only) выполняется автоматически, в выводе оба профиля,
//    у b connected=false;
// 3) connect_server ждёт approve, в событии есть server='test-sshd-b';
// 4) после approve приходит servers с двумя attached и tool_result ok;
// 5) exec_readonly выполняется на b (server='test-sshd-b', вывод содержит srv-b);
// 6) цикл завершается done без лимита шагов;
// 7) диалог профиля A сохранён с extraProfileIds, включающим id профиля B.
import WebSocket from 'ws';

const BASE = 'http://127.0.0.1:8091';
const PASSWORD = 'test123';

function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok' : '  FAIL'}: ${name} ${detail}`);
  if (!ok) process.exitCode = 1;
}

async function req(path, opts = {}, cookie = '') {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}), ...(cookie ? { cookie } : {}) },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

const login = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: PASSWORD }),
});
const m = /sc_session=([^;]+)/.exec(login.headers.get('set-cookie') ?? '');
const cookie = `sc_session=${m[1]}`;

const existing = await req('/api/profiles', {}, cookie);
for (const p of existing) await req(`/api/profiles/${p.id}`, { method: 'DELETE' }, cookie);

const makeProfile = (name, port) =>
  req(
    '/api/profiles',
    {
      method: 'POST',
      body: JSON.stringify({
        name,
        host: '127.0.0.1',
        port,
        username: 'test',
        authType: 'password',
        password: 'test123',
        dockerCommand: 'docker',
      }),
    },
    cookie,
  );

const profileA = await makeProfile('test-sshd-a', 2222);
const profileB = await makeProfile('test-sshd-b', 2223);
const pidA = profileA.id;
const pidB = profileB.id;

const ws = new WebSocket(`ws://127.0.0.1:8091/ws/agent?profileId=${pidA}`, { headers: { cookie } });

const events = [];
const waiters = [];

function waitFor(predicate, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const found = events.find(predicate);
    if (found) {
      resolve(found);
      return;
    }
    const timer = setTimeout(() => reject(new Error('multi-server test timeout')), timeoutMs);
    waiters.push({ predicate, resolve: (e) => { clearTimeout(timer); resolve(e); } });
  });
}

ws.on('message', (raw) => {
  const msg = JSON.parse(String(raw));
  events.push(msg);
  const idx = waiters.findIndex((w) => w.predicate(msg));
  if (idx >= 0) {
    const [w] = waiters.splice(idx, 1);
    w.resolve(msg);
  }
});

await new Promise((resolve, reject) => {
  ws.once('open', resolve);
  ws.once('error', reject);
});

// Начальное событие servers: домашний сервер A, подключён только он
const serversInitial = await waitFor((msg) => msg.type === 'servers');
check('initial servers event: home = A', serversInitial.home === pidA, `home=${serversInitial.home}`);
check(
  'initial servers event: attached = [A]',
  serversInitial.attached?.length === 1 && serversInitial.attached[0].id === pidA,
  JSON.stringify(serversInitial.attached),
);

ws.send(JSON.stringify({ type: 'message', content: 'подключи второй сервер и проверь его hostname' }));

// 1) list_servers — read-only, автоматически; в выводе оба профиля, b не подключён
const listResult = await waitFor((msg) => msg.type === 'tool_result' && msg.name === 'list_servers');
check('list_servers ran automatically', listResult.status === 'ok', JSON.stringify(listResult).slice(0, 300));
let listRows = [];
try {
  listRows = JSON.parse(listResult.output ?? '[]');
} catch {
  /* вывод не JSON — зафейлится проверкой ниже */
}
const rowA = listRows.find((r) => r.name === 'test-sshd-a');
const rowB = listRows.find((r) => r.name === 'test-sshd-b');
check('list_servers output contains both profiles', Boolean(rowA) && Boolean(rowB), JSON.stringify(listRows.map((r) => r.name)));
check('list_servers: A connected=true, B connected=false', rowA?.connected === true && rowB?.connected === false, JSON.stringify(listRows));

// 2) connect_server — мутирующий, ждёт approve; поле server — имя целевого профиля
const pending = await waitFor((msg) => msg.type === 'tool_pending' && msg.name === 'connect_server');
check('connect_server waits for approval', pending.server === 'test-sshd-b', `server=${pending.server}`);

ws.send(JSON.stringify({ type: 'approve', callId: pending.callId }));

// 3) после подключения — событие servers с двумя attached и tool_result ok
const serversTwo = await waitFor((msg) => msg.type === 'servers' && msg.attached?.length === 2);
check(
  'servers event after connect: attached = [A, B]',
  serversTwo.attached.some((s) => s.id === pidA) && serversTwo.attached.some((s) => s.id === pidB),
  JSON.stringify(serversTwo.attached.map((s) => s.name)),
);

const connectResult = await waitFor((msg) => msg.type === 'tool_result' && msg.callId === pending.callId);
check('connect_server result ok', connectResult.status === 'ok', String(connectResult.output ?? '').slice(0, 120));

// 4) exec_readonly выполняется на сервере B
const execResult = await waitFor((msg) => msg.type === 'tool_result' && msg.name === 'exec_readonly');
check('exec_readonly addressed to B', execResult.server === 'test-sshd-b', `server=${execResult.server}`);
check(
  'exec_readonly output from B (hostname srv-b)',
  execResult.status === 'ok' && String(execResult.output ?? '').includes('srv-b'),
  String(execResult.output ?? '').slice(0, 120),
);

// 5) цикл завершился финальным ответом, не лимитом шагов
const done = await waitFor((msg) => msg.type === 'done');
check('agent loop finished', done.note === undefined || done.note !== 'Достигнут лимит шагов', JSON.stringify(done));

ws.close();

// 6) диалог профиля A сохранён с extraProfileIds, включающим B
const dialogues = await req(`/api/ai/dialogues?profileId=${pidA}`, {}, cookie);
check('dialogue persisted', dialogues.dialogues.length > 0, JSON.stringify(dialogues.dialogues.map((d) => d.messageCount)));
const saved = dialogues.dialogues[0];
const full = await req(`/api/ai/dialogues/${saved.id}`, {}, cookie);
check(
  'dialogue extraProfileIds contains B',
  Array.isArray(full.dialogue.extraProfileIds) && full.dialogue.extraProfileIds.includes(pidB),
  JSON.stringify(full.dialogue.extraProfileIds),
);

// cleanup: диалоги и оба профиля
for (const d of dialogues.dialogues) {
  await req(`/api/ai/dialogues/${d.id}`, { method: 'DELETE' }, cookie);
}
await req(`/api/profiles/${pidA}`, { method: 'DELETE' }, cookie);
await req(`/api/profiles/${pidB}`, { method: 'DELETE' }, cookie);

console.log(process.exitCode ? 'MULTI-SERVER TEST: FAILED' : 'MULTI-SERVER TEST: PASSED');
