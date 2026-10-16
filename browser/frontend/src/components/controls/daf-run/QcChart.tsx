import type { Point } from '../../../utils/qcView';

export interface QcSeries {
  points: Point[];
  color: string;
  label: string;
  dashed?: boolean;
  width?: number;
}

export interface QcBand {
  from: number;
  to: number;
  color: string;
  label: string;
}

export interface QcMarker {
  x: number;
  color: string;
  label: string;
}

interface Props {
  series: QcSeries[];
  bands?: QcBand[];
  markers?: QcMarker[];
  xLabel: string;
  yLabel: string;
  xDomain?: [number, number];
  yDomain?: [number, number];
  height?: number;
  testId?: string;
  title?: string;
}

const W = 520;
const PAD = { left: 46, right: 12, top: 10, bottom: 34 };

export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!(max > min)) return [min];
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Number(v.toPrecision(10)));
  return out;
}

function fmt(value: number): string {
  if (Math.abs(value) >= 1000) return `${Math.round(value / 100) / 10}k`;
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(Math.abs(value) < 0.1 ? 3 : Math.abs(value) < 1 ? 2 : 1);
}

/** A small SVG line chart with numeric axes, shaded bands and vertical markers (QC curves). */
export function QcChart({ series, bands = [], markers = [], xLabel, yLabel, xDomain, yDomain, height = 200, testId, title }: Props) {
  const drawn = series.filter(s => s.points.length > 0);
  const xs = drawn.flatMap(s => s.points.map(p => p[0]));
  const ys = drawn.flatMap(s => s.points.map(p => p[1]));
  if (!xs.length) {
    return <div className="text-[11px] text-ink-secondary py-6 text-center" data-testid={testId}>No data</div>;
  }
  const [x0, x1] = xDomain ?? [Math.min(...xs), Math.max(...xs)];
  let [y0, y1] = yDomain ?? [Math.min(...ys), Math.max(...ys)];
  if (!yDomain) {
    const pad = (y1 - y0) * 0.06 || 0.5;
    y0 -= pad;
    y1 += pad;
  }
  const H = height;
  const iw = W - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  const sx = (x: number) => PAD.left + ((x - x0) / (x1 - x0 || 1)) * iw;
  const sy = (y: number) => PAD.top + ih - ((y - y0) / (y1 - y0 || 1)) * ih;
  const clampX = (x: number) => Math.max(x0, Math.min(x1, x));
  const path = (points: Point[]) => points
    .filter(p => p[0] >= x0 && p[0] <= x1)
    .map((p, i) => `${i ? 'L' : 'M'}${sx(p[0]).toFixed(1)},${sy(Math.max(y0, Math.min(y1, p[1]))).toFixed(1)}`)
    .join('');
  const xTicks = niceTicks(x0, x1);
  const yTicks = niceTicks(y0, y1, 4);

  return (
    <figure className="m-0" data-testid={testId}>
      {title && <figcaption className="text-[11px] font-medium text-gray-600 dark:text-gray-300 mb-0.5">{title}</figcaption>}
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto text-gray-500 dark:text-gray-400" role="img" aria-label={title || yLabel}>
        {bands.map(b => (
          <rect
            key={b.label}
            x={sx(clampX(b.from))}
            y={PAD.top}
            width={Math.max(0, sx(clampX(b.to)) - sx(clampX(b.from)))}
            height={ih}
            fill={b.color}
          >
            <title>{b.label}</title>
          </rect>
        ))}
        <line x1={PAD.left} y1={PAD.top + ih} x2={PAD.left + iw} y2={PAD.top + ih} stroke="currentColor" strokeOpacity={0.5} />
        <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={PAD.top + ih} stroke="currentColor" strokeOpacity={0.5} />
        {xTicks.map(t => (
          <g key={`x${t}`}>
            <line x1={sx(t)} x2={sx(t)} y1={PAD.top + ih} y2={PAD.top + ih + 3} stroke="currentColor" strokeOpacity={0.5} />
            <text x={sx(t)} y={PAD.top + ih + 13} fontSize={10} textAnchor="middle" fill="currentColor">{fmt(t)}</text>
          </g>
        ))}
        {yTicks.map(t => (
          <g key={`y${t}`}>
            <line x1={PAD.left - 3} x2={PAD.left} y1={sy(t)} y2={sy(t)} stroke="currentColor" strokeOpacity={0.5} />
            <line x1={PAD.left} x2={PAD.left + iw} y1={sy(t)} y2={sy(t)} stroke="currentColor" strokeOpacity={0.08} />
            <text x={PAD.left - 5} y={sy(t) + 3} fontSize={10} textAnchor="end" fill="currentColor">{fmt(t)}</text>
          </g>
        ))}
        <text x={PAD.left + iw / 2} y={H - 4} fontSize={10.5} textAnchor="middle" fill="currentColor">{xLabel}</text>
        <text x={11} y={PAD.top + ih / 2} fontSize={10.5} textAnchor="middle" fill="currentColor" transform={`rotate(-90 11 ${PAD.top + ih / 2})`}>{yLabel}</text>
        {markers.filter(m => m.x >= x0 && m.x <= x1).map(m => (
          <g key={m.label}>
            <line x1={sx(m.x)} x2={sx(m.x)} y1={PAD.top} y2={PAD.top + ih} stroke={m.color} strokeDasharray="3 3" />
            <text x={sx(m.x) + 3} y={PAD.top + 10} fontSize={10} fill={m.color}>{m.label}</text>
          </g>
        ))}
        {drawn.map(s => (
          <path
            key={s.label}
            d={path(s.points)}
            fill="none"
            stroke={s.color}
            strokeWidth={s.width ?? 1.6}
            strokeDasharray={s.dashed ? '5 4' : undefined}
          />
        ))}
      </svg>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-gray-500 dark:text-gray-400 pl-11">
        {drawn.map(s => (
          <span key={s.label} className="inline-flex items-center gap-1">
            <svg width="16" height="6" aria-hidden><line x1="0" y1="3" x2="16" y2="3" stroke={s.color} strokeWidth={2} strokeDasharray={s.dashed ? '4 3' : undefined} /></svg>
            {s.label}
          </span>
        ))}
        {bands.map(b => (
          <span key={b.label} className="inline-flex items-center gap-1">
            <span className="inline-block w-3 h-2 rounded-sm" style={{ background: b.color }} />
            {b.label}
          </span>
        ))}
      </div>
    </figure>
  );
}
