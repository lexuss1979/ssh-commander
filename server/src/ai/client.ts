import { config } from '../config.js';
import { getAiSettings, isOpenCodeGoBase } from '../services/settings.js';
import { aiStr } from './strings.js';
import type { PromptLang } from './prompts.js';
import { buildResponsesBody, parseResponsesMessage, usesGoResponses, type ResponsesContext } from './responses.js';

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
  /** Encrypted Responses context for the following steps and for recovery. */
  responsesContext?: ResponsesContext;
}

export interface StreamOptions {
  messages: ChatMessage[];
  tools?: ToolDef[];
  signal?: AbortSignal;
  onToken?: (token: string) => void;
  onToolCalls?: (calls: ToolCall[]) => void;
  /** Each completed attempt, including empty responses; never aggregate this again in the caller. */
  onUsage?: (usage: TokenUsage, model: string) => void;
  /** The agent session lang — for user-visible API errors. */
  lang?: PromptLang;
  /**
   * Stable dialogue id for sticky routing at providers like OpenCode Go
   * (`x-opencode-session`). Without it Go replies 400 MissingSessionID.
   * Reused across all steps of one dialogue (chat and plan).
   */
  sessionId?: string;
}

/** The client's own name, without a hard-coded version that would go stale on releases. */
const USER_AGENT = 'ssh-commander';

/** Only an HTTP rejection before streaming is eligible for a context retry. */
export class ContextOverflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContextOverflowError';
  }
}

function isContextOverflow(detail: string): boolean {
  return /maximum context length|context_length_exceeded|context window|too many tokens/i.test(detail);
}

/**
 * Call tokens from the API response's `usage` (docs/ai-costs-plan.md,
 * decision 1). Numbers are finite ≥ 0 only: provider garbage (a string,
 * NaN, a negative) drops the field. Invariants: cached ⊂ prompt,
 * reasoning ⊂ completion (enforced at capture — by clamping).
 */
export interface TokenUsage {
  promptTokens?: number;
  cachedTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
}

/** A composite return: usage is not put into ChatMessage, so it cannot end up
 * in this.messages and in the persisted dialogue (agent.ts). */
export interface ChatCompletionResult {
  message: ChatMessage;
  /** Sum of completed attempts; callers using onUsage must not record this again. */
  usage?: TokenUsage;
}

/** Only an empty, parsed response is eligible for an empty-response retry. */
export class EmptyResponseError extends Error {
  constructor(
    lang: PromptLang,
    public readonly finishReason?: string,
    public readonly hadReasoning = false,
    public readonly usage?: TokenUsage,
  ) {
    super(aiStr(lang, finishReason === 'content_filter' ? 'apiContentFiltered'
      : finishReason === 'length' ? 'apiLengthTruncated' : 'apiEmptyResponse'));
    this.name = 'EmptyResponseError';
  }
}

function nonnegInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;
}

