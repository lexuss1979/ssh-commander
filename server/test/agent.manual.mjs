// Тест цикла AI-агента против мокового OpenAI-совместимого endpoint'а:
// 1) read-only инструмент выполняется автоматически,
// 2) мутирующий инструмент ждёт подтверждения и выполняется после approve,
// 3) агент завершает цикл,
// 4) usage каждого вызова пишется в журнал расходов (ai-usage.json), сессия
//    шлёт WS-событие usage, summaries диалогов обогащаются итогами.
//
// Запуск: mock-openai-manual.mjs (:8199) + sshd на 127.0.0.1:2222 (user test)
// и сервер: APP_PASSWORD=test123 AI_API_KEY=x AI_API_BASE=http://127.0.0.1:8199/v1
// node server/dist/index.js (DATA_DIR по умолчанию — data/ в cwd сервера).
import WebSocket from 'ws';
import fs from 'node:fs';

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

const profile = await req(
  '/api/profiles',
  {
    method: 'POST',
    body: JSON.stringify({
      name: 'test-sshd',
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
const pid = profile.id;

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

const readOnlyResult = await waitFor((m) => m.type === 'tool_result' && m.name === 'exec_readonly');
check('read-only tool ran automatically', readOnlyResult.status === 'ok', JSON.stringify(readOnlyResult));
check('read-only output correct', String(readOnlyResult.output ?? '').trim() === 'test', readOnlyResult.output);

const pending = await waitFor((m) => m.type === 'tool_pending' && m.name === 'exec');
check('mutating tool waits for approval', true);

ws.send(JSON.stringify({ type: 'approve', callId: pending.callId }));
const writeResult = await waitFor((m) => m.type === 'tool_result' && m.callId === pending.callId);
check('approved tool executed', writeResult.status === 'ok', JSON.stringify(writeResult));

const done = await waitFor((m) => m.type === 'done');
check('agent loop finished', done.note === undefined || done.note !== 'Достигнут лимит шагов', JSON.stringify(done));

// Расходы: WS-событие usage с кумулятивными итогами диалога после записи.
const usageEvent = await waitFor((m) => m.type === 'usage');
check(
  'WS usage event carries dialogue totals',
  usageEvent.totals && usageEvent.totals.calls >= 1 && typeof usageEvent.totals.costUsd === 'number',
  JSON.stringify(usageEvent.totals),
);

// Проверяем, что мутирующая команда реально выполнилась на сервере
const files = await req(`/api/files/list?profileId=${pid}&path=/tmp`, {}, cookie);
check('approved command had effect', files.entries.some((e) => e.name === 'agent-approved'));

ws.close();

// Проверяем, что диалог сохранился и в нём есть сообщения
const dialogues = await req(`/api/ai/dialogues?profileId=${pid}`, {}, cookie);
check('dialogue persisted', dialogues.dialogues.length > 0, JSON.stringify(dialogues.dialogues.map((d) => d.messageCount)));
const saved = dialogues.dialogues[0];
const full = await req(`/api/ai/dialogues/${saved.id}`, {}, cookie);
check(
  'dialogue contains user and assistant messages',
  full.dialogue.messages.some((m) => m.role === 'user') && full.dialogue.messages.some((m) => m.role === 'assistant'),
  JSON.stringify(full.dialogue.messages.map((m) => m.role)),
);

// Расходы: summaries обогащены итогами (usage), итоги диалога и отчёт сходятся.
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

// Журнал расходов на диске: записи по профилю (DATA_DIR по умолчанию — data/).
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
  check(`ai-usage.json exists at ${usagePath}`, false, 'server DATA_DIR не по умолчанию?');
}

// Отчёт API: профиль и итоги за весь период.
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

console.log(process.exitCode ? 'AGENT TEST: FAILED' : 'AGENT TEST: PASSED');
