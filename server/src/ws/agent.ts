import type { WebSocket } from 'ws';
import { attachAgent } from '../ai/agent.js';
import type { PromptLang } from '../ai/prompts.js';
import type { Profile } from '../types.js';

/**
 * Agent session language from the WS connection's query parameter (`lang`):
 * agent language = interface language. A known value is taken as is; `ru`,
 * garbage or absence — the default `ru` (no failure).
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
