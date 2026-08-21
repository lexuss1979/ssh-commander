import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { Profile } from '../src/types.js';

// Сессия агента создаётся через динамический импорт ниже (нужен DATA_DIR).
const dataDir = mkdtempSync(path.join(tmpdir(), 'sc-agent-usage-'));
process.env.DATA_DIR = dataDir;

// Клиент и поиск — без сети: streamChatCompletion возвращает message + usage,
// searchWeb — ok + usage (проверяем запись в журнал, а не сам HTTP).
vi.mock('../src/ai/client.js', () => ({
  streamChatCompletion: vi.fn(async () => ({
    message: { role: 'assistant', content: 'ответ', tool_calls: [] },
    usage: { promptTokens: 1000, cachedTokens: 200, completionTokens: 500, reasoningTokens: 50 },
  })),
}));

vi.mock('../src/ai/web-search.js', () => ({
  isSearchConfigured: vi.fn(() => true),
  searchWeb: vi.fn(async () => ({
    ok: true,
    output: 'результат поиска',
    usage: { promptTokens: 8000, completionTokens: 400, searchRequests: 2 },
  })),
}));

const home: Profile = {
  id: 'home-srv',
  name: 'Домашний',
  host: 'home.local',
  port: 22,
  username: 'root',
  authType: 'password',
  password: 'home-secret',
  dockerCommand: 'docker',
};

const dialogueSeed = {
  id: 'd-usage',
  profileId: home.id,
  title: 'Расходы',
  messages: [],
  messageCount: 0,
  preview: '',
  createdAt: 1,
  updatedAt: 1,
};

writeFileSync(path.join(dataDir, 'profiles.json'), JSON.stringify({ profiles: [home] }, null, 2));
writeFileSync(path.join(dataDir, 'ai-dialogues.json'), JSON.stringify({ dialogues: [dialogueSeed] }, null, 2));

const agent = await import('../src/ai/agent.js');
const usageStore = await import('../src/ai/usage.js');
const dialogues = await import('../src/ai/dialogues.js');

type ToolResult = { status: 'ok' | 'error'; output: string; truncated: boolean };
type SessionInternals = {
  runTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
};

function makeSession() {
  const sent: Array<Record<string, unknown>> = [];
  const ws = {
    readyState: 1,
    OPEN: 1,
    send(data: string) {
      sent.push(JSON.parse(data) as Record<string, unknown>);
    },
  } as unknown as WebSocket;
  const session = new agent.AgentSession({ ...home }, ws, dialogues.getDialogue(dialogueSeed.id));
  return { session, sent };
}

function runTool(session: agent.AgentSession, name: string, args: Record<string, unknown> = {}) {
  return (session as unknown as SessionInternals).runTool(name, args);
}

async function waitFor(sent: Array<Record<string, unknown>>, predicate: (m: Record<string, unknown>) => boolean, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = sent.find(predicate);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('waitFor timeout');
}

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('agent: запись usage (docs/ai-costs-plan.md, решения 3, 5, 6, 8)', () => {
  it('runLoop: chat-вызов пишется в журнал, WS-событие usage с итогами диалога', async () => {
    const { session, sent } = makeSession();
    session.handleClientMessage({ type: 'message', content: 'привет' });

    await waitFor(sent, (m) => m.type === 'done');

    const records = usageStore.listUsage().filter((r) => r.dialogueId === dialogueSeed.id);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      profileId: home.id,
      dialogueId: dialogueSeed.id,
      kind: 'chat',
      model: 'gpt-4.1-mini',
      promptTokens: 1000,
      cachedTokens: 200,
      completionTokens: 500,
      reasoningTokens: 50,
    });
    // gpt-4.1-mini протарифицирован дефолтами: (1000−200)·0.4 + 200·0.2 + 500·1.6 = $0.00116
    expect(records[0].costUsd).toBeCloseTo(0.00116, 9);

    const usageEvent = sent.find((m) => m.type === 'usage');
    expect(usageEvent?.totals).toMatchObject({ calls: 1, costUsd: 0.00116, unpricedCalls: 0 });
  });

  it('runPlan: шаг планирования пишется как kind=plan', async () => {
    const { session, sent } = makeSession();
    session.handleClientMessage({ type: 'message', content: 'составь план', planMode: true });

    await waitFor(sent, (m) => m.type === 'plan_ready');
    await waitFor(sent, (m) => m.type === 'done');

    const records = usageStore.listUsage().filter((r) => r.kind === 'plan');
    expect(records).toHaveLength(1);
    expect(records[0].dialogueId).toBe(dialogueSeed.id);
    expect(sent.filter((m) => m.type === 'usage')).toHaveLength(1);
  });

  it('runTool web_search: kind=web_search с searchRequests, цена по токенам DeepSeek V4', async () => {
    const { session, sent } = makeSession();
    const result = await runTool(session, 'web_search', { query: 'версия nginx' });
    expect(result.status).toBe('ok');

    const records = usageStore.listUsage().filter((r) => r.kind === 'web_search');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      model: 'deepseek-v4-flash',
      promptTokens: 8000,
      completionTokens: 400,
      searchRequests: 2,
    });
    // deepseek-v4-flash протарифицирован (off-peak): (8000·0.22 + 400·0.66)/1M = 0.002024;
    // отдельного тарифа за поисковый запрос нет — поиск оплачивается токенами.
    expect(records[0].costUsd).toBeCloseTo(0.002024, 9);

    // Итоги диалога кумулятивные (chat + plan из предыдущих тестов + этот
    // web_search): все записи протарифицированы, unpricedCalls = 0.
    const usageEvent = sent.find((m) => m.type === 'usage');
    expect(usageEvent?.totals).toMatchObject({ calls: 3, unpricedCalls: 0 });
    expect((usageEvent?.totals as { costUsd: number }).costUsd).toBeCloseTo(0.004344, 9);
  });

  it('usageTotalsByDialogue агрегирует chat + web_search одного диалога', async () => {
    const totals = usageStore.usageTotalsByDialogue().get(dialogueSeed.id);
    expect(totals).toBeDefined();
    expect(totals?.calls).toBe(3); // chat + plan + web_search из предыдущих тестов
    expect(totals?.promptTokens).toBe(1000 + 1000 + 8000);
    expect(totals?.unpricedCalls).toBe(0);
  });
});