/**
 * Parsing the top-level `usage` of an OpenAI-compatible response.
 * Mapping: prompt_tokens / prompt_tokens_details.cached_tokens /
 * completion_tokens / completion_tokens_details.reasoning_tokens.
 * DeepSeek cache hits arrive as `prompt_cache_hit_tokens` (without
 * prompt_tokens_details) — read as a fallback for cachedTokens.
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
  // Usage invariants: cached ⊂ prompt, reasoning ⊂ completion — keep them
  // by clamping, so the price formula (subtraction) cannot go negative.
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

function responseError(detail: unknown, lang: PromptLang, apiKey: string): Error {
  let message: string;
  if (typeof detail === 'string') {
    message = detail;
  } else if (detail && typeof detail === 'object') {
    const error = detail as Record<string, unknown>;
    message = [error.code ?? error.type, error.message]
      .filter((value) => typeof value === 'string' && value !== 'error')
      .join(': ');
  } else {
    message = '';
  }
  // The provider must not echo the key, but even a reflected key never reaches the UI.
  if (apiKey) message = message.replaceAll(apiKey, '[redacted]');
  return new Error(aiStr(lang, 'apiResponseError', {
    message: message.trim().slice(0, 500) || aiStr(lang, 'apiErrorUnknown'),
  }));
}

function assertNonemptyMessage(
  message: ChatMessage, lang: PromptLang, finishReason?: string, hadReasoning = false, usage?: TokenUsage,
): void {
  if (!message.content?.trim() && !message.tool_calls?.length) {
    throw new EmptyResponseError(lang, finishReason, hadReasoning, usage);
  }
}

function normalizeMessage(data: Record<string, unknown>, lang: PromptLang, apiKey: string): ChatMessage {
  if (data.error || data.type === 'error') throw responseError(data.error ?? data, lang, apiKey);
  const choice = (data.choices as Array<{ message: ChatMessage & { reasoning_content?: unknown }; finish_reason?: unknown }> | undefined)?.[0];
  if (!choice?.message) {
    throw new EmptyResponseError(lang, undefined, false, parseTokenUsage(data));
  }
  const { reasoning_content: reasoning, ...message } = choice.message;
  assertNonemptyMessage(message, lang, typeof choice.finish_reason === 'string' ? choice.finish_reason : undefined,
    typeof reasoning === 'string' && reasoning.length > 0, parseTokenUsage(data));
  return message;
}

function normalizeResponse(
  data: Record<string, unknown>, lang: PromptLang, apiKey: string, model: string, apiBase: string,
  streamedReasoning = false,
): ChatCompletionResult {
  if (data.error || data.status === 'failed') throw responseError(data.error, lang, apiKey);
  if (data.status !== 'completed' && data.status !== 'incomplete') throw new Error(aiStr(lang, 'apiIncompleteResponse'));
  const message = parseResponsesMessage(data, model, apiBase, lang);
  const rawUsage = data.usage as Record<string, unknown> | undefined;
  const usage = rawUsage ? parseTokenUsage({ usage: {
    prompt_tokens: rawUsage.input_tokens, completion_tokens: rawUsage.output_tokens,
    prompt_tokens_details: rawUsage.input_tokens_details, completion_tokens_details: rawUsage.output_tokens_details,
  } }) : undefined;
  const reason = (data.incomplete_details as { reason?: unknown } | undefined)?.reason;
  const finishReason = reason === 'max_output_tokens' ? 'length' : typeof reason === 'string' ? reason : undefined;
  const hadReasoning = streamedReasoning || (Array.isArray(data.output) && data.output.some((item) => item?.type === 'reasoning'));
  assertNonemptyMessage(message, lang, finishReason, hadReasoning, usage);
  // Partial text or tool calls must never be replayed or executed.
  if (data.status !== 'completed') throw new Error(aiStr(lang, 'apiIncompleteResponse'));
  return { message, usage };
}

/**
 * A transport-level fetch failure (undici `TypeError: fetch failed`): the
 * real reason (DNS, ECONNRESET, TLS...) sits in `err.cause` — surface it
 * instead of the bare "fetch failed".
 */
function describeFetchFailure(err: unknown, lang: PromptLang): Error {
  const cause = (err as { cause?: unknown } | null)?.cause;
  const detail =
    cause instanceof Error && cause.message
      ? cause.message
      : String((err as Error | null)?.message ?? err);
  return new Error(aiStr(lang, 'apiNetworkError', { detail: detail.slice(0, 300) }));
}

/** undici signals transport failures with a TypeError; aborts and timeouts
 * come through as the AbortSignal reason (DOMException or our own Error). */
