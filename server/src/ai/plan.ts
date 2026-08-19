import type { ChatMessage, ToolDef } from './client.js';
import { getToolDefs } from './tools.js';

/**
 * Дополнение к системному промпту на шаге планирования (режим planMode).
 */
export const PLAN_MODE_INSTRUCTION =
  'Сейчас включён режим планирования. Составь подробный пошаговый план решения задачи пользователя ' +
  '(пронумерованные шаги с конкретными командами и файлами) и НИЧЕГО не выполняй: ' +
  'инструменты в этом режиме недоступны. Ответь только планом и жди подтверждения пользователя.';

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
