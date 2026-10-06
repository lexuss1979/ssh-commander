// Manual integration test of the "New server (root + password)" epic
// (docs/bootstrap-plan.md).
//
// Requires:
//  1. A running ssh-commander: `cd server && APP_PASSWORD=test123 APP_PORT=8090 npm run dev`
//     (BASE_URL/the app password — via the BASE_URL / APP_PASSWORD env).
//  2. Docker on the machine running the script (it raises the sshd container itself).
//
// Container preparation (the script does it itself, here — for a manual repeat):
//   docker run -d --name sc-boot-sshd -p 2223:2222 \
//     -e PASSWORD_ACCESS=true -e USER_NAME=test -e USER_PASSWORD=test123 \
//     linuxserver/openssh-server
//   docker exec sc-boot-sshd bash -c "echo 'root:test123' | chpasswd && \
//     sed -ri 's/^#?PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config"
//   docker restart sc-boot-sshd
//
// Run: node test/bootstrap.manual.mjs
// Scenarios: (1) rollback — a Match block overrides the hardening, the config
// is restored, password login works again; (2) the happy path without
// hardening twice — authorized_keys idempotency + an ssh-keygen -y cross-check
// (the key encoder is compatible with the OpenSSH tools); (3) hardening on top
// — the password disabled, the key works (checked with a direct ssh2 client).
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ssh2pkg from 'ssh2';

const { Client } = ssh2pkg;

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8090';
const PASSWORD = process.env.APP_PASSWORD ?? 'test123';
const SSH_HOST = process.env.BOOTSTRAP_SSH_HOST ?? '127.0.0.1';
const SSH_PORT = Number(process.env.BOOTSTRAP_SSH_PORT ?? 2223);
const ROOT_PASSWORD = process.env.BOOTSTRAP_ROOT_PASSWORD ?? 'test123';
const CONTAINER = 'sc-boot-sshd';
// The KEYS_DIR of the running server (dev mode: <repo>/keys) — to check the
// login with the generated key directly.
const KEYS_DIR = process.env.KEYS_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../keys');

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

