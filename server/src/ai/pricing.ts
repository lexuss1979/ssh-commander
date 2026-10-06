import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { config } from '../config.js';

/**
 * Model prices for AI cost accounting (docs/ai-costs-plan.md, decision 2).
 * Defaults in code + an override file `data/ai-prices.json` on top.
 *
 * A reference table, not user data: a broken price file → warn + defaults
 * (the corrupt-guard used by the stores is not needed here — the override
 * does not have to exist, and no data can be silently overwritten).
 */

/** A model price: USD per 1M tokens (input/output), cache input — optional,
 * the per-request rate of the server-side web_search — optional (USD per request). */
export interface ModelPrice {
  /** USD per 1M input tokens (cache miss). */
  input: number;
  /** USD per 1M cached input tokens; without it the cache is priced at `input`. */
  cachedInput?: number;
  /** USD per 1M output tokens. */
  output: number;
  /** USD per one server-side web_search request; without it search calls
   * are counted as unpriced (costUsd → null). */
  webSearchPerRequestUsd?: number;
}

/**
 * The default table of popular models. Prices are as of implementation
 * (OpenAI/DeepSeek price lists); freshness is maintained by the override
 * file `data/ai-prices.json`. A model without a price in the table is
 * more honest than a wrong number — such calls are marked `unpricedCalls`
 * in the report.
 *
 * DeepSeek V4 (api-docs.deepseek.com/quick_start/pricing): input — cache
 * miss, cachedInput — cache hit; off-peak rates are listed, peak hours
 * (01:00–04:00 and 06:00–10:00 UTC) cost twice as much. DeepSeek's
 * server-side web_search is billed in the search model's tokens — there is
 * no separate per-request price (see computeCostUsd: without
 * webSearchPerRequestUsd search is priced by tokens, not marked unpriced).
 */
export const DEFAULT_PRICES: Record<string, ModelPrice> = {
  // OpenAI (USD per 1M tokens; cached input — 50% off).
  'gpt-4.1': { input: 2.0, cachedInput: 1.0, output: 8.0 },
  'gpt-4.1-mini': { input: 0.4, cachedInput: 0.2, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, cachedInput: 0.05, output: 0.4 },
  'gpt-4o': { input: 2.5, cachedInput: 1.25, output: 10.0 },
  'gpt-4o-mini': { input: 0.15, cachedInput: 0.075, output: 0.6 },
  // DeepSeek: input — cache miss, cachedInput — cache hit (the provider's scheme).
  'deepseek-chat': { input: 0.27, cachedInput: 0.07, output: 1.1 },
  'deepseek-reasoner': { input: 0.55, cachedInput: 0.14, output: 2.19 },
  // DeepSeek V4, off-peak (peak ×2). Cache hits — from prompt_cache_hit_tokens /
  // prompt_tokens_details.cached_tokens (see client.ts parseTokenUsage).
  'deepseek-v4-flash': { input: 0.22, cachedInput: 0.007, output: 0.66 },
  'deepseek-v4-pro': { input: 0.66, cachedInput: 0.022, output: 1.98 },
  // Other models: prices not pinned — no entry (unpriced); add via
  // data/ai-prices.json.
};

const priceSchema = z.object({
  input: z.number().nonnegative(),
  cachedInput: z.number().nonnegative().optional(),
  output: z.number().nonnegative(),
  webSearchPerRequestUsd: z.number().nonnegative().optional(),
});

const pricesFileSchema = z.object({
  models: z.record(priceSchema).default({}),
});

function pricesFilePath(): string {
  return path.join(config.dataDir, 'ai-prices.json');
}

/**
 * The price table: defaults + a merge of the override file by model name
 * (a file entry fully replaces the default for that model). A broken/invalid
 * file — warn + defaults. Reading is synchronous and cheap, called only when
 * recording to the usage journal — no caching needed.
 */
export function loadPrices(): Record<string, ModelPrice> {
  let override: Record<string, ModelPrice> = {};
  try {
    const raw = fs.readFileSync(pricesFilePath(), 'utf8');
    override = pricesFileSchema.parse(JSON.parse(raw)).models;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`ai-prices.json is unreadable, using default prices:`, err);
    }
  }
  return { ...DEFAULT_PRICES, ...override };
}

/** Tokens/search requests for cost computation. */
export interface CostUsageInput {
  promptTokens?: number;
  cachedTokens?: number;
  completionTokens?: number;
  /** Number of server-side web_search requests (kind 'web_search' only). */
  searchRequests?: number;
}

function nonneg(v: number | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * The call cost in USD, or null when the model is unpriced.
 * The fixed formula (docs/ai-costs-plan.md, decision 2):
 *   cost = (promptTokens − cachedTokens) · input + cachedTokens · cachedInput
 *        + completionTokens · output + searchRequests · webSearchPerRequestUsd
 * Usage invariants (enforced at capture): cached ⊂ prompt,
 * reasoning ⊂ completion — reasoning does NOT enter the formula (already
 * inside output). Without `cachedInput` on the model, cache tokens are
 * priced at the regular `input` rate.
 * Search requests: the term is added only when `webSearchPerRequestUsd` is
 * set; without it search is priced by tokens (the DeepSeek rate: the
 * server-side web_search is billed in the search model's tokens, there is
 * no separate per-request price) — null only for an unknown model.
 */
export function computeCostUsd(model: string, usage: CostUsageInput): number | null {
  const price = loadPrices()[model];
  if (!price) return null;

  const prompt = nonneg(usage.promptTokens);
  // cached is a subset of prompt (the capture invariant); garbage protection.
  const cached = Math.min(nonneg(usage.cachedTokens), prompt);
  const completion = nonneg(usage.completionTokens);
  const searches = nonneg(usage.searchRequests);

  // Input/output prices are USD per 1M tokens; the search rate is USD per request.
  const TOKENS_PER_UNIT = 1_000_000;
  return (
    ((prompt - cached) * price.input +
      cached * (price.cachedInput ?? price.input) +
      completion * price.output) /
      TOKENS_PER_UNIT +
    searches * (price.webSearchPerRequestUsd ?? 0)
  );
}
