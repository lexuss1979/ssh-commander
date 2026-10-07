import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The AI config is read from settings.json only (epic 22: env mocks no longer
// work) — write settings via saveSettings into an isolated data directory.
process.env.AI_TEMPERATURE = '0.2';
const dataDir = mkdtempSync(path.join(tmpdir(), 'sc-client-'));
process.env.DATA_DIR = dataDir;

const client = await import('../src/ai/client.js');
const { saveSettings } = await import('../src/services/settings.js');

const defaultSettings = {
  aiProvider: 'custom' as const,
  aiApiKey: 'test-key',
  aiApiBase: 'http://mock-api',
  aiModel: 'test-model',
};
beforeEach(() => saveSettings(defaultSettings));

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(data: Record<string, unknown>): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function dataLine(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

describe('parseTokenUsage', () => {
  it('maps OpenAI usage: prompt/cached/completion/reasoning', () => {
    const usage = client.parseTokenUsage({
      usage: {
        prompt_tokens: 100,
        prompt_tokens_details: { cached_tokens: 20 },
        completion_tokens: 50,
        completion_tokens_details: { reasoning_tokens: 5 },
      },
    });
    expect(usage).toEqual({
      promptTokens: 100,
      cachedTokens: 20,
      completionTokens: 50,
      reasoningTokens: 5,
    });
  });

  it('no usage → undefined; no valid numbers → undefined', () => {
    expect(client.parseTokenUsage({})).toBeUndefined();
    expect(client.parseTokenUsage({ usage: null })).toBeUndefined();
    expect(
      client.parseTokenUsage({ usage: { prompt_tokens: 'x', completion_tokens: -1 } }),
    ).toBeUndefined();
  });

  it('garbage in numbers (string/negative/NaN) — the field is omitted', () => {
    const usage = client.parseTokenUsage({
      usage: {
        prompt_tokens: 100,
        prompt_tokens_details: { cached_tokens: 'many' },
        completion_tokens: -5,
        completion_tokens_details: { reasoning_tokens: NaN },
      },
    });
    expect(usage).toEqual({ promptTokens: 100 });
  });

  it('invariants: cached ⊂ prompt, reasoning ⊂ completion — clamped', () => {
    const usage = client.parseTokenUsage({
      usage: {
        prompt_tokens: 100,
        prompt_tokens_details: { cached_tokens: 500 },
        completion_tokens: 50,
        completion_tokens_details: { reasoning_tokens: 200 },
      },
    });
    expect(usage?.cachedTokens).toBe(100);
    expect(usage?.reasoningTokens).toBe(50);
  });

  it('DeepSeek: prompt_cache_hit_tokens — a fallback for cachedTokens', () => {
    const usage = client.parseTokenUsage({
      usage: {
        prompt_tokens: 100,
        prompt_cache_hit_tokens: 30,
        completion_tokens: 50,
      },
    });
    expect(usage).toEqual({ promptTokens: 100, cachedTokens: 30, completionTokens: 50 });
    // Explicit prompt_tokens_details.cached_tokens takes priority.
    const both = client.parseTokenUsage({
      usage: {
        prompt_tokens: 100,
        prompt_cache_hit_tokens: 30,
        prompt_tokens_details: { cached_tokens: 40 },
        completion_tokens: 50,
      },
    });
    expect(both?.cachedTokens).toBe(40);
  });
});

describe('streamChatCompletion — usage capture (docs/ai-costs-plan.md, decision 1)', () => {
  it('SSE: usage is read from the final {choices: [], usage} chunk', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        dataLine({ choices: [{ delta: { content: 'Привет' } }] }),
        dataLine({
          choices: [],
          usage: {
            prompt_tokens: 100,
            prompt_tokens_details: { cached_tokens: 20 },
            completion_tokens: 50,
            completion_tokens_details: { reasoning_tokens: 5 },
          },
        }),
        'data: [DONE]\n\n',
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { message, usage } = await client.streamChatCompletion({
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(message.content).toBe('Привет');
    expect(usage).toEqual({
      promptTokens: 100,
      cachedTokens: 20,
      completionTokens: 50,
      reasoningTokens: 5,
    });
  });

  it('SSE: no usage → usage undefined (a provider without include_usage)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseResponse([dataLine({ choices: [{ delta: { content: 'ok' } }] }), 'data: [DONE]\n\n']),
      ),
    );
    const { message, usage } = await client.streamChatCompletion({
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(message.content).toBe('ok');
    expect(usage).toBeUndefined();
  });

  it('SSE: a garbage usage chunk does not break the stream and yields no usage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseResponse([
          dataLine({ choices: [{ delta: { content: 'ok' } }] }),
          dataLine({ choices: [], usage: { prompt_tokens: 'x' } }),
          'data: [DONE]\n\n',
        ]),
      ),
    );
    const result = await client.streamChatCompletion({
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.message.content).toBe('ok');
    expect(result.usage).toBeUndefined();
  });

  it('non-stream fallback: top-level usage is passed through', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          choices: [{ message: { role: 'assistant', content: 'готово' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      ),
    );
    const { message, usage } = await client.streamChatCompletion({
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(message.content).toBe('готово');
    expect(usage).toEqual({ promptTokens: 10, completionTokens: 5 });
  });

  it('non-stream without usage → usage undefined', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ choices: [{ message: { role: 'assistant', content: 'готово' } }] }),
      ),
    );
    const result = await client.streamChatCompletion({
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.usage).toBeUndefined();
  });

  it('the request body contains stream_options.include_usage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseResponse([dataLine({ choices: [{ delta: { content: 'ok' } }] }), 'data: [DONE]\n\n']),
      ),
    );
    await client.streamChatCompletion({ messages: [{ role: 'user', content: 'hi' }] });
    const [url, init] = fetchMockArgs();
    expect(url).toBe('http://mock-api/chat/completions');
    const body = JSON.parse(init.body as string);
    // base and model come from settings.json (env is no longer a source).
    expect(body.model).toBe('test-model');
    expect(body.stream_options).toEqual({ include_usage: true });
  });
});

