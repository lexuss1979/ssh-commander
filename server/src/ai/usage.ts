import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';

/**
 * Журнал расходов AI (docs/ai-costs-plan.md, решение 4): отдельный стор
 * `data/ai-usage.json` — удаление диалога не стирает финансовую историю.
 * Канонический паттерн проекта (zod + tmp/rename + corrupt-guard, образец —
 * `db-connections.ts`). Запись — на один вызов API (chat/plan/web_search),
 * стоимость фиксируется в момент вызова: смена цен не переписывает историю,
 * токены в записи позволяют пересчитать потом.
 *
 * Объём: десятки тысяч записей ≈ единицы МБ JSON — компакция не нужна.
 */

export const usageKindSchema = z.enum(['chat', 'plan', 'web_search']);

/** Одна запись журнала — один вызов платного API. */
export interface UsageRecord {
  id: string;
  /** epoch ms вызова (локальное время сервера приложения — см. dateKey). */
  ts: number;
  /** Домашний профиль диалога — привязка затрат (решение 6). */
  profileId: string;
  dialogueId: string;
  kind: 'chat' | 'plan' | 'web_search';
  model: string;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  /** Только информационно: входит в completionTokens (инвариант usage). */
  reasoningTokens: number;
  /** Число поисковых запросов серверного web_search; только kind 'web_search'. */
  searchRequests?: number;
  /** Посчитанный в момент вызова costUsd; null — цена модели не задана. */
  costUsd: number | null;
}

const usageRecordSchema = z.object({
  id: z.string().min(1),
  ts: z.number().int().nonnegative(),
  profileId: z.string().min(1),
  dialogueId: z.string().min(1),
  kind: usageKindSchema,
  model: z.string().min(1),
  promptTokens: z.number().int().nonnegative(),
  cachedTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
  searchRequests: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().nullable(),
});

const storeSchema = z.object({ usage: z.array(usageRecordSchema).default([]) });

/** Вход recordUsage: id генерируется внутри. */
export type UsageRecordInput = Omit<UsageRecord, 'id'>;

/** Агрегат по диалогу/дню/профилю: суммы + честный счётчик вызовов без цены. */
export interface UsageAgg {
  calls: number;
  promptTokens: number;
  /** Кэшированные входные токены — информационно (в tooltip бейджа/ячейки). */
  cachedTokens: number;
  completionTokens: number;
  /** Сумма costUsd протарифицированных вызовов; неполна при unpricedCalls > 0. */
  costUsd: number;
  unpricedCalls: number;
}

export interface UsageDayReport {
  /** Локальная дата сервера, YYYY-MM-DD. */
  date: string;
  byProfile: Record<string, UsageAgg>;
  total: UsageAgg;
}

export interface UsageReportData {
  /** Дни desc, пустые дни не включаются. */
  days: UsageDayReport[];
  totals: UsageAgg;
}

let cache: UsageRecord[] | null = null;
// Set when the store file failed to parse: the broken file is moved aside
// (kept for recovery) and persist() refuses to run until a restart with a
// fixed file, so a corrupt store is never silently overwritten.
let corrupt = false;

function storePath(): string {
  return path.join(config.dataDir, 'ai-usage.json');
}

function load(): UsageRecord[] {
  if (!cache) {
    try {
      const raw = fs.readFileSync(storePath(), 'utf8');
      cache = storeSchema.parse(JSON.parse(raw)).usage;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        cache = [];
      } else {
        const backup = `${storePath()}.corrupt-${Date.now()}`;
        try {
          fs.renameSync(storePath(), backup);
        } catch {
          /* keep the original in place */
        }
        console.warn(`ai-usage store is unreadable, moved to ${backup}; refusing to overwrite it until restart:`, err);
        corrupt = true;
        cache = [];
      }
    }
  }
  return cache;
}

