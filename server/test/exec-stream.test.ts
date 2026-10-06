import { describe, expect, it, vi } from 'vitest';
import { execStream } from '../src/ssh/manager.js';
import type { Profile } from '../src/types.js';

// vi.hoisted runs before the imports are initialized, so the EventEmitter from
// node:events is unavailable here — a minimal emitter is defined inline. This
// also solves the vi.mock hoisting: the classes live in the hoisted block, the
// mock factory sees them.
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
    stdinWritten = '';
    endCalls = 0;
    write(data: string | Buffer): void {
      this.stdinWritten += data.toString();
    }
    end(): void {
      this.endCalls++;
    }
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
  it('code does not resolve until the channel closes — the stub does not fire early', async () => {
    const handle = execStream(profile('exec-stream-race'), 'tail -F /var/log/x', () => {});
    let settled = false;
    void handle.code.then(() => {
      settled = true;
    });
    // Warm up the microtasks/timers: connect(ready) and exec(cb) already ran,
    // the channel is open. The promise must wait for a real close.
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    const client = mock.FakeClient.instances.at(-1);
    const ch = client?.channels.at(-1);
    expect(ch).toBeDefined();
    ch!.emit('close', 0);
    await expect(handle.code).resolves.toBe(0);
  });

  it('a client.exec error resolves code to null', async () => {
    mock.FakeClient.failExecNext = true;
    const handle = execStream(profile('exec-stream-exec-err'), 'cmd', () => {});
    await expect(handle.code).resolves.toBe(null);
  });

  it('a getClient failure (SSH did not connect) resolves code to null, the promise does not hang', async () => {
    mock.FakeClient.failConnectNext = true;
    const handle = execStream(profile('exec-stream-connect-err'), 'cmd', () => {});
    await expect(handle.code).resolves.toBe(null);
  });

  it('does not cut multi-byte UTF-8 at chunk boundaries (StringDecoder)', async () => {
    const chunks: string[] = [];
    execStream(profile('exec-stream-utf8'), 'cmd', (c) => chunks.push(c));
    await new Promise((r) => setTimeout(r, 20));
    const ch = mock.FakeClient.instances.at(-1)?.channels.at(-1);
    expect(ch).toBeDefined();
    // Byte-by-byte delivery: every byte is a separate chunk, the worst case.
    const bytes = Buffer.from('привет é🌲');
    for (const b of bytes) ch!.emit('data', Buffer.from([b]));
    expect(chunks.join('')).toBe('привет é🌲');
    ch!.emit('close', 0);
  });

  it('the optional stdin is written into the channel and closed with EOF (the sudo -S password)', async () => {
    const chunks: string[] = [];
    const handle = execStream(profile('exec-stream-stdin'), 'sudo -S -p \'\' -- true', (c) => chunks.push(c), {
      stdin: 's3cret\n',
    });
    await new Promise((r) => setTimeout(r, 20));
    const ch = mock.FakeClient.instances.at(-1)?.channels.at(-1);
    expect(ch).toBeDefined();
    expect(ch!.stdinWritten).toBe('s3cret\n');
    expect(ch!.endCalls).toBe(1);
    // stdout chunks after the stdin keep arriving as before.
    ch!.emit('data', Buffer.from('done\n'));
    expect(chunks.join('')).toBe('done\n');
    ch!.emit('close', 0);
    await expect(handle.code).resolves.toBe(0);
  });

  it('without stdin the channel is untouched (backward compatibility)', async () => {
    execStream(profile('exec-stream-no-stdin'), 'cmd', () => {});
    await new Promise((r) => setTimeout(r, 20));
    const ch = mock.FakeClient.instances.at(-1)?.channels.at(-1);
    expect(ch!.stdinWritten).toBe('');
    expect(ch!.endCalls).toBe(0);
    ch!.emit('close', 0);
  });
});
