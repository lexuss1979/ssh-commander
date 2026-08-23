import { describe, expect, it, vi } from 'vitest';
import { execStream } from '../src/ssh/manager.js';
import type { Profile } from '../src/types.js';

// vi.hoisted исполняется до инициализации импортов, поэтому EventEmitter из
// node:events тут недоступен — минимальный эмиттер определён inline. Это же
// решает hoisting vi.mock: классы живут в hoisted-блоке, фабрика мока их видит.
const mock = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void;
  class FakeEmitter {
    private handlers = new Map<string, Handler[]>();
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
    close(): void {
      this.closeCalls++;
      this.emit('close', null);
    }
  }
  class FakeClient extends FakeEmitter {
    static instances: FakeClient[] = [];
    static failConnectNext = false;
    static failExecNext = false;
    failConnect: boolean;
    failExec: boolean;
    channels: FakeChannel[] = [];
    constructor() {
      super();
      this.failConnect = FakeClient.failConnectNext;
      this.failExec = FakeClient.failExecNext;
      FakeClient.failConnectNext = false;
      FakeClient.failExecNext = false;
      FakeClient.instances.push(this);
    }
    connect(): void {
      if (this.failConnect) {
        queueMicrotask(() => this.emit('error', new Error('connection refused')));
        return;
      }
      queueMicrotask(() => this.emit('ready'));
    }
    exec(_cmd: string, cb: (err: Error | null, ch: FakeChannel | null) => void): void {
      if (this.failExec) {
        queueMicrotask(() => cb(new Error('exec failed'), null));
        return;
      }
      const ch = new FakeChannel();
      this.channels.push(ch);
      queueMicrotask(() => cb(null, ch));
    }
    end(): void {
      /* noop */
    }
  }
  return { FakeClient };
});

vi.mock('ssh2', () => ({ Client: mock.FakeClient }));

function profile(id: string): Profile {
  return { id, name: id, host: 'h', port: 22, username: 'u', authType: 'password', password: 'p', dockerCommand: 'docker' };
}

describe('execStream', () => {
  it('code не резолвится до закрытия канала — заглушка не срабатывает раньше времени', async () => {
    const handle = execStream(profile('exec-stream-race'), 'tail -F /var/log/x', () => {});
    let settled = false;
    void handle.code.then(() => {
      settled = true;
    });
    // Прогреваем микротаски/таймеры: connect(ready) и exec(cb) уже отработали,
    // канал открыт. Промис обязан ждать настоящего close.
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    const client = mock.FakeClient.instances.at(-1);
    const ch = client?.channels.at(-1);
    expect(ch).toBeDefined();
    ch!.emit('close', 0);
    await expect(handle.code).resolves.toBe(0);
  });

  it('ошибка client.exec резолвит code в null', async () => {
    mock.FakeClient.failExecNext = true;
    const handle = execStream(profile('exec-stream-exec-err'), 'cmd', () => {});
    await expect(handle.code).resolves.toBe(null);
  });

  it('отказ getClient (SSH не подключился) резолвит code в null, промис не висит', async () => {
    mock.FakeClient.failConnectNext = true;
    const handle = execStream(profile('exec-stream-connect-err'), 'cmd', () => {});
    await expect(handle.code).resolves.toBe(null);
  });
});
