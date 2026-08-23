import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FakeClient } from './helpers/fake-ssh2.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'sc-tail-route-'));
process.env.DATA_DIR = dataDir;
writeFileSync(
  path.join(dataDir, 'profiles.json'),
  JSON.stringify({
    profiles: [
      {
        id: 'route-p1',
        name: 'route',
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

// Маршрут ходит через реальный getClient/execStream/withSftp → ssh2.Client
// (фейк в helpers/fake-ssh2.ts).
vi.mock('ssh2', () => ({ Client: FakeClient }));

const express = (await import('express')).default;
const { filesRouter } = await import('../src/routes/files.js');
const { closeProfileConnection } = await import('../src/ssh/manager.js');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: Server;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use('/api/files', filesRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/files`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
});

afterEach(async () => {
  // Закрываем все открытые follow-каналы и рвём кэшированное SSH-соединение:
  // слоты лимитера и соединение менеджера — модульные синглтоны и не должны
  // протекать между тестами (иначе instances.at(-1) указывает на удалённый
  // кэшем клиент).
  for (const client of FakeClient.instances) {
    for (const ch of client.channels) ch.emit('close', null);
  }
  closeProfileConnection('route-p1');
  FakeClient.instances = [];
  await sleep(20);
});

function tailUrl(follow: 0 | 1): string {
  const params = new URLSearchParams({
    profileId: 'route-p1',
    path: '/var/log/app.log',
    lines: '500',
    follow: String(follow),
  });
  return `${base}/tail?${params}`;
}

describe('GET /api/files/tail', () => {
  it('follow=0: разовый снимок text/plain, слот не занимается', async () => {
    FakeClient.autoCloseNext = true;
    const res = await fetch(tailUrl(0));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toBe('snapshot line 1\nsnapshot line 2');
    // Слот действительно не занят: три follow-стрима после снимка проходят.
    const held: AbortController[] = [];
    for (let i = 0; i < 3; i++) {
      const controller = new AbortController();
      held.push(controller);
      const followRes = await fetch(tailUrl(1), { signal: controller.signal });
      expect(followRes.status).toBe(200);
    }
    for (const c of held) c.abort();
  });

  it('follow=1 занимает слот: четвёртый стрим — 429', async () => {
    const held: Array<{ controller: AbortController; res: Response }> = [];
    for (let i = 0; i < 3; i++) {
      const controller = new AbortController();
      const res = await fetch(tailUrl(1), { signal: controller.signal });
      expect(res.status).toBe(200);
      held.push({ controller, res });
    }
    const rejected = await fetch(tailUrl(1));
    expect(rejected.status).toBe(429);
    expect(((await rejected.json()) as { error: string }).error).toContain('Достигнут лимит');
    for (const h of held) h.controller.abort();
  });

  it('req close снимает слот: после обрыва стрима доступен снова', async () => {
    const controller = new AbortController();
    const first = await fetch(tailUrl(1), { signal: controller.signal });
    expect(first.status).toBe(200);
    controller.abort();
    await sleep(30);
    const second = await fetch(tailUrl(1));
    expect(second.status).toBe(200);
    const reader = second.body!.getReader();
    await reader.cancel();
  });

  it('settle handle.code снимает слот: завершение канала освобождает доступ', async () => {
    const res = await fetch(tailUrl(1));
    expect(res.status).toBe(200);
    // Канал tail -F открыт; эмулируем его завершение (SSH-обрыв).
    const client = FakeClient.instances.at(-1);
    const ch = client?.channels.at(-1);
    expect(ch).toBeDefined();
    ch!.emit('close', null);
    // Ответ завершается — читаем до done.
    const text = await res.text();
    expect(text).toBe('');
    const next = await fetch(tailUrl(1));
    expect(next.status).toBe(200);
    const reader = next.body!.getReader();
    await reader.cancel();
  });

  it('несуществующий профиль — JSON-ошибка до открытия канала', async () => {
    const params = new URLSearchParams({ profileId: 'no-such', path: '/a.log', follow: '0' });
    const res = await fetch(`${base}/tail?${params}`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('not found');
  });
});
