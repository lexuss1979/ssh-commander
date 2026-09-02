import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../src/ai/client.js';
import { buildPlanRequestMessages, toolsForRequest } from '../src/ai/plan.js';
import { planModeInstruction } from '../src/ai/prompts.js';
import { getToolDefs } from '../src/ai/tools.js';

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
    expect(toolsForRequest(false)).toEqual(getToolDefs(false));
    expect(toolsForRequest(false)?.length).toBeGreaterThan(0);
  });
});

describe('buildPlanRequestMessages', () => {
  it('дополняет системный промпт инструкцией планирования на языке сессии', () => {
    const result = buildPlanRequestMessages(history, 'ru');
    expect(result[0].role).toBe('system');
    expect(result[0].content).toContain('Базовый системный промпт.');
    expect(result[0].content).toContain(planModeInstruction('ru'));
    expect(result[0].content).toContain('НИЧЕГО не выполняй');
  });

  it('lang=en — английская инструкция, без кириллицы в дополнении', () => {
    const result = buildPlanRequestMessages(history, 'en');
    expect(result[0].content).toContain(planModeInstruction('en'));
    expect(result[0].content).not.toContain(planModeInstruction('ru'));
    // История пользователя — данные, не переводятся.
    expect(result[1]).toEqual(history[1]);
  });

  it('сохраняет остальные сообщения без изменений', () => {
    const result = buildPlanRequestMessages(history, 'ru');
    expect(result).toHaveLength(history.length);
    expect(result[1]).toEqual(history[1]);
  });

  it('не мутирует исходный массив сообщений', () => {
    const snapshot = JSON.stringify(history);
    buildPlanRequestMessages(history, 'ru');
    expect(JSON.stringify(history)).toBe(snapshot);
  });

  it('история без системного сообщения возвращается как есть', () => {
    const noSystem: ChatMessage[] = [{ role: 'user', content: 'привет' }];
    expect(buildPlanRequestMessages(noSystem, 'ru')).toEqual(noSystem);
  });
});
