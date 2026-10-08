import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { ChatMessage } from '../src/ai/client.js';
import type { Profile } from '../src/types.js';

// Access levels of the agent (docs/agent-access-levels-plan.md): the decision
// "approve or auto" moves to needsApproval (ai/approval.ts) and is read from
// settings on every tool call. Real AgentSession; the external provider is a
// mock, the SSH layer is stubbed (the transport is out of scope here).
const dataDir = mkdtempSync(path.join(tmpdir(), 'sc-approval-mode-'));
vi.stubEnv('DATA_DIR', dataDir);

vi.mock('../src/ssh/manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ssh/manager.js')>();
  const sftp = {
    stat: (_p: string, cb: (e: null, a: unknown) => void) => cb(null, { size: 5, mode: 0o100644 }),
    writeFile: (_p: string, _d: unknown, cb: (e: null) => void) => cb(null),
    readFile: (_p: string, _e: string, cb: (e: null, d: string) => void) => cb(null, 'data'),
    readdir: (_p: string, cb: (e: null, l: unknown[]) => void) => cb(null, []),
  };
  return {
    ...actual,
    exec: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
    withSftp: vi.fn(async (_profile: unknown, fn: (s: typeof sftp) => unknown) => fn(sftp)),
  };
});

const { AgentSession } = await import('../src/ai/agent.js');
const { saveSettings, updateSettings } = await import('../src/services/settings.js');

const profile: Profile = {
  id: 'approval-srv', name: 'Тестовый', host: 'test.local', port: 22,
  username: 'user', authType: 'password', dockerCommand: 'docker',
};

type RequestBody = { messages: ChatMessage[] };
const requests: RequestBody[] = [];
const replies: ChatMessage[] = [];
const sessions: InstanceType<typeof AgentSession>[] = [];

// provider custom (not Go) → the plain chat/completions contract.
function seed(mode?: 'always' | 'needed' | 'never'): void {
  saveSettings({
    aiProvider: 'custom', aiApiKey: 'test-key', aiApiBase: 'http://mock-api', aiModel: 'test-model',
    ...(mode ? { agentApprovalMode: mode } : {}),
  });
}

