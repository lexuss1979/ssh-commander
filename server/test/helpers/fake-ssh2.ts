/**
 * Общий фейк ssh2 для интеграционных тестов маршрутов (vitest + vi.mock).
 * Тестовый файл делает `vi.mock('ssh2', () => ({ Client: FakeClient }))` —
 * фабрика ленивая, маршруты импортируются динамически после неё, так что
 * классы успевают инициализироваться (в отличие от vi.hoisted, результат
 * которого нельзя экспортировать из модуля).
 *
 * connect → async ready; exec → канал (follow держим открытым, снимок
 * авто-кормится данными и close через FakeClient.autoCloseNext); sftp →
 * stat обычного файла + readStream с текстом без NUL (precheck проходит).
 *
 * FakeChannel.close() НЕ эмитит 'close' — настоящий ssh2 не переэмитит
 * событие из close() (иначе exec() перезаписывает exit code после finish());
 * тесты эмитят 'close' явно, когда нужно.
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
  /** Следующий созданный клиент отдаст exec-каналу данные и close (снимок). */
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
