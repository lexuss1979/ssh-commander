import { describe, expect, it, vi } from 'vitest';
import type { Profile } from '../src/types.js';
import { openShell } from '../src/ssh/manager.js';
import {
  MAX_TERMINAL_SESSIONS_PER_PROFILE,
  attachTerminal,
  listTerminalSessions,
  parseTabId,
  sessionKey,
} from '../src/ws/terminal.js';

const openShellMock = vi.mocked(openShell);

// Registry of shells created by the openShell mock: tests need access to the
// channel (emitting 'close' = shell exit). vi.hoisted — the vi.mock factory is
// hoisted above regular declarations and cannot close over outer variables.
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
      destroy: () => {
        // Like ssh2: channel.close() eventually raises the channel 'close' event —
        // review #4: restart/ws-close exercise exactly this path.
        shell.channel.emit('close');
      },
    };
    h.shells.push(shell);
    return shell;
  }),
  closeProfileConnection: vi.fn(),
}));

type SentFrame = { type: string; data?: string };

/** Fake WebSocket: records sent/close calls, dispatches events. */
class FakeWs {
  // broadcast in ws/terminal.ts compares readyState with the static ws.OPEN,
  // also reachable through the instance — the fake mirrors that property.
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

  /** A client frame (like term.onData / toolbar buttons). */
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

// attach() starts the spawn asynchronously; a macrotask is enough for openShell
// to resolve and the channel handlers to be in place.
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
  it('includes container and tabId, defaults are host::0', () => {
    expect(sessionKey('p1')).toBe('p1::host::0');
    expect(sessionKey('p1', undefined, 3)).toBe('p1::host::3');
    expect(sessionKey('p1', 'abc', 2)).toBe('p1::abc::2');
  });

  it('distinguishes tabs of one container from host tabs', () => {
    expect(sessionKey('p1', 'abc', 1)).not.toBe(sessionKey('p1', 'abc', 2));
    expect(sessionKey('p1', undefined, 1)).not.toBe(sessionKey('p1', 'abc', 1));
  });
});

