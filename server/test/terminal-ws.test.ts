import { describe, expect, it, vi } from 'vitest';
import type { Profile } from '../src/types.js';
import {
  MAX_TERMINAL_SESSIONS_PER_PROFILE,
  attachTerminal,
  listTerminalSessions,
  parseTabId,
  sessionKey,
} from '../src/ws/terminal.js';

// Реестр shells, созданных моком openShell: тестам нужен доступ к каналу
// (эмит 'close' = выход из shell). vi.hoisted — фабрика vi.mock поднимается
// выше обычных объявлений и не может замыкаться на внешние переменные.
const h = vi.hoisted(() => {
  interface Handler {
    (...args: unknown[]): void;
  }
  function makeChannel() {
    const listeners = new Map<string, Handler[]>();
    return {
      on(event: string, fn: Handler) {
        const list = listeners.get(event) ?? [];
        list.push(fn);
        listeners.set(event, list);
      },
      emit(event: string) {
        for (const fn of [...(listeners.get(event) ?? [])]) fn();
      },
    };
  }
  const shells: Array<{ channel: ReturnType<typeof makeChannel> }> = [];
  return { makeChannel, shells };
});

vi.mock('../src/ssh/manager.js', () => ({
  openShell: vi.fn(async () => {
    const shell = {
      channel: h.makeChannel(),
      write: () => {},
      resize: () => {},
      destroy: () => {},
    };
    h.shells.push(shell);
    return shell;
  }),
  closeProfileConnection: vi.fn(),
}));

type SentFrame = { type: string; data?: string };

/** Фейковый WebSocket: пишет sent/close-вызовы, раздаёт события. */
class FakeWs {
  // broadcast в ws/terminal.ts сверяет readyState со статикой ws.OPEN,
  // доступной и через инстанс, — фейк повторяет это свойство.
  readonly OPEN = 1;
  readyState = 1;
  sent: SentFrame[] = [];
  closes: Array<{ code?: number; reason?: string }> = [];
  private listeners = new Map<string, Array<(arg?: string) => void>>();

  send(data: string): void {
    this.sent.push(JSON.parse(data) as SentFrame);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3; // CLOSED
    this.closes.push({ code, reason });
    this.emit('close');
  }

  on(event: string, fn: (arg?: string) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(fn);
    this.listeners.set(event, list);
  }

  emit(event: string): void {
    for (const fn of [...(this.listeners.get(event) ?? [])]) fn();
  }

  /** Клиентский фрейм (как term.onData / кнопки тулбара). */
  message(msg: unknown): void {
    for (const fn of this.listeners.get('message') ?? []) fn(JSON.stringify(msg));
  }

  sentTypes(): string[] {
    return this.sent.map((f) => f.type);
  }
}

function makeProfile(id: string): Profile {
  return { id, name: id, host: 'h', port: 22, username: 'u', authType: 'password', password: 'p' };
}

function attach(
  ws: FakeWs,
  profileId: string,
  opts: { tabId?: string; container?: string; containerName?: string } = {},
): void {
  const profile = makeProfile(profileId);
  attachTerminal(
    ws,
    profile,
    80,
    24,
    opts.container,
    opts.tabId ?? null,
    opts.containerName ?? null,
  );
}

// attach() запускает spawn асинхронно; макротаска достаточна, чтобы openShell
// резолвнулся и обработчики канала встали.
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function openSession(
  profileId: string,
  opts: { tabId?: string; container?: string; containerName?: string } = {},
): Promise<FakeWs> {
  const ws = new FakeWs();
  attach(ws, profileId, opts);
  await flush();
  return ws;
}

describe('sessionKey', () => {
  it('включает container и tabId, дефолты — host::0', () => {
    expect(sessionKey('p1')).toBe('p1::host::0');
    expect(sessionKey('p1', undefined, 3)).toBe('p1::host::3');
    expect(sessionKey('p1', 'abc', 2)).toBe('p1::abc::2');
  });

  it('различает вкладки одного контейнера и host-вкладки', () => {
    expect(sessionKey('p1', 'abc', 1)).not.toBe(sessionKey('p1', 'abc', 2));
    expect(sessionKey('p1', undefined, 1)).not.toBe(sessionKey('p1', 'abc', 1));
  });
});

describe('parseTabId', () => {
  it('отсутствие параметра — дефолт 0 (бесшовный деплой старого клиента)', () => {
    expect(parseTabId(null)).toBe(0);
  });

  it('валидные значения 0..9999', () => {
    expect(parseTabId('0')).toBe(0);
    expect(parseTabId('7')).toBe(7);
    expect(parseTabId('9999')).toBe(9999);
    expect(parseTabId('007')).toBe(7);
  });

  it('мусор — null: не-число, дробное, отрицательное, вне диапазона, пустое', () => {
    expect(parseTabId('abc')).toBeNull();
    expect(parseTabId('1.5')).toBeNull();
    expect(parseTabId('-1')).toBeNull();
    expect(parseTabId('10000')).toBeNull();
    expect(parseTabId('')).toBeNull();
    expect(parseTabId('1e3')).toBeNull();
    expect(parseTabId(' 1')).toBeNull();
  });
});

describe('attachTerminal: tabId', () => {
  it('невалидный tabId — close(1008) без создания сессии', () => {
    const ws = new FakeWs();
    attach(ws, 'tp1', { tabId: 'abc' });
    expect(ws.closes).toEqual([{ code: 1008, reason: 'Invalid tabId' }]);
    expect(listTerminalSessions('tp1')).toEqual([]);
    expect(ws.sent).toEqual([]);
  });

  it('без tabId — сессия с tabId 0 (старый клиент)', async () => {
    await openSession('tp2');
    const sessions = listTerminalSessions('tp2');
    expect(sessions).toEqual([{ tabId: 0, container: null, containerName: null }]);
  });
});

