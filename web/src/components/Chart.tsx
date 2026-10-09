import { memo } from 'react';
import { useT } from '../i18n';
import type { ChartSpec } from '../chart-spec';
import { formatChartValue } from '../chart-spec';

const W = 560;
const H = 300;
const PAD_L = 48;
const PAD_R = 8;
const PAD_T = 12;
const PAD_B = 32;
const PLOT_W = W - PAD_L - PAD_R;
const PLOT_H = H - PAD_T - PAD_B;
const TICKS = 4;

/** Series color classes cycle over the --chart-1..6 palette. */
function colorClass(i: number): string {
  return `chart-c${(i % 6) + 1}`;
}

/** [min, max] of every value; the domain always includes zero for bars. */
function valueDomain(spec: ChartSpec, includeZero: boolean): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const s of spec.series) {
    for (const v of s.data) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (includeZero) {
    if (min > 0) min = 0;
    if (max < 0) max = 0;
  }
  if (min === max) {
    min = Math.min(min, 0);
    max = min + 1;
  }
  return [min, max];
}

interface AxisProps {
  min: number;
  max: number;
  unit?: string;
}

/** Horizontal gridlines + y tick labels; also the zero line inside the domain. */
function Axis({ min, max, unit }: AxisProps) {
  const y = (v: number) => PAD_T + ((max - v) / (max - min)) * PLOT_H;
  const ticks: number[] = [];
  for (let j = 0; j <= TICKS; j++) ticks.push(min + ((max - min) * j) / TICKS);
  return (
    <g>
      {ticks.map((v, i) => (
        <g key={i}>
          <line className="chart-grid" x1={PAD_L} x2={W - PAD_R} y1={y(v)} y2={y(v)} />
          <text className="chart-axis-text chart-y-text" x={PAD_L - 6} y={y(v)}>
            {formatChartValue(v)}
            {i === TICKS && unit ? ` ${unit}` : ''}
          </text>
        </g>
      ))}
    </g>
  );
}

function XLabels({ labels }: { labels: string[] }) {
  const n = labels.length;
  // Thin out labels on crowded charts so they do not overlap.
  const step = Math.max(1, Math.ceil(n / 12));
  return (
    <g>
      {labels.map((label, i) =>
        i % step !== 0 && i !== n - 1 ? null : (
          <text
            key={i}
            className="chart-axis-text chart-x-text"
            x={PAD_L + ((i + 0.5) / n) * PLOT_W}
            y={H - 10}
          >
            {label}
          </text>
        ),
      )}
    </g>
  );
}

function BarPlot({ spec }: { spec: ChartSpec }) {
  const [min, max] = valueDomain(spec, true);
  const y = (v: number) => PAD_T + ((max - v) / (max - min)) * PLOT_H;
  const y0 = y(0);
  const n = spec.labels.length;
  const m = spec.series.length;
  const groupW = PLOT_W / n;
  const barW = Math.max(1, (groupW * 0.7) / m);
  return (
    <g>
      <Axis min={min} max={max} unit={spec.unit} />
      {spec.series.map((s, si) =>
        s.data.map((v, i) => {
          const x = PAD_L + i * groupW + groupW * 0.15 + si * barW;
          const top = v >= 0 ? y(v) : y0;
          const h = Math.max(0.5, Math.abs(y(v) - y0));
          return <rect key={`${si}-${i}`} className={colorClass(si)} x={x} y={top} width={barW * 0.9} height={h} />;
        }),
      )}
      {min < 0 && <line className="chart-zero" x1={PAD_L} x2={W - PAD_R} y1={y0} y2={y0} />}
      <XLabels labels={spec.labels} />
    </g>
  );
}

