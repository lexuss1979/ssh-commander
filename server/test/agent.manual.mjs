// The AI agent loop test against a mock OpenAI-compatible endpoint
// (mock-openai-manual.mjs): the mock scenario — list_servers (read-only,
// automatic) → connect_server (mutating, waits for approve) →
// exec_readonly on the attached server → the final response with the
// [[SUGGEST]] suggestion marker. Checked:
// 1) read-only tools run automatically,
// 2) a mutating tool waits for approval and runs after approve,
// 3) the agent finishes the loop,
// 4) the usage of every call is recorded into the cost journal
//    (ai-usage.json), the session sends the WS usage event, the dialogue
//    summaries are enriched with the totals,
// 5) the [[SUGGEST]] marker is cut out of the response: the WS sequence is
//    message (without the marker) → suggestion → done, and data/ai-dialogues.json
//    has no marker.
//
// Run: mock-openai-manual.mjs (:8199) + an sshd on 127.0.0.1:2222 (user test)
// and the server: APP_PASSWORD=test123 AI_API_KEY=x AI_API_BASE=http://127.0.0.1:8199/v1
// node server/dist/index.js (DATA_DIR defaults to data/ in the server cwd).
import WebSocket from 'ws';
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:8091';
const PASSWORD = 'test123';
const MARKER = '[[SUGGEST]]';

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

// Both profiles point at the same sshd: the mock attaches the "second server"
// by the name test-sshd-b and runs exec_readonly with server="test-sshd-b".
const makeProfile = (name) =>
  req(
    '/api/profiles',
    {
      method: 'POST',
      body: JSON.stringify({
        name,
        host: '127.0.0.1',
        port: 2222,
        username: 'test',
        authType: 'password',
        password: 'test123',
        dockerCommand: 'docker',
      }),
    },
    cookie,
  );

const profileA = await makeProfile('test-sshd');
const profileB = await makeProfile('test-sshd-b');
const pid = profileA.id;
const pidB = profileB.id;

const ws = new WebSocket(`ws://127.0.0.1:8091/ws/agent?profileId=${pid}`, { headers: { cookie } });

const events = [];
const waiters = [];

