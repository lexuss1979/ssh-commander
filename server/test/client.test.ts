import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

// До динамического импорта модуля: config читает env при загрузке.
process.env.AI_API_BASE = 'http://mock-api';
process.env.AI_API_KEY = 'test-key';
process.env.AI_MODEL = 'test-model';
process.env.AI_TEMPERATURE = '0.2';
// Изоляция settings.json: streamChatCompletion ходит через getAiConfig()
// (services/settings.ts) — пустой data-каталог даёт env-фолбэк.
const dataDir = mkdtempSync(path.join(tmpdir(), 'sc-client-'));
process.env.DATA_DIR = dataDir;

const client = await import('../src/ai/client.js');

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
  it('маппит OpenAI-usage: prompt/cached/completion/reasoning', () => {
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

  it('без usage → undefined; без валидных чисел → undefined', () => {
    expect(client.parseTokenUsage({})).toBeUndefined();
    expect(client.parseTokenUsage({ usage: null })).toBeUndefined();
    expect(
      client.parseTokenUsage({ usage: { prompt_tokens: 'x', completion_tokens: -1 } }),
    ).toBeUndefined();
  });

  it('мусор в числах (строка/отрицательное/NaN) — поле опускается', () => {
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

  it('инварианты: cached ⊂ prompt, reasoning ⊂ completion — кламп', () => {
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

  it('DeepSeek: prompt_cache_hit_tokens — fallback для cachedTokens', () => {
    const usage = client.parseTokenUsage({
      usage: {
        prompt_tokens: 100,
        prompt_cache_hit_tokens: 30,
        completion_tokens: 50,
      },
    });
    expect(usage).toEqual({ promptTokens: 100, cachedTokens: 30, completionTokens: 50 });
    // Явный prompt_tokens_details.cached_tokens приоритетнее.
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

describe('streamChatCompletion — захват usage (docs/ai-costs-plan.md, решение 1)', () => {
  it('SSE: usage читается из финального чанка {choices: [], usage}', async () => {
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

  it('SSE: usage отсутствует → usage undefined (провайдер без include_usage)', async () => {
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

  it('SSE: usage-чанк с мусором не ломает стрим и не даёт usage', async () => {
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

  it('non-stream fallback: верхнеуровневый usage пробрасывается', async () => {
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

  it('non-stream без usage → usage undefined', async () => {
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

  it('тело запроса содержит stream_options.include_usage', async () => {
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
    expect(body.stream_options).toEqual({ include_usage: true });
  });
});

function fetchMockArgs(): [string, RequestInit] {
  const call = (vi.mocked(fetch).mock.calls[0] ?? []) as unknown as [string, RequestInit];
  return call;
}