describe('attachTerminal: лимит', () => {
  it('пятая новая сессия — error-фрейм + close(1013), записи нет', async () => {
    const profileId = 'tl1';
    for (let i = 0; i < MAX_TERMINAL_SESSIONS_PER_PROFILE; i++) {
      await openSession(profileId, { tabId: String(i) });
    }
    expect(listTerminalSessions(profileId)).toHaveLength(4);

    const ws5 = new FakeWs();
    attach(ws5, profileId, { tabId: '9' });
    expect(ws5.sentTypes()).toEqual(['error']);
    expect(ws5.sent[0]?.data).toContain('Слишком много терминалов');
    expect(ws5.closes).toEqual([{ code: 1013, reason: 'Too many terminals' }]);
    expect(listTerminalSessions(profileId)).toHaveLength(4);
  });

  it('повторный attach к существующей сессии поверх полного лимита проходит', async () => {
    const profileId = 'tl2';
    for (let i = 0; i < MAX_TERMINAL_SESSIONS_PER_PROFILE; i++) {
      await openSession(profileId, { tabId: String(i) });
    }
    const ws = new FakeWs();
    attach(ws, profileId, { tabId: '1' });
    await flush();
    expect(ws.closes).toEqual([]);
    expect(ws.sentTypes()).toContain('connected');
    // Нового канала не открылось, записей по-прежнему 4.
    expect(listTerminalSessions(profileId)).toHaveLength(4);
  });

  it('лимит на профиль — сессии другого профиля не считаются', async () => {
    for (let i = 0; i < MAX_TERMINAL_SESSIONS_PER_PROFILE; i++) {
      await openSession('tl3a', { tabId: String(i) });
    }
    const ws = await openSession('tl3b');
    expect(ws.sentTypes()).toContain('connected');
    expect(listTerminalSessions('tl3b')).toHaveLength(1);
  });
});

describe('жизненный цикл записи', () => {
  it('exit внутри shell удаляет запись и освобождает слот', async () => {
    const profileId = 'tc1';
    const firstIdx = h.shells.length;
    const ws = await openSession(profileId, { tabId: '5' });
    expect(listTerminalSessions(profileId)).toHaveLength(1);

    h.shells[firstIdx].channel.emit('close');
    // Сервер закрыл аттачменты (1011), запись исчезла из реестра.
    expect(ws.closes).toEqual([{ code: 1011, reason: 'Terminal session closed' }]);
    expect(listTerminalSessions(profileId)).toEqual([]);

    // Тот же tabId поднимает свежую сессию — слот свободен.
    const ws2 = await openSession(profileId, { tabId: '5' });
    expect(ws2.sentTypes()).toContain('connected');
    expect(listTerminalSessions(profileId)).toHaveLength(1);
    expect(h.shells.length).toBe(firstIdx + 2);
  });

  it('WS-сообщение close → destroy → слот освободился', async () => {
    const profileId = 'tc2';
    for (let i = 0; i < MAX_TERMINAL_SESSIONS_PER_PROFILE; i++) {
      await openSession(profileId, { tabId: String(i) });
    }
    const ws = new FakeWs();
    attach(ws, profileId, { tabId: '0' });
    await flush();
    ws.message({ type: 'close' });
    expect(listTerminalSessions(profileId)).toHaveLength(3);

    const ws5 = await openSession(profileId, { tabId: '8' });
    expect(ws5.sentTypes()).toContain('connected');
    expect(listTerminalSessions(profileId)).toHaveLength(4);
  });

  it('grace: detach без close-фрейма держит запись живой (shell не вышел)', async () => {
    const profileId = 'tc3';
    const ws = await openSession(profileId);
    ws.close(); // клиент отвалился без close-фрейма — сессия в grace 60 c
    expect(listTerminalSessions(profileId)).toHaveLength(1);
    // Повторное подключение той же вкладки переиспользует shell.
    const ws2 = new FakeWs();
    attach(ws2, profileId);
    await flush();
    expect(ws2.sentTypes()).toContain('connected');
    expect(listTerminalSessions(profileId)).toHaveLength(1);
    // Явное закрытие вкладки гасит grace-таймер (не держит event loop теста).
    ws2.message({ type: 'close' });
    expect(listTerminalSessions(profileId)).toEqual([]);
  });
});

describe('listTerminalSessions', () => {
  it('поля tabId/container/containerName, фильтр по профилю', async () => {
    await openSession('tls-a', { tabId: '2' });
    await openSession('tls-a', { tabId: '3', container: 'abc123', containerName: 'web-1' });
    await openSession('tls-b', { tabId: '0' });

    expect(listTerminalSessions('tls-a')).toEqual([
      { tabId: 2, container: null, containerName: null },
      { tabId: 3, container: 'abc123', containerName: 'web-1' },
    ]);
    expect(listTerminalSessions('tls-b')).toEqual([
      { tabId: 0, container: null, containerName: null },
    ]);
  });

  it('containerName обрезается до 200 символов', async () => {
    await openSession('tls-c', { tabId: '1', container: 'c1', containerName: 'x'.repeat(300) });
    const [info] = listTerminalSessions('tls-c');
    expect(info?.containerName).toHaveLength(200);
  });
});
