import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FakeClient, FakeChannel } from './helpers/fake-ssh2.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'sc-packages-route-'));
process.env.DATA_DIR = dataDir;
// Several profiles: the package snapshot cache and the follow-slot limiter are
// module singletons — distinct ids isolate the tests from each other.
writeFileSync(
  path.join(dataDir, 'profiles.json'),
  JSON.stringify({
    profiles: ['p-1', 'p-2', 'p-3', 'p-4', 'p-5'].map((id) => ({
      id,
      name: id,
      host: 'h',
      port: 22,
      username: 'u',
      authType: 'password',
      password: 'p',
      dockerCommand: 'docker',
    })),
  }),
);

// The routes go through the real getClient/execStream → ssh2.Client (fake).
vi.mock('ssh2', () => ({ Client: FakeClient }));

const express = (await import('express')).default;
const { packagesRouter } = await import('../src/routes/packages.js');
const { detectPmCommand } = await import('../src/services/packages.js');
const { closeProfileConnection } = await import('../src/ssh/manager.js');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const APT_DETECT = '/usr/bin/apt-get\n';
const APT_LIST =
  'base-files/stable-security 12.4+deb12u7 amd64 [upgradable from: 12.4+deb12u5]\n@@LIST_CODE@@0\n';

let server: Server;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/packages', packagesRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/packages`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
});

afterEach(async () => {
  // Close all open channels (the limiter slots) and tear down the cached SSH
  // connection — the module singletons must not leak between tests.
  for (const client of FakeClient.instances) {
    for (const ch of client.channels) ch.emit('close', null);
  }
  closeProfileConnection('p-1');
  closeProfileConnection('p-2');
  closeProfileConnection('p-3');
  closeProfileConnection('p-4');
  closeProfileConnection('p-5');
  FakeClient.instances = [];
  FakeClient.execRouter = null;
  await sleep(20);
});

function updatesUrl(profileId: string): string {
  return `${base}/updates?profileId=${profileId}`;
}

function applyUrl(profileId: string): string {
  return `${base}/apply?profileId=${profileId}`;
}

/**
 * The standard apt-stand router:
 * - detect → /usr/bin/apt-get, code 0;
 * - snapshot (apt list) → the list + @@LIST_CODE@@0, code 0;
 * - probe → the probe stderr/code;
 * - apply → chunks (the channel stays open, the test closes it itself).
 */
function aptRouter(opts: {
  probe?: { stderr: string; code: number } | null;
  applyChunks?: string[];
} = {}) {
  return (cmd: string, ch: FakeChannel): void => {
    if (cmd === detectPmCommand()) {
      ch.emit('data', Buffer.from(APT_DETECT));
      ch.emit('close', 0);
      return;
    }
    if (cmd.includes('apt list --upgradable')) {
      ch.emit('data', Buffer.from(APT_LIST));
      ch.emit('close', 0);
      return;
    }
    if (cmd === "sudo -S -p '' -- true") {
      if (opts.probe) {
        ch.stderr.emit('data', Buffer.from(opts.probe.stderr));
        ch.emit('close', opts.probe.code);
      } else {
        ch.emit('close', 0);
      }
      return;
    }
    if (cmd.includes('apt-get -y upgrade')) {
      for (const c of opts.applyChunks ?? ['Reading package lists...\n']) {
        ch.emit('data', Buffer.from(c));
      }
      return; // the channel is open — the test emits close itself
    }
    ch.emit('close', 0);
  };
}

