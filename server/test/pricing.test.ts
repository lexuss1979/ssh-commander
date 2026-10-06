import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const dataDir = mkdtempSync(path.join(tmpdir(), 'sc-pricing-'));
process.env.DATA_DIR = dataDir;

const pricing = await import('../src/ai/pricing.js');

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

// Values from DEFAULT_PRICES to check the formula: gpt-4.1-mini
// { input: 0.4, cachedInput: 0.2, output: 1.6 } (USD per 1M tokens).
describe('computeCostUsd — the formula (docs/ai-costs-plan.md, decision 2)', () => {
  it('basic computation: input and output at the model prices', () => {
    // 1M input + 100K output = 0.4 + 0.16 = 0.56
    expect(pricing.computeCostUsd('gpt-4.1-mini', { promptTokens: 1_000_000, completionTokens: 100_000 }))
      .toBeCloseTo(0.56, 6);
  });

  it('cached tokens are subtracted from the input and priced at cachedInput', () => {
    // prompt 1M, of which cached 400K: (1M−400K)·0.4 + 400K·0.2 + 0 = 0.24 + 0.08 = 0.32
    expect(
      pricing.computeCostUsd('gpt-4.1-mini', {
        promptTokens: 1_000_000,
        cachedTokens: 400_000,
        completionTokens: 0,
      }),
    ).toBeCloseTo(0.32, 6);
  });

  it('without cachedInput for the model, cached tokens are priced at the regular input price', () => {
    // deepseek-chat: { input: 0.27, cachedInput: 0.07, output: 1.1 } — has cachedInput.
    // Take a model without cachedInput? All defaults have it — checked via an override
    // in a separate test. Here: cachedInput is present and applied.
    expect(
      pricing.computeCostUsd('deepseek-chat', {
        promptTokens: 1_000_000,
        cachedTokens: 500_000,
        completionTokens: 0,
      }),
    ).toBeCloseTo(0.5 * 0.27 + 0.5 * 0.07, 6); // 0.135 + 0.035 = 0.17
  });

  it('reasoning is NOT added to the total — it is inside completion_tokens (invariant)', () => {
    const withReasoning = pricing.computeCostUsd('gpt-4.1-mini', {
      promptTokens: 1000,
      completionTokens: 2000,
    });
    // reasoning_tokens=1000 must not increase the total: the output already contains them.
    const same = pricing.computeCostUsd('gpt-4.1-mini', {
      promptTokens: 1000,
      completionTokens: 2000,
    });
    expect(withReasoning).toBe(same);
    // A numeric check: 1000·0.4/1M + 2000·1.6/1M = 0.0004 + 0.0032 = 0.0036
    expect(withReasoning).toBeCloseTo(0.0036, 9);
  });

  it('search requests are a separate term only with webSearchPerRequestUsd', () => {
    // Without a search rate (the default gpt-4.1-mini) the search is priced by tokens —
    // the DeepSeek rate: the server-side web_search is paid in tokens, there is no
    // separate per-request price. The search term is added by an override only (below).
    const cost = pricing.computeCostUsd('gpt-4.1-mini', {
      promptTokens: 1000,
      completionTokens: 2000,
      searchRequests: 2,
    });
    expect(cost).toBeCloseTo(0.0036, 9); // tokens only: 0.0004 + 0.0032
  });

  it('deepseek-v4-flash is priced (off-peak DeepSeek V4)', () => {
    expect(pricing.DEFAULT_PRICES['deepseek-v4-flash']).toEqual({
      input: 0.22,
      cachedInput: 0.007,
      output: 0.66,
    });
    // 1M input (cache-miss) + 400K output = 0.22 + 0.264 = 0.484
    expect(
      pricing.computeCostUsd('deepseek-v4-flash', { promptTokens: 1_000_000, completionTokens: 400_000 }),
    ).toBeCloseTo(0.484, 6);
    // Cache hits at cachedInput: (600K·0.22 + 400K·0.007)/1M = 0.132 + 0.0028
    expect(
      pricing.computeCostUsd('deepseek-v4-flash', {
        promptTokens: 1_000_000,
        cachedTokens: 400_000,
        completionTokens: 0,
      }),
    ).toBeCloseTo(0.1348, 6);
  });

  it('an unknown model → null (unpriced), even with non-zero tokens', () => {
    expect(pricing.computeCostUsd('claude-opus-4-5', { promptTokens: 100, completionTokens: 100 }))
      .toBeNull();
    expect(pricing.computeCostUsd('gpt-5', { promptTokens: 100, completionTokens: 100 })).toBeNull();
  });

  it('zero tokens → 0 (a priced model)', () => {
    expect(pricing.computeCostUsd('gpt-4.1-mini', {})).toBe(0);
  });

  it('garbage in tokens (negatives/strings) is treated as 0', () => {
    // The type does not allow it, but the nonneg() runtime guard must not crash:
    const result = pricing.computeCostUsd('gpt-4.1-mini', {
      promptTokens: -5 as unknown as number,
      cachedTokens: 'x' as unknown as number,
      completionTokens: NaN,
    });
    expect(result).toBe(0);
  });
});

