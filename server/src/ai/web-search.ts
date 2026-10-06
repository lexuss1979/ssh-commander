import { config } from '../config.js';
import { getAiSettings } from '../services/settings.js';
import { aiStr } from './strings.js';
import type { PromptLang } from './prompts.js';

// The Anthropic-compatible DeepSeek endpoint: the server-side web search
// works only there (not in the OpenAI-compatible /chat/completions). The key
// is shared with aiApiKey from settings.json.
const SEARCH_TIMEOUT_MS = 90_000;
const MAX_QUERY_LENGTH = 400;
const MAX_TOKENS = 2048;

// A constant, not a setting: only this endpoint supports the server-side
// web_search tool at DeepSeek. Must not be changed or surfaced in the UI.
const DEEPSEEK_SEARCH_BASE = 'https://api.deepseek.com/anthropic';

/** Cap on actual search requests inside one tool call. */
export const MAX_USES_PER_CALL = 3;

export interface WebSearchResult {
  ok: boolean;
  output: string;
  /** Search call tokens (docs/ai-costs-plan.md, decision 5): filled only on
   * a successful response with usage in the body. */
  usage?: WebSearchUsage;
}

/** Usage of an Anthropic-compatible response: input/output tokens and the number
 * of actual search requests (server_tool_use.web_search_requests). */
export interface WebSearchUsage {
  promptTokens?: number;
  completionTokens?: number;
  searchRequests?: number;
}

export function isSearchConfigured(): boolean {
  const ai = getAiSettings();
  if (!ai.apiKey) return false;
  // The DeepSeek preset: search is enabled automatically (2-in-1, same key).
  if (ai.provider === 'deepseek') return true;
  // Others: search only with the env AI_SEARCH_API_BASE explicitly set
  // (backward compatibility; enables the "OpenAI chat + DeepSeek search" combo).
  return Boolean(config.ai.searchApiBase);
}

export function sanitizeQuery(raw: unknown): string {
  return String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_QUERY_LENGTH);
}

/**
 * Request body for the Anthropic Messages API with the server-side
 * web_search tool. A pure function — pinned by unit tests.
 */
export function buildSearchBody(
  query: string,
  opts: { model: string; maxUses: number },
  lang: PromptLang = 'ru',
): Record<string, unknown> {
  return {
    model: opts.model,
    max_tokens: MAX_TOKENS,
    messages: [
      {
        role: 'user',
        // The summary prompt is in the agent session lang (see ai/strings.ts).
        content: aiStr(lang, 'searchSummaryPrompt', { query }),
      },
    ],
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: opts.maxUses }],
  };
}

export interface SearchSource {
  title: string;
  url: string;
}

export interface ParsedSearchResponse {
  text: string;
  queries: string[];
  sources: SearchSource[];
  /** Usage from the response; absent if the provider did not return it. */
  usage?: WebSearchUsage;
}

function nonnegInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;
}

/**
 * Parsing a Messages API response: text blocks are the answer, server_tool_use
 * — the executed search queries, web_search_tool_result — the sources
 * (encrypted_content is not extracted — it is transparent to the model only).
 * Usage: input_tokens → promptTokens, output_tokens → completionTokens,
 * server_tool_use.web_search_requests → searchRequests.
 */
