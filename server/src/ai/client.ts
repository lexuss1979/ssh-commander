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
  /** Зашифрованный контекст Responses для следующих шагов и восстановления. */
  responsesContext?: ResponsesContext;
}

export interface StreamOptions {
  messages: ChatMessage[];
  tools?: ToolDef[];
  signal?: AbortSignal;
  onToken?: (token: string) => void;
  onToolCalls?: (calls: ToolCall[]) => void;
  /** Язык сессии агента — для пользовательски-видимых ошибок API. */
  lang?: PromptLang;
  /**
   * Стабильный id диалога для sticky-routing у провайдеров вроде OpenCode Go
   * (`x-opencode-session`). Без него Go отвечает 400 MissingSessionID.
   * Переиспользуется на всех шагах одного диалога (чат и plan).
   */
  sessionId?: string;
}

/** Собственное имя клиента без жёстко заданной версии, устаревающей при релизе. */
const USER_AGENT = 'ssh-commander';

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
  // Провайдер не должен возвращать ключ, но даже отражённый ключ не попадёт в UI.
  if (apiKey) message = message.replaceAll(apiKey, '[redacted]');
  return new Error(aiStr(lang, 'apiResponseError', {
    message: message.trim().slice(0, 500) || aiStr(lang, 'apiErrorUnknown'),
  }));
}

function assertNonemptyMessage(message: ChatMessage, lang: PromptLang): void {
  if (!message.content?.trim() && !message.tool_calls?.length) {
    throw new Error(aiStr(lang, 'apiEmptyResponse'));
  }
}

function normalizeMessage(data: Record<string, unknown>, lang: PromptLang, apiKey: string): ChatMessage {
  if (data.error || data.type === 'error') throw responseError(data.error ?? data, lang, apiKey);
  const choice = (data.choices as Array<{ message: ChatMessage }> | undefined)?.[0];
  if (!choice?.message) {
    throw new Error('AI API returned no message');
  }
  assertNonemptyMessage(choice.message, lang);
  return choice.message;
}

function normalizeResponse(
  data: Record<string, unknown>, lang: PromptLang, apiKey: string, model: string, apiBase: string,
): ChatCompletionResult {
  if (data.error || data.status === 'failed') throw responseError(data.error, lang, apiKey);
  if (data.status !== 'completed') throw new Error(aiStr(lang, 'apiIncompleteResponse'));
  const message = parseResponsesMessage(data, model, apiBase, lang);
  assertNonemptyMessage(message, lang);
  const usage = data.usage as Record<string, unknown> | undefined;
  return { message, usage: usage ? parseTokenUsage({ usage: {
    prompt_tokens: usage.input_tokens, completion_tokens: usage.output_tokens,
    prompt_tokens_details: usage.input_tokens_details, completion_tokens_details: usage.output_tokens_details,
  } }) : undefined };
}

/**
 * Потоковый клиент: Chat Completions, а для соответствующих моделей Go —
 * Responses. При обычном JSON-ответе использует разбор без стриминга.
 */
export async function streamChatCompletion(opts: StreamOptions): Promise<ChatCompletionResult> {
  // base/ключ/модель — только из settings.json (docs/settings-model-plan.md):
  // мержа с env больше нет, env сеется в settings при первом старте.
  const { provider, apiBase, apiKey, model } = getAiSettings();
  const lang = opts.lang ?? 'ru';
  // Пресет Go поддерживает и прокси; старый custom — официальный адрес Go.
  const usesOpenCodeGo = provider === 'opencode-go' || (provider === 'custom' && isOpenCodeGoBase(apiBase));
  const usesResponses = usesOpenCodeGo && usesGoResponses(model);
  const url = `${apiBase}/${usesResponses ? 'responses' : 'chat/completions'}`;
  const body = JSON.stringify(usesResponses ? buildResponsesBody(opts, model, apiBase) : {
    model,
    // Go отклоняет верхнеуровневое name у сообщений. Результат инструмента
    // связан с вызовом через tool_call_id; имена самих функций сохраняются.
    // Историю не меняем — адаптируем только исходящий запрос, включая старые диалоги.
    messages: opts.messages.map(({ responsesContext: _context, ...message }) =>
      usesOpenCodeGo ? { ...message, name: undefined } : message),
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
    () => connectTimeout.abort(new Error(aiStr(opts.lang ?? 'ru', 'apiTimeout'))),
    120_000,
  );
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, connectTimeout.signal])
    : connectTimeout.signal;

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${apiKey}`,
    'user-agent': USER_AGENT,
  };
  // Другим провайдерам ID диалога не отправляется.
  if (opts.sessionId && usesOpenCodeGo) {
    headers['x-opencode-session'] = opts.sessionId;
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
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
    if (usesResponses) return normalizeResponse(data, lang, apiKey, model, apiBase);
    return { message: normalizeMessage(data, lang, apiKey), usage: parseTokenUsage(data) };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let usage: TokenUsage | undefined;
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
      // Пропускаем только битый JSON; ошибки провайдера и обработчиков не глушим.
      if (name === 'error') throw responseError(payload, lang, apiKey);
      return;
    }
    const json = data && typeof data === 'object' ? data as Record<string, unknown> : {};
    if (name === 'error' || json.error || json.type === 'error') {
      throw responseError(json.error ?? (typeof data === 'string' ? data : json), lang, apiKey);
    }
    if (usesResponses) {
      const type = json.type ?? name;
      if ((type === 'response.output_text.delta' || type === 'response.refusal.delta') && typeof json.delta === 'string') {
        opts.onToken?.(json.delta);
      } else if (type === 'response.completed') {
        completedResponse = json.response as Record<string, unknown> | undefined;
        finished = true;
      } else if (type === 'response.failed' || type === 'response.incomplete') {
        const response = json.response as Record<string, unknown> | undefined;
        if (type === 'response.failed') throw responseError(response?.error, lang, apiKey);
        throw new Error(aiStr(lang, 'apiIncompleteResponse'));
      }
      return;
    }
    // Финальный usage-чанк может приходить с пустым choices.
    const chunkUsage = parseTokenUsage(json);
    if (chunkUsage) usage = chunkUsage;
    const delta = (json.choices as Array<{ delta: Record<string, unknown> }> | undefined)?.[0]?.delta;
    if (!delta) return;
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
        // Некоторые совместимые API закрывают поток без последнего перевода строки.
        if (!finished) {
          if (buffer) consumeLine(buffer.replace(/\r$/, ''));
          dispatchEvent();
        }
        break;
      }
    }
  } finally {
    // Закрываем HTTP-стрим и при ошибке, и при [DONE] без закрытия соединения.
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  if (usesResponses) {
    if (!completedResponse) throw new Error(aiStr(lang, 'apiInterruptedResponse'));
    const result = normalizeResponse(completedResponse, lang, apiKey, model, apiBase);
    if (result.message.tool_calls?.length) opts.onToolCalls?.(result.message.tool_calls);
    return result;
  }
  const finalCalls = calls.filter(Boolean);
  assertNonemptyMessage({ role: 'assistant', content, tool_calls: finalCalls }, lang);
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

