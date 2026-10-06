import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';

/**
 * AI costs journal (docs/ai-costs-plan.md, decision 4): a separate store
 * `data/ai-usage.json` — deleting a dialogue does not erase the financial
 * history. The project's canonical pattern (zod + tmp/rename + corrupt-guard,
 * the sample is `db-connections.ts`). A record is per API call
 * (chat/plan/web_search), the cost is fixed at call time: price changes do
 * not rewrite history, the tokens in a record allow recalculating later.
 *
 * Volume: tens of thousands of records ≈ a few MB of JSON — no compaction
 * needed.
 */

export const usageKindSchema = z.enum(['chat', 'plan', 'web_search']);

/** One journal record — one paid API call. */
export interface UsageRecord {
  id: string;
  /** Call epoch ms (the app server's local time — see dateKey). */
  ts: number;
  /** The dialogue's home profile — cost attribution (decision 6). */
  profileId: string;
  dialogueId: string;
  kind: 'chat' | 'plan' | 'web_search';
  model: string;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  /** Informational only: included in completionTokens (the usage invariant). */
  reasoningTokens: number;
  /** Number of server-side web_search requests; kind 'web_search' only. */
  searchRequests?: number;
  /** costUsd computed at call time; null — the model has no price. */
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

/** The recordUsage input: the id is generated inside. */
export type UsageRecordInput = Omit<UsageRecord, 'id'>;

/** An aggregate per dialogue/day/profile: sums + an honest counter of unpriced calls. */
export interface UsageAgg {
  calls: number;
  promptTokens: number;
  /** Cached input tokens — informational (in the badge/cell tooltip). */
  cachedTokens: number;
  completionTokens: number;
  /** Sum of costUsd over priced calls; incomplete when unpricedCalls > 0. */
  costUsd: number;
  unpricedCalls: number;
}

export interface UsageDayReport {
  /** The server's local date, YYYY-MM-DD. */
  date: string;
  byProfile: Record<string, UsageAgg>;
  total: UsageAgg;
}

export interface UsageReportData {
  /** Days desc, empty days are not included. */
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

/** The app server's local date (in Docker usually UTC — set TZ in compose
 * if needed), YYYY-MM-DD. */
export function dateKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** The date `days` days back from today (inclusive) — the report boundary. */
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

/** Recording a call: append + persist (each record rewrites the whole file
 * via tmp+rename — see the "rewrite per call" risk in the plan). */
export function recordUsage(input: UsageRecordInput): UsageRecord {
  const rec: UsageRecord = { ...input, id: crypto.randomUUID().slice(0, 8) };
  usageRecordSchema.parse(rec);
  const list = load();
  list.push(rec);
  persist(list);
  return { ...rec };
}

/** All journal records (tests, diagnostics). */
export function listUsage(): UsageRecord[] {
  return load().map((r) => ({ ...r }));
}

/** Cumulative totals per dialogue — for list enrichment and the WS badge. */
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
 * A report by days and profiles: in-memory aggregation, groups by
 * (date, profileId) + totals, the unpricedCalls counter (costUsd === null).
 * Days desc, empty days are not included. Profile names are joined by the
 * route (the stores know nothing about each other).
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
