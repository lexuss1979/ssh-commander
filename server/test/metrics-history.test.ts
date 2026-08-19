import { describe, expect, it, vi } from 'vitest';
import type { ServerMetrics } from '../src/services/metrics.js';
import {
  appendSample,
  clearHistory,
  decimate,
  getAllHistory,
  getHistory,
  shouldAppend,
  toSample,
  trimSamples,
  type HistorySample,
} from '../src/services/metrics-history.js';

function makeMetrics(
  timestamp: number,
  opts: Partial<{ cpu: number | null; memPct: number | null; load1: number | null }> = {},
): ServerMetrics {
  return {
    timestamp,
    cpu: { percent: opts.cpu === undefined ? 12.5 : opts.cpu, cores: 4 },
    memory: {
      totalBytes: 16_000_000_000,
      availableBytes: 8_000_000_000,
      usedBytes: 8_000_000_000,
      usedPercent: opts.memPct === undefined ? 50 : opts.memPct,
    },
    disks: [],
    uptimeSeconds: 86400,
    loadAverage: opts.load1 === undefined ? null : [opts.load1, 0.5, 0.3],
    processes: [],
  };
}

function sample(t: number, cpu = 10): HistorySample {
  return { t, cpu, memPct: 50, memUsedBytes: 1000, memTotalBytes: 2000, load1: 0.5 };
}

describe('toSample', () => {
  it('maps the light slice of a snapshot', () => {
    expect(toSample(makeMetrics(1_000, { cpu: 3.5, memPct: 77.7, load1: 1.25 }))).toEqual({
      t: 1_000,
      cpu: 3.5,
      memPct: 77.7,
      memUsedBytes: 8_000_000_000,
      memTotalBytes: 16_000_000_000,
      load1: 1.25,
    });
  });

  it('keeps nulls as nulls', () => {
    const s = toSample(makeMetrics(2_000, { cpu: null, memPct: null, load1: undefined }));
    expect(s.cpu).toBeNull();
    expect(s.memPct).toBeNull();
    expect(s.load1).toBeNull();
  });
});

describe('shouldAppend', () => {
  it('accepts the first sample for a profile', () => {
    expect(shouldAppend([], sample(1_000))).toBe(true);
  });

  it('rejects the same timestamp (metrics cache returns the same promise)', () => {
    expect(shouldAppend([sample(5_000)], sample(5_000))).toBe(false);
  });

  it('rejects gaps under 2 s and accepts >= 2 s', () => {
    expect(shouldAppend([sample(5_000)], sample(6_999))).toBe(false);
    expect(shouldAppend([sample(5_000)], sample(7_000))).toBe(true);
  });
});

describe('trimSamples', () => {
  it('returns the same array when nothing to trim', () => {
    const samples = [sample(0), sample(10_000), sample(20_000)];
    expect(trimSamples(samples, 20_000, 10, 60_000)).toBe(samples);
  });

  it('drops samples older than max age', () => {
    const samples = [sample(0), sample(10_000), sample(20_000)];
    const trimmed = trimSamples(samples, 25_000, 10, 12_000);
    expect(trimmed.map((s) => s.t)).toEqual([20_000]);
  });

  it('caps the count keeping the newest samples', () => {
    const samples = [1, 2, 3, 4, 5].map((t) => sample(t * 1_000));
    const trimmed = trimSamples(samples, 5_000, 3, 60_000);
    expect(trimmed.map((s) => s.t)).toEqual([3_000, 4_000, 5_000]);
  });

  it('handles an empty history', () => {
    expect(trimSamples([], 1_000)).toEqual([]);
  });
});

