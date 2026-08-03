import type { WebSocket } from 'ws';
import { attachAgent } from '../ai/agent.js';
import type { Profile } from '../types.js';

export function handleAgentWs(ws: WebSocket, profile: Profile): void {
  const session = attachAgent(ws, profile);
  ws.on('message', (raw) => {
    try {
      session.handleClientMessage(JSON.parse(String(raw)) as Record<string, unknown>);
    } catch {
      /* ignore malformed frames */
    }
  });
}

