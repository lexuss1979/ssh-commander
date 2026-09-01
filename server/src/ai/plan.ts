import type { ChatMessage, ToolDef } from './client.js';
import { getToolDefs } from './tools.js';
import { planModeInstruction } from './prompts.js';
import { config } from '../config.js';

/**
 * Дополнение к системному промпту на шаге планирования (режим planMode).
 * Язык — config.ai.lang (env AI_LANG); тексты — в ai/prompts.ts.
 */
export const PLAN_MODE_INSTRUCTION = planModeInstruction(config.ai.lang);

/**
 * Инструменты для запроса к Chat Completions API. В режиме планирования
 * инструменты не передаются вовсе: `undefined` означает, что ключ `tools`
 * отсутствует в теле запроса — защита на уровне API, а не только промпта.
 * В обычном режиме отдаётся набор с учётом гейтинга web_search.
 */
export function toolsForRequest(planMode: boolean): ToolDef[] | undefined {
  return planMode ? undefined : getToolDefs();
}

/**
 * Сообщения для запроса в режиме планирования: системный промпт дополняется
 * инструкцией составить план. Исходный массив не мутируется.
 */
export function buildPlanRequestMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m, i) =>
    i === 0 && m.role === 'system'
      ? { ...m, content: `${m.content ?? ''}\n\n${PLAN_MODE_INSTRUCTION}` }
      : m,
  );
}
