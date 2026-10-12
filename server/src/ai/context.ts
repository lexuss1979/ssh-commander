import type { ChatMessage, ToolDef } from './client.js';
import { sanitizeMessages } from './messages.js';
import type { PromptLang } from './prompts.js';
import { aiStr } from './strings.js';

export const COMPLETION_RESERVE = 16_000;
const RECENT_EXCHANGES = 10;
const OLD_TOOL_CHARS = 500;

/** Input budget, leaving room for completion even with a small configured window. */
export function contextInputBudget(limit: number): number {
  return Math.floor(limit - Math.min(COMPLETION_RESERVE, Math.floor(limit / 4)));
}

/** A heuristic, not a tokenizer. Count JSON, UTF-8 and opaque Responses items too. */
function valueTokens(value: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(value), 'utf8') / 3);
}

export function estimateTokens(messages: ChatMessage[], tools?: ToolDef[]): number {
  return messages.reduce((sum, message) => sum + valueTokens(message) + 10, 0)
    + (tools?.length ? valueTokens(tools) : 0);
}

export class ContextBudgetError extends Error {
  constructor(lang: PromptLang, budget: number) {
    super(Number.isFinite(budget) && budget >= 1
      ? aiStr(lang, 'contextCannotFit', { budget })
      : aiStr(lang, 'contextInvalidBudget'));
    this.name = 'ContextBudgetError';
  }
}

export interface ContextOptions {
  lang?: PromptLang;
  /** Exact offsets captured when assembling the system prompt; never parse memory text as delimiters. */
  memoryRange?: { start: number; end: number };
}

export interface ContextView {
  messages: ChatMessage[];
  estimatedTokens: number;
  droppedExchanges: number;
  truncatedTools: number;
  memoryTruncated: boolean;
}

/** Build a request-only view. Never mutate the saved history or split a tool exchange. */
export function fitToContext(
  source: ChatMessage[], tools: ToolDef[] | undefined, budget: number, options: ContextOptions = {},
): ContextView {
  const lang = options.lang ?? 'ru';
  if (!Number.isFinite(budget) || budget < 1) throw new ContextBudgetError(lang, budget);
  const clean = sanitizeMessages(source);
  const system = clean.filter((message) => message.role === 'system');
  const exchanges: ChatMessage[][] = [];
  for (const message of clean) {
    if (message.role === 'system') continue;
    if (message.role === 'user' || !exchanges.length) exchanges.push([]);
    exchanges[exchanges.length - 1].push(message);
  }
  const metadata = { droppedExchanges: 0, truncatedTools: 0, memoryTruncated: false };
  let messages = clean;
  let estimatedTokens = estimateTokens(messages, tools);
  const result = (): ContextView => ({ messages: sanitizeMessages(messages), estimatedTokens, ...metadata });
  if (estimatedTokens <= budget) return result();

  // Only old tool outputs shrink; recent results, arguments and reasoning stay intact.
  for (let i = 0; i < exchanges.length - RECENT_EXCHANGES; i++) {
    exchanges[i] = exchanges[i].map((message) => {
      if (message.role !== 'tool' || (message.content?.length ?? 0) <= OLD_TOOL_CHARS) return message;
      metadata.truncatedTools++;
      return { ...message, content: `${message.content!.slice(0, OLD_TOOL_CHARS)}\n${aiStr(lang, 'contextToolTruncated')}` };
    });
  }
  let firstUser: ChatMessage | undefined;
  const rebuild = (): void => {
    messages = [...system, ...(firstUser ? [firstUser] : []), ...exchanges.flat()];
    estimatedTokens = estimateTokens(messages, tools);
  };
  rebuild();
  if (estimatedTokens <= budget) return result();

  // Cache costs so eviction is linear even for a very long restored dialogue.
  const costs = exchanges.map((exchange) => estimateTokens(exchange));
  let removed = 0;
  while (estimatedTokens > budget && removed < exchanges.length - 1) {
    const exchange = exchanges[removed];
    if (removed === 0 && exchange[0]?.role === 'user') {
      firstUser = exchange[0];
      estimatedTokens += estimateTokens([firstUser]);
    }
    estimatedTokens -= costs[removed++];
    metadata.droppedExchanges++;
  }
  exchanges.splice(0, removed);
  rebuild();
  if (estimatedTokens <= budget) return result();
  if (firstUser) {
    firstUser = undefined;
    rebuild();
    if (estimatedTokens <= budget) return result();
  }

  // Emergency tier: trim only the known memory range, preserving safety and plan instructions.
  const range = options.memoryRange;
  const prompt = system[0]?.content;
  if (range && prompt && range.start >= 0 && range.end <= prompt.length && range.end > range.start) {
    const original = system[0];
    const prefix = prompt.slice(0, range.start);
    const memory = prompt.slice(range.start, range.end);
    const suffix = `\n${aiStr(lang, 'contextMemoryTruncated')}${prompt.slice(range.end)}`;
    const keepMemory = (chars: number): void => {
      system[0] = { ...original, content: prefix + memory.slice(0, chars) + suffix };
      rebuild();
    };
    keepMemory(0);
    if (estimatedTokens <= budget) {
      let low = 0;
      let high = memory.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        keepMemory(mid);
        if (estimatedTokens <= budget) low = mid;
        else high = mid - 1;
      }
      keepMemory(low);
      metadata.memoryTruncated = true;
      return result();
    }
  }
  // The current turn is indivisible: silently losing its request or tool results is unsafe.
  throw new ContextBudgetError(lang, budget);
}
