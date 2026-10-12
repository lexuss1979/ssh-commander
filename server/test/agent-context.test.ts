import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { ChatMessage, ToolDef } from '../src/ai/client.js';
import type { Profile } from '../src/types.js';
import { contextInputBudget, estimateTokens } from '../src/ai/context.js';
import { sanitizeMessages } from '../src/ai/messages.js';
import { planModeInstruction } from '../src/ai/prompts.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'sc-agent-context-'));
vi.stubEnv('DATA_DIR', dataDir);
vi.stubEnv('AI_CONTEXT_LIMIT', '60000');
const { AgentSession } = await import('../src/ai/agent.js');
const { createDialogue, getDialogue, saveDialogueMessages } = await import('../src/ai/dialogues.js');
const { saveSettings } = await import('../src/services/settings.js');
const { usageTotalsByDialogue } = await import('../src/ai/usage.js');
const { config } = await import('../src/config.js');
const profile: Profile = {
  id: 'context-test', name: 'Test', host: 'test.local', port: 22,
  username: 'root', authType: 'password', dockerCommand: 'docker',
};
type RequestBody = { messages: ChatMessage[]; tools?: ToolDef[] };
const requests: RequestBody[] = [];
const sessions: InstanceType<typeof AgentSession>[] = [];
let respond: (body: RequestBody, index: number) => Response;

function success(message: ChatMessage = { role: 'assistant', content: 'Done' }): Response {
  return new Response(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 100, completion_tokens: 10 } }), {
    headers: { 'content-type': 'application/json' },
  });
}
function overflow(): Response {
  return new Response('{"error":{"code":"context_length_exceeded"}}', { status: 400 });
}

beforeEach(() => {
  config.ai.maxSteps = 30;
  saveSettings({ aiProvider: 'custom', aiApiKey: 'test-key', aiApiBase: 'http://mock-api', aiModel: 'test-model' });
  requests.length = 0;
  respond = () => success();
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as RequestBody;
    requests.push(body);
    return respond(body, requests.length - 1);
  }));
});
afterEach(() => {
  sessions.splice(0).forEach((session) => session.stop());
  config.ai.maxSteps = 30;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('agent empty response retries', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  const empty = () => success({ role: 'assistant', content: null });
  async function finish(t: ReturnType<typeof target>, planMode = false) {
    t.session.handleClientMessage({ type: 'message', content: 'Continue', planMode });
    await vi.runAllTimersAsync();
    expect(t.session.isRunning).toBe(false);
  }

  it.each([false, true])('records each attempt once and keeps only the final message, plan=%s', async (planMode) => {
    config.ai.maxSteps = 1;
    respond = (_body, index) => index < 2 ? empty() : success();
    const t = target(false);
    await finish(t, planMode);
    expect(requests).toHaveLength(3);
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[2]).toEqual(requests[0]);
    expect(t.sent.filter((m) => m.type === 'error')).toEqual([]);
    expect(t.sent.filter((m) => m.type === 'message')).toHaveLength(1);
    expect(t.sent.filter((m) => m.type === 'usage')).toHaveLength(3);
    expect(t.sent.some((m) => m.type === 'plan_ready')).toBe(planMode);
    expect(usageTotalsByDialogue().get(t.session.dialogueId)).toMatchObject({ calls: 3, promptTokens: 300, completionTokens: 30 });
    expect(getDialogue(t.session.dialogueId)!.messages).toEqual([
      { role: 'user', content: 'Continue' }, { role: 'assistant', content: 'Done' },
    ]);
  });

  it.each([false, true])('records failed attempts without adding assistant placeholders, plan=%s', async (planMode) => {
    respond = empty;
    const t = target(false);
    await finish(t, planMode);
    expect(requests).toHaveLength(3);
    expect(t.sent.filter((m) => m.type === 'error')).toHaveLength(1);
    expect(t.sent.filter((m) => m.type === 'message')).toHaveLength(0);
    expect(usageTotalsByDialogue().get(t.session.dialogueId)?.calls).toBe(3);
    expect(getDialogue(t.session.dialogueId)!.messages).toEqual([{ role: 'user', content: 'Continue' }]);
  });

  it.each([false, true])('stops during backoff and retains the completed attempt cost, plan=%s', async (planMode) => {
    respond = empty;
    const t = target(false);
    t.session.handleClientMessage({ type: 'message', content: 'Continue', planMode });
    await vi.advanceTimersByTimeAsync(1000);
    t.session.stop();
    await vi.runAllTimersAsync();
    expect(t.session.isRunning).toBe(false);
    expect(requests).toHaveLength(1);
    expect(usageTotalsByDialogue().get(t.session.dialogueId)?.calls).toBe(1);
    expect(t.sent.some((m) => m.type === 'done' && m.stopped)).toBe(true);
    expect(t.sent.filter((m) => m.type === 'error')).toEqual([]);
  });

  it('does not repeat tools or consume extra execution steps', async () => {
    config.ai.maxSteps = 2;
    respond = (_body, index) => index === 0 ? success({
      role: 'assistant', content: null, tool_calls: [
        { id: 'read-once', type: 'function', function: { name: 'read_memory', arguments: '{}' } },
      ],
    }) : index < 3 ? empty() : success();
    const t = target(false);
    await finish(t);
    expect(requests).toHaveLength(4);
    expect(requests[2]).toEqual(requests[1]);
    expect(requests[3]).toEqual(requests[1]);
    expect(t.sent.filter((m) => m.type === 'tool_start')).toHaveLength(1);
    expect(t.sent.filter((m) => m.type === 'tool_result')).toHaveLength(1);
    expect(t.sent.filter((m) => m.type === 'error')).toEqual([]);
    expect(t.sent.find((m) => m.type === 'done')).not.toHaveProperty('note');
    expect(usageTotalsByDialogue().get(t.session.dialogueId)?.calls).toBe(4);
  });
});
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(dataDir, { recursive: true, force: true });
});

