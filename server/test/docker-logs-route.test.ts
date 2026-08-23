import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FakeClient } from './helpers/fake-ssh2.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'sc-docker-route-'));
process.env.DATA_DIR = dataDir;
writeFileSync(
  path.join(dataDir, 'profiles.json'),
  JSON.stringify({
    profiles: [
      {
        id: 'route-d1',
        name: 'route-docker',
        host: 'h',
        port: 22,
        username: 'u',
        authType: 'password',
        password: 'p',
        dockerCommand: 'docker',
      },
    ],
  }),
);

// Follow docker-логов ходит через streamContainerLogs → execStream →
// ssh2.Client (фейк в helpers/fake-ssh2.ts).
vi.mock('ssh2', () => ({ Client: FakeClient }));

const express = (await import('express')).default;
const { filesRouter } = await import('../src/routes/files.js');
const { dockerRouter } = await import('../src/routes/docker.js');
const { closeProfileConnection } = await import('../src/ssh/manager.js');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: Server;
let dockerBase = '';
let filesBase = '';

beforeAll(async () => {
  const app = express();
  app.use('/api/docker', dockerRouter);
  app.use('/api/files', filesRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dockerBase = `${root}/api/docker`;
  filesBase = `${root}/api/files`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
});

afterEach(async () => {
  for (const client of FakeClient.instances) {
    for (const ch of client.channels) ch.emit('close', null);
  }
  closeProfileConnection('route-d1');
  FakeClient.instances = [];
  await sleep(20);
});

function dockerLogsUrl(stream: boolean): string {
  const params = new URLSearchParams({ profileId: 'route-d1', tail: '200' });
  if (stream) params.set('stream', '1');
  return `${dockerBase}/containers/abc123/logs?${params}`;
}

function tailUrl(): string {
  const params = new URLSearchParams({
    profileId: 'route-d1',
    path: '/var/log/app.log',
    lines: '500',
    follow: '1',
  });
  return `${filesBase}/tail?${params}`;
}

describe('GET /api/docker/containers/:id/logs', () => {
  it('снимок (без stream) — text/plain, слот не занимается', async () => {
    FakeClient.autoCloseNext = true;
    const res = await fetch(dockerLogsUrl(false));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toContain('snapshot line 1');
  });

  it('follow-стрим занимает слот: четвёртый docker-стрим — 429', async () => {
    const held: AbortController[] = [];
    for (let i = 0; i < 3; i++) {
      const controller = new AbortController();
      held.push(controller);
      const res = await fetch(dockerLogsUrl(true), { signal: controller.signal });
      expect(res.status).toBe(200);
    }
    const rejected = await fetch(dockerLogsUrl(true));
    expect(rejected.status).toBe(429);
    expect(((await rejected.json()) as { error: string }).error).toContain('Слишком много');
    for (const c of held) c.abort();
  });

  it('лимит общий с tail: 2 docker + 1 tail, четвёртый (tail) — 429', async () => {
    const held: AbortController[] = [];
    for (let i = 0; i < 2; i++) {
      const controller = new AbortController();
      held.push(controller);
      const res = await fetch(dockerLogsUrl(true), { signal: controller.signal });
      expect(res.status).toBe(200);
    }
    const tailController = new AbortController();
    held.push(tailController);
    const tail = await fetch(tailUrl(), { signal: tailController.signal });
    expect(tail.status).toBe(200);
    // Слоты исчерпаны суммарно — отказ получает и tail, и docker-follow.
    const tailRejected = await fetch(tailUrl());
    expect(tailRejected.status).toBe(429);
    const dockerRejected = await fetch(dockerLogsUrl(true));
    expect(dockerRejected.status).toBe(429);
    for (const c of held) c.abort();
  });

  it('req close снимает слот: после обрыва docker-стрима доступен снова', async () => {
    const controller = new AbortController();
    const first = await fetch(dockerLogsUrl(true), { signal: controller.signal });
    expect(first.status).toBe(200);
    controller.abort();
    await sleep(30);
    const second = await fetch(dockerLogsUrl(true));
    expect(second.status).toBe(200);
    const reader = second.body!.getReader();
    await reader.cancel();
  });
});