function docker(args) {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { timeout: 60000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`docker ${args.join(' ')}: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });
}

async function req(pathname, opts = {}) {
  const res = await fetch(BASE + pathname, {
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
  return { status: res.status, body, headers: res.headers };
}

async function login() {
  const res = await req('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ password: PASSWORD }),
  });
  if (res.status !== 200) throw new Error(`login -> ${res.status}: ${JSON.stringify(res.body)}`);
  cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
}

/** A direct ssh2 attempt: 'ok' or an Error. */
function tryConnect({ username, password, privateKey }) {
  return new Promise((resolve) => {
    const client = new Client();
    const done = (result) => {
      try {
        client.end();
      } catch {
        /* noop */
      }
      resolve(result);
    };
    client.once('ready', () => done('ok'));
    client.once('error', (err) => done(err));
    client.connect({ host: SSH_HOST, port: SSH_PORT, username, password, privateKey, readyTimeout: 15000 });
  });
}

async function bootstrapCall(name, disablePasswordAuth) {
  return req('/api/profiles/bootstrap', {
    method: 'POST',
    body: JSON.stringify({
      name,
      host: SSH_HOST,
      port: SSH_PORT,
      username: 'root',
      password: ROOT_PASSWORD,
      disablePasswordAuth,
    }),
  });
}

function printSteps(steps) {
  for (const s of steps ?? []) {
    console.log(`    ${s.status === 'ok' ? '✓' : s.status === 'warn' ? '⚠' : '✕'} ${s.name}${s.detail ? ` — ${s.detail}` : ''}`);
  }
}

async function setupContainer() {
  console.log('Preparing the sshd container (docker):');
  await docker(['rm', '-f', CONTAINER]).catch(() => '');
  await docker([
    'run', '-d', '--name', CONTAINER, '-p', `${SSH_PORT}:2222`,
    '-e', 'PASSWORD_ACCESS=true', '-e', 'USER_NAME=test', '-e', 'USER_PASSWORD=test123',
    'linuxserver/openssh-server',
  ]);
  // Wait for sshd (the container starts its s6 services for a few seconds).
  for (let i = 0; i < 30; i++) {
    const up = await tryConnect({ username: 'test', password: 'test123' }).catch(() => null);
    if (up === 'ok') break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  // Root login by password.
  await docker([
    'exec', CONTAINER, 'bash', '-c',
    "echo 'root:" + ROOT_PASSWORD + "' | chpasswd && " +
      "sed -ri 's/^#?[[:space:]]*PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config && " +
      "grep -qi '^PasswordAuthentication yes' /etc/ssh/sshd_config || echo 'PasswordAuthentication yes' >> /etc/ssh/sshd_config",
  ]);
  await docker(['restart', CONTAINER]);
  for (let i = 0; i < 30; i++) {
    const up = await tryConnect({ username: 'root', password: ROOT_PASSWORD });
    if (up === 'ok') break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  const rootLogin = await tryConnect({ username: 'root', password: ROOT_PASSWORD });
  check('container: root logs in by password', rootLogin === 'ok', String(rootLogin));
}

async function cleanupKeyProfiles() {
  const list = await req('/api/profiles');
  for (const p of list.body) {
    if (p.keyPath?.includes('.ed25519')) {
      await req(`/api/profiles/${p.id}`, { method: 'DELETE' });
    }
  }
}

async function scenarioRollback() {
  console.log('\nScenario 1: rollback (a Match block overrides the hardening)');
  // The Match override for root in the main config: sshd -t is green,
  // but for the root user PasswordAuthentication yes overrides our drop-in.
  await docker(['exec', CONTAINER, 'bash', '-c',
    "cp /etc/ssh/sshd_config /etc/ssh/sshd_config.pre-match && " +
      "printf '%s\\n' '' 'Match User root' '    PasswordAuthentication yes' >> /etc/ssh/sshd_config"]);
  await docker(['restart', CONTAINER]);
  await new Promise((r) => setTimeout(r, 8000));

  const res = await bootstrapCall('rollback-vps', true);
  check('bootstrap failed', res.status >= 400, `status=${res.status}`);
  printSteps(res.body.steps);
  check('the error explains the hardening non-application', /не применился|отменены/i.test(String(res.body.error ?? '')), String(res.body.error).slice(0, 120));
  check('the steps include a rollback', (res.body.steps ?? []).some((s) => s.name.includes('Откат')), '');

  const dropin = await docker(['exec', CONTAINER, 'bash', '-c',
    `[ -f /etc/ssh/sshd_config.d/00-ssh-commander.conf ] && echo present || echo absent`]);
  check('the ssh-commander drop-in is removed', dropin.trim() === 'absent', dropin.trim());
  const pw = await tryConnect({ username: 'root', password: ROOT_PASSWORD });
  check('password login works again', pw === 'ok', String(pw));
  const profiles = await req('/api/profiles');
  check('no profile created', !profiles.body.some((p) => p.name === 'rollback-vps'), '');

  // Remove the Match block and restore the original config.
  await docker(['exec', CONTAINER, 'bash', '-c',
    'cp /etc/ssh/sshd_config.pre-match /etc/ssh/sshd_config && rm -f /etc/ssh/sshd_config.pre-match']);
  await docker(['restart', CONTAINER]);
  await new Promise((r) => setTimeout(r, 8000));
}

async function scenarioHappyAndIdempotency() {
  console.log('\nScenario 2: the happy path without hardening + idempotency');
  await cleanupKeyProfiles();

  const first = await bootstrapCall('happy-vps', false);
  check('the first bootstrap succeeds', first.status === 201, `status=${first.status} ${JSON.stringify(first.body.error ?? '')}`);
  printSteps(first.body.steps);
  check('a profile with authType=key', first.body.profile?.authType === 'key', JSON.stringify(first.body.profile ?? {}).slice(0, 120));
  check('the key is saved into keys/', fs.existsSync(first.body.profile?.keyPath ?? '/nonexistent'), first.body.profile?.keyPath ?? '');

  // An OpenSSH-compatibility cross-check of the encoder: a real ssh-keygen
  // derives from our private file the same pubkey that was installed on the
  // server (pins the "ssh-keygen -y" check in the repo, not ad hoc).
  try {
    const keyPath = first.body.profile.keyPath;
    const bodyOf = (s) => s.trim().split(/\s+/).slice(0, 2).join(' ');
    const derived = bodyOf(execFileSync('ssh-keygen', ['-y', '-f', keyPath]).toString());
    const line = await docker(['exec', CONTAINER, 'bash', '-c',
      `grep -E 'ssh-commander@happy-vps$' /root/.ssh/authorized_keys | head -1`]);
    const installed = bodyOf(line);
    check('ssh-keygen -y from the key file == the authorized_keys line', derived === installed, `derived=${derived} installed=${installed}`);
  } catch (e) {
    check('ssh-keygen -y from the key file == the authorized_keys line', false, e.message);
  }

  const second = await bootstrapCall('happy-vps-2', false);
  check('the repeated bootstrap succeeds', second.status === 201, `status=${second.status}`);

  const count = await docker(['exec', CONTAINER, 'bash', '-c', "grep -c 'ssh-commander@' /root/.ssh/authorized_keys || true"]);
  // Two bootstraps — two different names → two different comments; one line per profile.
  const lines = Number(count.trim()) || 0;
  check('exactly one ssh-commander key line per run (2)', lines === 2, `grep -c = ${count.trim()}`);

  const keyLogin = await tryConnect({ username: 'root', privateKey: fs.readFileSync(first.body.profile.keyPath) });
  check('login with the generated key works', keyLogin === 'ok', String(keyLogin));
}

async function scenarioHardening() {
  console.log('\nScenario 3: hardening on top (password login gets closed)');
  const res = await bootstrapCall('hardened-vps', true);
  check('the bootstrap with hardening succeeds', res.status === 201, `status=${res.status} ${JSON.stringify(res.body.error ?? '').slice(0, 200)}`);
  printSteps(res.body.steps);
  const pw = await tryConnect({ username: 'root', password: ROOT_PASSWORD });
  check('the password no longer gets in', pw !== 'ok' && /authentication/i.test(String(pw.message ?? pw)), String(pw.message ?? pw));

  const profile = res.body.profile;
  const keyLogin = await tryConnect({ username: 'root', privateKey: fs.readFileSync(profile.keyPath) });
  check('the key keeps working after the hardening', keyLogin === 'ok', String(keyLogin));

  const dropin = await docker(['exec', CONTAINER, 'bash', '-c',
    `[ -f /etc/ssh/sshd_config.d/00-ssh-commander.conf ] && echo present || echo absent`]);
  if (dropin.trim() === 'present') {
    const content = await docker(['exec', CONTAINER, 'cat', '/etc/ssh/sshd_config.d/00-ssh-commander.conf']);
    check('the drop-in contains both directives', /PasswordAuthentication no/.test(content) && /(KbdInteractive|ChallengeResponse)Authentication no/.test(content), content.trim());
  } else {
    const main = await docker(['exec', CONTAINER, 'cat', '/etc/ssh/sshd_config']);
    check('the main config is hardened (the fallback mode)', /^PasswordAuthentication no$/m.test(main), '');
    const backup = await docker(['exec', CONTAINER, 'bash', '-c', 'ls /etc/ssh/sshd_config.bak-ssh-commander-* 2>/dev/null | head -1']);
    check('a backup of the main config was created', Boolean(backup.trim()), backup.trim());
  }
}

(async () => {
  try {
    await login();
    await setupContainer();
    await scenarioRollback();
    await scenarioHappyAndIdempotency();
    await scenarioHardening();
  } catch (err) {
    failed += 1;
    console.error('SCENARIO ERROR:', err.message);
  } finally {
    console.log(`\nTotal: ok=${passed} fail=${failed}`);
    process.exit(failed > 0 ? 1 : 0);
  }
})();
