import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../src/ai/client.js';
import { PLAN_MODE_INSTRUCTION, buildPlanRequestMessages, toolsForRequest } from '../src/ai/plan.js';
import { toolDefs } from '../src/ai/tools.js';

const history: ChatMessage[] = [
  { role: 'system', content: 'Базовый системный промпт.' },
  { role: 'user', content: 'обнови nginx' },
];

describe('toolsForRequest', () => {
  it('в режиме планирования инструменты не передаются в API вовсе', () => {
    // undefined → JSON.stringify опускает ключ tools из тела запроса.
    expect(toolsForRequest(true)).toBeUndefined();
    expect(JSON.stringify({ tools: toolsForRequest(true) })).toBe('{}');
  });

  it('в обычном режиме возвращается полный набор инструментов', () => {
    expect(toolsForRequest(false)).toBe(toolDefs);
    expect(toolsForRequest(false)?.length).toBeGreaterThan(0);
  });
});

describe('buildPlanRequestMessages', () => {
  it('дополняет системный промпт инструкцией планирования', () => {
    const result = buildPlanRequestMessages(history);
    expect(result[0].role).toBe('system');
    expect(result[0].content).toContain('Базовый системный промпт.');
    expect(result[0].content).toContain(PLAN_MODE_INSTRUCTION);
    expect(result[0].content).toContain('НИЧЕГО не выполняй');
  });

  it('сохраняет остальные сообщения без изменений', () => {
    const result = buildPlanRequestMessages(history);
    expect(result).toHaveLength(history.length);
    expect(result[1]).toEqual(history[1]);
  });

  it('не мутирует исходный массив сообщений', () => {
    const snapshot = JSON.stringify(history);
    buildPlanRequestMessages(history);
    expect(JSON.stringify(history)).toBe(snapshot);
  });

  it('история без системного сообщения возвращается как есть', () => {
    const noSystem: ChatMessage[] = [{ role: 'user', content: 'привет' }];
    expect(buildPlanRequestMessages(noSystem)).toEqual(noSystem);
  });
});