function isTransportFailure(err: unknown): boolean {
  return err instanceof TypeError;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Retrying here never repeats tools or consumes an agent step. */
export async function streamChatCompletion(opts: StreamOptions): Promise<ChatCompletionResult> {
  const settings = getAiSettings();
  let usage: TokenUsage | undefined;
  let previousReason: string | undefined;
  const captureUsage = (next?: TokenUsage): void => {
    if (!next) return;
    usage ??= {};
    for (const key of ['promptTokens', 'cachedTokens', 'completionTokens', 'reasoningTokens'] as const) {
      if (next[key] !== undefined) usage[key] = (usage[key] ?? 0) + next[key];
    }
    opts.onUsage?.(next, settings.model);
  };
  for (let attempt = 0; ; attempt++) {
    opts.signal?.throwIfAborted();
    let emittedText = false;
    let leadingWhitespace = '';
    let result: ChatCompletionResult;
    try {
      result = await streamChatCompletionOnce({ ...opts, onToken: (token) => {
        // Empty attempts must leave no whitespace behind in the live UI.
        if (!emittedText) {
          leadingWhitespace += token;
          if (!leadingWhitespace.trim()) return;
          token = leadingWhitespace;
          leadingWhitespace = '';
          emittedText = true;
        }
        opts.onToken?.(token);
      } }, settings);
    } catch (err) {
      if (!(err instanceof EmptyResponseError)) throw err;
      captureUsage(err.usage);
      opts.signal?.throwIfAborted();
      const retry = attempt < 2 && !emittedText
        && !(err.finishReason === 'content_filter' && previousReason === 'content_filter');
      // Log metadata only: never prompts, keys, or reasoning text.
      console.warn('AI API empty response:', {
        sessionId: opts.sessionId, attempt: attempt + 1, retry,
        finishReason: (settings.apiKey ? err.finishReason?.replaceAll(settings.apiKey, '[redacted]') : err.finishReason)?.slice(0, 100),
        hadReasoning: err.hadReasoning,
      });
      if (!retry) throw err;
      previousReason = err.finishReason;
      await delay(attempt === 0 ? 2000 : 5000, opts.signal);
      continue;
    }
    captureUsage(result.usage);
    return { message: result.message, usage };
  }
}

/**
 * Streaming client: Chat Completions, and Responses for the matching Go
 * models. On a plain JSON response it parses without streaming.
 */
async function streamChatCompletionOnce(opts: StreamOptions, settings: ReturnType<typeof getAiSettings>): Promise<ChatCompletionResult> {
  // base/key/model — from settings.json only (docs/settings-model-plan.md):
  // there is no env merge anymore; env is seeded into settings at first start.
  const { provider, apiBase, apiKey, model } = settings;
  const lang = opts.lang ?? 'ru';
  // The Go preset also supports proxies; the legacy custom — the official Go address.
  const usesOpenCodeGo = provider === 'opencode-go' || (provider === 'custom' && isOpenCodeGoBase(apiBase));
  const usesResponses = usesOpenCodeGo && usesGoResponses(model);
  const url = `${apiBase}/${usesResponses ? 'responses' : 'chat/completions'}`;
  const body = JSON.stringify(usesResponses ? buildResponsesBody(opts, model, apiBase) : {
    model,
    // Go rejects a top-level name on messages. A tool result is tied to the
    // call via tool_call_id; the function names themselves are kept.
    // The history is not modified — only the outgoing request is adapted,
    // including old dialogues.
    messages: opts.messages.map(({ responsesContext: _context, ...message }) =>
      usesOpenCodeGo ? { ...message, name: undefined } : message),
    tools: opts.tools,
    tool_choice: opts.tools?.length ? 'auto' : undefined,
    temperature: config.ai.temperature,
    stream: true,
    // The final usage chunk (choices: [], usage: {...}) is the only source of
    // tokens when streaming; without include_usage it is not sent.
    stream_options: { include_usage: true },
  });

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${apiKey}`,
    'user-agent': USER_AGENT,
  };
  // The dialogue id is not sent to other providers.
  if (opts.sessionId && usesOpenCodeGo) {
    headers['x-opencode-session'] = opts.sessionId;
  }

  // The timeout covers only establishing the connection and receiving the
  // headers (the first response byte): once the SSE stream starts it is
  // lifted, because streaming the answer itself may take long. A user stop
  // (opts.signal) keeps working for the whole duration of the request.
  const fetchOnce = (): Promise<Response> => {
    const connectTimeout = new AbortController();
    const timer = setTimeout(
      () => connectTimeout.abort(new Error(aiStr(lang, 'apiTimeout'))),
      120_000,
    );
    const signal = opts.signal
      ? AbortSignal.any([opts.signal, connectTimeout.signal])
      : connectTimeout.signal;
    return fetch(url, { method: 'POST', headers, body, signal }).finally(() => clearTimeout(timer));
  };

  // One retry of a pure transport failure (DNS/TCP/TLS — no response was
  // received, the stream never started, so a repeat cannot duplicate tokens).
  // Aborts (user stop, the connect timeout) and HTTP error statuses are not
  // retried. The final failure is logged: the agent loop reports errors only
  // to the UI, without the server log there is nothing to diagnose.
  let res: Response;
  try {
    res = await fetchOnce();
  } catch (err) {
    if (!isTransportFailure(err) || opts.signal?.aborted) {
      if (isTransportFailure(err)) console.warn('AI API transport failure:', describeFetchFailure(err, lang).message);
      throw err;
    }
    console.warn('AI API transport failure, retrying once in 2 s:', describeFetchFailure(err, lang).message);
    await delay(2000, opts.signal);
    try {
      res = await fetchOnce();
    } catch (retryErr) {
      const described = isTransportFailure(retryErr) ? describeFetchFailure(retryErr, lang) : retryErr;
      console.warn('AI API transport failure (final):', (described as Error).message ?? described);
      throw described;
    }
  }

  if (!res.ok || !res.body) {
    const raw = await res.text().catch(() => '');
    const detail = apiKey ? raw.replaceAll(apiKey, '[redacted]') : raw;
    const message = `AI API error ${res.status}${detail ? `: ${detail.slice(0, 500)}` : ''}`;
    if (res.status === 400 && isContextOverflow(detail)) throw new ContextOverflowError(message);
    throw new Error(message);
  }

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream')) {
    const data = (await res.json()) as Record<string, unknown>;
    if (usesResponses) return normalizeResponse(data, lang, apiKey, model, apiBase);
    return { message: normalizeMessage(data, lang, apiKey), usage: parseTokenUsage(data) };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let usage: TokenUsage | undefined;
  let finishReason: string | undefined;
  let hadReasoning = false;
  const calls: ToolCall[] = [];
  let eventName = '';
  let eventData: string[] = [];
  let finished = false;
  let completedResponse: Record<string, unknown> | undefined;

  function dispatchEvent(): void {
    const name = eventName;
    const payload = eventData.join('\n').trim();
    eventName = '';
    eventData = [];
    if (name !== 'error' && (!payload || payload === '[DONE]')) {
      if (payload === '[DONE]') finished = true;
      return;
    }
    let data: unknown;
    try {
      data = JSON.parse(payload);
    } catch {
      // Only broken JSON is skipped; provider and handler errors are never muted.
      if (name === 'error') throw responseError(payload, lang, apiKey);
      return;
    }
    const json = data && typeof data === 'object' ? data as Record<string, unknown> : {};
    if (name === 'error' || json.error || json.type === 'error') {
      throw responseError(json.error ?? (typeof data === 'string' ? data : json), lang, apiKey);
    }
    if (usesResponses) {
      const type = json.type ?? name;
      if ((typeof type === 'string' && type.startsWith('response.reasoning'))
        || (json.item as { type?: string } | undefined)?.type === 'reasoning') hadReasoning = true;
      if ((type === 'response.output_text.delta' || type === 'response.refusal.delta') && typeof json.delta === 'string') {
        opts.onToken?.(json.delta);
      } else if (type === 'response.completed' || type === 'response.incomplete') {
        const response = json.response as Record<string, unknown> | undefined;
        completedResponse = response && {
          ...response, status: type === 'response.incomplete' ? 'incomplete' : response.status ?? 'completed',
        };
        finished = true;
      } else if (type === 'response.failed') {
        const response = json.response as Record<string, unknown> | undefined;
        throw responseError(response?.error, lang, apiKey);
      }
      return;
    }
    // The final usage chunk may arrive with empty choices.
    const chunkUsage = parseTokenUsage(json);
    if (chunkUsage) usage = chunkUsage;
    const choice = (json.choices as Array<{ delta?: Record<string, unknown>; finish_reason?: unknown }> | undefined)?.[0];
    if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason;
    const delta = choice?.delta;
    if (!delta) return;
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) hadReasoning = true;
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
  }

  function consumeLine(line: string): void {
    if (!line) dispatchEvent();
    else if (line.startsWith('event:')) eventName = line.slice(6).trim();
    else if (line.startsWith('data:')) eventData.push(line.slice(5).replace(/^ /, ''));
  }

  try {
    while (!finished) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let nl: number;
      while (!finished && (nl = buffer.indexOf('\n')) >= 0) {
        consumeLine(buffer.slice(0, nl).replace(/\r$/, ''));
        buffer = buffer.slice(nl + 1);
      }
      if (done) {
        // Some compatible APIs close the stream without the final newline.
        if (!finished) {
          if (buffer) consumeLine(buffer.replace(/\r$/, ''));
          dispatchEvent();
        }
        break;
      }
    }
  } finally {
    // Close the HTTP stream both on error and on [DONE] without connection close.
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  if (usesResponses) {
    if (!completedResponse) throw new Error(aiStr(lang, 'apiInterruptedResponse'));
    const result = normalizeResponse(completedResponse, lang, apiKey, model, apiBase, hadReasoning);
    if (result.message.tool_calls?.length) opts.onToolCalls?.(result.message.tool_calls);
    return result;
  }
  const finalCalls = calls.filter(Boolean);
  assertNonemptyMessage({ role: 'assistant', content, tool_calls: finalCalls }, lang, finishReason, hadReasoning, usage);
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

