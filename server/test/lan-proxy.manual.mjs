// Manual integration test of the optional LAN access mode (docs/lan-access.md,
// issue #3).
//
// Requires:
//  1. Docker on the machine running the script. The script raises the whole
//     bench itself: a real nginx with real TLS in front of the app image, and
//     two clients on an edge network that has no route to the backend.
//  2. Internet the first time (images are pulled, and alpine apk-installs
//     openssl to mint the self-signed certificate).
//
// No host port is ever published — the clients reach the proxy over a docker
// network only — so running this does not expose anything on the machine.
//
// The proxy configuration is derived from the shipped example
// (docs/examples/lan-proxy.nginx.conf) by substituting the listen address, the
// allow rule and the upstream. That is deliberate: the file users copy is the
// file under test, including its `proxy_set_header` block.
//
// Run: node test/lan-proxy.manual.mjs
// Env: IMAGE      — image tag to build/use (default ssh-commander:lan-stand)
//      SKIP_BUILD — 1 to reuse an existing image
//      KEEP       — 1 to leave the bench running for inspection
//      NET        — first two octets of the bench subnets (default 10.213);
//                   change it if the default collides with existing networks
//
// Scenarios:
//  (A) an allowed client drives REST and both WebSocket endpoints through the
//      proxy: login, cookie flags, Origin and Referer rules, session checks,
//      spoofed X-Forwarded-* headers, WSS upgrade for terminal and agent;
//  (B) a denied client is refused everywhere by nginx, and spoofing the
//      forwarding headers does not buy access;
//  (C) controls that prove the two gates are what produce those numbers:
//      a proxy that rewrites Origin to a trusted value defeats the CSRF gate,
//      and an allow-all proxy lets the denied client through.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const IMAGE = process.env.IMAGE ?? 'ssh-commander:lan-stand';
const NET = process.env.NET ?? '10.213';
const PASSWORD = 'lan-stand-password';
const TRUSTED = 'https://commander.home.arpa';

const EDGE = `${NET}.0.0/24`;
const INTERNAL = `${NET}.1.0/24`;
const BACKEND_IP = `${NET}.1.20`;
const PROXY_INTERNAL_IP = `${NET}.1.10`;
const PROXY_EDGE_IP = `${NET}.0.10`;
const BAD_EDGE_IP = `${NET}.0.11`;
const BAD_INTERNAL_IP = `${NET}.1.11`;
const ALLOWALL_EDGE_IP = `${NET}.0.12`;
const ALLOWALL_INTERNAL_IP = `${NET}.1.12`;
const ALLOWED_CLIENT_IP = `${NET}.0.21`;
const DENIED_CLIENT_IP = `${NET}.0.22`;

const NET_EDGE = 'sc-lan-edge';
const NET_INTERNAL = 'sc-lan-internal';
const C_BACKEND = 'sc-lan-backend';
const C_PROXY = 'sc-lan-proxy';
const C_BAD = 'sc-lan-bad';
const C_ALLOWALL = 'sc-lan-allowall';
const CONTAINERS = [C_BACKEND, C_PROXY, C_BAD, C_ALLOWALL];

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

/** docker wrapper. A numeric exit code is data; anything else is fatal. */
function docker(args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const out = ((err && err.stdout) || stdout || '').trim();
        const errOut = ((err && err.stderr) || stderr || '').trim();
        if (err && typeof err.code === 'string') {
          reject(new Error(`cannot run docker (${err.code}): ${err.message}`));
          return;
        }
        resolve({ out, err: errOut, code: err ? Number(err.code) || 1 : 0 });
      });
  });
}

