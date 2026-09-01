import { useMemo } from 'react';
import type { HistorySample } from '../api';
import { useT } from '../i18n';

/** Точка графика: момент сэмпла и значение (null — данных нет). */
interface ChartPoint {
  t: number;
  v: number | null;
}

/** Отрезок непрерывной линии между разрывами (null или гэп во времени). */
interface ChartSegment {
  line: string;
  area: string;
}

export interface ChartProps {
  samples: HistorySample[];
  value: (s: HistorySample) => number | null;
  tone: 'cpu' | 'mem';
}

/**
 * Геометрия в системе 0..100: x — позиция по времени сэмпла, y — проценты
 * сверху вниз. Ось именно временная: частота опросов непостоянна (3/5/10 с на
 * разных экранах, паузы скрытых вкладок), индексная ось «схлопывала» бы
 * ночные паузы и меняла масштаб плотных участков.
 *
 * Линия рвётся не только на null-значениях, но и на гэпах во времени
 * (t[i] − t[i−1] > 3 × медианного интервала): пауза опроса не должна
 * выглядеть сплошной линией между вечером и утром. Для LoadChart это же
 * согласует шкалу с подписями времени по краям.
 */
function buildSegments(points: ChartPoint[]): ChartSegment[] {
  const n = points.length;
  if (n < 2) return [];
  const t0 = points[0].t;
  const tSpan = points[n - 1].t - t0;
  if (tSpan <= 0) return [];
  const x = (t: number) => ((t - t0) / tSpan) * 100;
  const y = (v: number) => 100 - Math.min(100, Math.max(0, v));

  const gaps: number[] = [];
  for (let i = 1; i < n; i++) gaps.push(points[i].t - points[i - 1].t);
  gaps.sort((a, b) => a - b);
  const medianGap = gaps[Math.floor(gaps.length / 2)];
  const gapBreak = medianGap > 0 ? medianGap * 3 : Number.POSITIVE_INFINITY;

  const segments: ChartSegment[] = [];
  let current: Array<[number, number]> = [];
  const flush = () => {
    if (current.length >= 2) {
      const line = current
        .map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${px.toFixed(2)},${py.toFixed(2)}`)
        .join(' ');
      const [fx] = current[0];
      const [lx] = current[current.length - 1];
      segments.push({ line, area: `${line} L${lx.toFixed(2)},100 L${fx.toFixed(2)},100 Z` });
    }
    current = [];
  };
  points.forEach((p, i) => {
    const gap = i > 0 ? p.t - points[i - 1].t : 0;
    if (p.v === null || gap > gapBreak) {
      flush();
      return;
    }
    current.push([x(p.t), y(p.v)]);
  });
  flush();
  return segments;
}

function useSegments(samples: HistorySample[], value: (s: HistorySample) => number | null) {
  return useMemo(
    () => buildSegments(samples.map((s) => ({ t: s.t, v: value(s) }))),
    [samples, value],
  );
}

function SparkSvg({ segments, tone, className }: { segments: ChartSegment[]; tone: string; className?: string }) {
  return (
    <svg
      className={`sparkline sparkline-${tone}${className ? ` ${className}` : ''}`}
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {segments.map((seg, i) => (
        <path key={`a${i}`} className="sparkline-area" d={seg.area} />
      ))}
      {segments.map((seg, i) => (
        <path key={`l${i}`} className="sparkline-line" d={seg.line} />
      ))}
    </svg>
  );
}

/** Компактный график-спарклайн для карточек экрана «Серверы». */
export function Sparkline({ samples, value, tone }: ChartProps) {
  const segments = useSegments(samples, value);
  if (segments.length === 0) {
    return <div className="sparkline-pending" aria-hidden="true" />;
  }
  return <SparkSvg segments={segments} tone={tone} />;
}

function formatPct(v: number): string {
  return `${v.toFixed(1)}%`;
}

/** Длительность окна в минутах (минимум 1) — аргумент ключа sparkline.span. */
function spanMinutes(ms: number): number {
  return Math.max(1, Math.round(ms / 60000));
}

function formatTime(t: number, locale: string): string {
  return new Date(t).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

/** График нагрузки с мин/сред/макс и подписями времени — вкладка «Обзор». */
export function LoadChart({ samples, value, tone }: ChartProps) {
  const { t, locale } = useT();
  const segments = useSegments(samples, value);
  const stats = useMemo(() => {
    const vals = samples.map(value).filter((v): v is number => v !== null);
    if (vals.length === 0) return null;
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    for (const v of vals) {
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
    }
    return { min, max, avg: sum / vals.length };
  }, [samples, value]);

  if (segments.length === 0) {
    return <div className="load-chart-pending">{t('sparkline.collecting')}</div>;
  }
  const first = samples[0];
  const last = samples[samples.length - 1];
  return (
    <div className="load-chart">
      {stats && (
        <div className="load-chart-stats">
          <span>{t('sparkline.statMin')} {formatPct(stats.min)}</span>
          <span>{t('sparkline.statAvg')} {formatPct(stats.avg)}</span>
          <span>{t('sparkline.statMax')} {formatPct(stats.max)}</span>
          <span className="load-chart-span">{t('sparkline.span', spanMinutes(last.t - first.t))}</span>
        </div>
      )}
      <SparkSvg segments={segments} tone={tone} className="load-chart-svg" />
      <div className="load-chart-time">
        <span>{formatTime(first.t, locale)}</span>
        <span>{formatTime(last.t, locale)}</span>
      </div>
    </div>
  );
}
