// The ```chart fenced block spec (agent visuals, docs/agent-visuals-plan.md).
// Pure module without React/i18n imports — unit-tested by the server runner
// (server/test/chart-spec.test.ts, the alerts.ts + alerts-merge.test.ts
// precedent).

export type ChartType = 'bar' | 'line' | 'pie';

export interface ChartSeries {
  name: string;
  data: number[];
}

export interface ChartSpec {
  type: ChartType;
  title?: string;
  unit?: string;
  labels: string[];
  series: ChartSeries[];
}

export const CHART_MAX_LABELS = 24;
export const CHART_MAX_SERIES = 6;
export const CHART_MAX_LABEL_LEN = 60;

const CHART_TYPES: readonly string[] = ['bar', 'line', 'pie'];

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isShortString(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max;
}

/**
 * Parses the body of a ```chart code block into a validated spec.
 * Returns null on any violation — the caller then shows the plain code
 * block (mid-stream the JSON is incomplete half the time, so no error
 * state is latched).
 */
export function parseChartSpec(text: string): ChartSpec | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  if (typeof obj.type !== 'string' || !CHART_TYPES.includes(obj.type)) return null;
  const type = obj.type as ChartType;

  if (obj.title !== undefined && !isShortString(obj.title, 120)) return null;
  if (obj.unit !== undefined && !isShortString(obj.unit, 20)) return null;

  if (!Array.isArray(obj.labels) || obj.labels.length === 0 || obj.labels.length > CHART_MAX_LABELS) {
    return null;
  }
  if (!obj.labels.every((l) => isShortString(l, CHART_MAX_LABEL_LEN))) return null;
  const labels = obj.labels as string[];

  if (!Array.isArray(obj.series) || obj.series.length === 0 || obj.series.length > CHART_MAX_SERIES) {
    return null;
  }
  const series: ChartSeries[] = [];
  for (const s of obj.series) {
    if (typeof s !== 'object' || s === null || Array.isArray(s)) return null;
    const so = s as Record<string, unknown>;
    if (!isShortString(so.name, CHART_MAX_LABEL_LEN)) return null;
    if (!Array.isArray(so.data) || so.data.length !== labels.length) return null;
    if (!so.data.every(isFiniteNumber)) return null;
    series.push({ name: so.name, data: so.data as number[] });
  }

  // A pie shows shares of a whole: exactly one series of non-negative values
  // with a non-zero total.
  if (type === 'pie') {
    if (series.length !== 1) return null;
    if (series[0].data.some((v) => v < 0)) return null;
    if (series[0].data.reduce((a, b) => a + b, 0) <= 0) return null;
  }

  return {
    type,
    ...(obj.title !== undefined ? { title: obj.title as string } : {}),
    ...(obj.unit !== undefined ? { unit: obj.unit as string } : {}),
    labels,
    series,
  };
}

/** Compact value for axis ticks and pie percentages: 1234 → "1.2k". */
export function formatChartValue(v: number): string {
  const abs = Math.abs(v);
  const trim = (x: number) => {
    const s = x.toFixed(1);
    return s.endsWith('.0') ? s.slice(0, -2) : s;
  };
  if (abs >= 1_000_000) return `${trim(v / 1_000_000)}M`;
  if (abs >= 10_000) return `${Math.round(v / 1000)}k`;
  if (abs >= 1000) return `${trim(v / 1000)}k`;
  if (Number.isInteger(v)) return String(v);
  return trim(v);
}