function persist(list: UsageRecord[]): void {
  if (corrupt) {
    throw new Error('ai-usage store was corrupt at startup; refusing to overwrite it — fix or remove the *.corrupt-* file and restart');
  }
  fs.mkdirSync(config.dataDir, { recursive: true });
  const tmp = `${storePath()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ usage: list }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, storePath());
  cache = list.map((r) => ({ ...r }));
}

/** Локальная дата сервера приложения (в Docker обычно UTC — при необходимости
 * задать TZ в compose), YYYY-MM-DD. */
export function dateKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Дата `days` дней назад от сегодня (включительно) — граница отчёта. */
function cutoffKey(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - (days - 1));
  return dateKey(d.getTime());
}

const emptyAgg = (): UsageAgg => ({
  calls: 0,
  promptTokens: 0,
  cachedTokens: 0,
  completionTokens: 0,
  costUsd: 0,
  unpricedCalls: 0,
});

function addAgg(agg: UsageAgg, rec: UsageRecord): void {
  agg.calls += 1;
  agg.promptTokens += rec.promptTokens;
  agg.cachedTokens += rec.cachedTokens;
  agg.completionTokens += rec.completionTokens;
  if (rec.costUsd === null) {
    agg.unpricedCalls += 1;
  } else {
    agg.costUsd += rec.costUsd;
  }
}

/** Запись вызова: append + persist (каждая запись перезаписывает файл целиком
 * через tmp+rename — см. риск «перезапись на вызов» в плане). */
export function recordUsage(input: UsageRecordInput): UsageRecord {
  const rec: UsageRecord = { ...input, id: crypto.randomUUID().slice(0, 8) };
  usageRecordSchema.parse(rec);
  const list = load();
  list.push(rec);
  persist(list);
  return { ...rec };
}

/** Все записи журнала (тесты, диагностика). */
export function listUsage(): UsageRecord[] {
  return load().map((r) => ({ ...r }));
}

/** Кумулятивные итоги по диалогам — для enrichment списков и WS-бейджа. */
export function usageTotalsByDialogue(): Map<string, UsageAgg> {
  const totals = new Map<string, UsageAgg>();
  for (const rec of load()) {
    const agg = totals.get(rec.dialogueId) ?? emptyAgg();
    addAgg(agg, rec);
    totals.set(rec.dialogueId, agg);
  }
  return totals;
}

/**
 * Отчёт по дням и профилям: агрегация in-memory, группы по (дата, profileId)
 * + итоги, счётчик unpricedCalls (costUsd === null). Дни desc, пустые дни
 * не включаются. Имена профилей присоединяет роут (сторы друг о друге
 * не знают).
 */
export function usageReport(days: number | 'all'): UsageReportData {
  const from = days === 'all' ? undefined : cutoffKey(days);
  const byDate = new Map<string, { byProfile: Map<string, UsageAgg> }>();
  for (const rec of load()) {
    const key = dateKey(rec.ts);
    if (from !== undefined && key < from) continue;
    let day = byDate.get(key);
    if (!day) {
      day = { byProfile: new Map() };
      byDate.set(key, day);
    }
    const agg = day.byProfile.get(rec.profileId) ?? emptyAgg();
    addAgg(agg, rec);
    day.byProfile.set(rec.profileId, agg);
  }

  const daysOut: UsageDayReport[] = [];
  const totals = emptyAgg();
  for (const [date, day] of [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1))) {
    const byProfile: Record<string, UsageAgg> = {};
    const total = emptyAgg();
    for (const [profileId, agg] of day.byProfile) {
      byProfile[profileId] = agg;
      total.calls += agg.calls;
      total.promptTokens += agg.promptTokens;
      total.cachedTokens += agg.cachedTokens;
      total.completionTokens += agg.completionTokens;
      total.costUsd += agg.costUsd;
      total.unpricedCalls += agg.unpricedCalls;
    }
    daysOut.push({ date, byProfile, total });
    totals.calls += total.calls;
    totals.promptTokens += total.promptTokens;
    totals.cachedTokens += total.cachedTokens;
    totals.completionTokens += total.completionTokens;
    totals.costUsd += total.costUsd;
    totals.unpricedCalls += total.unpricedCalls;
  }
  return { days: daysOut, totals };
}
