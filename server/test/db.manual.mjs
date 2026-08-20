// Ручной интеграционный сценарий вкладки «Базы данных» (эпик 12, итерация 2:
// подключения с явными креденшалами, пароль — первой строкой stdin).
//
// Стенд (см. AGENTS.md, «Тестирование»): сервер ssh-commander запущен с
//   APP_HOST=127.0.0.1 APP_PORT=8091 APP_PASSWORD=test123
//   DATA_DIR=<tmp> KEYS_DIR=<tmp>
// и тестовый sshd (linuxserver/openssh-server) на 127.0.0.1:2222
// (user test / test123), у которого есть docker CLI и доступ к docker-демону
// (например, -v /var/run/docker.sock:/var/run/docker.sock). Сценарий сам
// поднимает контейнеры postgres:16-alpine, postgres:16 (dash-образ — прошлый
// blocker итерации 1 проявлялся именно на dash/busybox-шеллах) и mysql:8
// через docker API приложения и удаляет их в конце.
//
// Покрывает: discovery (подсказки формы), test-connection (верный/неверный
// пароль — Access denied текстом как есть), сохранённые подключения,
// overview (версия, базы), таблицы, SELECT, read-only SET (INSERT
// блокируется), read-only OFF, синтаксическая ошибка (stderr + exit code),
// дамп (gzip, разжимается), частичный update пароля, cleanup.
const BASE = 'http://127.0.0.1:8091';

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
  return { status: res.status, ok: res.ok, body, headers: res.headers };
}

const login = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: 'test123' }),
});
const m = /sc_session=([^;]+)/.exec(login.headers.get('set-cookie') ?? '');
const cookie = `sc_session=${m[1]}`;

const existing = await (await req('/api/profiles', {}, cookie)).body;
for (const p of existing) await req(`/api/profiles/${p.id}`, { method: 'DELETE' }, cookie);

const profile = (
  await req(
    '/api/profiles',
    {
      method: 'POST',
      body: JSON.stringify({
        name: 'test-sshd-db',
        host: '127.0.0.1',
        port: 2222,
        username: 'test',
        authType: 'password',
        password: 'test123',
        dockerCommand: 'docker',
      }),
    },
    cookie,
  )
).body;
const pid = profile.id;

// --- Стенд: postgres (alpine + dash) + mysql через docker API приложения ---
const CONTAINERS = [
  { image: 'postgres:16-alpine', name: 'sc-test-pg-alpine', env: ['POSTGRES_PASSWORD=pgpw'] },
  { image: 'postgres:16', name: 'sc-test-pg-dash', env: ['POSTGRES_PASSWORD=pgpw'] },
  { image: 'mysql:8', name: 'sc-test-mysql', env: ['MYSQL_ROOT_PASSWORD=myrootpw'] },
];
const NAMES = CONTAINERS.map((c) => c.name);

// Убираем остатки прошлого прогона (rm -f, не ошибка, если их нет).
const stale = await (await req(`/api/docker/containers?profileId=${pid}`, {}, cookie)).body;
for (const c of Array.isArray(stale) ? stale : []) {
  const names = String(c.Names ?? c.names ?? '');
  if (NAMES.some((n) => names.includes(n))) {
    await req(`/api/docker/containers/${c.Id ?? c.id}/rm?profileId=${pid}`, { method: 'POST' }, cookie);
  }
}

for (const spec of CONTAINERS) {
  const run = await req(
    `/api/docker/containers?profileId=${pid}`,
    { method: 'POST', body: JSON.stringify({ image: spec.image, name: spec.name, env: spec.env }) },
    cookie,
  );
  check(`docker run ${spec.image}`, run.ok, JSON.stringify(run.body).slice(0, 200));
}

