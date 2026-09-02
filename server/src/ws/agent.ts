import type { WebSocket } from 'ws';
import { attachAgent } from '../ai/agent.js';
import type { PromptLang } from '../ai/prompts.js';
import type { Profile } from '../types.js';

/**
 * Язык сессии агента из query-параметра WS-подключения (`lang`): язык агента
 * = язык интерфейса. Известное значение берётся как есть; `ru`/мусор/
 * отсутствие — дефолт `ru` (не валимся).
 */
export function parseAgentLang(param: string | null): PromptLang {
  return param === 'en' ? 'en' : 'ru';
}

export function handleAgentWs(
  ws: WebSocket,
  profile: Profile,
  dialogueId?: string,
  lang?: PromptLang,
): void {
  const session = attachAgent(ws, profile, dialogueId, lang);
  ws.on('message', (raw) => {
    try {
      session.handleClientMessage(JSON.parse(String(raw)) as Record<string, unknown>);
    } catch {
      /* ignore malformed frames */
    }
  });
}
