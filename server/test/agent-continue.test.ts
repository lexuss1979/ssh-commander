import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { ChatMessage } from '../src/ai/client.js';
import type { Profile } from '../src/types.js';

// The "Continue" button after a step-limit stop (issue #5). The step-limit
// state is persisted on the dialogue, the WS `continue` frame starts a new
// loop with a fresh AI_MAX_STEPS budget and no new user turn, a repeated
// click during a run is ignored, and a failed continuation keeps the state so
// the button can be pressed again. Real AgentSession; only the external
// provider is stubbed.
const dataDir = mkdtempSync(path.join(tmpdir(), 'sc-agent-continue-'));
vi.stubEnv('DATA_DIR', dataDir);
// A two-step budget keeps the step-limit tests short and deterministic.
const MAX_STEPS = 2;
vi.stubEnv('AI_MAX_STEPS', String(MAX_STEPS));

const { AgentSession } = await import('../src/ai/agent.js');
const { createDialogue, getDialogue } = await import('../src/ai/dialogues.js');
const { saveSettings } = await import('../src/services/settings.js');

const profile: Profile = {
  id: 'continue-srv', name: 'Тестовый', host: 'test.local', port: 22,
  username: 'user', authType: 'password', dockerCommand: 'docker',
};

type RequestBody = { messages: ChatMessage[] };
const requests: RequestBody[] = [];
const replies: ChatMessage[] = [];
const sessions: InstanceType<typeof AgentSession>[] = [];

/** The happy provider: one JSON Chat Completions answer per request. */
function installFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init: RequestInit) => {
    requests.push(JSON.parse(init.body as string) as RequestBody);
    return new Response(
      JSON.stringify({ choices: [{ message: replies.shift() ?? { role: 'assistant', content: 'готово' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }));
}

beforeEach(() => {
  saveSettings({
    aiProvider: 'custom', aiApiKey: 'test-key', aiApiBase: 'http://mock-api', aiModel: 'test-model',
  });
  requests.length = 0;
  replies.length = 0;
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

type Target = ReturnType<typeof makeSession>;

function doneEvents(target: Target): Array<Record<string, unknown>> {
  return target.sent.filter((m) => m.type === 'done');
}

function errorEvents(target: Target): Array<Record<string, unknown>> {
  return target.sent.filter((m) => m.type === 'error');
}

async function waitForDone(target: Target, count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(doneEvents(target)).toHaveLength(count);
    expect(target.session.isRunning).toBe(false);
  }, { timeout: 3000 });
}

/** Runs the dialogue into the step limit: MAX_STEPS tool calls, no final answer. */
async function hitStepLimit(target: Target): Promise<void> {
  replies.push(
    toolCall('ls-1', 'list_servers', {}),
    toolCall('ls-2', 'list_servers', {}),
  );
  target.session.handleClientMessage({ type: 'message', content: 'проверь сервер' });
  await waitForDone(target, 1);
  expect(getDialogue(target.session.dialogueId)?.stepLimitReached).toBe(true);
}

describe('step-limit stop', () => {
  it('persists the state and reports it in done (the button survives a reload)', async () => {
    const target = makeSession(createDialogue(profile.id).id);
    await hitStepLimit(target);

    const done = doneEvents(target)[0];
    expect(done.stepLimit).toBe(true);
    expect(String(done.note)).toBe(`Достигнут лимит шагов (${MAX_STEPS}).`);
    // The budget is respected: exactly MAX_STEPS API steps, no extra request.
    expect(requests).toHaveLength(MAX_STEPS);
    // Persisted on the dialogue — the client restores the button from it.
    expect(getDialogue(target.session.dialogueId)?.stepLimitReached).toBe(true);
  });

  it('a normal completion does not set the state and done carries stepLimit: false', async () => {
    const target = makeSession(createDialogue(profile.id).id);
    target.session.handleClientMessage({ type: 'message', content: 'привет' });
    await waitForDone(target, 1);
    expect(doneEvents(target)[0].stepLimit).toBe(false);
    expect(getDialogue(target.session.dialogueId)?.stepLimitReached).toBeFalsy();
  });

  it('an API error does not set the state (no button on an error stop)', async () => {
    const target = makeSession(createDialogue(profile.id).id);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { message: 'provider down' } }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    )));
    target.session.handleClientMessage({ type: 'message', content: 'привет' });
    await vi.waitFor(() => expect(errorEvents(target)).toHaveLength(1));
    expect(errorEvents(target)[0].stepLimit).toBe(false);
    expect(getDialogue(target.session.dialogueId)?.stepLimitReached).toBeFalsy();
  });
});