beforeEach(() => {
  seed();
  requests.length = 0;
  replies.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init: RequestInit) => {
    requests.push(JSON.parse(init.body as string) as RequestBody);
    return new Response(
      JSON.stringify({ choices: [{ message: replies.shift() ?? { role: 'assistant', content: 'готово' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }));
});

afterEach(() => {
  for (const session of sessions.splice(0)) session.stop();
  vi.unstubAllGlobals();
});
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(dataDir, { recursive: true, force: true });
});

function toolCall(id: string, name: string, args: Record<string, unknown>): ChatMessage {
  return {
    role: 'assistant', content: null,
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  };
}

function makeSession() {
  const sent: Array<Record<string, unknown>> = [];
  const ws = {
    readyState: 1, OPEN: 1,
    send(data: string) { sent.push(JSON.parse(data) as Record<string, unknown>); },
  } as unknown as WebSocket;
  const session = new AgentSession(profile, ws);
  sessions.push(session);
  return { session, sent };
}

function event(sent: Array<Record<string, unknown>>, type: string, callId: string): Record<string, unknown> | undefined {
  return sent.find((m) => m.type === type && m.callId === callId);
}

async function runToDone(target: ReturnType<typeof makeSession>, content: string): Promise<void> {
  const doneCount = target.sent.filter((m) => m.type === 'done').length;
  target.session.handleClientMessage({ type: 'message', content });
  await vi.waitFor(() => {
    expect(target.sent.filter((m) => m.type === 'error')).toEqual([]);
    expect(target.sent.filter((m) => m.type === 'done')).toHaveLength(doneCount + 1);
    expect(target.session.isRunning).toBe(false);
  }, { timeout: 3000 });
}

describe('agent approval mode — always (default, the field is absent)', () => {
  it('a mutating exec waits for the user decision (the invariant under the new decision point)', async () => {
    seed(); // no agentApprovalMode field on disk
    replies.push(toolCall('exec-1', 'exec', { command: 'systemctl restart nginx' }));
    const target = makeSession();
    target.session.handleClientMessage({ type: 'message', content: 'перезапусти nginx' });
    await vi.waitFor(() => expect(event(target.sent, 'tool_pending', 'exec-1')).toBeDefined());
    expect(event(target.sent, 'tool_start', 'exec-1')).toBeUndefined();
    expect(requests).toHaveLength(1);
    // The decision honors approve: the tool runs and the result reaches the model.
    target.session.handleClientMessage({ type: 'approve', callId: 'exec-1' });
    await vi.waitFor(() => expect(target.sent.some((m) => m.type === 'done')).toBe(true));
    expect(event(target.sent, 'tool_result', 'exec-1')?.status).toBe('ok');
    expect(requests[1].messages).toContainEqual(expect.objectContaining({ role: 'tool', tool_call_id: 'exec-1' }));
  });
});

describe('agent approval mode — needed', () => {
  it('write_memory runs automatically with the autoApproved flag, no tool_pending', async () => {
    seed('needed');
    replies.push(toolCall('mem-1', 'write_memory', { content: 'заметка' }));
    const target = makeSession();
    await runToDone(target, 'запиши в память');
    const start = event(target.sent, 'tool_start', 'mem-1');
    expect(start).toBeDefined();
    expect(start?.autoApproved).toBe(true);
    expect(event(target.sent, 'tool_pending', 'mem-1')).toBeUndefined();
    expect(event(target.sent, 'tool_result', 'mem-1')?.status).toBe('ok');
    // Both requests went out without a pause (no pending in between).
    expect(requests).toHaveLength(2);
  });

  it('write_file outside system paths is auto', async () => {
    seed('needed');
    replies.push(toolCall('wf-1', 'write_file', { path: '/home/user/x.txt', content: 'hello' }));
    const target = makeSession();
    await runToDone(target, 'запиши файл');
    const start = event(target.sent, 'tool_start', 'wf-1');
    expect(start?.autoApproved).toBe(true);
    expect(event(target.sent, 'tool_pending', 'wf-1')).toBeUndefined();
  });

  it.each([
    ['wf-etc', 'write_file', { path: '/etc/nginx/nginx.conf', content: 'x' }],
    ['wf-env', 'write_file', { path: '/home/user/.env', content: 'x' }],
    ['exec-1', 'exec', { command: 'reboot' }],
    ['dk-1', 'docker_action', { action: 'rm', target: 'web' }],
  ])('%s: %s waits for the user decision', async (callId, name, args) => {
    seed('needed');
    replies.push(toolCall(callId, name as string, args as Record<string, unknown>));
    const target = makeSession();
    target.session.handleClientMessage({ type: 'message', content: 'сделай' });
    await vi.waitFor(() => expect(event(target.sent, 'tool_pending', callId)).toBeDefined());
    expect(event(target.sent, 'tool_start', callId)).toBeUndefined();
    target.session.handleClientMessage({ type: 'reject', callId });
    await vi.waitFor(() => expect(target.sent.some((m) => m.type === 'done')).toBe(true));
    expect(event(target.sent, 'tool_result', callId)?.status).toBe('rejected');
  });
});

describe('agent approval mode — never (Full Access)', () => {
  it('exec and a write to /etc run automatically, no tool_pending', async () => {
    seed('never');
    replies.push(
      toolCall('exec-1', 'exec', { command: 'systemctl restart nginx' }),
      toolCall('wf-1', 'write_file', { path: '/etc/motd', content: 'x' }),
    );
    const target = makeSession();
    await runToDone(target, 'сделай всё сам');
    for (const callId of ['exec-1', 'wf-1']) {
      const start = event(target.sent, 'tool_start', callId);
      expect(start).toBeDefined();
      expect(start?.autoApproved).toBe(true);
      expect(event(target.sent, 'tool_pending', callId)).toBeUndefined();
      expect(event(target.sent, 'tool_result', callId)?.status).toBe('ok');
    }
  });
});

describe('agent approval mode — a mid-loop change acts on the next tool call', () => {
  it('needed → always: the first call is auto, the second waits', async () => {
    seed('needed');
    replies.push(toolCall('mem-1', 'write_memory', { content: 'первая' }), toolCall('mem-2', 'write_memory', { content: 'вторая' }));
    const target = makeSession();
    // The mode is switched by the mock while the second API request is in
    // flight: mem-1 was decided (and auto-ran) before it, mem-2 is decided
    // after the response — under the new mode (the setting is re-read per call).
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init: RequestInit) => {
      requests.push(JSON.parse(init.body as string) as RequestBody);
      if (requests.length === 2) {
        updateSettings({ agentApprovalMode: 'always' });
      }
      return new Response(
        JSON.stringify({ choices: [{ message: replies.shift() ?? { role: 'assistant', content: 'готово' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }));
    target.session.handleClientMessage({ type: 'message', content: 'запиши дважды' });
    await vi.waitFor(() => expect(event(target.sent, 'tool_start', 'mem-1')?.autoApproved).toBe(true));
    await vi.waitFor(() => expect(event(target.sent, 'tool_pending', 'mem-2')).toBeDefined());
    expect(event(target.sent, 'tool_pending', 'mem-1')).toBeUndefined();
    target.session.handleClientMessage({ type: 'approve', callId: 'mem-2' });
    await vi.waitFor(() => expect(target.sent.some((m) => m.type === 'done')).toBe(true));
  });
});
