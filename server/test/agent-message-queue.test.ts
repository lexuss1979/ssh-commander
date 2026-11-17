import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { ChatMessage } from '../src/ai/client.js';
import type { QueuedAgentMessage } from '../src/ai/dialogues.js';
import type { Profile } from '../src/types.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'sc-agent-queue-'));
vi.stubEnv('DATA_DIR', dataDir);
vi.stubEnv('AI_MAX_STEPS', '3');

vi.mock('../src/ssh/manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ssh/manager.js')>();
  return { ...actual, exec: vi.fn(async () => ({ code: 0, stdout: 'ok', stderr: '' })) };
});

const { AgentSession, attachAgent } = await import('../src/ai/agent.js');
const {
  createDialogue,
  getDialogue,
  setDialogueMessageQueue,
} = await import('../src/ai/dialogues.js');
const { exec } = await import('../src/ssh/manager.js');
const { saveSettings } = await import('../src/services/settings.js');

const profile: Profile = {
  id: 'queue-srv', name: 'Queue server', host: 'test.local', port: 22,
  username: 'user', authType: 'password', dockerCommand: 'docker',
};

type RequestBody = { messages: ChatMessage[]; tools?: unknown[] };
type Sent = Array<Record<string, unknown>>;
const requests: RequestBody[] = [];
const replies: ChatMessage[] = [];
const sessions: AgentSession[] = [];

function response(message: ChatMessage): Response {
  return new Response(
    JSON.stringify({ choices: [{ message }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function installFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init: RequestInit) => {
    requests.push(JSON.parse(init.body as string) as RequestBody);
    return response(replies.shift() ?? { role: 'assistant', content: 'done' });
  }));
}

function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

beforeEach(() => {
  saveSettings({
    aiProvider: 'custom', aiApiKey: 'test-key', aiApiBase: 'http://mock-api', aiModel: 'test-model',
  });
  requests.length = 0;
  replies.length = 0;
  vi.mocked(exec).mockClear();
  installFetch();
});

afterEach(() => {
  for (const session of sessions.splice(0)) session.stop();
  vi.unstubAllGlobals();
});

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(dataDir, { recursive: true, force: true });
});

interface FakeWs {
  ws: WebSocket;
  sent: Sent;
  close: () => void;
}

