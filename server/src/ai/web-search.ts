import { config } from '../config.js';

// Anthropic-совместимый endpoint DeepSeek: серверный web search работает
// только там (не в OpenAI-совместимом /chat/completions). Ключ общий с AI_API_KEY.
const SEARCH_TIMEOUT_MS = 90_000;
const MAX_QUERY_LENGTH = 400;
const MAX_TOKENS = 2048;

/** Лимит реальных поисковых запросов внутри одного вызова инструмента. */
export const MAX_USES_PER_CALL = 3;

export interface WebSearchResult {
  ok: boolean;
  output: string;
  /** Токены вызова поиска (docs/ai-costs-plan.md, решение 5): заполняется
   * только при успешном ответе с usage в теле. */
  usage?: WebSearchUsage;
}

/** Usage Anthropic-совместимого ответа: input/output токены и число реальных
 * поисковых запросов (server_tool_use.web_search_requests). */
export interface WebSearchUsage {
  promptTokens?: number;
  completionTokens?: number;
  searchRequests?: number;
}

export function isSearchConfigured(): boolean {
  return Boolean(config.ai.searchApiBase && config.ai.apiKey);
}

export function sanitizeQuery(raw: unknown): string {
  return String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_QUERY_LENGTH);
}

/**
 * Тело запроса к Anthropic Messages API с серверным инструментом web_search.
 * Чистая функция — зафиксирована в unit-тестах.
 */
export function buildSearchBody(
  query: string,
  opts: { model: string; maxUses: number },
): Record<string, unknown> {
  return {
    model: opts.model,
    max_tokens: MAX_TOKENS,
    messages: [
      {
        role: 'user',
        content:
          'Найди в интернете ответ на вопрос администратора Linux-сервера и изложи его кратко по-русски. ' +
          'В конце перечисли источники (заголовок и URL). Вопрос: ' + query,
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
  /** Usage из ответа; отсутствует, если провайдер его не вернул. */
  usage?: WebSearchUsage;
}

function nonnegInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;
}

/**
 * Разбор ответа Messages API: текстовые блоки — ответ, server_tool_use —
 * выполненные поисковые запросы, web_search_tool_result — источники
 * (encrypted_content не извлекаем — он прозрачен только для модели).
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

/** Форматирование результатов для tool-вывода агенту. */
export function formatSearchOutput(parsed: ParsedSearchResponse): string {
  const parts: string[] = [];
  if (parsed.text) parts.push(parsed.text);
  if (parsed.queries.length) parts.push(`Запросы поиска: ${parsed.queries.join('; ')}`);
  if (parsed.sources.length) {
    const lines = parsed.sources.map(
      (s, i) => `${i + 1}. ${s.title ? `${s.title} — ` : ''}${s.url}`,
    );
    parts.push(`Источники:\n${lines.join('\n')}`);
  }
  return parts.join('\n\n') || '(поиск не дал результатов)';
}

function extractErrorMessage(data: Record<string, unknown> | null): string | null {
  const err = data?.error as { message?: unknown } | undefined;
  return err && typeof err.message === 'string' && err.message ? err.message.slice(0, 500) : null;
}

/**
 * Один вызов инструмента web_search: запрос к поисковому endpoint'у и
 * форматирование ответа. Никогда не бросает — ошибки возвращаются текстом
 * (паттерн runTool).
 */
export async function searchWeb(rawQuery: string): Promise<WebSearchResult> {
  const query = sanitizeQuery(rawQuery);
  if (!query) return { ok: false, output: 'Пустой поисковый запрос.' };
  if (!isSearchConfigured()) {
    return {
      ok: false,
      output: 'Веб-поиск не настроен: задайте AI_SEARCH_API_BASE и AI_API_KEY.',
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error('Поиск не ответил за 90 секунд (таймаут)')),
    SEARCH_TIMEOUT_MS,
  );
  try {
    const res = await fetch(`${config.ai.searchApiBase}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.ai.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(
        buildSearchBody(query, { model: config.ai.searchModel, maxUses: MAX_USES_PER_CALL }),
      ),
      signal: controller.signal,
    });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok || !data || data.type === 'error') {
      const message = extractErrorMessage(data) ?? `HTTP ${res.status}`;
      return { ok: false, output: `Ошибка поиска (API): ${message}` };
    }
    return { ok: true, output: formatSearchOutput(parseSearchResponse(data)) };
  } catch (err) {
    return { ok: false, output: `Ошибка поиска: ${String((err as Error).message ?? err)}` };
  } finally {
    clearTimeout(timer);
  }
}
