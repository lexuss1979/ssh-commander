import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import WebSocket from 'ws';
import { isAllowedOrigin, isAllowedApiSource, readOriginPolicy } from '../src/util/origin.js';

const origin = 'https://commander.home.arpa';
const policy = readOriginPolicy({ APP_ACCESS_MODE: 'proxy', APP_TRUSTED_ORIGINS: origin });
it('fails closed on invalid configuration and untrusted origins', () => {
  for (const mode of ['typo', 'proxy']) expect(() => readOriginPolicy({ APP_ACCESS_MODE: mode })).toThrow();
  for (const value of ['http://lan', 'https://lan/', 'https://*.lan', 'https://user@lan', `${origin},`]) {
    expect(() => readOriginPolicy({ APP_ACCESS_MODE: 'proxy', APP_TRUSTED_ORIGINS: value })).toThrow();
  }
  expect(isAllowedOrigin(origin, policy)).toBe(true);
  expect(isAllowedApiSource('GET', undefined, `${origin}/`, policy)).toBe(true);
  expect(isAllowedApiSource('GET', 'https://evil.example', `${origin}/`, policy)).toBe(false);
  expect(isAllowedApiSource('POST', undefined, `${origin}/`, policy)).toBe(false);
  for (const value of [undefined, '', 'null', `${origin}:8443`, `${origin}.evil`, `${origin}/`, 'http://localhost']) {
    expect(isAllowedOrigin(value, policy)).toBe(false);
  }
  for (const value of ['file://localhost', 'ftp://localhost', 'http://localhost/path', 'http://0.0.0.0']) {
    expect(isAllowedOrigin(value)).toBe(false);
  }
});

// Run the actual production entry point, including both WS handlers.
const dir = mkdtempSync(path.join(tmpdir(), 'sc-network-'));
let child: ChildProcess;
let base: string;
let cookie: string;
beforeAll(async () => {
  const reservation = net.createServer();
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = (reservation.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: { ...process.env, APP_PORT: String(port), APP_HOST: '127.0.0.1', DATA_DIR: dir,
      KEYS_DIR: path.join(dir, 'keys'), APP_ACCESS_MODE: 'proxy', APP_TRUSTED_ORIGINS: origin,
      APP_PASSWORD: 'network-test-password', AI_API_KEY: '' }, stdio: 'pipe',
  });
  await new Promise<void>((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(output || 'Startup timed out')), 15000);
    child.stdout!.on('data', chunk => {
      output += chunk;
      if (output.includes('listening on')) { clearTimeout(timeout); resolve(); }
    });
    child.stderr!.on('data', chunk => { output += chunk; });
    child.once('exit', () => { clearTimeout(timeout); reject(new Error(output)); });
  });
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'network-test-password' }),
  });
  expect(login.status).toBe(200);
  const header = login.headers.get('set-cookie')!;
  for (const flag of ['Secure', 'HttpOnly', 'SameSite=Lax']) expect(header).toContain(flag);
  cookie = header.split(';')[0];
}, 20000);
afterAll(async () => {
  if (child && child.exitCode === null) {
    const stopped = new Promise<void>(resolve => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    await stopped;
  }
  rmSync(dir, { recursive: true, force: true });
});
it('allows REST only with trusted Origin and a valid session; setup remains closed', async () => {
  expect((await fetch(`${base}/api/profiles`, { headers: { origin, cookie } })).status).toBe(200);
  expect((await fetch(`${base}/api/profiles`, { headers: { origin } })).status).toBe(401);
  expect((await fetch(`${base}/api/profiles`, { headers: { referer: `${origin}/`, cookie } })).status).toBe(200);
  expect((await fetch(`${base}/api/profiles`, { headers: { referer: 'https://evil.example/', cookie } })).status).toBe(403);
  expect((await fetch(`${base}/api/setup`, { method: 'POST', headers: { origin } })).status).toBe(409);
  expect((await fetch(`${base}/api/health`)).status).toBe(200);
  for (const value of ['', 'null', 'https://evil.example', `${origin}:8443`]) {
    const headers: Record<string, string> = { cookie, 'x-forwarded-for': '127.0.0.1',
      'x-forwarded-host': 'commander.home.arpa', 'x-forwarded-proto': 'https',
      forwarded: 'for=127.0.0.1;host=commander.home.arpa;proto=https' };
    if (value) headers.origin = value;
    expect((await fetch(`${base}/api/profiles`, { headers })).status).toBe(403);
  }
});
function handshake(route: string, value?: string, authenticated = true): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace('http:', 'ws:')}${route}`, {
      headers: { ...(value === undefined ? {} : { origin: value }),
        ...(authenticated ? { cookie } : {}), 'x-forwarded-for': '127.0.0.1',
        'x-forwarded-host': 'commander.home.arpa', 'x-forwarded-proto': 'https' },
    });
    ws.on('open', () => { ws.close(); resolve(101); });
    ws.on('unexpected-response', (_req, response) => {
      response.resume(); ws.terminate(); resolve(response.statusCode!);
    });
    ws.on('error', reject);
  });
}
it('gates terminal and agent WS upgrades with Origin and session, ignoring proxy headers', async () => {
  for (const route of ['/ws/terminal', '/ws/agent']) {
    // No profile: upgrade succeeds then the existing handler closes with 1008.
    expect(await handshake(route, origin)).toBe(101);
    expect(await handshake(route, origin, false)).toBe(401);
    for (const value of [undefined, 'null', 'https://evil.example', `${origin}:8443`]) {
      expect(await handshake(route, value)).toBe(403);
    }
  }
});

it('refuses network startup before a password has been configured', async () => {
  const emptyDir = mkdtempSync(path.join(tmpdir(), 'sc-no-password-'));
  try {
    const result = await new Promise<{ code: number | null; output: string }>((resolve) => {
      const processUnderTest = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
        env: { ...process.env, APP_HOST: '127.0.0.1', DATA_DIR: emptyDir,
          KEYS_DIR: path.join(emptyDir, 'keys'), APP_ACCESS_MODE: 'proxy',
          APP_TRUSTED_ORIGINS: origin, APP_PASSWORD: '', AI_API_KEY: '' }, stdio: 'pipe',
      });
      let output = '';
      processUnderTest.stderr!.on('data', chunk => { output += chunk; });
      processUnderTest.once('exit', code => resolve({ code, output }));
    });
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('requires an existing app password');
  } finally { rmSync(emptyDir, { recursive: true, force: true }); }
});