function makeWs(): FakeWs {
  const sent: Sent = [];
  const handlers = new Map<string, Array<() => void>>();
  const ws = {
    readyState: 1,
    OPEN: 1,
    on(event: string, handler: () => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    send(data: string) { sent.push(JSON.parse(data) as Record<string, unknown>); },
  } as unknown as WebSocket;
  return {
    ws,
    sent,
    close() {
      (ws as unknown as { readyState: number }).readyState = 3;
      for (const handler of handlers.get('close') ?? []) handler();
    },
  };
}

function makeSession(dialogueId = createDialogue(profile.id).id) {
  const socket = makeWs();
  const dialogue = getDialogue(dialogueId);
  expect(dialogue).toBeDefined();
  const session = new AgentSession(profile, socket.ws, dialogue);
  sessions.push(session);
  return { session, sent: socket.sent, dialogueId };
}

function attach(dialogueId: string) {
  const socket = makeWs();
  const session = attachAgent(socket.ws, profile, dialogueId);
  sessions.push(session);
  return { session, sent: socket.sent, close: socket.close };
}

function toolCall(id: string, name: string, args: Record<string, unknown>): ChatMessage {
  return {
    role: 'assistant', content: null,
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  };
}

function queueEvents(sent: Sent): Array<Record<string, unknown>> {
  return sent.filter((event) => event.type === 'message_queue');
}

function queuedItems(sent: Sent): QueuedAgentMessage[] {
  const events = queueEvents(sent);
  return (events.at(-1)?.items ?? []) as QueuedAgentMessage[];
}

function doneEvents(sent: Sent): Sent {
  return sent.filter((event) => event.type === 'done');
}

async function waitForRequest(count: number): Promise<void> {
  await vi.waitFor(() => expect(requests).toHaveLength(count));
}

async function waitForSettled(target: { session: AgentSession; sent: Sent }, doneCount: number): Promise<void> {
  await vi.waitFor(() => {
    expect(doneEvents(target.sent)).toHaveLength(doneCount);
    expect(target.session.isRunning).toBe(false);
  });
}

describe('agent message queue', () => {
  it('does not start parallel loops; delete removes an item before it can reach the model', async () => {
    const first = gate();
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init: RequestInit) => {
      requests.push(JSON.parse(init.body as string) as RequestBody);
      if (requests.length === 1) await first.promise;
      return response({ role: 'assistant', content: 'done' });
    }));
    const target = makeSession();
    target.session.handleClientMessage({ type: 'message', content: 'current task' });
    await waitForRequest(1);

    target.session.handleClientMessage({ type: 'message', content: 'delete me', delivery: 'queue' });
    target.session.handleClientMessage({ type: 'message', content: 'next task', delivery: 'queue' });
    expect(requests).toHaveLength(1);
    expect(queuedItems(target.sent).map((item) => item.content)).toEqual(['delete me', 'next task']);
    expect(getDialogue(target.dialogueId)?.messageQueue).toHaveLength(2);

    const deleted = queuedItems(target.sent)[0];
    target.session.handleClientMessage({ type: 'delete_queued', id: deleted.id });
    target.session.handleClientMessage({ type: 'delete_queued', id: deleted.id });
    expect(queuedItems(target.sent).map((item) => item.content)).toEqual(['next task']);
    first.release();
    await waitForSettled(target, 2);

    expect(requests).toHaveLength(2);
    expect(requests[1].messages.some((m) => m.role === 'user' && m.content === 'next task')).toBe(true);
    expect(requests.flatMap((r) => r.messages).some((m) => m.content === 'delete me')).toBe(false);
    expect(getDialogue(target.dialogueId)?.messages.some((m) => m.content === 'delete me')).toBe(false);
    expect(getDialogue(target.dialogueId)?.messageQueue).toEqual([]);
  });

  it('runs ordinary queued messages in FIFO order with a fresh run for each', async () => {
    const first = gate();
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init: RequestInit) => {
      requests.push(JSON.parse(init.body as string) as RequestBody);
      if (requests.length === 1) await first.promise;
      return response({ role: 'assistant', content: 'done' });
    }));
    const target = makeSession();
    target.session.handleClientMessage({ type: 'message', content: 'current' });
    await waitForRequest(1);
    target.session.handleClientMessage({ type: 'message', content: 'second', delivery: 'queue' });
    target.session.handleClientMessage({ type: 'message', content: 'third', delivery: 'queue' });
    first.release();
    await waitForSettled(target, 3);

    expect(requests).toHaveLength(3);
    expect(requests[1].messages.at(-1)).toEqual({ role: 'user', content: 'second' });
    expect(requests[2].messages.at(-1)).toEqual({ role: 'user', content: 'third' });
    expect(target.sent.filter((event) => event.type === 'running')).toHaveLength(3);
    expect(target.sent.filter((event) => event.type === 'message' && event.role === 'user').map((event) => event.content))
      .toEqual(['second', 'third']);
  });

  it('applies steer after tool results, ahead of the ordinary queue, then runs the queued task', async () => {
    const first = gate();
    const second = gate();
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init: RequestInit) => {
      requests.push(JSON.parse(init.body as string) as RequestBody);
      if (requests.length === 1) await first.promise;
      if (requests.length === 2) await second.promise;
      return response(replies.shift() ?? { role: 'assistant', content: 'done' });
    }));
    replies.push(toolCall('ls-1', 'list_servers', {}));
    const target = makeSession();
    target.session.handleClientMessage({ type: 'message', content: 'original task' });
    await waitForRequest(1);
    target.session.handleClientMessage({ type: 'message', content: 'later task', delivery: 'queue' });
    target.session.handleClientMessage({ type: 'message', content: 'change direction', delivery: 'steer' });
    first.release();
    await waitForRequest(2);

    const steered = requests[1].messages;
    expect(steered.at(-1)).toEqual({ role: 'user', content: 'change direction' });
    expect(steered.at(-2)).toEqual(expect.objectContaining({ role: 'tool', tool_call_id: 'ls-1' }));
    expect(queuedItems(target.sent).map((item) => item.content)).toEqual(['later task']);
    second.release();
    await waitForSettled(target, 2);
    expect(requests).toHaveLength(3);
    expect(requests[2].messages.at(-1)).toEqual({ role: 'user', content: 'later task' });
    expect(queuedItems(target.sent)).toEqual([]);
  });

  it('keeps a pending approval intact and applies steer after the approved tool', async () => {
    replies.push(toolCall('exec-1', 'exec', { command: 'systemctl restart nginx' }));
    const target = makeSession();
    target.session.handleClientMessage({ type: 'message', content: 'restart nginx' });
    await vi.waitFor(() => expect(target.sent.some((e) => e.type === 'tool_pending')).toBe(true));

    target.session.handleClientMessage({ type: 'message', content: 'also check the status', delivery: 'steer' });
    expect(requests).toHaveLength(1);
    expect(target.sent.some((e) => e.type === 'tool_pending')).toBe(true);
    target.session.handleClientMessage({ type: 'approve', callId: 'exec-1' });
    await waitForSettled(target, 1);

    expect(vi.mocked(exec)).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(2);
    expect(requests[1].messages.at(-2)).toEqual(expect.objectContaining({ role: 'tool', tool_call_id: 'exec-1' }));
    expect(requests[1].messages.at(-1)).toEqual({ role: 'user', content: 'also check the status' });
  });

  it('stop cancels the current run and clears every pending item', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string | URL, init: RequestInit) => {
      requests.push(JSON.parse(init.body as string) as RequestBody);
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }));
    const target = makeSession();
    target.session.handleClientMessage({ type: 'message', content: 'long task' });
    await waitForRequest(1);
    target.session.handleClientMessage({ type: 'message', content: 'next', delivery: 'queue' });
    target.session.handleClientMessage({ type: 'message', content: 'redirect', delivery: 'steer' });
    expect(queuedItems(target.sent)).toHaveLength(2);

    target.session.handleClientMessage({ type: 'stop' });
    target.session.handleClientMessage({ type: 'message', content: 'too late', delivery: 'steer' });
    await waitForSettled(target, 1);
    expect(target.sent.some((event) =>
      event.type === 'error' && event.scope === 'queue' && event.rejectedContent === 'too late'
    )).toBe(true);
    expect(doneEvents(target.sent)[0].stopped).toBe(true);
    expect(queuedItems(target.sent)).toEqual([]);
    expect(getDialogue(target.dialogueId)?.messageQueue).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requests).toHaveLength(1);
  });

  it('reuses the running session on reconnect and broadcasts queue snapshots to both sockets', async () => {
    const first = gate();
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init: RequestInit) => {
      requests.push(JSON.parse(init.body as string) as RequestBody);
      if (requests.length === 1) await first.promise;
      return response({ role: 'assistant', content: 'done' });
    }));
    const dialogue = createDialogue(profile.id);
    const one = attach(dialogue.id);
    one.session.handleClientMessage({ type: 'message', content: 'current task' });
    await waitForRequest(1);
    one.session.handleClientMessage({ type: 'message', content: 'queued from one', delivery: 'queue' });

    const two = attach(dialogue.id);
    expect(two.session).toBe(one.session);
    expect(two.sent.some((event) => event.type === 'running')).toBe(true);
    expect(queuedItems(two.sent).map((item) => item.content)).toEqual(['queued from one']);
    const id = queuedItems(two.sent)[0].id;
    two.session.handleClientMessage({ type: 'delete_queued', id });
    expect(queuedItems(one.sent)).toEqual([]);
    expect(queuedItems(two.sent)).toEqual([]);

    one.close();
    expect(one.session.isRunning).toBe(true);
    first.release();
    await waitForSettled(two, 1);
    expect(requests).toHaveLength(1);
  });

  it('replays a pending tool approval to a newly attached socket', async () => {
    replies.push(toolCall('exec-reconnect', 'exec', { command: 'true' }));
    const dialogue = createDialogue(profile.id);
    const one = attach(dialogue.id);
    one.session.handleClientMessage({ type: 'message', content: 'run' });
    await vi.waitFor(() => expect(one.sent.some((e) => e.type === 'tool_pending')).toBe(true));

    const two = attach(dialogue.id);
    expect(two.session).toBe(one.session);
    expect(two.sent.some((event) => event.type === 'tool_pending' && event.callId === 'exec-reconnect')).toBe(true);
    two.session.handleClientMessage({ type: 'reject', callId: 'exec-reconnect' });
    await waitForSettled(two, 1);
  });

  it('announces and resumes a persisted queue through the real attach path', async () => {
    const dialogue = createDialogue(profile.id);
    setDialogueMessageQueue(dialogue.id, [{
      id: 'persisted-1', content: 'restored task', kind: 'queue', createdAt: Date.now(),
    }]);
    const target = attach(dialogue.id);
    expect(queueEvents(target.sent)[0]?.items).toEqual([
      expect.objectContaining({ id: 'persisted-1', content: 'restored task' }),
    ]);

    await waitForSettled(target, 1);
    expect(requests).toHaveLength(1);
    expect(requests[0].messages.at(-1)).toEqual({ role: 'user', content: 'restored task' });
    expect(target.sent.some((event) =>
      event.type === 'message' && event.role === 'user' && event.content === 'restored task'
    )).toBe(true);
  });

  it('does not drain without a client and resumes the persisted queue on attach', async () => {
    const first = gate();
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init: RequestInit) => {
      requests.push(JSON.parse(init.body as string) as RequestBody);
      if (requests.length === 1) await first.promise;
      return response({ role: 'assistant', content: 'done' });
    }));
    const dialogue = createDialogue(profile.id);
    const one = attach(dialogue.id);
    one.session.handleClientMessage({ type: 'message', content: 'current' });
    await waitForRequest(1);
    one.session.handleClientMessage({ type: 'message', content: 'next', delivery: 'queue' });
    one.close();
    first.release();
    await vi.waitFor(() => expect(one.session.isRunning).toBe(false));
    expect(requests).toHaveLength(1);
    expect(getDialogue(dialogue.id)?.messageQueue?.map((item) => item.content)).toEqual(['next']);

    const two = attach(dialogue.id);
    await waitForSettled(two, 1);
    expect(requests).toHaveLength(2);
    expect(requests[1].messages.at(-1)).toEqual({ role: 'user', content: 'next' });
  });

  it('aborts a pending approval after the last disconnect instead of hanging forever', async () => {
    replies.push(toolCall('disconnect-exec', 'exec', { command: 'true' }));
    const dialogue = createDialogue(profile.id);
    const one = attach(dialogue.id);
    one.session.handleClientMessage({ type: 'message', content: 'run' });
    await vi.waitFor(() => expect(one.sent.some((event) => event.type === 'tool_pending')).toBe(true));
    one.session.handleClientMessage({ type: 'message', content: 'next', delivery: 'queue' });
    one.close();

    await vi.waitFor(() => {
      expect(one.session.isRunning).toBe(false);
      expect(requests).toHaveLength(2);
    });
    expect(getDialogue(dialogue.id)?.messages.some((message) =>
      message.role === 'tool' && message.tool_call_id === 'disconnect-exec' && message.content?.includes('остановлен')
    )).toBe(true);
    expect(getDialogue(dialogue.id)?.messageQueue?.map((item) => item.content)).toEqual(['next']);
  });

  it('stop resolves a pending approval and prevents queued follow-up runs', async () => {
    replies.push(toolCall('stop-exec', 'exec', { command: 'true' }));
    const target = makeSession();
    target.session.handleClientMessage({ type: 'message', content: 'run' });
    await vi.waitFor(() => expect(target.sent.some((event) => event.type === 'tool_pending')).toBe(true));
    target.session.handleClientMessage({ type: 'message', content: 'next', delivery: 'queue' });
    target.session.handleClientMessage({ type: 'stop' });
    await waitForSettled(target, 1);
    expect(requests).toHaveLength(1);
    expect(doneEvents(target.sent)[0].stopped).toBe(true);
    expect(queuedItems(target.sent)).toEqual([]);
  });

  it('replacing the session for another dialogue preserves its persisted queue', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string | URL, init: RequestInit) => {
      requests.push(JSON.parse(init.body as string) as RequestBody);
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }));
    const firstDialogue = createDialogue(profile.id);
    const one = attach(firstDialogue.id);
    one.session.handleClientMessage({ type: 'message', content: 'current' });
    await waitForRequest(1);
    one.session.handleClientMessage({ type: 'message', content: 'keep my text', delivery: 'queue' });

    const secondDialogue = createDialogue(profile.id);
    attach(secondDialogue.id);
    await waitForSettled(one, 1);
    expect(doneEvents(one.sent)[0].stopped).toBe(true);
    expect(getDialogue(firstDialogue.id)?.messageQueue?.map((item) => item.content)).toEqual(['keep my text']);
  });

  it.each(['steer', 'queue'] as const)(
    'at the exhausted step budget %s stays queued, then starts a fresh user run',
    async (delivery) => {
      const third = gate();
      vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init: RequestInit) => {
        requests.push(JSON.parse(init.body as string) as RequestBody);
        if (requests.length === 3) await third.promise;
        return response(replies.shift() ?? { role: 'assistant', content: 'done' });
      }));
      replies.push(
        toolCall('limit-1', 'list_servers', {}),
        toolCall('limit-2', 'list_servers', {}),
        toolCall('limit-3', 'list_servers', {}),
      );
      const target = makeSession();
      target.session.handleClientMessage({ type: 'message', content: 'current' });
      await waitForRequest(3);
      target.session.handleClientMessage({ type: 'message', content: `pending ${delivery}`, delivery });
      third.release();
      await waitForSettled(target, 2);

      expect(requests).toHaveLength(4);
      expect(requests[2].messages.some((message) => message.content === `pending ${delivery}`)).toBe(false);
      expect(requests[3].messages.at(-1)).toEqual({ role: 'user', content: `pending ${delivery}` });
      expect(doneEvents(target.sent)[0].stepLimit).toBe(true);
      expect(doneEvents(target.sent)[1].stepLimit).toBe(false);
    },
  );

  it('steer joins the current budget instead of resetting the step counter', async () => {
    const first = gate();
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init: RequestInit) => {
      requests.push(JSON.parse(init.body as string) as RequestBody);
      if (requests.length === 1) await first.promise;
      return response(replies.shift() ?? { role: 'assistant', content: 'done' });
    }));
    replies.push(
      toolCall('budget-1', 'list_servers', {}),
      toolCall('budget-2', 'list_servers', {}),
      toolCall('budget-3', 'list_servers', {}),
    );
    const target = makeSession();
    target.session.handleClientMessage({ type: 'message', content: 'current' });
    await waitForRequest(1);
    target.session.handleClientMessage({ type: 'message', content: 'steer', delivery: 'steer' });
    first.release();
    await waitForSettled(target, 1);
    expect(requests).toHaveLength(3);
    expect(requests[1].messages.at(-1)).toEqual({ role: 'user', content: 'steer' });
    expect(doneEvents(target.sent)[0].stepLimit).toBe(true);
  });

  it('waits for every call in a multi-tool response before applying steer', async () => {
    const first = gate();
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init: RequestInit) => {
      requests.push(JSON.parse(init.body as string) as RequestBody);
      if (requests.length === 1) await first.promise;
      return response(replies.shift() ?? { role: 'assistant', content: 'done' });
    }));
    replies.push({
      role: 'assistant', content: null,
      tool_calls: [
        { id: 'multi-1', type: 'function', function: { name: 'list_servers', arguments: '{}' } },
        { id: 'multi-2', type: 'function', function: { name: 'list_servers', arguments: '{}' } },
      ],
    });
    const target = makeSession();
    target.session.handleClientMessage({ type: 'message', content: 'current' });
    await waitForRequest(1);
    target.session.handleClientMessage({ type: 'message', content: 'steer', delivery: 'steer' });
    first.release();
    await waitForRequest(2);
    expect(requests[1].messages.slice(-3)).toEqual([
      expect.objectContaining({ role: 'tool', tool_call_id: 'multi-1' }),
      expect.objectContaining({ role: 'tool', tool_call_id: 'multi-2' }),
      { role: 'user', content: 'steer' },
    ]);
    await waitForSettled(target, 1);
  });

  it('uses the planMode of an ordinary queued item and keeps the finished plan pending', async () => {
    const first = gate();
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init: RequestInit) => {
      requests.push(JSON.parse(init.body as string) as RequestBody);
      if (requests.length === 1) await first.promise;
      return response({ role: 'assistant', content: 'done' });
    }));
    const target = makeSession();
    target.session.handleClientMessage({ type: 'message', content: 'current' });
    await waitForRequest(1);
    target.session.handleClientMessage({ type: 'message', content: 'next plan', delivery: 'queue', planMode: true });
    first.release();
    await waitForSettled(target, 2);
    expect(requests).toHaveLength(2);
    expect(requests[1].tools).toBeUndefined();
    expect(requests[1].messages.at(-1)).toEqual({ role: 'user', content: 'next plan' });
    expect(target.session.isPlanPending).toBe(true);
    expect(target.sent.filter((event) => event.type === 'plan_ready')).toHaveLength(1);
  });

  it('enforces the shared queue cap and message length with localized errors', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string | URL, init: RequestInit) => {
      requests.push(JSON.parse(init.body as string) as RequestBody);
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }));
    const target = makeSession();
    target.session.handleClientMessage({ type: 'message', content: 'current' });
    await waitForRequest(1);
    for (let i = 0; i < 20; i++) {
      target.session.handleClientMessage({ type: 'message', content: `queued ${i}`, delivery: 'queue' });
    }
    expect(queuedItems(target.sent)).toHaveLength(20);
    target.session.handleClientMessage({ type: 'message', content: 'overflow', delivery: 'queue' });
    expect(target.sent.some((event) =>
      event.type === 'error' && event.scope === 'queue' && event.rejectedContent === 'overflow'
    )).toBe(true);
    expect(queuedItems(target.sent)).toHaveLength(20);
    target.session.handleClientMessage({ type: 'stop' });
    await waitForSettled(target, 1);
    expect(requests).toHaveLength(1);
  });

  it('rejects an oversized queued message without starting another request', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string | URL, init: RequestInit) => {
      requests.push(JSON.parse(init.body as string) as RequestBody);
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }));
    const target = makeSession();
    target.session.handleClientMessage({ type: 'message', content: 'current' });
    await waitForRequest(1);
    const long = 'x'.repeat(32001);
    target.session.handleClientMessage({ type: 'message', content: long, delivery: 'queue' });
    expect(target.sent.some((event) =>
      event.type === 'error' && event.scope === 'queue' && event.rejectedContent === long
    )).toBe(true);
    expect(queuedItems(target.sent)).toEqual([]);
    target.session.handleClientMessage({ type: 'stop' });
    await waitForSettled(target, 1);
    expect(requests).toHaveLength(1);
  });

  it('replays an executing automatic tool to a reattached socket', async () => {
    const executing = gate();
    vi.mocked(exec).mockImplementationOnce(async () => {
      await executing.promise;
      return { code: 0, stdout: 'ok', stderr: '' };
    });
    replies.push(toolCall('auto-read', 'exec_readonly', { command: 'ls' }));
    const dialogue = createDialogue(profile.id);
    const one = attach(dialogue.id);
    one.session.handleClientMessage({ type: 'message', content: 'read' });
    await vi.waitFor(() => expect(one.sent.some((event) => event.type === 'tool_start')).toBe(true));
    const two = attach(dialogue.id);
    expect(two.sent.some((event) => event.type === 'tool_start' && event.callId === 'auto-read')).toBe(true);
    executing.release();
    await waitForSettled(two, 1);
  });

  it('replays plan_ready when reattaching to a pending plan', async () => {
    const dialogue = createDialogue(profile.id);
    const one = attach(dialogue.id);
    one.session.handleClientMessage({ type: 'message', content: 'plan', planMode: true });
    await waitForSettled(one, 1);
    expect(one.session.isPlanPending).toBe(true);
    const two = attach(dialogue.id);
    expect(two.sent.some((event) => event.type === 'plan_ready')).toBe(true);
  });

  it('steers planning into another tools-free planning request', async () => {
    const first = gate();
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init: RequestInit) => {
      requests.push(JSON.parse(init.body as string) as RequestBody);
      if (requests.length === 1) await first.promise;
      return response({ role: 'assistant', content: 'plan' });
    }));
    const target = makeSession();
    target.session.handleClientMessage({ type: 'message', content: 'draft a plan', planMode: true });
    await waitForRequest(1);
    target.session.handleClientMessage({ type: 'message', content: 'include rollback', delivery: 'steer', planMode: true });
    first.release();
    await waitForSettled(target, 1);

    expect(requests).toHaveLength(2);
    expect(requests[0].tools).toBeUndefined();
    expect(requests[1].tools).toBeUndefined();
    expect(requests[1].messages.at(-1)).toEqual({ role: 'user', content: 'include rollback' });
    expect(target.sent.filter((event) => event.type === 'plan_ready')).toHaveLength(1);
  });
});
