import { config } from '../config.js';

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
export async function streamChatCompletion(opts: StreamOptions): Promise<ChatMessage> {
  const url = `${config.ai.apiBase}/chat/completions`;
  const body = JSON.stringify({
    model: config.ai.model,
    messages: opts.messages,
    tools: opts.tools,
    tool_choice: opts.tools?.length ? 'auto' : undefined,
    temperature: config.ai.temperature,
    stream: true,
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
        authorization: `Bearer ${config.ai.apiKey}`,
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
    return normalizeMessage(data);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
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
    role: 'assistant',
    content: content || null,
    tool_calls: finalCalls.length ? finalCalls : undefined,
  };
}