describe('streamChatCompletion — errors inside HTTP 200', () => {
  it.each([
    dataLine({ error: { code: 'inference_failed', message: 'Upstream failed' } }),
    'event: error\n' + dataLine({ error: { type: 'inference_failed', message: 'Upstream failed' } }),
    'event: error\ndata: inference_failed: Upstream failed\n\n',
    'event: error\ndata: "inference_failed: Upstream failed"\n\n',
    'event: error\ndata: {"error":\ndata: {"code":"inference_failed","message":"Upstream failed"}}\n\n',
    dataLine({ type: 'error', code: 'inference_failed', message: 'Upstream failed' }).trimEnd(),
  ])('reports the provider error instead of an empty response: %s', async (frame) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([frame])));
    await expect(client.streamChatCompletion({ messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toThrow('Ошибка AI API: inference_failed: Upstream failed');
  });

  it.each([
    ['ru', 'Ошибка AI API: Провайдер сообщил об ошибке без описания.'],
    ['en', 'AI API error: The provider reported an error without details.'],
  ] as const)('event: error without details is localized (%s)', async (lang, expected) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(['event: error\ndata: {}\n\n'])));
    await expect(client.streamChatCompletion({ messages: [{ role: 'user', content: 'hi' }], lang }))
      .rejects.toThrow(expected);
  });

  it.each([
    '',
    'data: [DONE]\n\n',
    dataLine({ choices: [{ delta: { reasoning_content: 'скрытое рассуждение' } }] }) + 'data: [DONE]\n\n',
  ])('an empty stream or reasoning-only does not count as a successful response', async (frame) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([frame])));
    await expect(client.streamChatCompletion({ messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toThrow('AI API завершил ответ без текста и вызовов инструментов');
  });

  it('a JSON response with error at HTTP 200 keeps the error description', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: { message: 'inference_failed' } })));
    await expect(client.streamChatCompletion({ messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toThrow('Ошибка AI API: inference_failed');
  });

  it('an empty message in a JSON response is not a success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      choices: [{ message: { role: 'assistant', content: null } }],
    })));
    await expect(client.streamChatCompletion({ messages: [{ role: 'user', content: 'hi' }], lang: 'en' }))
      .rejects.toThrow('The AI API completed the response without text or tool calls');
  });

  it('an error after partial text is not swallowed and does not call onToolCalls', async () => {
    const onToken = vi.fn();
    const onToolCalls = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      dataLine({ choices: [{ delta: { content: 'начало' } }] }),
      dataLine({ error: { message: 'inference_failed' } }),
    ])));
    await expect(client.streamChatCompletion({ messages: [{ role: 'user', content: 'hi' }], onToken, onToolCalls }))
      .rejects.toThrow('inference_failed');
    expect(onToken).toHaveBeenCalledWith('начало');
    expect(onToolCalls).not.toHaveBeenCalled();
  });

  it('a provider error does not reflect the API key in the UI', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      dataLine({ error: { message: 'bad key test-key' } }),
    ])));
    await expect(client.streamChatCompletion({ messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toThrow('bad key [redacted]');
  });
});