describe('parseTabId', () => {
  it('missing parameter — default 0 (seamless deploy of the old client)', () => {
    expect(parseTabId(null)).toBe(0);
  });

  it('valid values 0..9999', () => {
    expect(parseTabId('0')).toBe(0);
    expect(parseTabId('7')).toBe(7);
    expect(parseTabId('9999')).toBe(9999);
    expect(parseTabId('007')).toBe(7);
  });

  it('garbage — null: not a number, fractional, negative, out of range, empty', () => {
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
  it('rejects garbage tabId with close(1008)', () => {
    const ws = new FakeWs();
    attach(ws, 'tp1', { tabId: 'abc' });
    expect(ws.closes).toEqual([{ code: 1008, reason: 'Invalid tabId' }]);
    expect(listTerminalSessions('tp1')).toEqual([]);
    expect(ws.sent).toEqual([]);
  });

  it('without tabId — a session with tabId 0 (old client)', async () => {
    await openSession('tp2');
    const sessions = listTerminalSessions('tp2');
    expect(sessions).toEqual([{ tabId: 0, container: null, containerName: null }]);
  });
});

describe('attachTerminal: limit', () => {
  it('the fifth new session — an error frame + close(1013), no record', async () => {
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

  it('re-attaching to an existing session on top of the full limit passes', async () => {
    const profileId = 'tl2';
    for (let i = 0; i < MAX_TERMINAL_SESSIONS_PER_PROFILE; i++) {
      await openSession(profileId, { tabId: String(i) });
    }
    const ws = new FakeWs();
    attach(ws, profileId, { tabId: '1' });
    await flush();
    expect(ws.closes).toEqual([]);
    expect(ws.sentTypes()).toContain('connected');
    // No new channel opened, still 4 records.
    expect(listTerminalSessions(profileId)).toHaveLength(4);
  });

  it('the limit is per profile — sessions of another profile do not count', async () => {
    for (let i = 0; i < MAX_TERMINAL_SESSIONS_PER_PROFILE; i++) {
      await openSession('tl3a', { tabId: String(i) });
    }
    const ws = await openSession('tl3b');
    expect(ws.sentTypes()).toContain('connected');
    expect(listTerminalSessions('tl3b')).toHaveLength(1);
  });
});

describe('record lifecycle', () => {
  it('exit inside the shell removes the record and frees the slot', async () => {
    const profileId = 'tc1';
    const firstIdx = h.shells.length;
    const ws = await openSession(profileId, { tabId: '5' });
    expect(listTerminalSessions(profileId)).toHaveLength(1);

    h.shells[firstIdx].channel.emit('close');
    // The server closed the attachments (1011), the record vanished from the registry.
    expect(ws.closes).toEqual([{ code: 1011, reason: 'Terminal session closed' }]);
    expect(listTerminalSessions(profileId)).toEqual([]);

    // The same tabId raises a fresh session — the slot is free.
    const ws2 = await openSession(profileId, { tabId: '5' });
    expect(ws2.sentTypes()).toContain('connected');
    expect(listTerminalSessions(profileId)).toHaveLength(1);
    expect(h.shells.length).toBe(firstIdx + 2);
  });

  it('a WS close message → destroy → the slot is freed', async () => {
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

  it('spawn failure removes the record and does not occupy a slot (review #1)', async () => {
    const profileId = 'tc4';
    openShellMock.mockRejectedValueOnce(new Error('SSH connect fail'));
    const ws = new FakeWs();
    attach(ws, profileId, { tabId: '1' });
    await flush();
    expect(ws.sentTypes()).toContain('error');
    // No ghost record: neither in the list nor in the map (the slot is free).
    expect(listTerminalSessions(profileId)).toEqual([]);
    // Re-attaching with the same tabId creates a fresh record instead of
    // struggling with the stale one.
    const ws2 = await openSession(profileId, { tabId: '1' });
    expect(ws2.sentTypes()).toContain('connected');
    expect(listTerminalSessions(profileId)).toHaveLength(1);
    ws2.message({ type: 'close' });
  });

  it('restart survives the old channel close: the record is alive, the channel is recreated', async () => {
    const profileId = 'tc5';
    const firstIdx = h.shells.length;
    const ws = await openSession(profileId, { tabId: '3' });
    ws.message({ type: 'restart' });
    await flush();
    // restart nulls this.shell BEFORE destroying the old channel — the guard in
    // the close handler keeps the record: "Refresh session" holds it for the new
    // shell (invariant fixed in review #4).
    expect(listTerminalSessions(profileId)).toHaveLength(1);
    expect(h.shells.length).toBe(firstIdx + 2);
    expect(ws.sentTypes()).toContain('connected');
    ws.message({ type: 'close' });
    expect(listTerminalSessions(profileId)).toEqual([]);
  });

  it('shell exit during grace removes the record immediately', async () => {
    const profileId = 'tc6';
    const firstIdx = h.shells.length;
    const ws = await openSession(profileId, { tabId: '2' });
    ws.close(); // detach without a close frame → the 60 s grace timer
    expect(listTerminalSessions(profileId)).toHaveLength(1);
    // The shell died during grace: the close handler clears both the timer and
    // the record — a second destroy by the timer does not fire, the slot is free.
    h.shells[firstIdx].channel.emit('close');
    expect(listTerminalSessions(profileId)).toEqual([]);
    const ws2 = await openSession(profileId, { tabId: '2' });
    ws2.message({ type: 'close' });
  });

  it('grace: a detach without a close frame keeps the record alive (the shell has not exited)', async () => {
    const profileId = 'tc3';
    const ws = await openSession(profileId);
    ws.close(); // the client dropped without a close frame — the session is in 60 s grace
    expect(listTerminalSessions(profileId)).toHaveLength(1);
    // Re-attaching the same tab reuses the shell.
    const ws2 = new FakeWs();
    attach(ws2, profileId);
    await flush();
    expect(ws2.sentTypes()).toContain('connected');
    expect(listTerminalSessions(profileId)).toHaveLength(1);
    // Closing the tab explicitly cancels the grace timer (does not hold the test event loop).
    ws2.message({ type: 'close' });
    expect(listTerminalSessions(profileId)).toEqual([]);
  });
});

describe('listTerminalSessions', () => {
  it('tabId/container/containerName fields, filter by profile', async () => {
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

  it('containerName is truncated to 200 characters', async () => {
    await openSession('tls-c', { tabId: '1', container: 'c1', containerName: 'x'.repeat(300) });
    const [info] = listTerminalSessions('tls-c');
    expect(info?.containerName).toHaveLength(200);
  });
});