export function parseSearchResponse(data: Record<string, unknown>): ParsedSearchResponse {
  const blocks = (data.content as Array<Record<string, unknown>> | undefined) ?? [];
  const textParts: string[] = [];
  const queries: string[] = [];
  const sources: SearchSource[] = [];
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      textParts.push(block.text.trim());
    } else if (block.type === 'server_tool_use' && block.name === 'web_search') {
      const input = block.input as { query?: unknown } | undefined;
      if (input && typeof input.query === 'string' && input.query.trim()) {
        queries.push(input.query.trim());
      }
    } else if (block.type === 'web_search_tool_result') {
      const items = (block.content as Array<Record<string, unknown>> | undefined) ?? [];
      for (const item of items) {
        if (item.type === 'web_search_result' && typeof item.url === 'string' && item.url) {
          sources.push({ title: String(item.title ?? ''), url: item.url });
        }
      }
    }
  }
  let usage: WebSearchUsage | undefined;
  const rawUsage = data.usage as Record<string, unknown> | undefined;
  if (rawUsage && typeof rawUsage === 'object') {
    const toolUse = rawUsage.server_tool_use as Record<string, unknown> | undefined;
    const promptTokens = nonnegInt(rawUsage.input_tokens);
    const completionTokens = nonnegInt(rawUsage.output_tokens);
    const searchRequests = nonnegInt(toolUse?.web_search_requests);
    if (promptTokens !== undefined || completionTokens !== undefined || searchRequests !== undefined) {
      usage = {};
      if (promptTokens !== undefined) usage.promptTokens = promptTokens;
      if (completionTokens !== undefined) usage.completionTokens = completionTokens;
      if (searchRequests !== undefined) usage.searchRequests = searchRequests;
    }
  }
  return { text: textParts.join('\n\n'), queries, sources, usage };
}

/** Formats the results for the agent tool output (the lang is the session lang). */
export function formatSearchOutput(parsed: ParsedSearchResponse, lang: PromptLang = 'ru'): string {
  const parts: string[] = [];
  if (parsed.text) parts.push(parsed.text);
  if (parsed.queries.length) {
    parts.push(`${aiStr(lang, 'searchQueriesLabel')}: ${parsed.queries.join('; ')}`);
  }
  if (parsed.sources.length) {
    const lines = parsed.sources.map(
      (s, i) => `${i + 1}. ${s.title ? `${s.title} — ` : ''}${s.url}`,
    );
    parts.push(`${aiStr(lang, 'searchSourcesLabel')}:\n${lines.join('\n')}`);
  }
  return parts.join('\n\n') || aiStr(lang, 'searchNoResults');
}

function extractErrorMessage(data: Record<string, unknown> | null): string | null {
  const err = data?.error as { message?: unknown } | undefined;
  return err && typeof err.message === 'string' && err.message ? err.message.slice(0, 500) : null;
}

/**
 * One web_search tool call: a request to the search endpoint and formatting
 * of the response. Never throws — errors come back as text (the runTool
 * pattern).
 */
export async function searchWeb(rawQuery: string, lang: PromptLang = 'ru'): Promise<WebSearchResult> {
  const query = sanitizeQuery(rawQuery);
  if (!query) return { ok: false, output: aiStr(lang, 'searchEmptyQuery') };
  if (!isSearchConfigured()) {
    return { ok: false, output: aiStr(lang, 'searchUnavailable') };
  }

  const ai = getAiSettings();
  // The search base: for the DeepSeek preset — the constant Anthropic endpoint
  // (same key); for the others — env AI_SEARCH_API_BASE (env-only, like the
  // search model).
  const searchBase = ai.provider === 'deepseek' ? DEEPSEEK_SEARCH_BASE : config.ai.searchApiBase;

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(aiStr(lang, 'searchTimeout'))),
    SEARCH_TIMEOUT_MS,
  );
  try {
    const res = await fetch(`${searchBase}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ai.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(
        buildSearchBody(query, { model: config.ai.searchModel, maxUses: MAX_USES_PER_CALL }, lang),
      ),
      signal: controller.signal,
    });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok || !data || data.type === 'error') {
      const message = extractErrorMessage(data) ?? `HTTP ${res.status}`;
      return { ok: false, output: aiStr(lang, 'searchApiError', { message }) };
    }
    return { ok: true, output: formatSearchOutput(parseSearchResponse(data), lang) };
  } catch (err) {
    return { ok: false, output: aiStr(lang, 'searchError', { message: String((err as Error).message ?? err) }) };
  } finally {
    clearTimeout(timer);
  }
}
