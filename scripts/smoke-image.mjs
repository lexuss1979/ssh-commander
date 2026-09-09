// Изолированная проверка образа: onboarding, UI, авторизация и сохранность данных.
// Запуск: node scripts/smoke-image.mjs IMAGE [linux/amd64|linux/arm64]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const [image, platform = 'linux/amd64'] = process.argv.slice(2);
if (!image || !['linux/amd64', 'linux/arm64'].includes(platform)) throw Error('Usage: smoke-image.mjs IMAGE [PLATFORM]');
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 120_000 }).trim();
const root = mkdtempSync(join(tmpdir(), 'ssh-commander-smoke-'));
const name = `sc-smoke-${randomUUID()}`;
const password = randomUUID();
for (const dir of ['data', 'keys']) mkdirSync(join(root, dir));
writeFileSync(join(root, 'keys', 'smoke-marker'), 'Synthetic marker, not an SSH key.');
let running = false;
try {
  for (const first of [true, false]) {
    docker('run', '-d', '--name', name, '--platform', platform, '-p', '127.0.0.1::8080',
      '--mount', `type=bind,source=${join(root, 'data')},target=/data`,
      '--mount', `type=bind,source=${join(root, 'keys')},target=/keys`, image);
    running = true;
    const info = JSON.parse(docker('inspect', name))[0];
    const binding = info.NetworkSettings.Ports['8080/tcp'][0];
    assert.equal(binding.HostIp, '127.0.0.1');
    const base = `http://127.0.0.1:${binding.HostPort}`;
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try {
        const response = await fetch(`${base}/api/setup/status`, { signal: AbortSignal.timeout(2000) });
        if (response.ok) { assert.equal((await response.json()).required, first); ready = true; break; }
      } catch (error) { if (error.code === 'ERR_ASSERTION') throw error; }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    assert(ready, 'Application readiness timeout');
    const html = await fetch(base);
    assert.equal(html.status, 200);
    const content = await html.text();
    assert.match(content, /id="root"/);
    const asset = content.match(/src="([^"]+\.js)"/)[1];
    assert.equal((await fetch(new URL(asset, base))).status, 200);
    const auth = await fetch(`${base}${first ? '/api/setup' : '/api/auth/login'}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
    });
    assert.equal(auth.status, 200, 'Onboarding/login');
    const cookie = auth.headers.get('set-cookie')?.split(';')[0];
    assert(cookie);
    const settings = await fetch(`${base}/api/settings`, { headers: { cookie } });
    assert.equal(settings.status, 200);
    assert.equal((await settings.json()).ai.apiKeySet, false);
    assert.equal((await fetch(`${base}/api/settings`)).status, 401);
    // На Linux файл 0600 принадлежит root контейнера, runner не может читать его с хоста.
    const stored = docker('exec', name, 'cat', '/data/settings.json');
    assert(!stored.includes(password));
    assert.match(stored, /scrypt/);
    if (first) writeFileSync(join(root, 'expected-settings'), stored);
    else assert.equal(stored, readFileSync(join(root, 'expected-settings'), 'utf8'));
    assert.equal(readFileSync(join(root, 'keys', 'smoke-marker'), 'utf8'), 'Synthetic marker, not an SSH key.');
    docker('rm', '-f', name);
    running = false;
  }
  console.log(`PASS ${image} ${platform}: UI, assets, onboarding without AI, login, recreation, data/keys preserved`);
} finally {
  if (running) docker('rm', '-f', name);
  // root получен только через mkdtemp; пользовательские каталоги сюда не передаются.
  rmSync(root, { recursive: true, force: true });
}
