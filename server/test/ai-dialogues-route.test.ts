import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The REST side of the step-limit continuation (issue #5): the dialogue
// detail carries the persisted `stepLimitReached`, so the "Continue" card is
// restored after a reload without waiting for any WS event.
const dataDir = mkdtempSync(path.join(tmpdir(), 'sc-ai-dialogues-route-'));
vi.stubEnv('DATA_DIR', dataDir);

const express = (await import('express')).default;
const { aiRouter } = await import('../src/routes/ai.js');
const { createDialogue, setDialogueMessageQueue, setDialogueStepLimitReached } = await import('../src/ai/dialogues.js');

let server: Server;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/ai', aiRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ai`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllEnvs();
  rmSync(dataDir, { recursive: true, force: true });
});

interface DialoguePayload {
  dialogue: {
    id: string;
    stepLimitReached?: boolean;
    messageQueue?: Array<{ id: string; content: string; kind: 'steer' | 'queue' }>;
    usage?: unknown;
  };
}

describe('GET /api/ai/dialogues/:id — the step-limit state', () => {
  it('a new dialogue has no field (the client reads it as false)', async () => {
    const d = createDialogue('route-profile');
    const res = await fetch(`${base}/dialogues/${d.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DialoguePayload;
    expect(body.dialogue.stepLimitReached).toBeUndefined();
  });

  it('a step-limit stop is exposed as stepLimitReached: true', async () => {
    const d = createDialogue('route-profile');
    setDialogueStepLimitReached(d.id, true);
    const res = await fetch(`${base}/dialogues/${d.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DialoguePayload;
    expect(body.dialogue.stepLimitReached).toBe(true);
    expect(body.dialogue.id).toBe(d.id);
  });

  it('exposes the persisted message queue for reconnect restoration', async () => {
    const d = createDialogue('route-profile');
    setDialogueMessageQueue(d.id, [{
      id: 'route-queue-1', content: 'next task', kind: 'steer', createdAt: Date.now(),
    }]);
    const res = await fetch(`${base}/dialogues/${d.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DialoguePayload;
    expect(body.dialogue.messageQueue).toEqual([
      expect.objectContaining({ id: 'route-queue-1', content: 'next task', kind: 'steer' }),
    ]);
  });

  it('a resolved continuation is exposed as false', async () => {
    const d = createDialogue('route-profile');
    setDialogueStepLimitReached(d.id, true);
    setDialogueStepLimitReached(d.id, false);
    const res = await fetch(`${base}/dialogues/${d.id}`);
    const body = (await res.json()) as DialoguePayload;
    expect(body.dialogue.stepLimitReached).toBe(false);
  });
});