describe('decimate', () => {
  it('copies the input when it fits (result is safe to mutate)', () => {
    const samples = [sample(0), sample(1_000)];
    const picked = decimate(samples, 5);
    expect(picked).toEqual(samples);
    expect(picked).not.toBe(samples);
  });

  it('picks evenly spaced points and always keeps the last one', () => {
    const samples = Array.from({ length: 10 }, (_, i) => sample(i * 1_000));
    const picked = decimate(samples, 4);
    expect(picked.map((s) => s.t)).toEqual([0, 3_000, 6_000, 9_000]);
  });

  it('handles a single sample and an empty array', () => {
    expect(decimate([sample(0)], 1).map((s) => s.t)).toEqual([0]);
    expect(decimate([], 10)).toEqual([]);
  });
});

describe('appendSample / getHistory roundtrip', () => {
  // Уникальные id на тест: реестр общий для модуля и между тестами не чистится.
  // Timestamps — относительно Date.now(): при отдаче история фильтруется по
  // wall clock (см. тесты stale ниже), абсолютные константы протухли бы.
  it('appends fresh snapshots and skips cache-hit duplicates', () => {
    const id = 'rt-dedupe';
    const t0 = Date.now();
    appendSample(id, makeMetrics(t0));
    appendSample(id, makeMetrics(t0)); // тот же timestamp — кэш
    appendSample(id, makeMetrics(t0 + 1_500)); // ближе 2 с
    appendSample(id, makeMetrics(t0 + 2_000)); // ровно 2 с — принимается
    expect(getHistory(id).map((s) => s.t)).toEqual([t0, t0 + 2_000]);
    clearHistory(id);
  });

  it('serves copies: mutation of the result does not affect the registry', () => {
    const id = 'rt-copy';
    const t0 = Date.now();
    appendSample(id, makeMetrics(t0));
    appendSample(id, makeMetrics(t0 + 10_000));
    const first = getHistory(id);
    first.pop();
    expect(getHistory(id)).toHaveLength(2);
    clearHistory(id);
  });

  it('getAllHistory lists profiles with decimated samples; clearHistory removes one', () => {
    const idA = 'rt-bulk-a';
    const idB = 'rt-bulk-b';
    const t0 = Date.now() - 100_000;
    for (let i = 0; i < 10; i++) {
      appendSample(idA, makeMetrics(t0 + i * 10_000));
    }
    appendSample(idB, makeMetrics(t0));
    const all = getAllHistory(4);
    const entryA = all.find((p) => p.id === idA);
    expect(entryA?.samples).toHaveLength(4);
    expect(all.find((p) => p.id === idB)?.samples).toHaveLength(1);
    clearHistory(idA);
    expect(getAllHistory().find((p) => p.id === idA)).toBeUndefined();
    clearHistory(idB);
  });

  it('getHistory of an unknown profile is an empty array', () => {
    expect(getHistory('rt-unknown')).toEqual([]);
  });
});

describe('serve-time staleness', () => {
  // Возраст при отдаче отмеряется по wall clock: пока профиль лежит и новых
  // сэмплов нет, история всё равно стареет (trimSamples при записи отрезает
  // хвост только относительно свежего сэмпла).
  it('drops everything after the profile was idle over 24 h', () => {
    const id = 'stale-all';
    const t0 = Date.now();
    appendSample(id, makeMetrics(t0));
    appendSample(id, makeMetrics(t0 + 10_000));
    vi.setSystemTime(t0 + 10_000 + 24 * 60 * 60 * 1000 + 1);
    expect(getHistory(id)).toEqual([]);
    expect(getAllHistory().find((p) => p.id === id)?.samples).toEqual([]);
    vi.useRealTimers();
    clearHistory(id);
  });

  it('keeps samples that are still inside the 24 h window', () => {
    const id = 'stale-partial';
    const t0 = Date.now();
    appendSample(id, makeMetrics(t0));
    appendSample(id, makeMetrics(t0 + 10_000));
    // Через сутки минус 5 с: первая точка уже за окном, вторая ещё свежа.
    vi.setSystemTime(t0 + 10_000 + 24 * 60 * 60 * 1000 - 5_000);
    expect(getHistory(id).map((s) => s.t)).toEqual([t0 + 10_000]);
    vi.useRealTimers();
    clearHistory(id);
  });
});