describe('continue', () => {
  it('starts exactly one new loop with a fresh budget and no new user turn', async () => {
    const dialogue = createDialogue(profile.id);
    const target = makeSession(dialogue.id);
    await hitStepLimit(target);

    target.session.handleClientMessage({ type: 'continue' });
    await waitForDone(target, 2);

    // The continuation is one API request: a fresh MAX_STEPS budget starts
    // from zero and the default reply has no tool calls.
    expect(requests).toHaveLength(MAX_STEPS + 1);
    const continued = requests[MAX_STEPS].messages;
    // No synthetic user message: the history ends with the tool results of
    // the interrupted run, so the model picks the task up from there.
    expect(continued.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(continued.some((m) => m.role === 'user' && m.content === 'проверь сервер')).toBe(true);
    expect(continued[0].role).toBe('system');
    expect(continued[continued.length - 1].role).toBe('tool');
    expect(continued.filter((m) => m.role === 'tool')).toHaveLength(MAX_STEPS);
    // The run completed normally: the state is cleared for good.
    expect(doneEvents(target)[1].stepLimit).toBe(false);
    expect(getDialogue(dialogue.id)?.stepLimitReached).toBe(false);
  });

  it('a hit of the limit again re-arms the state', async () => {
    const dialogue = createDialogue(profile.id);
    const target = makeSession(dialogue.id);
    await hitStepLimit(target);

    // The continuation hits the same limit: a fresh budget of steps, then the
    // button is back.
    replies.push(
      toolCall('ls-3', 'list_servers', {}),
      toolCall('ls-4', 'list_servers', {}),
    );
    target.session.handleClientMessage({ type: 'continue' });
    await waitForDone(target, 2);
    expect(doneEvents(target)[1].stepLimit).toBe(true);
    expect(getDialogue(dialogue.id)?.stepLimitReached).toBe(true);
    expect(requests).toHaveLength(MAX_STEPS * 2);
  });

  it('a repeated click during a run is ignored (no second loop)', async () => {
    const target = makeSession(createDialogue(profile.id).id);
    await hitStepLimit(target);

    // Hold the continuation's API request: the run stays in flight.
    let release: (() => void) | null = null;
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init: RequestInit) => {
      requests.push(JSON.parse(init.body as string) as RequestBody);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return new Response(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'готово' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }));

    target.session.handleClientMessage({ type: 'continue' });
    await vi.waitFor(() => expect(target.session.isRunning).toBe(true));
    const runningBefore = target.sent.filter((m) => m.type === 'running').length;

    target.session.handleClientMessage({ type: 'continue' });
    target.session.handleClientMessage({ type: 'continue' });
    // No extra request was issued by the ignored clicks.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requests).toHaveLength(MAX_STEPS + 1);
    expect(target.sent.filter((m) => m.type === 'running')).toHaveLength(runningBefore);

    release?.();
    await waitForDone(target, 2);
    expect(requests).toHaveLength(MAX_STEPS + 1);
  });

  it('a reloaded session restores the state from the dialogue and continues', async () => {
    const dialogue = createDialogue(profile.id);
    const first = makeSession(dialogue.id);
    await hitStepLimit(first);
    first.session.stop();

    // A page reload: a fresh session on the same persisted dialogue.
    const restored = makeSession(dialogue.id);
    expect(getDialogue(dialogue.id)?.stepLimitReached).toBe(true);
    restored.session.handleClientMessage({ type: 'continue' });
    await waitForDone(restored, 1);
    expect(requests).toHaveLength(MAX_STEPS + 1);
    expect(doneEvents(restored)[0].stepLimit).toBe(false);
    expect(getDialogue(dialogue.id)?.stepLimitReached).toBe(false);
  });

  it('a failed continuation keeps the state and a retry succeeds', async () => {
    const dialogue = createDialogue(profile.id);
    const target = makeSession(dialogue.id);
    await hitStepLimit(target);

    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { message: 'provider down' } }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    )));
    target.session.handleClientMessage({ type: 'continue' });
    await vi.waitFor(() => expect(errorEvents(target)).toHaveLength(1));
    // The error keeps the state on the wire — the client can show the button
    // again and retry, which is exactly what the next block does.
    expect(errorEvents(target)[0].stepLimit).toBe(true);
    expect(getDialogue(dialogue.id)?.stepLimitReached).toBe(true);

    installFetch();
    target.session.handleClientMessage({ type: 'continue' });
    await waitForDone(target, 2);
    expect(doneEvents(target)[1].stepLimit).toBe(false);
    expect(getDialogue(dialogue.id)?.stepLimitReached).toBe(false);
  });

  it('a stale continue without the state is rejected and runs nothing', () => {
    const target = makeSession(createDialogue(profile.id).id);
    target.session.handleClientMessage({ type: 'continue' });
    expect(errorEvents(target)).toHaveLength(1);
    expect(errorEvents(target)[0].message).toBe(
      'Продолжение недоступно: агент не останавливался из-за лимита шагов.',
    );
    expect(errorEvents(target)[0].stepLimit).toBe(false);
    expect(requests).toHaveLength(0);
    expect(target.session.isRunning).toBe(false);
  });

  it('a new user turn resolves the pending continuation', async () => {
    const dialogue = createDialogue(profile.id);
    const target = makeSession(dialogue.id);
    await hitStepLimit(target);

    target.session.handleClientMessage({ type: 'message', content: 'другая задача' });
    await waitForDone(target, 2);
    expect(getDialogue(dialogue.id)?.stepLimitReached).toBe(false);
    // The new turn is a regular user message on top of the old history.
    expect(requests[MAX_STEPS].messages.filter((m) => m.role === 'user')).toHaveLength(2);
    expect(doneEvents(target)[1].stepLimit).toBe(false);
  });

  it('a user stop clears the state (no button after a deliberate stop)', async () => {
    const dialogue = createDialogue(profile.id);
    const target = makeSession(dialogue.id);
    await hitStepLimit(target);

    // The continuation request hangs until the user presses "Stop".
    vi.stubGlobal('fetch', vi.fn((_url: string | URL, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      requests.push(JSON.parse(init.body as string) as RequestBody);
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })));

    target.session.handleClientMessage({ type: 'continue' });
    await vi.waitFor(() => expect(requests).toHaveLength(MAX_STEPS + 1));
    target.session.handleClientMessage({ type: 'stop' });
    await vi.waitFor(() => {
      expect(doneEvents(target)).toHaveLength(2);
      expect(target.session.isRunning).toBe(false);
    });
    expect(doneEvents(target)[1].stopped).toBe(true);
    expect(doneEvents(target)[1].stepLimit).toBe(false);
    expect(getDialogue(dialogue.id)?.stepLimitReached).toBe(false);
  });
});
