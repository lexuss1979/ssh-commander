import type { ServerMetrics } from './metrics.js';

/**
 * A lightweight slice of the metrics snapshot for the load chart: processes,
 * disks and other heavy fields are not accumulated — only what is drawn on
 * "Overview" and "Servers".
 */
export interface HistorySample {
  /** Snapshot time (ms, ssh-commander server clock). */
  t: number;
  cpu: number | null;
  memPct: number | null;
  memUsedBytes: number | null;
  memTotalBytes: number | null;
  load1: number | null;
}

// The minimum gap between samples equals the collectMetrics cache TTL: the
// cache returns the same promise (the same timestamp), a duplicate record is
// not needed, and two independent snapshots closer than 2 s do not happen
// anyway.
const MIN_SAMPLE_GAP_MS = 2000;
// ~12 h at the basic 10 s polling (sidebar), ~3.5 h at the dense 3 s
// ("Overview").
const MAX_SAMPLES_PER_PROFILE = 4320;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

// In-memory storage only: the history lives while the process runs and the
// UI feeds it with polling (like the tunnel registry). After a restart it
// accumulates anew.
const history = new Map<string, HistorySample[]>();

export function toSample(metrics: ServerMetrics): HistorySample {
  return {
    t: metrics.timestamp,
    cpu: metrics.cpu.percent,
    memPct: metrics.memory.usedPercent,
    memUsedBytes: metrics.memory.usedBytes,
    memTotalBytes: metrics.memory.totalBytes,
    load1: metrics.loadAverage ? metrics.loadAverage[0] : null,
  };
}

/** A sample is worth recording: the first for a profile or at least 2 s after the last one. */
export function shouldAppend(samples: HistorySample[], sample: HistorySample): boolean {
  const last = samples[samples.length - 1];
  if (!last) return true;
  return sample.t - last.t >= MIN_SAMPLE_GAP_MS;
}

/**
 * History trim: samples older than maxAgeMs and everything beyond maxSamples
 * are dropped (the freshest remain). The array is not copied if there is
 * nothing to cut.
 */
export function trimSamples(
  samples: HistorySample[],
  now: number,
  maxSamples: number = MAX_SAMPLES_PER_PROFILE,
  maxAgeMs: number = MAX_AGE_MS,
): HistorySample[] {
  const minT = now - maxAgeMs;
  let start = 0;
  while (start < samples.length && samples[start].t < minT) start++;
  let out = start > 0 ? samples.slice(start) : samples;
  if (out.length > maxSamples) {
    out = out.slice(out.length - maxSamples);
  }
  return out;
}

/**
 * Uniform sampling down to maxPoints points (the first and last are kept),
 * so the API response does not bloat on large history windows. Always
 * returns a new array — the caller may mutate it without touching the
 * registry.
 */
export function decimate(samples: HistorySample[], maxPoints: number): HistorySample[] {
  if (samples.length <= maxPoints) return samples.slice();
  const step = (samples.length - 1) / (maxPoints - 1);
  const out: HistorySample[] = [];
  for (let i = 0; i < maxPoints - 1; i++) {
    out.push(samples[Math.floor(i * step)]);
  }
  out.push(samples[samples.length - 1]);
  return out;
}

/** Record a sample from a fresh snapshot (called from collectMetrics). */
export function appendSample(profileId: string, metrics: ServerMetrics): void {
  const samples = history.get(profileId) ?? [];
  const sample = toSample(metrics);
  if (!shouldAppend(samples, sample)) return;
  history.set(profileId, trimSamples([...samples, sample], sample.t));
}

/**
 * One profile's history (a copy, decimated to maxPoints). The age is also
 * measured on delivery — by wall clock: while a profile is down and there
 * are no new samples, yesterday's points must not look current (trimSamples
 * on write cuts the tail only relative to a fresh sample).
 */
export function getHistory(profileId: string, maxPoints = 360): HistorySample[] {
  const samples = history.get(profileId);
  if (!samples) return [];
  return decimate(trimSamples(samples, Date.now()), maxPoints);
}

/** All profiles' history for the summary "Servers" screen. */
export function getAllHistory(
  maxPoints = 120,
): Array<{ id: string; samples: HistorySample[] }> {
  return [...history.entries()].map(([id, samples]) => ({
    id,
    samples: decimate(trimSamples(samples, Date.now()), maxPoints),
  }));
}

/** Removed along with the profile, so the registry does not leak. */
export function clearHistory(profileId: string): void {
  history.delete(profileId);
}
