import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { ChatMessage } from '../src/ai/client.js';
import type { Profile } from '../src/types.js';

// Real AgentSession and HTTP client; only the external provider is stubbed.
const dataDir = mkdtempSync(path.join(tmpdir(), 'sc-agent-session-'));
vi.stubEnv('DATA_DIR', dataDir);
const { AgentSession } = await import('../src/ai/agent.js');
const { getDialogue } = await import('../src/ai/dialogues.js');
const { saveSettings } = await import('../src/services/settings.js');
saveSettings({
  aiProvider: 'opencode-go', aiApiKey: 'test-key', aiApiBase: 'http://mock-api', aiModel: 'test-model',
});

const profile: Profile = {
  id: 'session-srv', name: 'Тестовый', host: 'test.local', port: 22,
  username: 'root', authType: 'password', dockerCommand: 'docker',
};
type RequestBody = { messages: ChatMessage[]; tools?: unknown[] };
const requests: Array<{ headers: Headers; body: RequestBody }> = [];
const replies: ChatMessage[] = [];
const sessions: InstanceType<typeof AgentSession>[] = [];

beforeEach(() => {
  saveSettings({
    aiProvider: 'opencode-go', aiApiKey: 'test-key', aiApiBase: 'http://mock-api', aiModel: 'test-model',
  });
  requests.length = 0;
  replies.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    const body = JSON.parse(init.body as string) as RequestBody;
    requests.push({ headers, body });
    // The mock reproduces the OpenCode Go contract: without the headers the request is rejected.
    const valid = headers.get('x-opencode-session') && /^ssh-commander(?:\/\S+)?$/.test(headers.get('user-agent') ?? '')
      && body.messages.every((message) => !Object.hasOwn(message, 'name'));
    return new Response(JSON.stringify(valid
      ? { choices: [{ message: replies.shift() ?? { role: 'assistant', content: 'готово' } }] }
      : { error: { type: 'MissingSessionID' } }), {
      status: valid ? 200 : 400, headers: { 'content-type': 'application/json' },
    });
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

function makeSession(dialogueId?: string) {
  const sent: Array<Record<string, unknown>> = [];
  const ws = {
    readyState: 1, OPEN: 1,
    send(data: string) { sent.push(JSON.parse(data) as Record<string, unknown>); },
  } as unknown as WebSocket;
  const dialogue = dialogueId ? getDialogue(dialogueId) : undefined;
  if (dialogueId) expect(dialogue).toBeDefined();
  const session = new AgentSession(profile, ws, dialogue);
  sessions.push(session);
  return { session, sent };
}

async function sendMessage(
  target: ReturnType<typeof makeSession>,
  event: Record<string, unknown>,
) {
  const doneCount = target.sent.filter((m) => m.type === 'done').length;
  target.session.handleClientMessage(event);
  await vi.waitFor(() => {
    expect(target.sent.filter((m) => m.type === 'error')).toEqual([]);
    expect(target.sent.filter((m) => m.type === 'done')).toHaveLength(doneCount + 1);
    expect(target.session.isRunning).toBe(false);
  }, { timeout: 3000 });
}

describe('agent — a stable OpenCode Go session', () => {
  const reasoning = { type: 'reasoning' as const, id: 'rs-test', summary: [] as [], encrypted_content: 'test-encrypted' };

  function mockResponses(outputs: unknown[][]) {
    saveSettings({
      aiProvider: 'opencode-go', aiApiKey: 'test-key', aiApiBase: 'http://mock-api', aiModel: 'gpt-6-luna',
    });
    const requests: Array<{ url: string; headers: Headers; body: { input: Record<string, unknown>[]; tools?: unknown[] } }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      requests.push({ url, headers: new Headers(init.headers), body });
      const output = outputs.shift() ?? [{ type: 'message', content: [{ type: 'output_text', text: 'готово' }] }];
      return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output } })}\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      });
    }));
    return requests;
  }

  it('Responses: tools, reasoning and the saved dialogue continue with the same ID', async () => {
    const captured = mockResponses([[
      reasoning, { type: 'function_call', id: 'fc-test', call_id: 'memory-call', name: 'read_memory', arguments: '{}' },
    ]]);
    const original = makeSession();
    await sendMessage(original, { type: 'message', content: 'прочитай память' });
    expect(captured).toHaveLength(2);
    expect(captured[1].body.input).toContainEqual(reasoning);
    expect(captured[1].body.input).toContainEqual(expect.objectContaining({ type: 'function_call_output', call_id: 'memory-call' }));
    expect(getDialogue(original.session.dialogueId)?.messages.find((m) => m.role === 'assistant')?.responsesContext?.items)
      .toEqual([reasoning]);
    original.session.stop();
    const restored = makeSession(original.session.dialogueId);
    await sendMessage(restored, { type: 'message', content: 'продолжай' });
    expect(captured[2].body.input).toContainEqual(reasoning);
    expect(captured.map((r) => r.url)).toEqual(Array(3).fill('http://mock-api/responses'));
    expect(captured.map((r) => r.headers.get('x-opencode-session'))).toEqual(Array(3).fill(original.session.dialogueId));
  });

  it('Responses: a plan without tools, execution after approve_plan with tools', async () => {
    const captured = mockResponses([]);
    const target = makeSession();
    await sendMessage(target, { type: 'message', content: 'составь план', planMode: true });
    expect(target.sent.some((m) => m.type === 'plan_ready')).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0].body.tools).toBeUndefined();
    await sendMessage(target, { type: 'approve_plan' });
    expect(captured).toHaveLength(2);
    expect(captured[1].body.tools?.length).toBeGreaterThan(0);
  });

  it('Responses: a mutating tool waits for the user decision and honors reject', async () => {
    // Arbitrary shell (`exec`) waits in every mode except `never` — the
    // needed default (the v2 per-dialogue revision) auto-runs only
    // low-risk mutations like write_memory.
    const captured = mockResponses([[
      { type: 'function_call', call_id: 'exec-call', name: 'exec', arguments: '{"command":"rm -rf /tmp/x"}' },
    ]]);
    const target = makeSession();
    target.session.handleClientMessage({ type: 'message', content: 'почисти каталог' });
    await vi.waitFor(() => expect(target.sent.some((m) => m.type === 'tool_pending' && m.callId === 'exec-call')).toBe(true));
    expect(captured).toHaveLength(1);
    expect(target.session.isRunning).toBe(true);
    await sendMessage(target, { type: 'reject', callId: 'exec-call' });
    expect(captured).toHaveLength(2);
    expect(captured[1].body.input).toContainEqual({
      type: 'function_call_output', call_id: 'exec-call', output: 'Пользователь отклонил выполнение этого действия.',
    });
    expect(target.sent.find((m) => m.type === 'tool_result')?.status).toBe('rejected');
  });

  it.each([
    'data: {"error":{"code":"inference_failed","message":"Upstream failed"}}\n\n',
    'data: [DONE]\n\n',
  ])('an error or an empty SSE response is visible in the UI and not saved as an empty response', async (frame) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(frame, {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    })));
    const target = makeSession();
    target.session.handleClientMessage({ type: 'message', content: 'привет' });
    await vi.waitFor(() => {
      expect(target.sent.filter((m) => m.type === 'error')).toHaveLength(1);
      expect(target.session.isRunning).toBe(false);
    });
    expect(target.sent.find((m) => m.type === 'error')?.message).toMatch(/inference_failed|без текста/);
    expect(target.sent.filter((m) => m.type === 'message')).toEqual([]);
    expect(getDialogue(target.session.dialogueId)?.messages.filter((m) => m.role === 'assistant')).toEqual([]);
  });

  it('keeps the ID across tool steps and the next message', async () => {
    const target = makeSession();
    replies.push({
      role: 'assistant', content: null,
      tool_calls: [{ id: 'memory-call', type: 'function', function: { name: 'read_memory', arguments: '{}' } }],
    });

    await sendMessage(target, { type: 'message', content: 'прочитай память' });
    expect(requests).toHaveLength(2);
    expect(requests[1].body.messages).toContainEqual(expect.objectContaining({
      role: 'tool', tool_call_id: 'memory-call',
    }));
    expect(getDialogue(target.session.dialogueId)?.messages).toContainEqual(expect.objectContaining({
      role: 'tool', tool_call_id: 'memory-call', name: 'read_memory',
    }));
    await sendMessage(target, { type: 'message', content: 'продолжай' });

    expect(requests).toHaveLength(3);
    expect(requests.map((r) => r.headers.get('x-opencode-session'))).toEqual([
      target.session.dialogueId, target.session.dialogueId, target.session.dialogueId,
    ]);
    target.session.stop();
    const restored = makeSession(target.session.dialogueId);
    await sendMessage(restored, { type: 'message', content: 'продолжай после восстановления' });
    expect(requests[3].body.messages).toContainEqual(expect.objectContaining({
      role: 'tool', tool_call_id: 'memory-call',
    }));
    expect(requests[3].body.messages.every((message) => !Object.hasOwn(message, 'name'))).toBe(true);
  });

  it('uses one ID for the plan and its execution', async () => {
    const target = makeSession();
    await sendMessage(target, { type: 'message', content: 'составь план', planMode: true });
    expect(target.sent.some((m) => m.type === 'plan_ready')).toBe(true);
    expect(requests[0].body.tools).toBeUndefined();
    await sendMessage(target, { type: 'approve_plan' });

    expect(requests).toHaveLength(2);
    expect(requests[1].body.tools?.length).toBeGreaterThan(0);
    expect(requests.map((r) => r.headers.get('x-opencode-session'))).toEqual([
      target.session.dialogueId, target.session.dialogueId,
    ]);
  });

  it('restores the ID of a saved dialogue and gives a new one to a fresh dialogue', async () => {
    const original = makeSession();
    await sendMessage(original, { type: 'message', content: 'первый запрос' });
    original.session.stop();
    const restored = makeSession(original.session.dialogueId);
    await sendMessage(restored, { type: 'message', content: 'после переподключения' });
    const fresh = makeSession();
    await sendMessage(fresh, { type: 'message', content: 'новый диалог' });

    expect(fresh.session.dialogueId).not.toBe(original.session.dialogueId);
    expect(requests.map((r) => r.headers.get('x-opencode-session'))).toEqual([
      original.session.dialogueId, original.session.dialogueId, fresh.session.dialogueId,
    ]);
    expect(requests[1].body.messages).toContainEqual({ role: 'user', content: 'первый запрос' });
  });
});
