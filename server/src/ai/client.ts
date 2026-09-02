import { config } from '../config.js';
import { getAiSettings } from '../services/settings.js';

export interface ToolFunction {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolDef {
  type: 'function';
  function: ToolFunction;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface StreamOptions {
  messages: ChatMessage[];
  tools?: ToolDef[];
  signal?: AbortSignal;
  onToken?: (token: string) => void;
  onToolCalls?: (calls: ToolCall[]) => void;
}

/**
 * Токены вызова из `usage` ответа API (docs/ai-costs-plan.md, решение 1).
 * Числа — только конечные ≥ 0: мусор от провайдера (строка, NaN,
 * отрицательное) опускает поле. Инварианты: cached ⊂ prompt,
 * reasoning ⊂ completion (поддерживаются на захвате — клампом).
 */
export interface TokenUsage {
  promptTokens?: number;
  cachedTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
}

/** Составной возврат: usage не кладётся в ChatMessage, чтобы не попасть
 * в this.messages и в persisted-диалог (agent.ts). */
export interface ChatCompletionResult {
  message: ChatMessage;
  usage?: TokenUsage;
}

function nonnegInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;
}

/**
 * Разбор верхнеуровневого `usage` OpenAI-совместимого ответа.
 * Маппинг: prompt_tokens / prompt_tokens_details.cached_tokens /
 * completion_tokens / completion_tokens_details.reasoning_tokens.
 * Кэш-хиты DeepSeek приходят как `prompt_cache_hit_tokens` (без
 * prompt_tokens_details) — читаем как fallback для cachedTokens.
 */
export function parseTokenUsage(data: Record<string, unknown>): TokenUsage | undefined {
  const usage = data.usage;
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as Record<string, unknown>;
  const promptTokens = nonnegInt(u.prompt_tokens);
  const completionTokens = nonnegInt(u.completion_tokens);
  if (promptTokens === undefined && completionTokens === undefined) return undefined;

  const details = u.prompt_tokens_details as Record<string, unknown> | undefined;
  const completionDetails = u.completion_tokens_details as Record<string, unknown> | undefined;
  let cachedTokens =
    nonnegInt(details?.cached_tokens) ?? nonnegInt(u.prompt_cache_hit_tokens);
  let reasoningTokens = nonnegInt(completionDetails?.reasoning_tokens);
  // Инварианты usage: cached ⊂ prompt, reasoning ⊂ completion — держим их
  // клампом, чтобы формула цен (вычитание) не уходила в минус.
  if (cachedTokens !== undefined && promptTokens !== undefined) {
    cachedTokens = Math.min(cachedTokens, promptTokens);
  }
  if (reasoningTokens !== undefined && completionTokens !== undefined) {
    reasoningTokens = Math.min(reasoningTokens, completionTokens);
  }

  const result: TokenUsage = {};
  if (promptTokens !== undefined) result.promptTokens = promptTokens;
  if (cachedTokens !== undefined) result.cachedTokens = cachedTokens;
  if (completionTokens !== undefined) result.completionTokens = completionTokens;
  if (reasoningTokens !== undefined) result.reasoningTokens = reasoningTokens;
  return result;
}

function normalizeMessage(data: Record<string, unknown>): ChatMessage {
  const choice = (data.choices as Array<{ message: ChatMessage }> | undefined)?.[0];
  if (!choice?.message) {
    throw new Error('AI API returned no message');
  }
  return choice.message;
}

/**
 * OpenAI-compatible Chat Completions with streaming. Falls back to a
 * non-streaming parse if the endpoint replies with a plain JSON body.
 */
export async function streamChatCompletion(opts: StreamOptions): Promise<ChatCompletionResult> {
  // base/ключ/модель — только из settings.json (docs/settings-model-plan.md):
  // мержа с env больше нет, env сеется в settings при первом старте.
  const { apiBase, apiKey, model } = getAiSettings();
  const url = `${apiBase}/chat/completions`;
  const body = JSON.stringify({
    model,
    messages: opts.messages,
    tools: opts.tools,
    tool_choice: opts.tools?.length ? 'auto' : undefined,
    temperature: config.ai.temperature,
    stream: true,
    // Финальный usage-чанк (choices: [], usage: {...}) — единственный источник
    // токенов при стриминге; без include_usage его нет.
    stream_options: { include_usage: true },
  });

  // Таймаут только на установление соединения и получение заголовков
  // (первый байт ответа): после начала SSE-стрима он снимается, так как
  // сам стриминг ответа может идти долго. Остановка пользователем
  // (opts.signal) продолжает работать на всём протяжении запроса.
  const connectTimeout = new AbortController();
  const timer = setTimeout(
    () => connectTimeout.abort(new Error('AI API не ответил за 120 секунд (таймаут ожидания ответа)')),
    120_000,
  );
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, connectTimeout.signal])
    : connectTimeout.signal;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body,
      signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    throw new Error(`AI API error ${res.status}${detail ? `: ${detail.slice(0, 500)}` : ''}`);
  }

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream')) {
    const data = (await res.json()) as Record<string, unknown>;
    return { message: normalizeMessage(data), usage: parseTokenUsage(data) };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let usage: TokenUsage | undefined;
  const calls: ToolCall[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload) as Record<string, unknown>;
        // usage читается независимо от choices: финальный usage-чанк приходит
        // с пустым choices и до этого пропускался строкой `if (!delta) continue`.
        const chunkUsage = parseTokenUsage(json);
        if (chunkUsage) usage = chunkUsage;
        const delta = (json.choices as Array<{ delta: Record<string, unknown> }> | undefined)?.[0]?.delta;
        if (!delta) continue;
        if (typeof delta.content === 'string' && delta.content) {
          content += delta.content;
          opts.onToken?.(delta.content);
        }
        const rawCalls = delta.tool_calls as
          | Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>
          | undefined;
        if (rawCalls) {
          for (const tc of rawCalls) {
            const index = tc.index ?? 0;
            let call = calls[index];
            if (!call) {
              call = {
                id: tc.id ?? `call_${index}`,
                type: 'function',
                function: { name: tc.function?.name ?? '', arguments: tc.function?.arguments ?? '' },
              };
              calls[index] = call;
            } else {
              if (tc.id) call.id = tc.id;
              if (tc.function?.name) call.function.name = tc.function.name;
              if (tc.function?.arguments) call.function.arguments += tc.function.arguments;
            }
          }
        }
      } catch {
        // Skip malformed SSE lines.
      }
    }
  }

  const finalCalls = calls.filter(Boolean);
  if (finalCalls.length) opts.onToolCalls?.(finalCalls);
  return {
    message: {
      role: 'assistant',
      content: content || null,
      tool_calls: finalCalls.length ? finalCalls : undefined,
    },
    usage,
  };
}

