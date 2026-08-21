import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const dataDir = mkdtempSync(path.join(tmpdir(), 'sc-usage-'));
process.env.DATA_DIR = dataDir;

const usage = await import('../src/ai/usage.js');

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function rec(overrides: Partial<Parameters<typeof usage.recordUsage>[0]> = {}) {
  return usage.recordUsage({
    ts: Date.now(),
    profileId: 'p1',
    dialogueId: 'd1',
    kind: 'chat',
    model: 'gpt-4.1-mini',
    promptTokens: 1000,
    cachedTokens: 100,
    completionTokens: 500,
    reasoningTokens: 0,
    costUsd: 0.0012,
    ...overrides,
  });
}

describe('ai-usage store', () => {
  it('round-trip записи: id генерируется, файл персистится атомарно', () => {
    const r = rec();
    expect(r.id).toMatch(/^[0-9a-f]{8}$/);
    const list = usage.listUsage();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      profileId: 'p1',
      dialogueId: 'd1',
      kind: 'chat',
      model: 'gpt-4.1-mini',
      promptTokens: 1000,
      cachedTokens: 100,
      completionTokens: 500,
      costUsd: 0.0012,
    });
    // tmp-файла после записи не остаётся.
    const files = readdirSync(dataDir);
    expect(files).toContain('ai-usage.json');
    expect(files.some((f) => f.startsWith('ai-usage.json.tmp'))).toBe(false);
    expect(JSON.parse(readFileSync(path.join(dataDir, 'ai-usage.json'), 'utf8')).usage).toHaveLength(1);
  });

  it('web_search запись несёт searchRequests', () => {
    rec({
      dialogueId: 'd2',
      kind: 'web_search',
      model: 'deepseek-v4-flash',
      promptTokens: 8000,
      cachedTokens: 0,
      completionTokens: 400,
      reasoningTokens: 0,
      searchRequests: 2,
      costUsd: null,
    });
    const found = usage.listUsage().find((x) => x.dialogueId === 'd2');
    expect(found?.searchRequests).toBe(2);
    expect(found?.costUsd).toBeNull();
  });

  it('невалидная запись отклоняется (отрицательные токены, чужой kind)', () => {
    expect(() => rec({ promptTokens: -1 })).toThrow();
    expect(() => rec({ kind: 'bogus' as never })).toThrow();
  });

  it('usageTotalsByDialogue: смесь priced/unpriced — сумма + unpricedCalls', () => {
    // d3: два priced + один unpriced вызов.
    rec({ dialogueId: 'd3', promptTokens: 1000, costUsd: 0.001 });
    rec({ dialogueId: 'd3', promptTokens: 2000, costUsd: 0.002 });
    rec({ dialogueId: 'd3', promptTokens: 3000, costUsd: null });
    const totals = usage.usageTotalsByDialogue();
    const t = totals.get('d3');
    expect(t).toBeDefined();
    expect(t?.calls).toBe(3);
    expect(t?.promptTokens).toBe(6000);
    expect(t?.costUsd).toBeCloseTo(0.003, 9);
    expect(t?.unpricedCalls).toBe(1);
  });

  it('usageReport: группировка по дням и профилям, totals, unpricedCalls', () => {
    // Сегодня: pA — 2 вызова (1 priced, 1 unpriced); pB — 1 вызов.
    const today = usage.dateKey(Date.now());
    rec({ profileId: 'pA', dialogueId: 'dA', costUsd: 0.01, promptTokens: 111 });
    rec({ profileId: 'pA', dialogueId: 'dA', costUsd: null, promptTokens: 222 });
    rec({ profileId: 'pB', dialogueId: 'dB', costUsd: 0.02, promptTokens: 333 });

    const report = usage.usageReport(30);
    const day = report.days.find((d) => d.date === today);
    expect(day).toBeDefined();
    expect(day?.byProfile['pA']).toMatchObject({ calls: 2, costUsd: 0.01, unpricedCalls: 1 });
    expect(day?.byProfile['pA']?.promptTokens).toBe(333);
    expect(day?.byProfile['pB']).toMatchObject({ calls: 1, costUsd: 0.02, unpricedCalls: 0 });
    // total дня = сумма всех его профилей (в файле есть и записи из других
    // тестов — проверяем инвариант согласованности, а не абсолютные числа).
    const sumCalls = Object.values(day?.byProfile ?? {}).reduce((n, a) => n + a.calls, 0);
    const sumCost = Object.values(day?.byProfile ?? {}).reduce((n, a) => n + a.costUsd, 0);
    const sumUnpriced = Object.values(day?.byProfile ?? {}).reduce((n, a) => n + a.unpricedCalls, 0);
    expect(day?.total.calls).toBe(sumCalls);
    expect(day?.total.costUsd).toBeCloseTo(sumCost, 9);
    expect(day?.total.unpricedCalls).toBe(sumUnpriced);
    expect(report.totals.calls).toBeGreaterThanOrEqual(3);
    expect(report.totals.unpricedCalls).toBeGreaterThanOrEqual(1);
  });

  it('usageReport: дни desc, пустые дни не включаются', () => {
    const report = usage.usageReport('all');
    const dates = report.days.map((d) => d.date);
    const sorted = [...dates].sort((a, b) => (a < b ? 1 : -1));
    expect(dates).toEqual(sorted);
    // У каждого дня есть хотя бы один вызов.
    for (const d of report.days) expect(d.total.calls).toBeGreaterThan(0);
  });

  it('usageReport: days=' + "'all'" + ' включает записи старше окна', () => {
    const old = new Date();
    old.setDate(old.getDate() - 60);
    rec({ profileId: 'p1', dialogueId: 'd6', ts: old.getTime(), costUsd: 0.5 });
    const all = usage.usageReport('all');
    const day30 = usage.usageReport(30);
    const oldDate = usage.dateKey(old.getTime());
    expect(all.days.some((d) => d.date === oldDate)).toBe(true);
    expect(day30.days.some((d) => d.date === oldDate)).toBe(false);
    expect(day30.totals.calls).toBeLessThan(all.totals.calls);
  });

  it('moves a broken store aside and refuses to persist until restart', async () => {
    rmSync(path.join(dataDir, 'ai-usage.json'), { force: true });
    writeFileSync(path.join(dataDir, 'ai-usage.json'), '{not json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.resetModules();
    const fresh = await import('../src/ai/usage.js');

    expect(fresh.listUsage()).toEqual([]);

    const backups = readdirSync(dataDir).filter((f) => f.startsWith('ai-usage.json.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(path.join(dataDir, backups[0]), 'utf8')).toBe('{not json');
    expect(warn).toHaveBeenCalled();

    expect(() =>
      fresh.recordUsage({
        ts: Date.now(),
        profileId: 'p1',
        dialogueId: 'd1',
        kind: 'chat',
        model: 'm',
        promptTokens: 1,
        cachedTokens: 0,
        completionTokens: 0,
        reasoningTokens: 0,
        costUsd: null,
      }),
    ).toThrow(/corrupt/);
    expect(readdirSync(dataDir).filter((f) => f === 'ai-usage.json')).toHaveLength(0);
    warn.mockRestore();
  });
});