function LinePlot({ spec }: { spec: ChartSpec }) {
  const [min, max] = valueDomain(spec, false);
  const y = (v: number) => PAD_T + ((max - v) / (max - min)) * PLOT_H;
  const n = spec.labels.length;
  const x = (i: number) => (n === 1 ? PAD_L + PLOT_W / 2 : PAD_L + (i / (n - 1)) * PLOT_W);
  return (
    <g>
      <Axis min={min} max={max} unit={spec.unit} />
      {spec.series.map((s, si) => (
        <g key={si} className={colorClass(si)}>
          <polyline
            className="chart-line"
            points={s.data.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}
          />
          {s.data.map((v, i) => (
            <circle key={i} className="chart-dot" cx={x(i)} cy={y(v)} r={2.5} />
          ))}
        </g>
      ))}
      <XLabels labels={spec.labels} />
    </g>
  );
}

interface PieSlice {
  label: string;
  value: number;
  path: string | null; // null — a full circle (single 100% slice)
}

function pieSlices(spec: ChartSpec): PieSlice[] {
  const CX = 130;
  const CY = 130;
  const R = 108;
  const data = spec.series[0].data;
  const total = data.reduce((a, b) => a + b, 0);
  let angle = -Math.PI / 2;
  return data.map((value, i) => {
    const frac = value / total;
    if (frac >= 1) return { label: spec.labels[i], value, path: null };
    if (frac <= 0) return { label: spec.labels[i], value, path: '' };
    const a0 = angle;
    const a1 = angle + frac * 2 * Math.PI;
    angle = a1;
    const p = (a: number) => `${(CX + R * Math.cos(a)).toFixed(2)},${(CY + R * Math.sin(a)).toFixed(2)}`;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    return {
      label: spec.labels[i],
      value,
      path: `M${CX},${CY} L${p(a0)} A${R},${R} 0 ${large} 1 ${p(a1)} Z`,
    };
  });
}

function PiePlot({ spec }: { spec: ChartSpec }) {
  const data = spec.series[0].data;
  const total = data.reduce((a, b) => a + b, 0);
  const slices = pieSlices(spec);
  return (
    <div className="chart-pie-wrap">
      <svg viewBox="0 0 260 260" className="chart-pie" aria-hidden="true">
        {slices.map((s, i) =>
          s.path === null ? (
            <circle key={i} className={colorClass(i)} cx={130} cy={130} r={108} />
          ) : s.path === '' ? null : (
            <path key={i} className={colorClass(i)} d={s.path} />
          ),
        )}
      </svg>
      <ul className="chart-pie-legend">
        {slices.map((s, i) => (
          <li key={i}>
            <span className={`chart-swatch ${colorClass(i)}`} />
            <span className="chart-pie-label">{s.label}</span>
            <span className="chart-pie-value">
              {formatChartValue(s.value)}
              {spec.unit ? ` ${spec.unit}` : ''} · {((s.value / total) * 100).toFixed(1)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Renders a validated ```chart spec (web/src/chart-spec.ts) as dependency-free
 * SVG. Title and legend are HTML (free wrapping), only the plot is SVG;
 * colors come from the --chart-1..6 CSS variables of the active theme.
 */
export const Chart = memo(function Chart({ spec }: { spec: ChartSpec }) {
  const { t } = useT();
  const showLegend = spec.type !== 'pie' && spec.series.length > 1;
  return (
    <div className="chart-block" role="img" aria-label={spec.title ?? t('markdown.chartAria')}>
      {(spec.title || spec.unit) && (
        <div className="chart-title">
          {spec.title}
          {spec.unit && <span className="chart-unit">, {spec.unit}</span>}
        </div>
      )}
      {showLegend && (
        <div className="chart-legend">
          {spec.series.map((s, i) => (
            <span key={i} className="chart-legend-item">
              <span className={`chart-swatch ${colorClass(i)}`} />
              {s.name}
            </span>
          ))}
        </div>
      )}
      {spec.type === 'pie' ? (
        <PiePlot spec={spec} />
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} className="chart-plot" aria-hidden="true">
          {spec.type === 'bar' ? <BarPlot spec={spec} /> : <LinePlot spec={spec} />}
        </svg>
      )}
    </div>
  );
});
