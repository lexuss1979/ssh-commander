import type { ChatMessage, StreamOptions, ToolCall } from './client.js';
import type { PromptLang } from './prompts.js';
import { aiStr } from './strings.js';

/** Модели Go с Responses API: https://opencode.ai/docs/go/#endpoints. */
const GO_RESPONSES_MODELS = new Set([
  'gpt-6-luna', 'gpt-5.6-luna', 'grok-4.7', 'grok-4.6',
  'muse-spark-1.3-contributor', 'muse-spark-1.2-contributor',
]);

export function usesGoResponses(model: string): boolean {
  return GO_RESPONSES_MODELS.has(model);
}

/** Только непрозрачный контекст reasoning; текст рассуждений не сохраняется. */
export interface ResponsesContext {
  model: string;
  apiBase: string;
  items: Array<{
    type: 'reasoning';
    id: string;
    summary: [];
    encrypted_content: string;
  }>;
}

/** История остаётся локальной: каждый запрос содержит полный контекст. */
export function buildResponsesBody(opts: StreamOptions, model: string, apiBase: string): Record<string, unknown> {
  const input: Record<string, unknown>[] = [];
  for (const message of opts.messages) {
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: message.content ?? '' });
      continue;
    }
    if (message.role === 'assistant') {
      const context = message.responsesContext;
      // Зашифрованное состояние нельзя переносить в другую модель или API.
      if (context?.model === model && context.apiBase === apiBase) input.push(...context.items);
      if (message.content) input.push({ role: 'assistant', content: message.content });
      for (const call of message.tool_calls ?? []) {
        input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
      }
    } else {
      input.push({ role: message.role, content: message.content ?? '' });
    }
  }
  return {
    model, input, stream: true, store: false,
    include: ['reasoning.encrypted_content'],
    tools: opts.tools?.map(({ function: fn }) => ({ type: 'function', ...fn, strict: false })),
    tool_choice: opts.tools?.length ? 'auto' : undefined,
  };
}

/** Финальный output — источник текста и завершённых вызовов инструментов. */
export function parseResponsesMessage(data: Record<string, unknown>, model: string, apiBase: string, lang: PromptLang): ChatMessage {
  const output = Array.isArray(data.output) ? data.output as Record<string, unknown>[] : [];
  const texts: string[] = [];
  const calls: ToolCall[] = [];
  const items: ResponsesContext['items'] = [];
  for (const item of output) {
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content as Record<string, unknown>[]) {
        if (part.type === 'output_text' && typeof part.text === 'string') texts.push(part.text);
        if (part.type === 'refusal' && typeof part.refusal === 'string') texts.push(part.refusal);
      }
    } else if (item.type === 'function_call') {
      if (typeof item.call_id !== 'string' || !item.call_id || typeof item.name !== 'string' || !item.name
        || typeof item.arguments !== 'string') throw new Error(aiStr(lang, 'apiInvalidToolCall'));
      calls.push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } });
    } else if (item.type === 'reasoning' && typeof item.id === 'string' && typeof item.encrypted_content === 'string') {
      items.push({ type: 'reasoning', id: item.id, summary: [], encrypted_content: item.encrypted_content });
    }
  }
  return {
    role: 'assistant', content: texts.join('') || null,
    ...(calls.length ? { tool_calls: calls } : {}),
    ...(items.length ? { responsesContext: { model, apiBase, items } } : {}),
  };
}