describe('loadPrices — the data/ai-prices.json override', () => {
  it('no file — defaults', () => {
    expect(pricing.loadPrices()['gpt-4.1-mini']).toEqual({ input: 0.4, cachedInput: 0.2, output: 1.6 });
    expect(pricing.loadPrices()['deepseek-chat']).toBeDefined();
  });

  it('merged by model name: a file entry fully replaces the default one', () => {
    writeFileSync(
      path.join(dataDir, 'ai-prices.json'),
      JSON.stringify({
        models: {
          'gpt-4.1-mini': { input: 0.5, cachedInput: 0.25, output: 2.0, webSearchPerRequestUsd: 0.03 },
          'my-custom-model': { input: 1.0, output: 2.0 },
        },
      }),
    );
    const prices = pricing.loadPrices();
    expect(prices['gpt-4.1-mini']).toEqual({
      input: 0.5,
      cachedInput: 0.25,
      output: 2.0,
      webSearchPerRequestUsd: 0.03,
    });
    // A new model from the file — now priced.
    expect(pricing.computeCostUsd('my-custom-model', { promptTokens: 1_000_000, completionTokens: 500_000 }))
      .toBeCloseTo(1.0 + 1.0, 6);
    // Other defaults are untouched.
    expect(prices['deepseek-chat']).toBeDefined();
  });

  it('cachedInput from the override participates in the formula', () => {
    // my-custom-model without cachedInput: the cache is priced at input (1.0).
    expect(
      pricing.computeCostUsd('my-custom-model', {
        promptTokens: 1_000_000,
        cachedTokens: 300_000,
        completionTokens: 0,
      }),
    ).toBeCloseTo(1.0, 6); // (1M−300K)·1 + 300K·1 = 1.0
  });

  it('search requests priced at the override rate', () => {
    // gpt-4.1-mini from the override: webSearchPerRequestUsd 0.03.
    const cost = pricing.computeCostUsd('gpt-4.1-mini', {
      promptTokens: 1000,
      cachedTokens: 0,
      completionTokens: 2000,
      searchRequests: 2,
    });
    // tokens: 1000·0.5/1M + 2000·2/1M = 0.0005 + 0.004 = 0.0045; search: 2·0.03 = 0.06
    expect(cost).toBeCloseTo(0.0045 + 0.06, 9);
  });

  it('a broken prices file → warn + defaults (no corrupt-blocking: it is a reference table)', () => {
    writeFileSync(path.join(dataDir, 'ai-prices.json'), '{not json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const prices = pricing.loadPrices();
    expect(warn).toHaveBeenCalled();
    expect(prices['gpt-4.1-mini']).toEqual({ input: 0.4, cachedInput: 0.2, output: 1.6 });
    // The file is NOT renamed to *.corrupt-* (unlike the user stores).
    expect(readFileSync(path.join(dataDir, 'ai-prices.json'), 'utf8')).toBe('{not json');
    warn.mockRestore();
  });

  it('an invalid file schema (a negative price) → warn + defaults', () => {
    writeFileSync(
      path.join(dataDir, 'ai-prices.json'),
      JSON.stringify({ models: { 'gpt-4.1-mini': { input: -1, output: 1 } } }),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const prices = pricing.loadPrices();
    expect(warn).toHaveBeenCalled();
    expect(prices['gpt-4.1-mini']).toEqual({ input: 0.4, cachedInput: 0.2, output: 1.6 });
    warn.mockRestore();
  });
});