async function dockerOrThrow(args, timeout) {
  const r = await docker(args, timeout);
  if (r.code !== 0) throw new Error(`docker ${args.slice(0, 3).join(' ')} failed: ${r.err || r.out}`);
  return r.out;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Docker Desktop wants forward slashes in bind mounts, including on Windows. */
function mountPath(p) {
  return p.split(path.sep).join('/');
}

async function teardown() {
  for (const c of CONTAINERS) {
    await docker(['rm', '-f', c]);
  }
  for (const n of [NET_EDGE, NET_INTERNAL]) {
    await docker(['network', 'rm', n]);
  }
}

// --------------------------------------------------------------- the probes
// Written into a temp directory and mounted into node:22-alpine clients. The
// embedded sources avoid backticks and ${} on purpose so they can live inside
// the template literals below without escaping.
const RUN_PROBE = `
import https from 'node:https';
import http from 'node:http';
import tls from 'node:tls';
import crypto from 'node:crypto';

var HOST = process.env.PROXY_HOST || 'commander.home.arpa';
var TRUSTED = 'https://commander.home.arpa';
var PASSWORD = process.env.STAND_PASSWORD || 'stand-test-pw';
var ROLE = process.env.ROLE || 'allowed';
var BACKEND_IP = process.env.BACKEND_IP || '${BACKEND_IP}';

var results = [];
function check(name, actual, expected, note) {
  results.push({ ok: actual === expected, name: name, expected: expected, actual: actual, note: note || '' });
}
function info(name, actual, note) {
  results.push({ ok: true, name: name, expected: 'info', actual: actual, note: note || '', informational: true });
}

function request(o) {
  o = o || {};
  var method = o.method || 'GET';
  var host = o.host || HOST;
  var port = o.port || 443;
  var secure = port === 443;
  return new Promise(function (resolve) {
    var options = { host: host, port: port, method: method, path: o.path || '/',
      headers: o.headers || {}, timeout: o.timeout || 8000 };
    if (secure) { options.rejectUnauthorized = false; options.servername = HOST; }
    var settled = false;
    function done(v) { if (!settled) { settled = true; resolve(v); } }
    var r = (secure ? https : http).request(options, function (res) {
      var data = '';
      res.setEncoding('utf8');
      res.on('data', function (c) { data += c; });
      res.on('end', function () { done({ status: res.statusCode, headers: res.headers, body: data }); });
    });
    r.on('timeout', function () { r.destroy(); done({ status: 0, error: 'timeout' }); });
    r.on('error', function (e) { done({ status: 0, error: e.code || e.message }); });
    if (o.body !== undefined) r.write(o.body);
    r.end();
  });
}

function wsUpgrade(o) {
  o = o || {};
  var headers = o.headers || {};
  return new Promise(function (resolve) {
    var settled = false;
    var socket;
    function done(v) { if (!settled) { settled = true; try { socket.destroy(); } catch (e) {} resolve(v); } }
    socket = tls.connect({ host: HOST, port: 443, rejectUnauthorized: false, servername: HOST }, function () {
      var lines = ['GET ' + (o.path || '/ws/terminal?profileId=probe') + ' HTTP/1.1',
        'Host: ' + HOST, 'Upgrade: websocket', 'Connection: Upgrade',
        'Sec-WebSocket-Key: ' + crypto.randomBytes(16).toString('base64'),
        'Sec-WebSocket-Version: 13'];
      Object.keys(headers).forEach(function (k) { lines.push(k + ': ' + headers[k]); });
      lines.push('', '');
      socket.write(lines.join('\\r\\n'));
    });
    var buf = '';
    socket.on('data', function (chunk) {
      buf += chunk.toString('latin1');
      var m = buf.match(/^HTTP\\/1\\.1 (\\d{3})/);
      if (m) done(Number(m[1]));
    });
    socket.on('error', function () { done(0); });
    setTimeout(function () { done(0); }, 8000);
  });
}

var SPOOF = { 'x-forwarded-for': '${ALLOWED_CLIENT_IP}', 'x-forwarded-host': HOST,
  'x-forwarded-proto': 'https', 'x-real-ip': '${ALLOWED_CLIENT_IP}',
  forwarded: 'for=${ALLOWED_CLIENT_IP};host=' + HOST + ';proto=https' };

var byName = await request({ path: '/api/health', host: 'backend', port: 8080, timeout: 3000 });
check('backend unreachable by service name', byName.status, 0, byName.error || '');
var byIp = await request({ path: '/api/health', host: BACKEND_IP, port: 8080, timeout: 3000 });
check('backend unreachable by private address', byIp.status, 0, byIp.error || '');

if (ROLE === 'denied') {
  check('nginx: GET /', (await request({})).status, 403);
  check('nginx: GET /api/health', (await request({ path: '/api/health' })).status, 403);
  check('nginx: POST /api/auth/login', (await request({ method: 'POST', path: '/api/auth/login',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }) })).status, 403);
  check('nginx: WS upgrade', await wsUpgrade({}), 403);
  check('nginx: GET / with spoofed X-Forwarded-For',
    (await request({ headers: { 'x-forwarded-for': '${ALLOWED_CLIENT_IP}' } })).status, 403);
  check('nginx: GET / with spoofed Forwarded',
    (await request({ headers: { forwarded: 'for=${ALLOWED_CLIENT_IP}' } })).status, 403);
  check('nginx: GET / with spoofed X-Real-IP',
    (await request({ headers: { 'x-real-ip': '${ALLOWED_CLIENT_IP}' } })).status, 403);
  check('nginx: WS upgrade with spoofed X-Forwarded-For',
    await wsUpgrade({ headers: { 'x-forwarded-for': '${ALLOWED_CLIENT_IP}' } }), 403);
} else {
  check('proxy: GET / serves the UI', (await request({})).status, 200);
  check('no plain HTTP listener on port 80', (await request({ port: 80, timeout: 3000 })).status, 0);

  var health = await request({ path: '/api/health' });
  info('GET /api/health without Origin (peer is the proxy, not loopback)', health.status,
    'a healthcheck behind a proxy needs an Origin/Referer or a session');

  var login = await request({ method: 'POST', path: '/api/auth/login',
    headers: { origin: TRUSTED, 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }) });
  check('login through the proxy', login.status, 200);
  var setCookie = String(login.headers['set-cookie'] || '');
  ['Secure', 'HttpOnly', 'SameSite=Lax'].forEach(function (flag) {
    check('session cookie carries ' + flag, setCookie.indexOf(flag) >= 0, true);
  });
  var cookie = setCookie.split(';')[0];

  check('GET /api/profiles with Origin + session',
    (await request({ path: '/api/profiles', headers: { origin: TRUSTED, cookie: cookie } })).status, 200);
  check('GET /api/profiles with Origin, no session',
    (await request({ path: '/api/profiles', headers: { origin: TRUSTED } })).status, 401);
  check('GET /api/profiles with session, no Origin and no Referer',
    (await request({ path: '/api/profiles', headers: { cookie: cookie } })).status, 403);
  check('GET /api/profiles with session + trusted Referer',
    (await request({ path: '/api/profiles', headers: { cookie: cookie, referer: TRUSTED + '/' } })).status, 200);
  check('GET /api/profiles with foreign Origin',
    (await request({ path: '/api/profiles', headers: { origin: 'https://evil.example', cookie: cookie } })).status, 403);
  check('GET /api/profiles with Origin on the wrong port',
    (await request({ path: '/api/profiles', headers: { origin: TRUSTED + ':8443', cookie: cookie } })).status, 403);
  check('POST /api/setup stays closed (no network onboarding)',
    (await request({ method: 'POST', path: '/api/setup',
      headers: { origin: TRUSTED, 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'another-password' }) })).status, 409);

  check('GET /api/profiles with spoofed forwarding headers + Origin',
    (await request({ path: '/api/profiles', headers: Object.assign({ origin: TRUSTED, cookie: cookie }, SPOOF) })).status, 200);
  check('GET /api/profiles with spoofed forwarding headers and no Origin',
    (await request({ path: '/api/profiles', headers: Object.assign({ cookie: cookie }, SPOOF) })).status, 403);
  check('GET /api/profiles with spoofed headers and foreign Origin',
    (await request({ path: '/api/profiles', headers: Object.assign({ origin: 'https://evil.example', cookie: cookie }, SPOOF) })).status, 403);

  var routes = [{ path: '/ws/terminal?profileId=probe', label: 'terminal' },
    { path: '/ws/agent?profileId=probe', label: 'agent' }];
  for (var i = 0; i < routes.length; i++) {
    var r = routes[i];
    check('WS ' + r.label + ': trusted Origin + session upgrades',
      await wsUpgrade({ path: r.path, headers: { origin: TRUSTED, cookie: cookie } }), 101);
    check('WS ' + r.label + ': trusted Origin, no session',
      await wsUpgrade({ path: r.path, headers: { origin: TRUSTED } }), 401);
    check('WS ' + r.label + ': no Origin',
      await wsUpgrade({ path: r.path, headers: { cookie: cookie } }), 403);
    check('WS ' + r.label + ': foreign Origin',
      await wsUpgrade({ path: r.path, headers: { origin: 'https://evil.example', cookie: cookie } }), 403);
    check('WS ' + r.label + ': spoofed forwarding headers do not help',
      await wsUpgrade({ path: r.path, headers: Object.assign({ cookie: cookie }, SPOOF) }), 403);
  }
}

var bad = 0;
results.forEach(function (r) {
  if (!r.ok) bad++;
  var mark = r.informational ? 'INFO' : (r.ok ? 'PASS' : 'FAIL');
  console.log('    ' + mark + '  ' + r.name + '  [expected ' + r.expected + ', got ' + r.actual + ']' +
    (r.note ? '  (' + r.note + ')' : ''));
});
console.log('    RESULT ok=' + (results.length - bad) + ' fail=' + bad);
process.exit(bad === 0 ? 0 : 1);
`;

const ORIGIN_PROBE = `
import https from 'node:https';

var HOST = process.env.PROXY_HOST || 'commander.home.arpa';
var TRUSTED = 'https://commander.home.arpa';
var PASSWORD = process.env.STAND_PASSWORD || 'stand-test-pw';

function request(o) {
  o = o || {};
  return new Promise(function (resolve) {
    var r = https.request({ host: HOST, port: 443, method: o.method || 'GET', path: o.path || '/',
      headers: o.headers || {}, rejectUnauthorized: false, servername: HOST, timeout: 8000 }, function (res) {
      var data = '';
      res.setEncoding('utf8');
      res.on('data', function (c) { data += c; });
      res.on('end', function () { resolve({ status: res.statusCode, headers: res.headers }); });
    });
    r.on('timeout', function () { r.destroy(); resolve({ status: 0 }); });
    r.on('error', function () { resolve({ status: 0 }); });
    if (o.body !== undefined) r.write(o.body);
    r.end();
  });
}

var login = await request({ method: 'POST', path: '/api/auth/login',
  headers: { origin: TRUSTED, 'content-type': 'application/json' },
  body: JSON.stringify({ password: PASSWORD }) });
var cookie = String(login.headers['set-cookie'] || '').split(';')[0];
console.log('    login=' + login.status);
var foreign = await request({ path: '/api/profiles', headers: { origin: 'https://evil.example', cookie: cookie } });
var none = await request({ path: '/api/profiles', headers: { cookie: cookie } });
var ok = await request({ path: '/api/profiles', headers: { origin: TRUSTED, cookie: cookie } });
console.log('    ORIGIN foreign=' + foreign.status + ' none=' + none.status + ' trusted=' + ok.status);
`;

// ------------------------------------------------------------------- driver
function deriveConfigs(dir) {
  const examplePath = path.join(REPO, 'docs/examples/lan-proxy.nginx.conf');
  const example = fs.readFileSync(examplePath, 'utf8');
  function substitute(src, from, to, what) {
    if (!src.includes(from)) {
      throw new Error(`the shipped nginx example no longer contains "${from}" (${what}) — update this scenario`);
    }
    return src.replace(from, to);
  }
  const base = substitute(
    substitute(
      substitute(example, 'listen 192.168.1.10:443 ssl;', 'listen 443 ssl;', 'listen address'),
      'allow 192.168.1.25;', `allow ${ALLOWED_CLIENT_IP};`, 'client allow rule'),
    'proxy_pass http://127.0.0.1:8080;', `proxy_pass http://${BACKEND_IP}:8080;`, 'upstream address');

  const rewrite = substitute(base, 'proxy_set_header Origin $http_origin;',
    'proxy_set_header Origin https://commander.home.arpa;', 'Origin preservation');
  const allowAll = substitute(base, `allow ${ALLOWED_CLIENT_IP};`, `allow ${EDGE};`, 'client allow rule');

  fs.writeFileSync(path.join(dir, 'nginx.conf'), base);
  fs.writeFileSync(path.join(dir, 'nginx-origin-rewrite.conf'), rewrite);
  fs.writeFileSync(path.join(dir, 'nginx-allow-all.conf'), allowAll);
  check('proxy config derived from the shipped example', true);
  return { example, base, rewrite, allowAll };
}

async function mintCertificate(tlsDir) {
  const script = 'apk add --no-cache openssl >/dev/null 2>&1 && '
    + 'openssl req -x509 -newkey rsa:2048 -nodes -keyout /tls/commander.key '
    + '-out /tls/commander.crt -days 30 -subj /CN=commander.home.arpa '
    + '-addext subjectAltName=DNS:commander.home.arpa';
  await dockerOrThrow(['run', '--rm', '-v', `${mountPath(tlsDir)}:/tls`, 'alpine:latest', 'sh', '-c', script], 300000);
  const ok = fs.existsSync(path.join(tlsDir, 'commander.crt')) && fs.existsSync(path.join(tlsDir, 'commander.key'));
  check('self-signed certificate minted', ok);
}

async function startProxy(name, configFile, dir, internalIp, edgeIp) {
  await dockerOrThrow(['run', '-d', '--name', name, '--network', NET_INTERNAL, '--ip', internalIp,
    '-v', `${mountPath(path.join(dir, configFile))}:/etc/nginx/conf.d/default.conf:ro`,
    '-v', `${mountPath(path.join(dir, 'tls'))}:/etc/nginx/tls:ro`,
    'nginx:alpine']);
  await dockerOrThrow(['network', 'connect', '--ip', edgeIp, NET_EDGE, name]);
}

async function runProbe({ role, ip, proxyHost, proxyIp, dir, script = 'run-probe.mjs' }) {
  const r = await docker(['run', '--rm', '--network', NET_EDGE, '--ip', ip,
    '--add-host', `${proxyHost}:${proxyIp}`,
    '-e', `ROLE=${role}`, '-e', `PROXY_HOST=${proxyHost}`, '-e', `STAND_PASSWORD=${PASSWORD}`,
    '-e', `BACKEND_IP=${BACKEND_IP}`,
    '-v', `${mountPath(dir)}:/probe:ro`,
    'node:22-alpine', 'node', `/probe/${script}`], 180000);
  const text = r.out || r.err;
  for (const line of text.split('\n')) {
    if (line.trim()) console.log(line);
  }
  return text;
}

function parseResult(text) {
  const m = text.match(/RESULT ok=(\d+) fail=(\d+)/);
  return m ? { ok: Number(m[1]), fail: Number(m[2]) } : null;
}

function parseOrigin(text) {
  const m = text.match(/ORIGIN foreign=(\d+) none=(\d+) trusted=(\d+)/);
  return m ? { foreign: Number(m[1]), none: Number(m[2]), trusted: Number(m[3]) } : null;
}

(async () => {
  let dir = '';
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-lan-proxy-'));
    console.log(`bench directory: ${dir}`);
    await teardown();

    if (process.env.SKIP_BUILD !== '1') {
      console.log(`\nbuilding ${IMAGE} (this is the slow part)`);
      const build = await docker(['build', '-t', IMAGE, REPO], 1800000);
      if (build.code !== 0) throw new Error(`docker build failed: ${build.err.slice(-2000)}`);
    }
    const hasMode = await docker(['run', '--rm', '--entrypoint', 'sh', IMAGE, '-c',
      'grep -rl APP_ACCESS_MODE /app 2>/dev/null | wc -l']);
    check(`image ${IMAGE} carries the proxy mode`, Number(hasMode.out) >= 1, hasMode.out);

    fs.writeFileSync(path.join(dir, 'run-probe.mjs'), RUN_PROBE);
    fs.writeFileSync(path.join(dir, 'origin-probe.mjs'), ORIGIN_PROBE);
    fs.mkdirSync(path.join(dir, 'tls'));

    console.log('\n--- configuration ---');
    deriveConfigs(dir);
    await mintCertificate(path.join(dir, 'tls'));

    console.log('\n--- raising the bench ---');
    await dockerOrThrow(['network', 'create', '--subnet', EDGE, NET_EDGE]);
    await dockerOrThrow(['network', 'create', '--internal', '--subnet', INTERNAL, NET_INTERNAL]);
    await dockerOrThrow(['run', '-d', '--name', C_BACKEND, '--network', NET_INTERNAL, '--ip', BACKEND_IP,
      '-e', 'APP_ACCESS_MODE=proxy', '-e', `APP_TRUSTED_ORIGINS=${TRUSTED}`,
      '-e', `APP_PASSWORD=${PASSWORD}`, '-e', 'APP_HOST=0.0.0.0', '-e', 'APP_PORT=8080', '-e', 'AI_API_KEY=',
      IMAGE]);

    let ready = false;
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      const logs = await docker(['logs', C_BACKEND]);
      if ((logs.out + logs.err).includes('listening on')) { ready = true; break; }
    }
    check('the backend reported a listening socket', ready);
    if (!ready) throw new Error('the backend never started');

    await startProxy(C_PROXY, 'nginx.conf', dir, PROXY_INTERNAL_IP, PROXY_EDGE_IP);
    await startProxy(C_BAD, 'nginx-origin-rewrite.conf', dir, BAD_INTERNAL_IP, BAD_EDGE_IP);
    await startProxy(C_ALLOWALL, 'nginx-allow-all.conf', dir, ALLOWALL_INTERNAL_IP, ALLOWALL_EDGE_IP);
    await sleep(3000);

    console.log(`\n(A) allowed client ${ALLOWED_CLIENT_IP} through the proxy`);
    const a = parseResult(await runProbe({ role: 'allowed', ip: ALLOWED_CLIENT_IP,
      proxyHost: 'commander.home.arpa', proxyIp: PROXY_EDGE_IP, dir }));
    check('every allowed-client expectation held', a !== null && a.fail === 0, a ? `fail=${a.fail}` : 'no RESULT line');

    console.log(`\n(B) denied client ${DENIED_CLIENT_IP}`);
    const b = parseResult(await runProbe({ role: 'denied', ip: DENIED_CLIENT_IP,
      proxyHost: 'commander.home.arpa', proxyIp: PROXY_EDGE_IP, dir }));
    check('every denied-client expectation held', b !== null && b.fail === 0, b ? `fail=${b.fail}` : 'no RESULT line');

    console.log('\n(C) control: the correct proxy refuses a foreign or missing Origin');
    const c = parseOrigin(await runProbe({ role: 'allowed', ip: ALLOWED_CLIENT_IP,
      proxyHost: 'commander.home.arpa', proxyIp: PROXY_EDGE_IP, dir, script: 'origin-probe.mjs' }));
    check('foreign Origin refused', c !== null && c.foreign === 403, c ? `got ${c.foreign}` : 'no ORIGIN line');
    check('missing Origin refused', c !== null && c.none === 403, c ? `got ${c.none}` : 'no ORIGIN line');
    check('trusted Origin accepted', c !== null && c.trusted === 200, c ? `got ${c.trusted}` : 'no ORIGIN line');

    console.log('\n(D) control: rewriting Origin to a trusted value defeats the CSRF gate');
    const d = parseOrigin(await runProbe({ role: 'allowed', ip: ALLOWED_CLIENT_IP,
      proxyHost: 'commander-bad.home.arpa', proxyIp: BAD_EDGE_IP, dir, script: 'origin-probe.mjs' }));
    check('the anti-pattern really does let a foreign Origin through',
      d !== null && d.foreign === 200, d ? `got ${d.foreign}` : 'no ORIGIN line');

    console.log(`\n(E) control: the denied client passes when the allow rule covers it`);
    const e = parseResult(await runProbe({ role: 'allowed', ip: DENIED_CLIENT_IP,
      proxyHost: 'commander-all.home.arpa', proxyIp: ALLOWALL_EDGE_IP, dir }));
    check('the allow rule is what produced the earlier refusals',
      e !== null && e.fail === 0, e ? `fail=${e.fail}` : 'no RESULT line');
  } catch (err) {
    failed += 1;
    console.error('SCENARIO ERROR:', err.message);
  } finally {
    if (process.env.KEEP === '1') {
      console.log('\nbench left running (KEEP=1); remove it with:');
      console.log(`  docker rm -f ${CONTAINERS.join(' ')}`);
      console.log(`  docker network rm ${NET_EDGE} ${NET_INTERNAL}`);
    } else {
      await teardown();
      console.log('\nbench removed');
    }
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    console.log(`\nTotal: ok=${passed} fail=${failed}`);
    process.exit(failed > 0 ? 1 : 0);
  }
})();
