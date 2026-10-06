// Manual integration scenario of the "Databases" tab (epic 12, iteration 2:
// connections with explicit credentials, the password as the first stdin line).
//
// The stand (see AGENTS.md, "Testing"): the ssh-commander server is running with
//   APP_HOST=127.0.0.1 APP_PORT=8091 APP_PASSWORD=test123
//   DATA_DIR=<tmp> KEYS_DIR=<tmp>
// and a test sshd (linuxserver/openssh-server) on 127.0.0.1:2222
// (user test / test123) that has the docker CLI and access to the docker daemon
// (e.g. -v /var/run/docker.sock:/var/run/docker.sock). The scenario itself
// raises the postgres:16-alpine, postgres:16 (the dash image — the iteration 1
// blocker showed up exactly on dash/busybox shells) and mysql:8 containers
// through the app docker API and removes them at the end.
//
// Covers: discovery (the hint shapes), test-connection (a correct/wrong
// password — Access denied as-is text), saved connections,
// overview (the version, the databases), tables, SELECT, the read-only SET
// (INSERT blocked), read-only OFF, a syntax error (stderr + exit code),
// a dump (gzip, unpacks), a partial password update, cleanup.
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

// --- The stand: postgres (alpine + dash) + mysql through the app docker API ---
const CONTAINERS = [
  { image: 'postgres:16-alpine', name: 'sc-test-pg-alpine', env: ['POSTGRES_PASSWORD=pgpw'] },
  { image: 'postgres:16', name: 'sc-test-pg-dash', env: ['POSTGRES_PASSWORD=pgpw'] },
  { image: 'mysql:8', name: 'sc-test-mysql', env: ['MYSQL_ROOT_PASSWORD=myrootpw'] },
];
const NAMES = CONTAINERS.map((c) => c.name);

// Remove the leftovers of the previous run (rm -f, not an error when missing).
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

// Wait for the DBMS readiness: discovery must see all the containers.
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
  // The password is not returned outward.
  check(`connection ${payload.name} has no password in response`, res.ok && !('password' in (res.body ?? {})));
  if (res.ok) createdConnections.push(res.body.id);
  return res.ok ? res.body : null;
};

// --- The negative path BEFORE saving: a wrong password is visible in test ---------
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

// --- PostgreSQL: local trust — any/empty password, both images -----------
for (const s of pgSuggestions) {
  const conn = await makeConnection({
    profileId: pid,
    name: s.name,
    engine: 'postgres',
    target: { kind: 'container', containerId: s.id },
    username: 'postgres',
    // The PG official image: the local socket is trust — no password needed, but
    // we also check a non-empty one (the first stdin line transfer).
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
        password: '', // empty in the form = check the saved one
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

  // The terminator: psql silently drops a statement without ';' — the server appends it itself.
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

  // The dump: the password goes as the first stdin line, the gzip magic + it unpacks.
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
    /* checked below */
  }
  check(`pg (${s.image}) dump gunzips and contains sc_manual_test`, dumpText.includes('sc_manual_test'), dumpText.slice(0, 80));

  // The negative path: a nonexistent database — an error, not a valid empty .sql.gz
  // under 200 (the pipe exit code without pipefail is the gzip code, always successful).
  const badDump = await fetch(`${BASE}/api/db/dump?profileId=${pid}&connectionId=${conn.id}&database=nosuchdb`, {
    headers: { cookie },
  });
  const badBuf = Buffer.from(await badDump.arrayBuffer());
  let badErr = '';
  try {
    badErr = JSON.parse(badBuf.toString('utf8')).error ?? '';
  } catch {
    /* check the status below */
  }
  check(
    `pg (${s.image}) dump of missing db returns error, not empty archive`,
    !badDump.ok && badBuf[0] === 0x7b && /pg_dump|базы|database/i.test(badErr),
    `status=${badDump.status} body=${badBuf.toString('utf8').slice(0, 120)}`,
  );
}

// --- MySQL: saved credentials, a partial password update ---------------
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

    // mysql starts slower — wait until a query is possible.
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

    // A partial update: the password was not passed — the previous one is kept; a rename
    // does not break the connection.
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

// The list outward — without passwords and only of the own profile.
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
