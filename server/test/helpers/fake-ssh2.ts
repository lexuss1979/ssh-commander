/**
 * The shared ssh2 fake for the route integration tests (vitest + vi.mock).
 * A test file does `vi.mock('ssh2', () => ({ Client: FakeClient }))` —
 * the factory is lazy, the routes are imported dynamically after it, so the
 * classes have time to initialize (unlike vi.hoisted, whose result cannot be
 * exported from a module).
 *
 * connect → async ready; exec → a channel (follow is kept open, a snapshot
 * auto-feeds data and close via FakeClient.autoCloseNext); sftp → the stat of
 * a regular file + a readStream with NUL-free text (the precheck passes).
 *
 * FakeChannel.close() does NOT emit 'close' — real ssh2 does not re-emit the
 * event from close() (otherwise exec() overwrites the exit code after finish());
 * the tests emit 'close' explicitly when needed.
 */
class FakeEmitter {
  handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  on(ev: string, fn: (...args: unknown[]) => void): this {
    const list = this.handlers.get(ev) ?? [];
    list.push(fn);
    this.handlers.set(ev, list);
    return this;
  }
  once(ev: string, fn: (...args: unknown[]) => void): this {
    const wrapped = (...args: unknown[]) => {
      this.off(ev, wrapped);
      fn(...args);
    };
    return this.on(ev, wrapped);
  }
  off(ev: string, fn: (...args: unknown[]) => void): this {
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

export class FakeChannel extends FakeEmitter {
  stderr = new FakeEmitter();
  closeCalls = 0;
  /** The stdin written into the channel (for the "password only in stdin" checks). */
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

export class FakeClient extends FakeEmitter {
  static instances: FakeClient[] = [];
  /** The next created client feeds the exec channel data and close (a snapshot). */
  static autoCloseNext = false;
  /** All new clients feed the exec channel data and close (for multi-profile tests). */
  static autoCloseAll = false;
  /**
   * The exec command router (for route tests that need a different answer per
   * command: the manager detect, the sudo probe, a snapshot, apply).
   * When set, it is called instead of the auto-snapshot; the test emits
   * data/close itself. Reset in afterEach.
   */
  static execRouter: ((cmd: string, ch: FakeChannel) => void) | null = null;
  channels: FakeChannel[] = [];
  autoClose: boolean;
  constructor() {
    super();
    this.autoClose = FakeClient.autoCloseNext || FakeClient.autoCloseAll;
    FakeClient.autoCloseNext = false;
    FakeClient.instances.push(this);
  }
  connect(): void {
    queueMicrotask(() => this.emit('ready'));
  }
  sftp(cb: (err: null, sftp: FakeSftp) => void): void {
    queueMicrotask(() => cb(null, new FakeSftp()));
  }
  exec(cmd: string, cb: (err: null, ch: FakeChannel) => void): void {
    const ch = new FakeChannel();
    this.channels.push(ch);
    queueMicrotask(() => {
      cb(null, ch);
      const router = FakeClient.execRouter;
      if (router) {
        router(cmd, ch);
        return;
      }
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