function target(long = true, lang: 'ru' | 'en' = 'en') {
  const dialogue = createDialogue(profile.id);
  const history: ChatMessage[] = long ? Array.from({ length: 80 }, (_, i): ChatMessage[] => [
    { role: 'user', content: `Task ${i}` },
    { role: 'assistant', content: `Result ${i}: ${'x'.repeat(6000)}` },
  ]).flat() : [];
  saveDialogueMessages(dialogue.id, history);
  const sent: Array<Record<string, unknown>> = [];
  const ws = { readyState: 1, OPEN: 1, send(data: string) { sent.push(JSON.parse(data)); } } as unknown as WebSocket;
  const session = new AgentSession(profile, ws, getDialogue(dialogue.id), lang);
  sessions.push(session);
  return { session, sent, history };
}
async function run(t: ReturnType<typeof target>, planMode = false) {
  t.session.handleClientMessage({ type: 'message', content: 'Continue', planMode });
  await vi.waitFor(() => expect(t.session.isRunning).toBe(false), { timeout: 3000 });
}

describe('agent context budgets', () => {
  it.each([false, true])('fits restored history, keeps persistence and accounts for plan=%s', async (planMode) => {
    const t = target();
    await run(t, planMode);
    expect(t.sent.filter((m) => m.type === 'error')).toEqual([]);
    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(estimateTokens(request.messages, request.tools)).toBeLessThanOrEqual(contextInputBudget(60000));
    expect(request.messages).toEqual(sanitizeMessages(request.messages));
    expect(request.messages).toContainEqual(t.history[0]);
    expect(request.messages.at(-1)).toEqual({ role: 'user', content: 'Continue' });
    expect(request.messages.length).toBeLessThan(t.history.length);
    if (planMode) {
      expect(request.tools).toBeUndefined();
      expect(request.messages[0].content).toContain(planModeInstruction('en'));
    } else expect(request.tools?.length).toBeGreaterThan(0);
    const saved = getDialogue(t.session.dialogueId)!.messages;
    expect(saved.slice(0, t.history.length)).toEqual(t.history);
    expect(saved).toHaveLength(t.history.length + 2);
    expect(t.sent.filter((m) => m.type === 'notice')).toHaveLength(1);
    expect(t.sent.find((m) => m.type === 'notice')?.message).toContain('full dialogue history is preserved');
  });

  it.each([false, true])('retries once with a genuinely smaller request and retains the reduced session budget, plan=%s', async (planMode) => {
    config.ai.maxSteps = 1;
    respond = (_body, index) => index === 0 ? overflow() : success();
    const t = target();
    await run(t, planMode);
    expect(t.sent.filter((m) => m.type === 'error')).toEqual([]);
    expect(requests).toHaveLength(2);
    const firstSize = estimateTokens(requests[0].messages, requests[0].tools);
    const retrySize = estimateTokens(requests[1].messages, requests[1].tools);
    expect(retrySize).toBeLessThanOrEqual(Math.floor(firstSize / 2));
    expect(t.sent.filter((m) => m.type === 'message')).toHaveLength(1);
    expect(usageTotalsByDialogue().get(t.session.dialogueId)?.calls).toBe(1);
    await run(t, planMode);
    expect(requests).toHaveLength(3);
    expect(estimateTokens(requests[2].messages, requests[2].tools)).toBeLessThanOrEqual(Math.floor(firstSize / 2));
    expect(getDialogue(t.session.dialogueId)!.messages.slice(0, t.history.length)).toEqual(t.history);
  });

  it('does not repeat tools or consume an extra execution step on an overflow retry', async () => {
    config.ai.maxSteps = 2;
    respond = (_body, index) => index === 0 ? overflow() : index === 1 ? success({
      role: 'assistant', content: 'Read memory', tool_calls: [
        { id: 'read-once', type: 'function', function: { name: 'read_memory', arguments: '{}' } },
      ],
    }) : success();
    const t = target();
    await run(t);
    expect(t.sent.filter((m) => m.type === 'error')).toEqual([]);
    expect(requests).toHaveLength(3);
    expect(t.sent.filter((m) => m.type === 'tool_start')).toHaveLength(1);
    expect(t.sent.filter((m) => m.type === 'tool_result')).toHaveLength(1);
    expect(requests[2].messages).toEqual(sanitizeMessages(requests[2].messages));
    expect(requests[2].messages.at(-1)?.tool_call_id).toBe('read-once');
    expect(t.sent.filter((m) => m.type === 'notice' && String(m.message).includes('earlier history'))).toHaveLength(1);
    expect(usageTotalsByDialogue().get(t.session.dialogueId)?.calls).toBe(2);
  });

  it.each([false, true])('surfaces a second overflow instead of looping, plan=%s', async (planMode) => {
    respond = () => overflow();
    const t = target();
    await run(t, planMode);
    expect(requests).toHaveLength(2);
    expect(t.sent.filter((m) => m.type === 'error')).toHaveLength(1);
    expect(t.sent.filter((m) => m.type === 'message')).toEqual([]);
    expect(getDialogue(t.session.dialogueId)!.messages).toHaveLength(t.history.length + 1);
  });

  it('does not retry unrelated errors or overflow errors after streaming has started', async () => {
    for (const response of [
      new Response('invalid tool call', { status: 400 }),
      new Response('data: {"choices":[{"delta":{"content":"Partial reply"}}]}\n\ndata: {"error":{"code":"context_length_exceeded"}}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      }),
    ]) {
      requests.length = 0;
      respond = () => response;
      const t = target();
      await run(t);
      expect(requests).toHaveLength(1);
      expect(t.sent.filter((m) => m.type === 'error')).toHaveLength(1);
    }
  });

  it('does not retry when the user stops the rejected request', async () => {
    const t = target();
    respond = () => { t.session.stop(); return overflow(); };
    await run(t);
    expect(requests).toHaveLength(1);
    expect(t.sent.some((m) => m.type === 'done' && m.stopped)).toBe(true);
    expect(t.sent.filter((m) => m.type === 'error')).toEqual([]);
  });

  it('sends no notices on short histories and reports oversized current requests before HTTP', async () => {
    const t = target(false, 'ru');
    await run(t);
    expect(t.sent.filter((m) => m.type === 'notice')).toEqual([]);
    t.session.handleClientMessage({ type: 'message', content: 'я'.repeat(300000) });
    await vi.waitFor(() => expect(t.session.isRunning).toBe(false));
    expect(requests).toHaveLength(1);
    expect(t.sent.find((m) => m.type === 'error')?.message).toContain('не помещаются');
  });
});