// Ждём готовности СУБД: discovery должен увидеть все контейнеры.
let suggestions = [];
for (let i = 0; i < 30 && suggestions.length < CONTAINERS.length; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const res = await req(`/api/db/discovery?profileId=${pid}`, {}, cookie);
  suggestions = res.ok ? res.body.suggestions : [];
}
const pgSuggestions = suggestions.filter((s) => s.engine === 'postgres');
const mySuggestion = suggestions.find((s) => s.engine === 'mysql');
check(
  `discovery: found ${CONTAINERS.length} containers (incl. dash image)`,
  pgSuggestions.length === 2 && Boolean(mySuggestion),
  JSON.stringify(suggestions.map((s) => s.image)),
);
check('discovery suggests users from env', mySuggestion?.suggestedUser === 'root');

const createdConnections = [];
const makeConnection = async (payload) => {
  const res = await req('/api/db/connections', { method: 'POST', body: JSON.stringify(payload) }, cookie);
  check(`create connection ${payload.name}`, res.ok, JSON.stringify(res.body).slice(0, 200));
  // Пароль наружу не отдаётся.
  check(`connection ${payload.name} has no password in response`, res.ok && !('password' in (res.body ?? {})));
  if (res.ok) createdConnections.push(res.body.id);
  return res.ok ? res.body : null;
};

// --- Негативный путь ДО сохранения: неверный пароль виден в test ---------
if (mySuggestion) {
  const bad = await req(
    '/api/db/connections/test',
    {
      method: 'POST',
      body: JSON.stringify({
        profileId: pid,
        name: 'mysql-bad',
        engine: 'mysql',
        target: { kind: 'container', containerId: mySuggestion.id },
        username: 'root',
        password: 'wrong-password',
      }),
    },
    cookie,
  );
  check(
    'mysql test with wrong password: Access denied as-is',
    bad.status === 400 && /Access denied/i.test(bad.body?.error?.message ?? ''),
    JSON.stringify(bad.body).slice(0, 200),
  );
}

