import { describe, expect, it } from 'vitest';
// The chart spec module — pure TypeScript without React/DOM, so it is
// covered by the server runner directly (the alerts-merge.test.ts precedent).
import {
  CHART_MAX_LABELS,
  CHART_MAX_SERIES,
  formatChartValue,
  parseChartSpec,
} from '../../web/src/chart-spec.js';

function spec(over: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'bar',
    labels: ['a', 'b'],
    series: [{ name: 's1', data: [1, 2] }],
    ...over,
  });
}

describe('parseChartSpec', () => {
  it('accepts valid bar/line/pie specs', () => {
    expect(parseChartSpec(spec({}))).toMatchObject({ type: 'bar' });
    expect(parseChartSpec(spec({ type: 'line' }))).toMatchObject({ type: 'line' });
    expect(parseChartSpec(spec({ type: 'pie' }))).toMatchObject({ type: 'pie' });
  });

  it('keeps optional title/unit and drops nothing from series', () => {
    const parsed = parseChartSpec(
      spec({ title: 'Disk', unit: 'GB', series: [{ name: 'used', data: [1, 2] }, { name: 'free', data: [3, 4] }] }),
    );
    expect(parsed).toMatchObject({ title: 'Disk', unit: 'GB' });
    expect(parsed?.series).toHaveLength(2);
  });

  it('rejects non-JSON and non-object bodies', () => {
    expect(parseChartSpec('not json')).toBeNull();
    expect(parseChartSpec('{"type":"bar"')).toBeNull(); // mid-stream fragment
    expect(parseChartSpec('[1,2,3]')).toBeNull();
    expect(parseChartSpec('null')).toBeNull();
  });

  it('rejects unknown types and bad optional fields', () => {
    expect(parseChartSpec(spec({ type: 'radar' }))).toBeNull();
    expect(parseChartSpec(spec({ title: 5 }))).toBeNull();
    expect(parseChartSpec(spec({ unit: 'x'.repeat(21) }))).toBeNull();
  });

  it('rejects empty/oversized/invalid labels', () => {
    expect(parseChartSpec(spec({ labels: [] }))).toBeNull();
    expect(parseChartSpec(spec({ labels: Array(CHART_MAX_LABELS + 1).fill('x') }))).toBeNull();
    expect(parseChartSpec(spec({ labels: ['a', 5] }))).toBeNull();
    expect(parseChartSpec(spec({ labels: ['a', 'x'.repeat(61)] }))).toBeNull();
  });

  it('rejects empty/oversized series and data not matching labels', () => {
    expect(parseChartSpec(spec({ series: [] }))).toBeNull();
    expect(
      parseChartSpec(
        spec({ series: Array.from({ length: CHART_MAX_SERIES + 1 }, (_, i) => ({ name: `s${i}`, data: [1, 2] })) }),
      ),
    ).toBeNull();
    expect(parseChartSpec(spec({ series: [{ name: 's1', data: [1] }] }))).toBeNull();
    expect(parseChartSpec(spec({ series: [{ name: 's1', data: [1, 'x'] }] }))).toBeNull();
    expect(parseChartSpec(spec({ series: [{ name: '', data: [1, 2] }] }))).toBeNull();
  });

  it('JSON cannot carry NaN/Infinity, but non-finite slips via nothing else — check strings masquerading as numbers', () => {
    expect(parseChartSpec('{"type":"bar","labels":["a","b"],"series":[{"name":"s","data":[1e999,2]}]}')).toBeNull();
  });

  it('pie requires exactly one series of non-negative values with a positive total', () => {
    expect(
      parseChartSpec(spec({ type: 'pie', series: [{ name: 'a', data: [1, 2] }, { name: 'b', data: [3, 4] }] })),
    ).toBeNull();
    expect(parseChartSpec(spec({ type: 'pie', series: [{ name: 'a', data: [1, -2] }] }))).toBeNull();
    expect(parseChartSpec(spec({ type: 'pie', series: [{ name: 'a', data: [0, 0] }] }))).toBeNull();
    expect(parseChartSpec(spec({ type: 'pie', series: [{ name: 'a', data: [0, 5] }] }))).not.toBeNull();
  });
});

describe('formatChartValue', () => {
  it('formats magnitudes compactly', () => {
    expect(formatChartValue(0)).toBe('0');
    expect(formatChartValue(42)).toBe('42');
    expect(formatChartValue(2.5)).toBe('2.5');
    expect(formatChartValue(1500)).toBe('1.5k');
    expect(formatChartValue(10_000)).toBe('10k');
    expect(formatChartValue(2_300_000)).toBe('2.3M');
    expect(formatChartValue(-1500)).toBe('-1.5k');
    expect(formatChartValue(2000)).toBe('2k'); // trailing .0 is trimmed
  });
});
