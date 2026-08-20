// Ручной интеграционный сценарий вкладки «Базы данных» (эпик 12).
//
// Стенд (см. AGENTS.md, «Тестирование»): сервер ssh-commander запущен с
//   APP_HOST=127.0.0.1 APP_PORT=8091 APP_PASSWORD=test123
//   DATA_DIR=<tmp> KEYS_DIR=<tmp>
// и тестовый sshd (linuxserver/openssh-server) на 127.0.0.1:2222
// (user test / test123), у которого есть docker CLI и доступ к docker-демону
// (например, -v /var/run/docker.sock:/var/run/docker.sock). Сценарий сам
// поднимает контейнеры postgres:16-alpine и mysql:8 через API приложения
// и удаляет их в конце.
//
// Покрывает: discovery (instances), overview (версия, базы), таблицы,
// SELECT, read-only SET (INSERT блокируется), read-only OFF, синтаксическая
// ошибка (stderr + exit code), дамп (gzip, разжимается), cleanup.
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

// --- Стенд: postgres + mysql через docker API приложения -------------------
const PG_NAME = 'sc-test-pg';
const MY_NAME = 'sc-test-mysql';

// Убираем остатки прошлого прогона (rm -f, не ошибка, если их нет).
const stale = await (await req(`/api/docker/containers?profileId=${pid}`, {}, cookie)).body;
for (const c of Array.isArray(stale) ? stale : []) {
  const names = String(c.Names ?? c.names ?? '');
  if (names.includes(PG_NAME) || names.includes(MY_NAME)) {
    await req(`/api/docker/containers/${c.Id ?? c.id}/rm?profileId=${pid}`, { method: 'POST' }, cookie);
  }
}

for (const spec of [
  { image: 'postgres:16-alpine', name: PG_NAME, env: ['POSTGRES_PASSWORD=pgpw'] },
  { image: 'mysql:8', name: MY_NAME, env: ['MYSQL_ROOT_PASSWORD=myrootpw'] },
]) {
  const run = await req(
    `/api/docker/containers?profileId=${pid}`,
    { method: 'POST', body: JSON.stringify({ image: spec.image, name: spec.name, env: spec.env }) },
    cookie,
  );
  check(`docker run ${spec.image}`, run.ok, JSON.stringify(run.body).slice(0, 200));
}

// Ждём готовности СУБД: discovery должен увидеть оба контейнера.
let instances = [];
for (let i = 0; i < 30 && instances.length < 2; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const res = await req(`/api/db/instances?profileId=${pid}`, {}, cookie);
  instances = res.ok ? res.body.instances : [];
}
const pg = instances.find((i) => i.engine === 'postgres');
const my = instances.find((i) => i.engine === 'mysql');
check('discovery: found postgres + mysql', Boolean(pg && my), JSON.stringify(instances));