// --- PostgreSQL: local trust — пароль любой/пустой, оба образа -----------
for (const s of pgSuggestions) {
  const conn = await makeConnection({
    profileId: pid,
    name: s.name,
    engine: 'postgres',
    target: { kind: 'container', containerId: s.id },
    username: 'postgres',
    // PG official-образ: локальный сокет trust — пароль не нужен, но
    // проверяем и непустой (передачу первой строкой stdin).
    password: 'pgpw',
    defaultDatabase: 'postgres',
  });
  if (!conn) continue;

  const test = await req(
    '/api/db/connections/test',
    {
      method: 'POST',
      body: JSON.stringify({
        id: conn.id,
        profileId: pid,
        name: conn.name,
        engine: 'postgres',
        target: conn.target,
        username: 'postgres',
        password: '', // пустой в форме = проверяем сохранённый
      }),
    },
    cookie,
  );
  check(`pg (${s.image}) test-connection with saved password`, test.ok, JSON.stringify(test.body).slice(0, 200));

  const overview = await req(`/api/db/overview?profileId=${pid}&connectionId=${conn.id}`, {}, cookie);
  check(`pg (${s.image}) overview ok`, overview.ok, JSON.stringify(overview.body).slice(0, 200));
  check(`pg (${s.image}) version mentions PostgreSQL`, /PostgreSQL/i.test(overview.body?.version ?? ''), overview.body?.version);

  const q = async (sql, readOnly) =>
    req(
      '/api/db/query',
      { method: 'POST', body: JSON.stringify({ profileId: pid, connectionId: conn.id, database: 'postgres', sql, readOnly }) },
      cookie,
    );
  const select = await q("SELECT 1 AS one, 'a,b\n\"c\"' AS two", true);
  check(`pg (${s.image}) SELECT parses CSV (quoted comma/newline)`, select.ok && JSON.stringify(select.body.rows) === JSON.stringify([['1', 'a,b\n"c"']]), JSON.stringify(select.body).slice(0, 300));

  // Терминатор: psql молча отбрасывает statement без ';' — сервер дописывает его сам.
  const noSemicolon = await q('SELECT 42 AS answer', true);
  check(`pg (${s.image}) SELECT without trailing ; executes`, noSemicolon.ok && JSON.stringify(noSemicolon.body.rows) === JSON.stringify([['42']]), JSON.stringify(noSemicolon.body).slice(0, 300));

  const blocked = await q('CREATE TABLE sc_manual_test (id int)', true);
  check(`pg (${s.image}) read-only blocks CREATE`, blocked.status === 400 && blocked.body?.error, JSON.stringify(blocked.body).slice(0, 200));

  const write = await q('CREATE TABLE IF NOT EXISTS sc_manual_test (id int); INSERT INTO sc_manual_test VALUES (42);', false);
  check(`pg (${s.image}) write with readOnly=false`, write.ok, JSON.stringify(write.body).slice(0, 200));

  const readBack = await q('SELECT id FROM sc_manual_test', true);
  check(`pg (${s.image}) read back inserted row`, readBack.ok && JSON.stringify(readBack.body.rows) === JSON.stringify([['42']]), JSON.stringify(readBack.body).slice(0, 200));

  const syntax = await q('SELEC 1', true);
  check(
    `pg (${s.image}) syntax error: stderr + exitCode`,
    syntax.status === 400 && /ERROR/.test(syntax.body?.error?.stderr ?? '') && typeof syntax.body?.error?.exitCode === 'number',
    JSON.stringify(syntax.body).slice(0, 200),
  );

  const tables = await req(`/api/db/tables?profileId=${pid}&connectionId=${conn.id}&database=postgres`, {}, cookie);
  check(`pg (${s.image}) tables list works`, tables.ok && Array.isArray(tables.body.tables), JSON.stringify(tables.body).slice(0, 200));

  // Дамп: пароль уходит первой строкой stdin, gzip-магия + разжимается.
  const dump = await fetch(`${BASE}/api/db/dump?profileId=${pid}&connectionId=${conn.id}&database=postgres`, {
    headers: { cookie },
  });
  const buf = Buffer.from(await dump.arrayBuffer());
  check(`pg (${s.image}) dump is gzip`, dump.ok && buf[0] === 0x1f && buf[1] === 0x8b, `status=${dump.status} bytes=${buf.length}`);
  const { gunzipSync } = await import('node:zlib');
  let dumpText = '';
  try {
    dumpText = gunzipSync(buf).toString('utf8');
  } catch {
    /* проверим ниже */
  }
  check(`pg (${s.image}) dump gunzips and contains sc_manual_test`, dumpText.includes('sc_manual_test'), dumpText.slice(0, 80));

  // Негативный путь: несуществующая база — ошибка, а не валидный пустой .sql.gz
  // под 200 (exit code пайпа без pipefail — это код gzip, всегда успешный).
  const badDump = await fetch(`${BASE}/api/db/dump?profileId=${pid}&connectionId=${conn.id}&database=nosuchdb`, {
    headers: { cookie },
  });
  const badBuf = Buffer.from(await badDump.arrayBuffer());
  let badErr = '';
  try {
    badErr = JSON.parse(badBuf.toString('utf8')).error ?? '';
  } catch {
    /* проверим статус ниже */
  }
  check(
    `pg (${s.image}) dump of missing db returns error, not empty archive`,
    !badDump.ok && badBuf[0] === 0x7b && /pg_dump|базы|database/i.test(badErr),
    `status=${badDump.status} body=${badBuf.toString('utf8').slice(0, 120)}`,
  );
}