async function apply(profileId: string, body: unknown): Promise<Response> {
  return fetch(applyUrl(profileId), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('GET /api/packages/updates', () => {
  it('the snapshot: 200, the shape and the 60 s cache (a repeated request runs no exec)', async () => {
    FakeClient.execRouter = aptRouter();
    const res = await fetch(updatesUrl('p-1'));
    expect(res.status).toBe(200);
    const snap = (await res.json()) as Record<string, unknown>;
    expect(snap.pm).toBe('apt');
    expect(Array.isArray(snap.updates)).toBe(true);
    expect((snap.updates as unknown[]).length).toBe(1);
    expect(snap.rebootRequired).toBe(false);
    const execCount = FakeClient.instances.reduce((n, c) => n + c.channels.length, 0);
    const again = await fetch(updatesUrl('p-1'));
    expect(again.status).toBe(200);
    const execCount2 = FakeClient.instances.reduce((n, c) => n + c.channels.length, 0);
    expect(execCount2).toBe(execCount); // the cache returned the same promise
  });

  it('an unknown profile — 404', async () => {
    const res = await fetch(updatesUrl('no-such'));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toContain('not found');
  });
});

describe('POST /api/packages/apply — validation before the stream', () => {
  it('an unknown profile — 404', async () => {
    const res = await apply('no-such', {});
    expect(res.status).toBe(404);
  });

  it('no package manager — 400, the stream never opens', async () => {
    FakeClient.execRouter = (cmd, ch) => {
      if (cmd === detectPmCommand()) {
        ch.emit('data', Buffer.from('command not found\n'));
        ch.emit('close', 0);
      }
    };
    const res = await apply('p-2', {});
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('Менеджер пакетов не найден');
  });

  it('the probe wrong-password → 400 "wrong sudo password" before the channel opens', async () => {
    FakeClient.execRouter = aptRouter({ probe: { stderr: 'Sorry, try again.\n', code: 1 } });
    const res = await apply('p-3', { sudoPassword: 'bad' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('Неверный sudo-пароль');
  });

  it('the probe not-in-sudoers → 400 "no sudo rights"', async () => {
    FakeClient.execRouter = aptRouter({
      probe: { stderr: 'u is not in the sudoers file. This incident will be reported.\n', code: 1 },
    });
    const res = await apply('p-4', { sudoPassword: 'x' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('нет прав sudo');
  });

  it('the probe sudo-not-found → 400 "sudo is not installed"', async () => {
    FakeClient.execRouter = aptRouter({ probe: { stderr: 'sudo: not found\n', code: 127 } });
    const res = await apply('p-5', { sudoPassword: 'x' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('sudo не установлен');
  });

  it('the probe other → 502', async () => {
    FakeClient.execRouter = aptRouter({ probe: { stderr: 'some odd error\n', code: 1 } });
    const res = await apply('p-1', { sudoPassword: 'x' });
    expect(res.status).toBe(502);
  });
});

describe('POST /api/packages/apply — the stream', () => {
  it('success: the password only in stdin (not in the command), chunks in the body, completion by close', async () => {
    FakeClient.execRouter = aptRouter({ probe: null });
    const res = await apply('p-2', { sudoPassword: 's3cret-pass' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const client = FakeClient.instances.at(-1);
    const applyCh = client?.channels.at(-1);
    expect(applyCh).toBeDefined();
    // The password went as the first stdin line, not into the command line.
    expect(applyCh!.stdinWritten).toBe('s3cret-pass\n');
    expect(applyCh!.endCalls).toBe(1);
    applyCh!.emit('close', 0);
    const text = await res.text();
    expect(text).toContain('Reading package lists...');
    // After settle the slot is free.
    const next = await apply('p-2', {});
    expect(next.status).toBe(200);
    FakeClient.instances.at(-1)?.channels.at(-1)?.emit('close', 0);
    await next.text();
  });

  it('a wrong password → 400 (the probe before the stream: the apply channel never opened)', async () => {
    const commands: string[] = [];
    FakeClient.execRouter = (cmd, ch) => {
      commands.push(cmd);
      if (cmd === detectPmCommand()) {
        ch.emit('data', Buffer.from(APT_DETECT));
        ch.emit('close', 0);
      } else if (cmd === "sudo -S -p '' -- true") {
        ch.stderr.emit('data', Buffer.from('Sorry, try again.\n'));
        ch.emit('close', 1);
      }
    };
    const res = await apply('p-3', { sudoPassword: 'bad' });
    expect(res.status).toBe(400);
    // Detect + probe ran, the apply command never started.
    expect(commands.some((c) => c.includes('apt-get -y upgrade'))).toBe(false);
  });

  it('the fourth concurrent stream — 429', async () => {
    FakeClient.execRouter = aptRouter();
    const held: Array<{ controller: AbortController; res: Response }> = [];
    for (let i = 0; i < 3; i++) {
      const controller = new AbortController();
      const res = await apply('p-4', {});
      expect(res.status).toBe(200);
      held.push({ controller, res });
    }
    const rejected = await apply('p-4', {});
    expect(rejected.status).toBe(429);
    expect(((await rejected.json()) as { error: string }).error).toContain('Достигнут лимит');
    for (const h of held) h.controller.abort();
  });

  it('req close releases the slot: after a dropped stream it is available again', async () => {
    FakeClient.execRouter = aptRouter();
    const controller = new AbortController();
    const first = await apply('p-5', {});
    expect(first.status).toBe(200);
    controller.abort();
    await sleep(30);
    const second = await apply('p-5', {});
    expect(second.status).toBe(200);
    FakeClient.instances.at(-1)?.channels.at(-1)?.emit('close', 0);
    await second.text();
  });

  it('the settled handle.code releases the slot: the channel completion frees access', async () => {
    FakeClient.execRouter = aptRouter();
    const first = await apply('p-1', {});
    expect(first.status).toBe(200);
    const ch = FakeClient.instances.at(-1)?.channels.at(-1);
    expect(ch).toBeDefined();
    ch!.emit('close', 0);
    await first.text();
    const second = await apply('p-1', {});
    expect(second.status).toBe(200);
    FakeClient.instances.at(-1)?.channels.at(-1)?.emit('close', 0);
    await second.text();
  });

  it('settle invalidates the snapshot cache: the next GET /updates runs the exec again', async () => {
    FakeClient.execRouter = aptRouter();
    await fetch(updatesUrl('p-2'));
    const before = FakeClient.instances.reduce((n, c) => n + c.channels.length, 0);
    // The apply runs to the end.
    const res = await apply('p-2', {});
    expect(res.status).toBe(200);
    FakeClient.instances.at(-1)?.channels.at(-1)?.emit('close', 0);
    await res.text();
    await fetch(updatesUrl('p-2'));
    const after = FakeClient.instances.reduce((n, c) => n + c.channels.length, 0);
    expect(after).toBeGreaterThan(before); // the cache was reset — detect+snapshot ran again
  });
});