describe('streamChatCompletion — transport failures', () => {
  const transportError = (causeMessage: string) =>
    Object.assign(new TypeError('fetch failed'), { cause: new Error(causeMessage) });

  it('a transport failure is retried once; a successful retry is transparent', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(transportError('connect ECONNRESET 1.2.3.4:443'))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { role: 'assistant', content: 'готово' } }] }));
    vi.stubGlobal('fetch', fetchMock);
    const { message } = await client.streamChatCompletion({ messages: [{ role: 'user', content: 'hi' }] });
    expect(message.content).toBe('готово');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 10000);

  it('a repeated transport failure surfaces the cause, not a bare "fetch failed"', async () => {
    const fetchMock = vi.fn().mockRejectedValue(transportError('getaddrinfo EAI_AGAIN mock-api'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(client.streamChatCompletion({ messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toThrow('Сбой сети при вызове AI API: getaddrinfo EAI_AGAIN mock-api');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 10000);

  it.each([
    ['ru', 'Сбой сети при вызове AI API: connect ECONNRESET'],
    ['en', 'Network failure while calling the AI API: connect ECONNRESET'],
  ] as const)('the transport failure message is localized (%s)', async (lang, expected) => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(transportError('connect ECONNRESET')));
    await expect(client.streamChatCompletion({ messages: [{ role: 'user', content: 'hi' }], lang }))
      .rejects.toThrow(expected);
  }, 10000);

  it('an abort (user stop) is not a transport failure and is not retried', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn().mockRejectedValue(controller.signal.reason);
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      client.streamChatCompletion({ messages: [{ role: 'user', content: 'hi' }], signal: controller.signal }),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('streamChatCompletion — SSE edge cases', () => {
  it('keeps the response when the stream ends without the final newline and across chunk boundaries', async () => {
    const frame = dataLine({ choices: [{ delta: { content: 'готово' } }] }).trimEnd();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([frame.slice(0, 17), frame.slice(17)])));
    expect((await client.streamChatCompletion({ messages: [{ role: 'user', content: 'hi' }] })).message.content)
      .toBe('готово');
  });

  it('skips broken JSON but keeps the next valid response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      'data: {broken\n\n', dataLine({ choices: [{ delta: { content: 'ok' } }] }),
    ])));
    expect((await client.streamChatCompletion({ messages: [{ role: 'user', content: 'hi' }] })).message.content)
      .toBe('ok');
  });

  it('a tool-call-only response is valid, arguments are assembled from chunks', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      dataLine({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'read_memory', arguments: '{' } }] } }] }),
      dataLine({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '}' } }] } }] }),
      'data: [DONE]\n\n',
    ])));
    const onToolCalls = vi.fn();
    const result = await client.streamChatCompletion({ messages: [{ role: 'user', content: 'hi' }], onToolCalls });
    expect(result.message.content).toBeNull();
    expect(result.message.tool_calls).toEqual([{
      id: 'call-1', type: 'function', function: { name: 'read_memory', arguments: '{}' },
    }]);
    expect(onToolCalls).toHaveBeenCalledWith(result.message.tool_calls);
  });

  it('[DONE] finishes reading even if the provider did not close the connection', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          dataLine({ choices: [{ delta: { content: 'ok' } }] }) + 'data: [DONE]\n\n',
        ));
      }, cancel,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, {
      headers: { 'content-type': 'text/event-stream' },
    })));
    expect((await client.streamChatCompletion({ messages: [{ role: 'user', content: 'hi' }] })).message.content)
      .toBe('ok');
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe('streamChatCompletion — provider session headers', () => {
  it.each([
    ['opencode-go', 'http://mock-api', true],
    ['custom', 'https://opencode.ai/zen/go/v1', true],
    ['custom', 'http://mock-api', false],
    ['deepseek', 'https://api.deepseek.com/v1', false],
    ['openai', 'https://api.openai.com/v1', false],
  ] as const)('%s: stripping name from messages for Go = %s', async (aiProvider, aiApiBase, stripName) => {
    saveSettings({ ...defaultSettings, aiProvider, aiApiBase });
    const call = { id: 'memory-call', type: 'function' as const, function: { name: 'read_memory', arguments: '{}' } };
    const messages: import('../src/ai/client.js').ChatMessage[] = [
      { role: 'user', content: 'прочитай память', name: 'user' },
      { role: 'assistant', content: null, tool_calls: [call] },
      { role: 'tool', tool_call_id: call.id, name: 'read_memory', content: 'memory contents' },
    ];
    const tools = [{ type: 'function' as const, function: { name: 'read_memory', description: 'Память', parameters: { type: 'object' } } }];
    const original = structuredClone(messages);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      choices: [{ message: { role: 'assistant', content: 'готово' } }],
    })));
    await client.streamChatCompletion({ messages, tools, sessionId: 'dialogue-123' });
    const body = JSON.parse(fetchMockArgs()[1].body as string);
    expect(Object.hasOwn(body.messages[0], 'name')).toBe(!stripName);
    expect(body.messages[2]).toEqual(stripName
      ? { role: 'tool', tool_call_id: call.id, content: 'memory contents' }
      : original[2]);
    expect(body.messages[1].tool_calls).toEqual([call]);
    expect(body.tools).toEqual(tools);
    expect(messages).toEqual(original);
  });

  it.each(['SSE', 'JSON'] as const)('%s: passes the dialogue ID and its own User-Agent', async (format) => {
    saveSettings({ ...defaultSettings, aiProvider: 'opencode-go' });
    const response = format === 'SSE'
      ? sseResponse([dataLine({ choices: [{ delta: { content: 'ok' } }] }), 'data: [DONE]\n\n'])
      : jsonResponse({ choices: [{ message: { role: 'assistant', content: 'ok' } }] });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

    const result = await client.streamChatCompletion({
      messages: [{ role: 'user', content: 'hi' }],
      sessionId: 'dialogue-123',
    });

    const headers = new Headers(fetchMockArgs()[1].headers);
    expect(headers.get('x-opencode-session')).toBe('dialogue-123');
    // The version in the own User-Agent is optional.
    expect(headers.get('user-agent')).toMatch(/^ssh-commander(?:\/\S+)?$/);
    expect(headers.get('authorization')).toBe('Bearer test-key');
    expect(headers.get('content-type')).toBe('application/json');
    expect(result.message.content).toBe('ok');
  });

  it.each([undefined, ''])('without an ID (%s) no empty session header is sent', async (sessionId) => {
    saveSettings({ ...defaultSettings, aiProvider: 'opencode-go' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
    })));

    const result = await client.streamChatCompletion({
      messages: [{ role: 'user', content: 'hi' }], sessionId,
    });

    expect(new Headers(fetchMockArgs()[1].headers).has('x-opencode-session')).toBe(false);
    expect(result.message.content).toBe('ok');
  });

  it.each([
    ['custom', 'https://opencode.ai/zen/go/v1', true],
    ['custom', 'https://opencode.ai/zen/go/v1/', true],
    ['custom', 'https://opencode.ai.evil.example/zen/go/v1', false],
    ['custom', 'https://other.example/opencode.ai/zen/go/v1', false],
    ['custom', 'https://opencode.ai/zen/v1', false],
    ['custom', 'https://opencode.ai/zen/go/v10', false],
    ['custom', 'http://mock-api', false],
    ['deepseek', 'https://api.deepseek.com/v1', false],
    ['openai', 'https://api.openai.com/v1', false],
  ] as const)('%s (%s): Go header enabled = %s', async (aiProvider, aiApiBase, enabled) => {
    saveSettings({ ...defaultSettings, aiProvider, aiApiBase });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
    })));
    await client.streamChatCompletion({ messages: [{ role: 'user', content: 'hi' }], sessionId: 'dialogue-123' });
    const headers = new Headers(fetchMockArgs()[1].headers);
    expect(headers.get('x-opencode-session')).toBe(enabled ? 'dialogue-123' : null);
  });
});

