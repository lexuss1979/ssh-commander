import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { ChatMessage } from '../src/ai/client.js';
import type { Profile } from '../src/types.js';

// The per-dialogue access level (docs/agent-access-levels-plan.md, revision
// v2): the mode lives on the dialogue, is announced on attach by the
// `approval_mode` event and changed live by the `set_approval_mode` frame
// ('never' gated by riskAcknowledged server-side). Real AgentSession; the
// external provider is a mock, the SSH layer is stubbed (the transport is
// out of scope here).
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

const { AgentSession, attachAgent } = await import('../src/ai/agent.js');
const { createDialogue, getDialogue, setDialogueApprovalMode } = await import('../src/ai/dialogues.js');
const { saveSettings } = await import('../src/services/settings.js');

const profile: Profile = {
  id: 'approval-srv', name: 'Тестовый', host: 'test.local', port: 22,
  username: 'user', authType: 'password', dockerCommand: 'docker',
};

type RequestBody = { messages: ChatMessage[] };
const requests: RequestBody[] = [];
const replies: ChatMessage[] = [];
const sessions: InstanceType<typeof AgentSession>[] = [];

// provider custom (not Go) → the plain chat/completions contract. The access
// level is not a setting anymore — the AI config only.
beforeEach(() => {
  saveSettings({
    aiProvider: 'custom', aiApiKey: 'test-key', aiApiBase: 'http://mock-api', aiModel: 'test-model',
  });
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

function makeWs(sent: Array<Record<string, unknown>>): WebSocket {
  return {
    readyState: 1, OPEN: 1, on: () => undefined,
    send(data: string) { sent.push(JSON.parse(data) as Record<string, unknown>); },
  } as unknown as WebSocket;
}

function makeSession(dialogueId?: string) {
  const sent: Array<Record<string, unknown>> = [];
  const dialogue = dialogueId ? getDialogue(dialogueId) : undefined;
  if (dialogueId) expect(dialogue).toBeDefined();
  const session = new AgentSession(profile, makeWs(sent), dialogue);
  sessions.push(session);
  return { session, sent };
}

// Through the real attach path: the persisted mode must be announced to the
// client by the `approval_mode` event before the first action.
function makeAttachedSession(dialogueId: string) {
  const sent: Array<Record<string, unknown>> = [];
  const session = attachAgent(makeWs(sent), profile, dialogueId);
  sessions.push(session);
  return { session, sent };
}

function event(sent: Array<Record<string, unknown>>, type: string, callId: string): Record<string, unknown> | undefined {
  return sent.find((m) => m.type === type && m.callId === callId);
}

async function runToDone(target: ReturnType<typeof makeSession>, content: string): Promise<void> {
  const doneCount = target.sent.filter((m) => m.type === 'done').length;
  const errorCount = target.sent.filter((m) => m.type === 'error').length;
  target.session.handleClientMessage({ type: 'message', content });
  await vi.waitFor(() => {
    expect(target.sent.filter((m) => m.type === 'error')).toHaveLength(errorCount);
    expect(target.sent.filter((m) => m.type === 'done')).toHaveLength(doneCount + 1);
    expect(target.session.isRunning).toBe(false);
  }, { timeout: 3000 });
}

describe('approval mode — needed is the default (dialogue without the field)', () => {
  it('write_memory runs automatically with the autoApproved flag, no tool_pending', async () => {
    const dialogue = createDialogue(profile.id);
    const target = makeSession(dialogue.id);
    replies.push(toolCall('mem-1', 'write_memory', { content: 'заметка' }));
    await runToDone(target, 'запиши в память');
    const start = event(target.sent, 'tool_start', 'mem-1');
    expect(start).toBeDefined();
    expect(start?.autoApproved).toBe(true);
    expect(event(target.sent, 'tool_pending', 'mem-1')).toBeUndefined();
    expect(event(target.sent, 'tool_result', 'mem-1')?.status).toBe('ok');
    // Both requests went out without a pause (no pending in between).
    expect(requests).toHaveLength(2);
  });

  it.each([
    ['wf-etc', 'write_file', { path: '/etc/nginx/nginx.conf', content: 'x' }],
    ['wf-env', 'write_file', { path: '/home/user/.env', content: 'x' }],
    ['exec-1', 'exec', { command: 'reboot' }],
    ['dk-1', 'docker_action', { action: 'rm', target: 'web' }],
  ])('%s: %s waits for the user decision', async (callId, name, args) => {
    const target = makeSession(createDialogue(profile.id).id);
    replies.push(toolCall(callId, name as string, args as Record<string, unknown>));
    const doneCount = target.sent.filter((m) => m.type === 'done').length;
    target.session.handleClientMessage({ type: 'message', content: 'сделай' });
    await vi.waitFor(() => expect(event(target.sent, 'tool_pending', callId)).toBeDefined());
    expect(event(target.sent, 'tool_start', callId)).toBeUndefined();
    target.session.handleClientMessage({ type: 'reject', callId });
    await vi.waitFor(() => expect(target.sent.filter((m) => m.type === 'done')).toHaveLength(doneCount + 1));
    expect(event(target.sent, 'tool_result', callId)?.status).toBe('rejected');
  });

  it('write_file outside system paths is auto', async () => {
    const target = makeSession(createDialogue(profile.id).id);
    replies.push(toolCall('wf-1', 'write_file', { path: '/home/user/x.txt', content: 'hello' }));
    await runToDone(target, 'запиши файл');
    expect(event(target.sent, 'tool_start', 'wf-1')?.autoApproved).toBe(true);
    expect(event(target.sent, 'tool_pending', 'wf-1')).toBeUndefined();
  });
});

describe('approval mode — always (persisted on the dialogue)', () => {
  it('a mutating exec waits for the user decision and honors approve', async () => {
    const dialogue = createDialogue(profile.id);
    setDialogueApprovalMode(dialogue.id, 'always');
    const target = makeSession(dialogue.id);
    replies.push(toolCall('exec-1', 'exec', { command: 'systemctl restart nginx' }));
    target.session.handleClientMessage({ type: 'message', content: 'перезапусти nginx' });
    await vi.waitFor(() => expect(event(target.sent, 'tool_pending', 'exec-1')).toBeDefined());
    expect(event(target.sent, 'tool_start', 'exec-1')).toBeUndefined();
    expect(requests).toHaveLength(1);
    target.session.handleClientMessage({ type: 'approve', callId: 'exec-1' });
    await vi.waitFor(() => expect(target.sent.some((m) => m.type === 'done')).toBe(true));
    expect(event(target.sent, 'tool_result', 'exec-1')?.status).toBe('ok');
    expect(requests[1].messages).toContainEqual(expect.objectContaining({ role: 'tool', tool_call_id: 'exec-1' }));
  });
});

describe('approval mode — never (persisted on the dialogue)', () => {
  it('exec and a write to /etc run automatically, no tool_pending', async () => {
    const dialogue = createDialogue(profile.id);
    setDialogueApprovalMode(dialogue.id, 'never');
    const target = makeSession(dialogue.id);
    replies.push(
      toolCall('exec-1', 'exec', { command: 'systemctl restart nginx' }),
      toolCall('wf-1', 'write_file', { path: '/etc/motd', content: 'x' }),
    );
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

describe('set_approval_mode — the live WS frame', () => {
  it('always applies to the next tool call and is persisted', async () => {
    const dialogue = createDialogue(profile.id); // needed by default
    const target = makeSession(dialogue.id);
    replies.push(
      toolCall('mem-1', 'write_memory', { content: 'первая' }),
      toolCall('mem-2', 'write_memory', { content: 'вторая' }),
    );
    // Hold the second API response until the frame is sent: otherwise the
    // loop races ahead and decides mem-2 by the old mode.
    let releaseSecond: (() => void) | null = null;
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init: RequestInit) => {
      requests.push(JSON.parse(init.body as string) as RequestBody);
      if (requests.length === 2) {
        await new Promise<void>((resolve) => {
          releaseSecond = resolve;
        });
      }
      return new Response(
        JSON.stringify({ choices: [{ message: replies.shift() ?? { role: 'assistant', content: 'готово' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }));
    target.session.handleClientMessage({ type: 'message', content: 'запиши дважды' });
    await vi.waitFor(() => expect(event(target.sent, 'tool_result', 'mem-1')).toBeDefined());
    // The frame arrives mid-run: mem-1 was decided by the old mode, mem-2 —
    // by the new one (the session field is re-read per tool call).
    target.session.handleClientMessage({ type: 'set_approval_mode', mode: 'always' });
    expect(target.sent.some((m) => m.type === 'approval_mode' && m.mode === 'always')).toBe(true);
    releaseSecond?.();
    await vi.waitFor(() => expect(event(target.sent, 'tool_pending', 'mem-2')).toBeDefined());
    expect(event(target.sent, 'tool_pending', 'mem-1')).toBeUndefined();
    target.session.handleClientMessage({ type: 'approve', callId: 'mem-2' });
    await vi.waitFor(() => expect(target.sent.some((m) => m.type === 'done')).toBe(true));
    expect(getDialogue(dialogue.id)?.approvalMode).toBe('always');
  });

  it("never without riskAcknowledged → error, the mode unchanged and not persisted", async () => {
    const dialogue = createDialogue(profile.id);
    const target = makeSession(dialogue.id);
    target.session.handleClientMessage({ type: 'set_approval_mode', mode: 'never' });
    const err = target.sent.find((m) => m.type === 'error');
    expect(err?.message).toBe('Подтвердите осознание рисков');
    expect(target.sent.some((m) => m.type === 'approval_mode')).toBe(false);
    expect(getDialogue(dialogue.id)?.approvalMode).toBeUndefined();
    // Behaviorally unchanged: write_memory still auto-runs in the needed mode.
    replies.push(toolCall('mem-1', 'write_memory', { content: 'x' }));
    await runToDone(target, 'запиши память');
    expect(event(target.sent, 'tool_start', 'mem-1')?.autoApproved).toBe(true);
    expect(event(target.sent, 'tool_pending', 'mem-1')).toBeUndefined();
  });

  it('never with riskAcknowledged → applied to the next call and persisted', async () => {
    const dialogue = createDialogue(profile.id);
    const target = makeSession(dialogue.id);
    target.session.handleClientMessage({ type: 'set_approval_mode', mode: 'never', riskAcknowledged: true });
    expect(target.sent.some((m) => m.type === 'approval_mode' && m.mode === 'never')).toBe(true);
    expect(getDialogue(dialogue.id)?.approvalMode).toBe('never');
    replies.push(toolCall('wf-1', 'write_file', { path: '/etc/motd', content: 'x' }));
    await runToDone(target, 'запиши конфиг');
    expect(event(target.sent, 'tool_start', 'wf-1')?.autoApproved).toBe(true);
    expect(event(target.sent, 'tool_pending', 'wf-1')).toBeUndefined();
  });

  it('a garbage mode → error, nothing changes', () => {
    const dialogue = createDialogue(profile.id);
    const target = makeSession(dialogue.id);
    target.session.handleClientMessage({ type: 'set_approval_mode', mode: 'sometimes' });
    const err = target.sent.find((m) => m.type === 'error');
    expect(err?.message).toContain('Недопустимый уровень доступа');
    expect(target.sent.some((m) => m.type === 'approval_mode')).toBe(false);
    expect(getDialogue(dialogue.id)?.approvalMode).toBeUndefined();
  });

  it('attach announces the persisted mode by the approval_mode event', () => {
    const dialogue = createDialogue(profile.id);
    setDialogueApprovalMode(dialogue.id, 'never');
    const target = makeAttachedSession(dialogue.id);
    expect(target.sent.some((m) => m.type === 'approval_mode' && m.mode === 'never')).toBe(true);
  });
});
