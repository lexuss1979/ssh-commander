import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../src/ai/client.js';
import { sanitizeMessages } from '../src/ai/messages.js';

function assistantWithCalls(callIds: string[]): ChatMessage {
  return {
    role: 'assistant',
    content: null,
    tool_calls: callIds.map((id) => ({
      id,
      type: 'function' as const,
      function: { name: 'exec_readonly', arguments: '{"command":"ls"}' },
    })),
  };
}

function toolResult(callId: string): ChatMessage {
  return { role: 'tool', tool_call_id: callId, name: 'exec_readonly', content: 'file.txt' };
}

describe('sanitizeMessages', () => {
  it('keeps a complete tool-call exchange', () => {
    const messages = [
      { role: 'user' as const, content: 'посмотри файлы' },
      assistantWithCalls(['call_1']),
      toolResult('call_1'),
      { role: 'assistant' as const, content: 'Вот результат.' },
    ];
    expect(sanitizeMessages(messages)).toEqual(messages);
  });

  it('drops a trailing assistant tool_calls message without responses', () => {
    const messages = [
      { role: 'user' as const, content: 'посмотри файлы' },
      assistantWithCalls(['call_1']),
    ];
    expect(sanitizeMessages(messages)).toEqual([messages[0]]);
  });

  it('drops an incomplete exchange before the next user message', () => {
    const messages = [
      { role: 'user' as const, content: 'первый вопрос' },
      assistantWithCalls(['call_1']),
      { role: 'user' as const, content: 'второй вопрос' },
    ];
    expect(sanitizeMessages(messages)).toEqual([messages[0], messages[2]]);
  });

  it('drops an exchange with only some tool responses', () => {
    const messages = [
      { role: 'user' as const, content: 'проверь оба' },
      assistantWithCalls(['call_1', 'call_2']),
      toolResult('call_1'),
    ];
    expect(sanitizeMessages(messages)).toEqual([messages[0]]);
  });

  it('drops orphaned tool messages', () => {
    const messages = [
      { role: 'user' as const, content: 'вопрос' },
      toolResult('call_1'),
    ];
    expect(sanitizeMessages(messages)).toEqual([messages[0]]);
  });

  it('keeps multiple complete exchanges', () => {
    const messages = [
      { role: 'user' as const, content: 'вопрос' },
      assistantWithCalls(['call_1']),
      toolResult('call_1'),
      assistantWithCalls(['call_2']),
      toolResult('call_2'),
      { role: 'assistant' as const, content: 'Готово.' },
    ];
    expect(sanitizeMessages(messages)).toEqual(messages);
  });
});
