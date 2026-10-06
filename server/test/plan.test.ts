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
  it('in planning mode the tools are not passed to the API at all', () => {
    // undefined → JSON.stringify опускает ключ tools из тела запроса.
    expect(toolsForRequest(true)).toBeUndefined();
    expect(JSON.stringify({ tools: toolsForRequest(true) })).toBe('{}');
  });

  it('in the regular mode the full tool set is returned', () => {
    expect(toolsForRequest(false)).toEqual(getToolDefs('ru', false));
    expect(toolsForRequest(false)?.length).toBeGreaterThan(0);
  });
});

describe('buildPlanRequestMessages', () => {
  it('appends the planning instruction in the session language to the system prompt', () => {
    const result = buildPlanRequestMessages(history, 'ru');
    expect(result[0].role).toBe('system');
    expect(result[0].content).toContain('Базовый системный промпт.');
    expect(result[0].content).toContain(planModeInstruction('ru'));
    expect(result[0].content).toContain('НИЧЕГО не выполняй');
  });

  it('lang=en — the English instruction, no Cyrillic in the addition', () => {
    const result = buildPlanRequestMessages(history, 'en');
    expect(result[0].content).toContain(planModeInstruction('en'));
    expect(result[0].content).not.toContain(planModeInstruction('ru'));
    // The user history is data, it is not translated.
    expect(result[1]).toEqual(history[1]);
  });

  it('keeps the other messages unchanged', () => {
    const result = buildPlanRequestMessages(history, 'ru');
    expect(result).toHaveLength(history.length);
    expect(result[1]).toEqual(history[1]);
  });

  it('does not mutate the original message array', () => {
    const snapshot = JSON.stringify(history);
    buildPlanRequestMessages(history, 'ru');
    expect(JSON.stringify(history)).toBe(snapshot);
  });

  it('a history without a system message is returned as is', () => {
    const noSystem: ChatMessage[] = [{ role: 'user', content: 'привет' }];
    expect(buildPlanRequestMessages(noSystem, 'ru')).toEqual(noSystem);
  });
});
