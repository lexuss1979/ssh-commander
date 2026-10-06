import type { ChatMessage, ToolDef } from './client.js';
import { getToolDefs } from './tools.js';
import { planModeInstruction, type PromptLang } from './prompts.js';

/**
 * Tools for a Chat Completions API request. In plan mode no tools are
 * passed at all: `undefined` means the `tools` key is absent from the
 * request body — protection at the API level, not only in the prompt.
 * In the regular mode the set is returned with web_search gating applied.
 */
export function toolsForRequest(planMode: boolean, lang: PromptLang = 'ru'): ToolDef[] | undefined {
  return planMode ? undefined : getToolDefs(lang);
}

/**
 * Messages for a plan-mode request: the system prompt is extended with the
 * instruction to draft a plan in the session lang. The source array is not
 * mutated.
 */
export function buildPlanRequestMessages(messages: ChatMessage[], lang: PromptLang): ChatMessage[] {
  return messages.map((m, i) =>
    i === 0 && m.role === 'system'
      ? { ...m, content: `${m.content ?? ''}\n\n${planModeInstruction(lang)}` }
      : m,
  );
}