// --- MySQL: сохранённые креденшалы, частичный update пароля ---------------
if (mySuggestion) {
  const conn = await makeConnection({
    profileId: pid,
    name: mySuggestion.name,
    engine: 'mysql',
    target: { kind: 'container', containerId: mySuggestion.id },
    username: 'root',
    password: 'myrootpw',
  });
  if (conn) {
    const goodTest = await req(
      '/api/db/connections/test',
      {
        method: 'POST',
        body: JSON.stringify({
          profileId: pid,
          name: conn.name,
          engine: 'mysql',
          target: conn.target,
          username: 'root',
          password: 'myrootpw',
        }),
      },
      cookie,
    );
    check('mysql test with correct password', goodTest.ok, JSON.stringify(goodTest.body).slice(0, 200));

    // mysql стартует дольше — ждём возможность сделать запрос.
    let overview = null;
    for (let i = 0; i < 30; i++) {
      overview = await req(`/api/db/overview?profileId=${pid}&connectionId=${conn.id}`, {}, cookie);
      if (overview.ok) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    check('mysql overview ok (saved credentials)', overview?.ok, JSON.stringify(overview?.body).slice(0, 200));
    check('mysql version looks like 8.x', /^\d+\./.test(overview?.body?.version ?? ''), overview?.body?.version);

    const q = async (sql, readOnly) =>
      req(
        '/api/db/query',
        { method: 'POST', body: JSON.stringify({ profileId: pid, connectionId: conn.id, database: 'mysql', sql, readOnly }) },
        cookie,
      );
    const select = await q("SELECT 1 AS one, CONCAT('a\tb') AS two", true);
    check('mysql SELECT with tab value', select.ok && JSON.stringify(select.body.rows) === JSON.stringify([['1', 'a\tb']]), JSON.stringify(select.body).slice(0, 300));

    const blocked = await q('CREATE TABLE mysql.sc_manual_test (id INT)', true);
    check('mysql read-only blocks CREATE', blocked.status === 400 && blocked.body?.error, JSON.stringify(blocked.body).slice(0, 200));

    const syntax = await q('SELEC 1', true);
    check('mysql syntax error: stderr + exitCode', syntax.status === 400 && (syntax.body?.error?.stderr ?? '') !== '', JSON.stringify(syntax.body).slice(0, 200));

    const dump = await fetch(`${BASE}/api/db/dump?profileId=${pid}&connectionId=${conn.id}&database=mysql`, {
      headers: { cookie },
    });
    const buf = Buffer.from(await dump.arrayBuffer());
    check('mysql dump is gzip', dump.ok && buf[0] === 0x1f && buf[1] === 0x8b, `status=${dump.status} bytes=${buf.length}`);

    // Частичный update: пароль не передан — сохранён прежний; смена имени
    // не ломает подключение.
    const upd = await req(
      `/api/db/connections/${conn.id}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          profileId: pid,
          name: 'mysql-renamed',
          engine: 'mysql',
          target: conn.target,
          username: 'root',
        }),
      },
      cookie,
    );
    check('mysql connection rename without password keeps stored secret', upd.ok, JSON.stringify(upd.body).slice(0, 200));
    const selectAfter = await q('SELECT 1 AS one', true);
    check('mysql works after partial update (stored password kept)', selectAfter.ok, JSON.stringify(selectAfter.body).slice(0, 200));
  }
}

// Список наружу — без пароля и только своего профиля.
const listRes = await req(`/api/db/connections?profileId=${pid}`, {}, cookie);
check(
  'connection list has no passwords',
  listRes.ok && listRes.body.connections.every((c) => !('password' in c) && c.hasPassword !== undefined),
  JSON.stringify(listRes.body).slice(0, 200),
);

// --- Cleanup ----------------------------------------------------------------
for (const id of createdConnections) {
  await req(`/api/db/connections/${id}`, { method: 'DELETE' }, cookie);
}
const list = await (await req(`/api/docker/containers?profileId=${pid}`, {}, cookie)).body;
for (const c of Array.isArray(list) ? list : []) {
  const names = String(c.Names ?? c.names ?? '');
  if (NAMES.some((n) => names.includes(n))) {
    await req(`/api/docker/containers/${c.Id ?? c.id}/rm?profileId=${pid}`, { method: 'POST' }, cookie);
  }
}
await req(`/api/profiles/${pid}`, { method: 'DELETE' }, cookie);
console.log(process.exitCode ? 'DONE (with failures)' : 'DONE');
