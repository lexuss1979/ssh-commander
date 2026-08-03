import type { ChatMessage } from './client.js';

/**
 * OpenAI requires every assistant message with `tool_calls` to be followed by
 * tool messages responding to each `tool_call_id`. A dangling exchange can end
 * up in the history when the agent is stopped, the WebSocket closes, or the
 * process dies while a tool call is in flight. Sending such history to the API
 * fails with HTTP 400 ("insufficient tool messages following tool_calls
 * message"). This trims incomplete trailing exchanges and orphaned tool
 * messages so the history is always a valid sequence.
 */
export function sanitizeMessages(messages: ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  let pendingIds = new Set<string>();
  let exchangeStart = -1;

  const rollback = (): void => {
    if (exchangeStart >= 0) {
      result.length = exchangeStart;
      pendingIds = new Set<string>();
      exchangeStart = -1;
    }
  };

  for (const message of messages) {
    if (message.role === 'assistant' && message.tool_calls?.length) {
      if (pendingIds.size > 0) {
        rollback();
      }
      exchangeStart = result.length;
      pendingIds = new Set(message.tool_calls.map((c) => c.id));
      result.push(message);
      continue;
    }
    if (message.role === 'tool') {
      const callId = message.tool_call_id ?? '';
      if (pendingIds.has(callId)) {
        pendingIds.delete(callId);
        result.push(message);
      } else {
        // Orphaned tool message: no assistant exchange awaiting this response.
        rollback();
      }
      continue;
    }
    if (pendingIds.size > 0) {
      rollback();
    }
    result.push(message);
  }

  if (pendingIds.size > 0) {
    rollback();
  }
  return result;
}
