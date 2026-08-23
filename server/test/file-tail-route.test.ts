import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

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

// Маршрут ходит через реальный getClient/execStream/withSftp → ssh2.Client.
// Подменяем Client фейковым: connect → async ready; exec → канал (follow
// держим открытым, снимок авто-кормится данными и close); sftp → stat
// обычного файла + readStream с текстом без NUL (precheck проходит).
const mock = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void;
  class FakeEmitter {
    handlers = new Map<string, Handler[]>();
    on(ev: string, fn: Handler): this {
      const list = this.handlers.get(ev) ?? [];
      list.push(fn);
      this.handlers.set(ev, list);
      return this;
    }
    once(ev: string, fn: Handler): this {
      const wrapped: Handler = (...args: unknown[]) => {
        this.off(ev, wrapped);
        fn(...args);
      };
      return this.on(ev, wrapped);
    }
    off(ev: string, fn: Handler): this {
      const list = this.handlers.get(ev);
      if (list) this.handlers.set(ev, list.filter((f) => f !== fn));
      return this;
    }
    emit(ev: string, ...args: unknown[]): boolean {
      const list = [...(this.handlers.get(ev) ?? [])];
      for (const fn of list) fn(...args);
      return list.length > 0;
    }
  }
  class FakeChannel extends FakeEmitter {
    stderr = new FakeEmitter();
    closeCalls = 0;
    // Настоящий ssh2 НЕ переэмитит 'close' из close(): событие приходит от
    // сервера. Переэмит в фейке заставлял exec() перезаписать exit code
    // после finish(). Тесты эмитят 'close' явно, когда это нужно.
    close(): void {
      this.closeCalls++;
    }
  }
  class FakeReadStream extends FakeEmitter {}
  class FakeSftp {
    stat(_p: string, cb: (err: null, stats: { mode: number; size: number }) => void): void {
      queueMicrotask(() => cb(null, { mode: 0o100644, size: 100 }));
    }
    createReadStream(_p: string, _opts: { start: number; end: number }): FakeReadStream {
      const s = new FakeReadStream();
      queueMicrotask(() => {
        s.emit('data', Buffer.from('plain text head'));
        s.emit('close');
      });
      return s;
    }
  }
  class FakeClient extends FakeEmitter {
    static instances: FakeClient[] = [];
    static autoCloseNext = false;
    channels: FakeChannel[] = [];
    autoClose: boolean;
    constructor() {
      super();
      this.autoClose = FakeClient.autoCloseNext;
      FakeClient.autoCloseNext = false;
      FakeClient.instances.push(this);
    }
    connect(): void {
      queueMicrotask(() => this.emit('ready'));
    }
    sftp(cb: (err: null, sftp: FakeSftp) => void): void {
      queueMicrotask(() => cb(null, new FakeSftp()));
    }
    exec(_cmd: string, cb: (err: null, ch: FakeChannel) => void): void {
      const ch = new FakeChannel();
      this.channels.push(ch);
      queueMicrotask(() => {
        cb(null, ch);
        if (this.autoClose) {
          queueMicrotask(() => {
            ch.emit('data', Buffer.from('snapshot line 1\nsnapshot line 2'));
            ch.emit('close', 0);
          });
        }
      });
    }
    end(): void {
      /* noop */
    }
  }
  return { FakeClient };
});

vi.mock('ssh2', () => ({ Client: mock.FakeClient }));

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
  for (const client of mock.FakeClient.instances) {
    for (const ch of client.channels) ch.emit('close', null);
  }
  closeProfileConnection('route-p1');
  mock.FakeClient.instances = [];
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
    mock.FakeClient.autoCloseNext = true;
    const res = await fetch(tailUrl(0));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toBe('snapshot line 1\nsnapshot line 2');
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
    expect(((await rejected.json()) as { error: string }).error).toContain('Слишком много');
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
    const client = mock.FakeClient.instances.at(-1);
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