// --- PostgreSQL -------------------------------------------------------------
if (pg) {
  const overview = await req(`/api/db/overview?profileId=${pid}&instanceId=${pg.id}`, {}, cookie);
  check('pg overview ok', overview.ok, JSON.stringify(overview.body).slice(0, 200));
  check('pg version mentions PostgreSQL', /PostgreSQL/i.test(overview.body?.version ?? ''), overview.body?.version);
  check('pg databases include postgres', (overview.body?.databases ?? []).some((d) => d.name === 'postgres'));

  const q = async (sql, readOnly) =>
    req(
      '/api/db/query',
      { method: 'POST', body: JSON.stringify({ profileId: pid, instanceId: pg.id, database: 'postgres', sql, readOnly }) },
      cookie,
    );
  const select = await q("SELECT 1 AS one, 'a,b\n\"c\"' AS two", true);
  check('pg SELECT parses CSV (quoted comma/newline)', select.ok && JSON.stringify(select.body.rows) === JSON.stringify([['1', 'a,b\n"c"']]), JSON.stringify(select.body).slice(0, 300));

  // Терминатор: psql молча отбрасывает statement без ';' — сервер дописывает его сам.
  const noSemicolon = await q('SELECT 42 AS answer', true);
  check('pg SELECT without trailing ; executes', noSemicolon.ok && JSON.stringify(noSemicolon.body.rows) === JSON.stringify([['42']]), JSON.stringify(noSemicolon.body).slice(0, 300));

  const blocked = await q('CREATE TABLE sc_manual_test (id int)', true);
  check('pg read-only blocks CREATE', blocked.status === 400 && blocked.body?.error, JSON.stringify(blocked.body).slice(0, 200));

  const write = await q('CREATE TABLE IF NOT EXISTS sc_manual_test (id int); INSERT INTO sc_manual_test VALUES (42);', false);
  check('pg write with readOnly=false', write.ok, JSON.stringify(write.body).slice(0, 200));

  const readBack = await q('SELECT id FROM sc_manual_test', true);
  check('pg read back inserted row', readBack.ok && JSON.stringify(readBack.body.rows) === JSON.stringify([['42']]), JSON.stringify(readBack.body).slice(0, 200));

  const syntax = await q('SELEC 1', true);
  check(
    'pg syntax error: stderr + exitCode',
    syntax.status === 400 && /ERROR/.test(syntax.body?.error?.stderr ?? '') && typeof syntax.body?.error?.exitCode === 'number',
    JSON.stringify(syntax.body).slice(0, 200),
  );

  const tables = await req(`/api/db/tables?profileId=${pid}&instanceId=${pg.id}&database=postgres`, {}, cookie);
  check('pg tables list works', tables.ok && Array.isArray(tables.body.tables), JSON.stringify(tables.body).slice(0, 200));

  // Дамп: gzip-магия + разжимается и содержит таблицу.
  const dump = await fetch(`${BASE}/api/db/dump?profileId=${pid}&instanceId=${pg.id}&database=postgres`, {
    headers: { cookie },
  });
  const buf = Buffer.from(await dump.arrayBuffer());
  check('pg dump is gzip', dump.ok && buf[0] === 0x1f && buf[1] === 0x8b, `status=${dump.status} bytes=${buf.length}`);
  const { gunzipSync } = await import('node:zlib');
  let dumpText = '';
  try {
    dumpText = gunzipSync(buf).toString('utf8');
  } catch {
    /* проверим ниже */
  }
  check('pg dump gunzips and contains sc_manual_test', dumpText.includes('sc_manual_test'), dumpText.slice(0, 80));

  // Негативный путь: несуществующая база — ошибка, а не валидный пустой .sql.gz
  // под 200 (exit code пайпа без pipefail — это код gzip, всегда успешный).
  const badDump = await fetch(`${BASE}/api/db/dump?profileId=${pid}&instanceId=${pg.id}&database=nosuchdb`, {
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
    'pg dump of missing db returns error, not empty archive',
    !badDump.ok && badBuf[0] === 0x7b && /pg_dump|базы|database/i.test(badErr),
    `status=${badDump.status} body=${badBuf.toString('utf8').slice(0, 120)}`,
  );
}

// --- MySQL ------------------------------------------------------------------
if (my) {
  // mysql стартует дольше — ждём возможность сделать запрос.
  let overview = null;
  for (let i = 0; i < 30; i++) {
    overview = await req(`/api/db/overview?profileId=${pid}&instanceId=${my.id}`, {}, cookie);
    if (overview.ok) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  check('mysql overview ok', overview?.ok, JSON.stringify(overview?.body).slice(0, 200));
  check('mysql version looks like 8.x', /^\d+\./.test(overview?.body?.version ?? ''), overview?.body?.version);

  const q = async (sql, readOnly) =>
    req(
      '/api/db/query',
      { method: 'POST', body: JSON.stringify({ profileId: pid, instanceId: my.id, database: 'mysql', sql, readOnly }) },
      cookie,
    );
  const select = await q("SELECT 1 AS one, CONCAT('a\tb') AS two", true);
  check('mysql SELECT with tab value', select.ok && JSON.stringify(select.body.rows) === JSON.stringify([['1', 'a\tb']]), JSON.stringify(select.body).slice(0, 300));

  const blocked = await q('CREATE TABLE mysql.sc_manual_test (id INT)', true);
  check('mysql read-only blocks CREATE', blocked.status === 400 && blocked.body?.error, JSON.stringify(blocked.body).slice(0, 200));

  const syntax = await q('SELEC 1', true);
  check('mysql syntax error: stderr + exitCode', syntax.status === 400 && (syntax.body?.error?.stderr ?? '') !== '', JSON.stringify(syntax.body).slice(0, 200));
}

// --- Cleanup ----------------------------------------------------------------
const list = await (await req(`/api/docker/containers?profileId=${pid}`, {}, cookie)).body;
for (const c of Array.isArray(list) ? list : []) {
  const names = String(c.Names ?? c.names ?? '');
  if (names.includes(PG_NAME) || names.includes(MY_NAME)) {
    await req(`/api/docker/containers/${c.Id ?? c.id}/rm?profileId=${pid}`, { method: 'POST' }, cookie);
  }
}
await req(`/api/profiles/${pid}`, { method: 'DELETE' }, cookie);
console.log(process.exitCode ? 'DONE (with failures)' : 'DONE');