function fetchMockArgs(): [string, RequestInit] {
  const call = (vi.mocked(fetch).mock.calls[0] ?? []) as unknown as [string, RequestInit];
  return call;
}

describe('streamChatCompletion — Responses for Go models', () => {
  const model = 'gpt-6-luna';
  const apiBase = 'http://mock-api';
  const reasoning = { type: 'reasoning' as const, id: 'rs-1', summary: [] as [], encrypted_content: 'encrypted-test-context' };
  const textItem = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] };
  const callItem = { type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'read_memory', arguments: '{}' };
  const completed = (output: unknown[] = [textItem]) => ({ status: 'completed', output });
  const completionEvent = (output: unknown[] = [textItem]) => dataLine({ type: 'response.completed', response: completed(output) });

  beforeEach(() => saveSettings({ ...defaultSettings, aiProvider: 'opencode-go', aiModel: model }));

  it.each([
    ['opencode-go', apiBase, model, '/responses'],
    ['opencode-go', apiBase, 'gpt-5.6-luna', '/responses'],
    ['opencode-go', apiBase, 'grok-4.7', '/responses'],
    ['opencode-go', apiBase, 'grok-4.6', '/responses'],
    ['opencode-go', apiBase, 'muse-spark-1.3-contributor', '/responses'],
    ['opencode-go', apiBase, 'muse-spark-1.2-contributor', '/responses'],
    ['custom', 'https://opencode.ai/zen/go/v1', model, '/responses'],
    ['opencode-go', apiBase, 'glm-5.3-flash', '/chat/completions'],
    ['custom', apiBase, model, '/chat/completions'],
    ['openai', 'https://api.openai.com/v1', model, '/chat/completions'],
  ] as const)('%s/%s/%s → %s', async (aiProvider, aiApiBase, aiModel, endpoint) => {
    saveSettings({ ...defaultSettings, aiProvider, aiApiBase, aiModel });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(endpoint === '/responses'
      ? completed() : { choices: [{ message: { role: 'assistant', content: 'OK' } }] })));
    expect((await client.streamChatCompletion({ messages: [{ role: 'user', content: 'hi' }], sessionId: 'same-session' })).message.content)
      .toBe('OK');
    expect(fetchMockArgs()[0]).toBe(aiApiBase + endpoint);
    if (endpoint === '/responses') {
      const headers = new Headers(fetchMockArgs()[1].headers);
      expect(headers.get('x-opencode-session')).toBe('same-session');
      expect(headers.get('user-agent')).toBe('ssh-commander');
    }
  });

  it('translates history, parallel calls and results without mutating the original messages', async () => {
    const messages: import('../src/ai/client.js').ChatMessage[] = [
      { role: 'system', content: 'system' }, { role: 'user', content: 'request', name: 'user' },
      { role: 'assistant', content: 'checking', responsesContext: { model, apiBase, items: [reasoning] }, tool_calls: [
        { id: 'call-1', type: 'function', function: { name: 'read_memory', arguments: '{}' } },
        { id: 'call-2', type: 'function', function: { name: 'list_servers', arguments: '{}' } },
      ] },
      { role: 'tool', tool_call_id: 'call-1', name: 'read_memory', content: 'memory' },
      { role: 'tool', tool_call_id: 'call-2', name: 'list_servers', content: 'servers' },
    ];
    const original = structuredClone(messages);
    const tools = [{ type: 'function' as const, function: { name: 'read_memory', description: 'Память', parameters: { type: 'object' } } }];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(completed())));
    await client.streamChatCompletion({ messages, tools });
    const body = JSON.parse(fetchMockArgs()[1].body as string);
    expect(body.input).toEqual([
      { role: 'system', content: 'system' }, { role: 'user', content: 'request' }, reasoning,
      { role: 'assistant', content: 'checking' },
      { type: 'function_call', call_id: 'call-1', name: 'read_memory', arguments: '{}' },
      { type: 'function_call', call_id: 'call-2', name: 'list_servers', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call-1', output: 'memory' },
      { type: 'function_call_output', call_id: 'call-2', output: 'servers' },
    ]);
    expect(body.tools).toEqual([{ type: 'function', ...tools[0].function, strict: false }]);
    expect(body.store).toBe(false);
    expect(body.include).toEqual(['reasoning.encrypted_content']);
    expect(body).not.toHaveProperty('messages');
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('stream_options');
    expect(body).not.toHaveProperty('previous_response_id');
    expect(messages).toEqual(original);
  });

  it('planning — without tools and tool_choice', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(completed())));
    await client.streamChatCompletion({ messages: [{ role: 'user', content: 'plan' }] });
    const body = JSON.parse(fetchMockArgs()[1].body as string);
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('tool_choice');
  });

  it('streams text and takes usage and the encrypted context from the final event', async () => {
    const onToken = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      dataLine({ type: 'response.reasoning_summary_text.delta', delta: 'НЕ ПОКАЗЫВАТЬ' }),
      dataLine({ type: 'response.output_text.delta', delta: 'O' }),
      dataLine({ type: 'response.output_text.delta', delta: 'K' }),
      dataLine({ type: 'response.completed', response: { ...completed([reasoning, textItem]), usage: {
        input_tokens: 20, output_tokens: 10, input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 7 },
      } } }).trimEnd(),
    ])));
    const result = await client.streamChatCompletion({ messages: [{ role: 'user', content: 'hi' }], onToken });
    expect(onToken.mock.calls).toEqual([['O'], ['K']]);
    expect(result.message).toEqual({ role: 'assistant', content: 'OK', responsesContext: { model, apiBase, items: [reasoning] } });
    expect(result.usage).toEqual({ promptTokens: 20, cachedTokens: 4, completionTokens: 10, reasoningTokens: 7 });
  });

  it('completed function_calls use call_id, arguments are not duplicated from delta', async () => {
    const onToolCalls = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      dataLine({ type: 'response.output_item.added', output_index: 1, item: { ...callItem, arguments: '' } }),
      dataLine({ type: 'response.function_call_arguments.delta', output_index: 1, delta: '{' }),
      dataLine({ type: 'response.function_call_arguments.delta', output_index: 1, delta: '}' }),
      completionEvent([reasoning, callItem, { ...callItem, id: 'fc-2', call_id: 'call-2', name: 'list_servers' }]),
    ])));
    const result = await client.streamChatCompletion({ messages: [{ role: 'user', content: 'hi' }], onToolCalls });
    expect(result.message.content).toBeNull();
    expect(result.message.tool_calls).toEqual([
      { id: 'call-1', type: 'function', function: { name: 'read_memory', arguments: '{}' } },
      { id: 'call-2', type: 'function', function: { name: 'list_servers', arguments: '{}' } },
    ]);
    expect(onToolCalls).toHaveBeenCalledExactlyOnceWith(result.message.tool_calls);
  });

  it.each([
    [dataLine({ type: 'response.failed', response: { error: { code: 'inference_failed' } } }), 'inference_failed'],
    [dataLine({ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }), 'не завершил'],
    [dataLine({ type: 'error', message: 'provider broke' }), 'provider broke'],
    [dataLine({ type: 'response.output_text.delta', delta: 'partial' }), 'прервался'],
    [dataLine({ type: 'response.output_item.added', item: callItem }) + 'data: [DONE]\n\n', 'прервался'],
    [completionEvent([]), 'без текста'],
    [completionEvent([{ ...callItem, call_id: undefined }]), 'некорректный вызов инструмента'],
  ])('does not execute tools and reports an error for an unsuccessful stream', async (frame, expected) => {
    const onToolCalls = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([frame])));
    await expect(client.streamChatCompletion({ messages: [{ role: 'user', content: 'hi' }], onToolCalls }))
      .rejects.toThrow(expected);
    expect(onToolCalls).not.toHaveBeenCalled();
  });

  it('response.completed finishes reading without closing the connection', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(completionEvent())); }, cancel,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, { headers: { 'content-type': 'text/event-stream' } })));
    expect((await client.streamChatCompletion({ messages: [{ role: 'user', content: 'hi' }] })).message.content).toBe('OK');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('JSON: a model refusal is visible as text, the reasoning summary is not kept', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(completed([
      { ...reasoning, summary: [{ type: 'summary_text', text: 'НЕ ПОКАЗЫВАТЬ' }] },
      { type: 'message', content: [{ type: 'refusal', refusal: 'Cannot comply' }] },
    ]))));
    const result = await client.streamChatCompletion({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result.message.content).toBe('Cannot comply');
    expect(result.message.responsesContext?.items).toEqual([reasoning]);
    expect(JSON.stringify(result)).not.toContain('НЕ ПОКАЗЫВАТЬ');
  });

  it.each([
    ['gpt-5.6-luna', apiBase],
    [model, 'http://other-api'],
  ])('does not send the encrypted context to another model or base', async (contextModel, contextBase) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(completed())));
    await client.streamChatCompletion({ messages: [{ role: 'assistant', content: 'old', responsesContext: {
      model: contextModel, apiBase: contextBase, items: [reasoning],
    } }] });
    expect(JSON.parse(fetchMockArgs()[1].body as string).input).toEqual([{ role: 'assistant', content: 'old' }]);
  });

  it('does not send Responses metadata to Chat Completions when the model changes', async () => {
    saveSettings(defaultSettings);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { role: 'assistant', content: 'OK' } }] })));
    await client.streamChatCompletion({ messages: [{ role: 'assistant', content: 'old', responsesContext: { model, apiBase, items: [reasoning] } }] });
    expect(JSON.parse(fetchMockArgs()[1].body as string).messages).toEqual([{ role: 'assistant', content: 'old' }]);
  });
});
