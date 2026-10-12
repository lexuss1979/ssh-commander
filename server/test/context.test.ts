import { describe, expect, it } from 'vitest';
import type { ChatMessage, ToolDef } from '../src/ai/client.js';
import { ContextBudgetError, contextInputBudget, estimateTokens, fitToContext } from '../src/ai/context.js';
import { sanitizeMessages } from '../src/ai/messages.js';
import { buildPlanRequestMessages } from '../src/ai/plan.js';
import { planModeInstruction } from '../src/ai/prompts.js';

const system: ChatMessage = { role: 'system', content: 'Safety rules stay intact.' };
const tools: ToolDef[] = [{ type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: {} } }];
function exchange(id: number, size = 6000): ChatMessage[] {
  return [
    { role: 'user', content: `Task ${id}` },
    { role: 'assistant', content: null, tool_calls: [
      { id: `call-${id}`, type: 'function', function: { name: 'read_file', arguments: '{"path":"/tmp/example"}' } },
    ] },
    { role: 'tool', content: 'x'.repeat(size), tool_call_id: `call-${id}` },
    { role: 'assistant', content: `Finished ${id}` },
  ];
}

describe('context estimation and request views', () => {
  it('counts UTF-8, arguments, tool definitions and opaque reasoning, with message overhead', () => {
    expect(contextInputBudget(120000)).toBe(104000);
    expect(contextInputBudget(4000)).toBe(3000);
    const plain: ChatMessage[] = [{ role: 'user', content: 'x'.repeat(300) }];
    const cyrillic: ChatMessage[] = [{ role: 'user', content: 'я'.repeat(300) }];
    expect(estimateTokens(plain)).toBeGreaterThan(100);
    expect(estimateTokens(cyrillic)).toBeGreaterThan(estimateTokens(plain));
    expect(estimateTokens(plain, tools)).toBeGreaterThan(estimateTokens(plain));
    const rich: ChatMessage = { role: 'assistant', content: null, responsesContext: {
      model: 'test', apiBase: 'https://example.test', items: [
        { type: 'reasoning', id: 'r1', summary: [], encrypted_content: 'z'.repeat(6000) },
      ],
    } };
    expect(estimateTokens([rich])).toBeGreaterThan(2000);
    const call = exchange(0)[1];
    expect(estimateTokens([{ ...call, tool_calls: call.tool_calls!.map((tc) => ({ ...tc, function: { ...tc.function, arguments: 'x'.repeat(6000) } })) }]))
      .toBeGreaterThan(estimateTokens([call]) + 1900);
  });

  it('leaves short histories unchanged and sanitizes interrupted exchanges', () => {
    const source = [system, ...exchange(0)];
    expect(fitToContext(source, tools, 100000).messages).toEqual(source);
    const interrupted = [...source, ...exchange(1).slice(0, 2)];
    expect(fitToContext(interrupted, tools, 100000).messages).toEqual(sanitizeMessages(interrupted));
  });

  it('tier 1 shortens only tool outputs older than the last ten turns without mutation', () => {
    const source = [system, ...Array.from({ length: 12 }, (_, i) => exchange(i)).flat()];
    const original = structuredClone(source);
    const view = fitToContext(source, tools, estimateTokens(source, tools) - 1000, { lang: 'en' });
    expect(view.truncatedTools).toBe(2);
    expect(view.droppedExchanges).toBe(0);
    const outputs = view.messages.filter((m) => m.role === 'tool');
    expect(outputs[0].content).toContain('truncated to save context');
    expect(outputs[1].content!.length).toBeLessThan(600);
    expect(outputs.slice(2).every((m) => m.content!.length === 6000)).toBe(true);
    expect(source).toEqual(original);
  });

  it('evicts whole turns, preserving the first user when possible and the entire current turn', () => {
    const source = [system, ...Array.from({ length: 12 }, (_, i) => exchange(i)).flat()];
    const budget = estimateTokens([system, source[1], ...exchange(10), ...exchange(11)], tools);
    const view = fitToContext(source, tools, budget);
    expect(view.droppedExchanges).toBe(10);
    expect(view.messages).toEqual([system, source[1], ...exchange(10), ...exchange(11)]);
    expect(view.messages).toEqual(sanitizeMessages(view.messages));
    expect(view.estimatedTokens).toBe(estimateTokens(view.messages, tools));
    expect(view.estimatedTokens).toBeLessThanOrEqual(budget);
    expect(source).toHaveLength(49);
  });

  it('drops an oversized first request if necessary, but never truncates the current request', () => {
    const latest: ChatMessage = { role: 'user', content: 'Continue' };
    const source: ChatMessage[] = [system, { role: 'user', content: 'x'.repeat(30000) }, { role: 'assistant', content: 'OK' }, latest];
    expect(fitToContext(source, tools, 1000).messages).toEqual([system, latest]);
    expect(() => fitToContext([system, { role: 'user', content: 'x'.repeat(30000) }], tools, 1000))
      .toThrow(ContextBudgetError);
  });

  it('keeps multiple calls and their Responses reasoning together on eviction', () => {
    const old = exchange(0);
    old[1].responsesContext = { model: 'test', apiBase: 'https://example.test', items: [
      { type: 'reasoning', id: 'r1', summary: [], encrypted_content: 'z'.repeat(6000) },
    ] };
    old[1].tool_calls!.push({ id: 'second', type: 'function', function: { name: 'read_file', arguments: '{}' } });
    old.splice(3, 0, { role: 'tool', tool_call_id: 'second', content: 'Second output' });
    const latest = exchange(1, 100);
    latest[1].responsesContext = structuredClone(old[1].responsesContext);
    const source = [system, ...old, ...latest];
    const original = structuredClone(source);
    const budget = estimateTokens([system, old[0], ...latest], tools);
    const view = fitToContext(source, tools, budget);
    expect(view.messages).toEqual([system, old[0], ...latest]);
    expect(view.messages).toEqual(sanitizeMessages(view.messages));
    expect(view.messages.at(-3)?.responsesContext).toEqual(latest[1].responsesContext);
    expect(source).toEqual(original);
  });

  it('trims only the exact memory range, retaining the safety prefix and plan suffix', () => {
    const prefix = 'Safety rules.\n\n';
    const memory = 'Profile memory:\n' + 'я'.repeat(60000);
    const source = buildPlanRequestMessages([
      { role: 'system', content: prefix + memory }, { role: 'user', content: 'Plan the change' },
    ], 'en');
    const original = structuredClone(source);
    const view = fitToContext(source, undefined, 2000, { lang: 'en', memoryRange: { start: prefix.length, end: prefix.length + memory.length } });
    expect(view.memoryTruncated).toBe(true);
    expect(view.messages[0].content).toMatch(/^Safety rules/);
    expect(view.messages[0].content).toContain(planModeInstruction('en'));
    expect(view.messages[0].content).toContain('memory truncated');
    expect(view.estimatedTokens).toBeLessThanOrEqual(2000);
    expect(source).toEqual(original);
    expect(() => fitToContext(source, undefined, 2000)).toThrow(ContextBudgetError);
  });

  it('fails locally if mandatory instructions or tool definitions alone exceed the budget', () => {
    expect(() => fitToContext([{ role: 'system', content: 'x'.repeat(90000) }], tools, 1000)).toThrow(ContextBudgetError);
    expect(() => fitToContext([system], [{ ...tools[0], function: { ...tools[0].function, description: 'x'.repeat(90000) } }], 1000))
      .toThrow(ContextBudgetError);
    for (const budget of [NaN, Infinity, 0, -1]) {
      expect(() => fitToContext([system], tools, budget)).toThrow(ContextBudgetError);
      expect(() => fitToContext([system], tools, budget, { lang: 'en' })).toThrow('Invalid context budget');
      expect(() => fitToContext([system], tools, budget, { lang: 'ru' })).toThrow('Некорректный бюджет контекста');
    }
  });
});