function waitFor(predicate, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const found = events.find(predicate);
    if (found) {
      resolve(found);
      return;
    }
    const timer = setTimeout(() => reject(new Error('agent test timeout')), timeoutMs);
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

ws.send(JSON.stringify({ type: 'message', content: 'выполни проверку' }));

// 1) list_servers — read-only, runs automatically without approval
const listResult = await waitFor((m) => m.type === 'tool_result' && m.name === 'list_servers');
check('read-only tool ran automatically', listResult.status === 'ok', JSON.stringify(listResult).slice(0, 200));

// 2) connect_server — mutating, waits for approve
const pending = await waitFor((m) => m.type === 'tool_pending' && m.name === 'connect_server');
check('mutating tool waits for approval', pending.server === 'test-sshd-b', `server=${pending.server}`);

ws.send(JSON.stringify({ type: 'approve', callId: pending.callId }));
const connectResult = await waitFor((m) => m.type === 'tool_result' && m.callId === pending.callId);
check('approved tool executed', connectResult.status === 'ok', JSON.stringify(connectResult).slice(0, 200));

// The connect had an effect: a servers event with two attached servers
const serversTwo = await waitFor((m) => m.type === 'servers' && m.attached?.length === 2);
check(
  'connect had effect (servers event with 2 attached)',
  serversTwo.attached.some((s) => s.id === pid) && serversTwo.attached.some((s) => s.id === pidB),
  JSON.stringify(serversTwo.attached.map((s) => s.name)),
);

// 3) exec_readonly on the attached server — also automatic
const execResult = await waitFor((m) => m.type === 'tool_result' && m.name === 'exec_readonly');
check(
  'exec_readonly ran automatically on attached server',
  execResult.status === 'ok' && String(execResult.output ?? '').includes('(exit code: 0)'),
  String(execResult.output ?? '').slice(0, 120),
);

// 4) the final response: the marker is cut out of message, the suggestion is a separate event
const finalMessage = await waitFor(
  (m) => m.type === 'message' && typeof m.content === 'string' && m.content.includes('Готово'),
);
check('final message has no suggest marker', !finalMessage.content.includes(MARKER), finalMessage.content);

const suggestion = await waitFor((m) => m.type === 'suggestion');
check('suggestion event carries marker text', suggestion.text === 'Да, перезапусти nginx', JSON.stringify(suggestion));

const done = await waitFor((m) => m.type === 'done');
check('agent loop finished', done.note === undefined || done.note !== 'Достигнут лимит шагов', JSON.stringify(done));

// The event order: message (clean content) → suggestion → done
const idxMessage = events.indexOf(finalMessage);
const idxSuggestion = events.indexOf(suggestion);
const idxDone = events.indexOf(done);
check(
  'event order is message → suggestion → done',
  idxMessage >= 0 && idxMessage < idxSuggestion && idxSuggestion < idxDone,
  `${idxMessage}, ${idxSuggestion}, ${idxDone}`,
);

// Costs: the WS usage event with the cumulative dialogue totals after the record.
const usageEvent = await waitFor((m) => m.type === 'usage');
check(
  'WS usage event carries dialogue totals',
  usageEvent.totals && usageEvent.totals.calls >= 1 && typeof usageEvent.totals.costUsd === 'number',
  JSON.stringify(usageEvent.totals),
);

ws.close();

// Check that the dialogue persisted and holds messages
const dialogues = await req(`/api/ai/dialogues?profileId=${pid}`, {}, cookie);
check('dialogue persisted', dialogues.dialogues.length > 0, JSON.stringify(dialogues.dialogues.map((d) => d.messageCount)));
const saved = dialogues.dialogues[0];
const full = await req(`/api/ai/dialogues/${saved.id}`, {}, cookie);
check(
  'dialogue contains user and assistant messages',
  full.dialogue.messages.some((m) => m.role === 'user') && full.dialogue.messages.some((m) => m.role === 'assistant'),
  JSON.stringify(full.dialogue.messages.map((m) => m.role)),
);
check(
  'dialogue messages contain no suggest marker',
  !JSON.stringify(full.dialogue.messages).includes(MARKER),
);
check(
  'dialogue extraProfileIds contains B (connect persisted)',
  Array.isArray(full.dialogue.extraProfileIds) && full.dialogue.extraProfileIds.includes(pidB),
  JSON.stringify(full.dialogue.extraProfileIds),
);

// On-disk persist: data/ai-dialogues.json has no marker.
const dialoguesPath = 'data/ai-dialogues.json';
if (fs.existsSync(dialoguesPath)) {
  const store = JSON.parse(fs.readFileSync(dialoguesPath, 'utf8'));
  const stored = (store.dialogues ?? []).find((d) => d.id === saved.id);
  check(
    'ai-dialogues.json stored dialogue has no marker',
    Boolean(stored) && !JSON.stringify(stored.messages ?? []).includes(MARKER),
  );
} else {
  check(`ai-dialogues.json exists at ${dialoguesPath}`, false, 'is the server DATA_DIR non-default?');
}

// Costs: the summaries are enriched with the usage totals, the dialogue totals and the report agree.
check(
  'dialogue summary enriched with usage',
  saved.usage && saved.usage.calls >= 1 && typeof saved.usage.costUsd === 'number',
  JSON.stringify(saved.usage),
);
check(
  'dialogue detail enriched with usage',
  full.dialogue.usage && full.dialogue.usage.calls >= 1,
  JSON.stringify(full.dialogue.usage),
);

// The cost journal on disk: records per profile (DATA_DIR defaults to data/).
const usagePath = 'data/ai-usage.json';
if (fs.existsSync(usagePath)) {
  const store = JSON.parse(fs.readFileSync(usagePath, 'utf8'));
  const recs = (store.usage ?? []).filter((r) => r.profileId === pid);
  check(
    'ai-usage.json contains records for the profile (kind=chat, costUsd computed)',
    recs.length >= 1 && recs.every((r) => r.kind === 'chat' && typeof r.costUsd === 'number'),
    JSON.stringify(recs.map((r) => ({ kind: r.kind, tokens: r.promptTokens, costUsd: r.costUsd }))),
  );
} else {
  check(`ai-usage.json exists at ${usagePath}`, false, 'is the server DATA_DIR non-default?');
}

// The API report: the profile and the totals for the whole period.
const report = await req('/api/ai/usage?days=all', {}, cookie);
check(
  'usage report API lists the profile and totals',
  report.profiles.some((p) => p.id === pid) && report.totals.calls >= 1 && typeof report.totals.costUsd === 'number',
  JSON.stringify(report.totals),
);

for (const d of dialogues.dialogues) {
  await req(`/api/ai/dialogues/${d.id}`, { method: 'DELETE' }, cookie);
}

await req(`/api/profiles/${pid}`, { method: 'DELETE' }, cookie);
await req(`/api/profiles/${pidB}`, { method: 'DELETE' }, cookie);

console.log(process.exitCode ? 'AGENT TEST: FAILED' : 'AGENT TEST: PASSED');
