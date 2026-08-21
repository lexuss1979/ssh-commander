import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { config } from '../config.js';

/**
 * Цены моделей для учёта расходов AI (docs/ai-costs-plan.md, решение 2).
 * Дефолты в коде + оверрайд-файл `data/ai-prices.json` поверх них.
 *
 * Справочник, а не пользовательские данные: битый файл цен → warn + дефолты
 * (corrupt-guard, как у хранилищ, здесь не нужен — оверрайд не обязан
 * существовать, молчаливого затирания данных нет).
 */

/** Цена модели: USD за 1М токенов (вход/выход), кэш-вход — опционально,
 * тариф поискового запроса серверного web_search — опционально (USD за запрос). */
export interface ModelPrice {
  /** USD за 1M входных токенов (кэш-miss). */
  input: number;
  /** USD за 1M кэшированных входных токенов; без него кэш считается по `input`. */
  cachedInput?: number;
  /** USD за 1M выходных токенов. */
  output: number;
  /** USD за один поисковый запрос серверного web_search; без него вызовы
   * поиска считаются непротарифицированными (costUsd → null). */
  webSearchPerRequestUsd?: number;
}

/**
 * Дефолтная таблица популярных моделей. Цены — на момент реализации
 * (прайсы OpenAI/DeepSeek); актуальность держится оверрайд-файлом
 * `data/ai-prices.json`. Модель без цены в таблице честнее неверной
 * цифры — такие вызовы помечаются `unpricedCalls` в отчёте.
 *
 * DeepSeek V4 (api-docs.deepseek.com/quick_start/pricing): вход — кэш-miss,
 * cachedInput — кэш-hit; указаны off-peak тарифы, пиковые часы
 * (01:00–04:00 и 06:00–10:00 UTC) в 2 раза дороже. Серверный web_search
 * DeepSeek оплачивается токенами модели поиска — отдельной цены за запрос
 * нет (см. computeCostUsd: без webSearchPerRequestUsd поиск считается по
 * токенам, а не помечается непротарифицированным).
 */
export const DEFAULT_PRICES: Record<string, ModelPrice> = {
  // OpenAI (USD за 1M токенов; cached input — со скидкой 50%).
  'gpt-4.1': { input: 2.0, cachedInput: 1.0, output: 8.0 },
  'gpt-4.1-mini': { input: 0.4, cachedInput: 0.2, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, cachedInput: 0.05, output: 0.4 },
  'gpt-4o': { input: 2.5, cachedInput: 1.25, output: 10.0 },
  'gpt-4o-mini': { input: 0.15, cachedInput: 0.075, output: 0.6 },
  // DeepSeek: вход — кэш-miss, cachedInput — кэш-hit (схема провайдера).
  'deepseek-chat': { input: 0.27, cachedInput: 0.07, output: 1.1 },
  'deepseek-reasoner': { input: 0.55, cachedInput: 0.14, output: 2.19 },
  // DeepSeek V4, off-peak (пик ×2). Кэш-хиты — из prompt_cache_hit_tokens /
  // prompt_tokens_details.cached_tokens (см. client.ts parseTokenUsage).
  'deepseek-v4-flash': { input: 0.22, cachedInput: 0.007, output: 0.66 },
  'deepseek-v4-pro': { input: 0.66, cachedInput: 0.022, output: 1.98 },
  // Прочие модели: цены не зафиксированы — без записи (unpriced); добавить
  // через data/ai-prices.json.
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
 * Таблица цен: дефолты + мерж оверрайд-файла по имени модели (запись файла
 * полностью заменяет дефолтную для этой модели). Битый/невалидный файл —
 * warn + дефолты. Чтение синхронное и дешёвое, вызывается только при записи
 * в журнал usage — кэширование не нужно.
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

/** Токены/поисковые запросы для расчёта стоимости. */
export interface CostUsageInput {
  promptTokens?: number;
  cachedTokens?: number;
  completionTokens?: number;
  /** Число поисковых запросов серверного web_search (только kind 'web_search'). */
  searchRequests?: number;
}

function nonneg(v: number | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Стоимость вызова в USD или null, если модель не протарифицирована.
 * Зафиксированная формула (docs/ai-costs-plan.md, решение 2):
 *   cost = (promptTokens − cachedTokens) · input + cachedTokens · cachedInput
 *        + completionTokens · output + searchRequests · webSearchPerRequestUsd
 * Инварианты usage (гарантируются на захвате): cached ⊂ prompt,
 * reasoning ⊂ completion — reasoning в формулу НЕ входит (уже в output).
 * Без `cachedInput` у модели кэш-токены считаются по обычной цене `input`.
 * Поисковые запросы: слагаемое добавляется только при заданном
 * `webSearchPerRequestUsd`; без него поиск считается по токенам (тариф
 * DeepSeek: серверный web_search оплачивается токенами модели поиска,
 * отдельной цены за запрос нет) — null только для неизвестной модели.
 */
export function computeCostUsd(model: string, usage: CostUsageInput): number | null {
  const price = loadPrices()[model];
  if (!price) return null;

  const prompt = nonneg(usage.promptTokens);
  // cached — подмножество prompt (инвариант захвата); защита от мусора.
  const cached = Math.min(nonneg(usage.cachedTokens), prompt);
  const completion = nonneg(usage.completionTokens);
  const searches = nonneg(usage.searchRequests);

  // Цены вход/выход — USD за 1M токенов; тариф поиска — USD за запрос.
  const TOKENS_PER_UNIT = 1_000_000;
  return (
    ((prompt - cached) * price.input +
      cached * (price.cachedInput ?? price.input) +
      completion * price.output) /
      TOKENS_PER_UNIT +
    searches * (price.webSearchPerRequestUsd ?? 0)
  );
}
