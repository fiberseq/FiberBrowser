/**
 * The nucleosome panel's small charts: inline SVG, drawn in currentColor or the observation's colour so they read in
 * light and dark mode. Every mark that selects reads is a button-like target with a tooltip.
 */
import type { NucPhasingBin } from './types';

const HATCH = (color: string) => `repeating-linear-gradient(135deg, ${color} 0 2px, transparent 2px 4px)`;

/** A histogram as small bars; `onBin` makes each bar a selection target. */
export function MiniHistogram({ edges, counts, color, width = 120, height = 26, onBin, unit = '', marks = [], testId }: {
  edges: number[]; counts: number[]; color: string; width?: number; height?: number;
  onBin?: (lo: number, hi: number) => void; unit?: string; marks?: number[]; testId?: string;
}) {
  const max = Math.max(1, ...counts);
  const n = counts.length;
  if (!n || counts.every(c => !c)) return <span className="text-ink-muted" data-testid={testId}>—</span>;
  const bw = width / n;
  const x = (v: number) => ((v - edges[0]) / (edges[n] - edges[0])) * width;
  return <svg width={width} height={height + 8} viewBox={`0 0 ${width} ${height + 8}`} className="overflow-visible" data-testid={testId}
    role="img" aria-label={`histogram, ${counts.reduce((a, b) => a + b, 0)} values`}>
    {counts.map((c, i) => c ? <rect key={i} x={i * bw + 0.5} y={height - (c / max) * height} width={Math.max(1, bw - 1)}
      height={(c / max) * height} fill={color} opacity={0.85} className={onBin ? 'cursor-pointer hover:opacity-100' : undefined}
      onClick={onBin ? () => onBin(edges[i], edges[i + 1]) : undefined} data-testid={testId ? `${testId}-bin` : undefined}>
      <title>{`${edges[i]}–${edges[i + 1]}${unit}: ${c}`}{onBin ? ' · click: highlight these reads' : ''}</title></rect> : null)}
    {marks.map(m => m >= edges[0] && m <= edges[n]
      ? <line key={m} x1={x(m)} x2={x(m)} y1={0} y2={height} stroke="currentColor" strokeOpacity={0.35} strokeDasharray="2 2" /> : null)}
    <text x={0} y={height + 8} fontSize={7} fill="currentColor" opacity={0.6}>{edges[0]}</text>
    <text x={width} y={height + 8} fontSize={7} fill="currentColor" opacity={0.6} textAnchor="end">{edges[n]}{unit}</text>
  </svg>;
}

export interface SharePart { key: string; label: string; value: number; color: string; hatched?: boolean }

/** Shares as one stacked bar; `onPart` makes each part a selection target. Hatched parts are never dropped.
 * `denominator`: the whole the values are shares of (default: their sum); with fractions that may sum below one
 * (a window with unsegmented bases) pass 1, and the remainder stays empty. */
export function StackedShares({ parts, width = 112, onPart, testId, title, denominator }: {
  parts: SharePart[]; width?: number; onPart?: (key: string) => void; testId?: string; title?: string; denominator?: number;
}) {
  const sum = parts.reduce((a, p) => a + (p.value || 0), 0);
  const total = denominator && denominator > 0 ? Math.max(denominator, sum) : sum;
  if (!sum) return <span className="text-ink-muted" data-testid={testId}>—</span>;
  return <div className="flex h-3 overflow-hidden rounded-sm border border-line dark:border-white/10" style={{ width }} data-testid={testId}
    title={title ?? parts.map(p => `${p.label}: ${(p.value / total * 100).toFixed(0)}%`).join('\n')}>
    {parts.map(p => p.value ? <span key={p.key} role={onPart ? 'button' : undefined} tabIndex={onPart ? 0 : undefined}
      className={onPart ? 'cursor-pointer hover:brightness-110' : undefined}
      title={`${p.label}: ${(p.value / total * 100).toFixed(0)}%${onPart ? ' · click: highlight these reads' : ''}`}
      onClick={onPart ? () => onPart(p.key) : undefined}
      onKeyDown={onPart ? (e => { if (e.key === 'Enter') onPart(p.key); }) : undefined}
      data-testid={testId ? `${testId}-${p.key}` : undefined}
      style={{ width: `${(p.value / total) * 100}%`, background: p.hatched ? HATCH(p.color) : p.color }} /> : null)}
  </div>;
}

/** Phasing per bin: the resultant above its null (bars) with the period-sensitivity maximum (ticks). */
export function PhasingBars({ bins, color, width = 120, height = 26, testId }: {
  bins: NucPhasingBin[]; color: string; width?: number; height?: number; testId?: string;
}) {
  if (!bins.length) return <span className="text-ink-muted">—</span>;
  const vals = bins.map(b => b.R_minus_null ?? 0);
  const top = Math.max(0.05, ...bins.map(b => Math.max(b.R_minus_null ?? 0, (b.R_max_period ?? 0) - (b.null_mean ?? 0))));
  const bw = width / bins.length;
  return <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} data-testid={testId} role="img"
    aria-label="phasing by bin">
    <line x1={0} x2={width} y1={height - 1} y2={height - 1} stroke="currentColor" strokeOpacity={0.3} />
    {bins.map((b, i) => {
      const v = Math.max(0, vals[i]);
      const h = (v / top) * (height - 2);
      const pmax = Math.max(0, (b.R_max_period ?? 0) - (b.null_mean ?? 0));
      return <g key={i}>
        <rect x={i * bw + 1} y={height - 1 - h} width={Math.max(1, bw - 2)} height={h} fill={color}
          opacity={b.null_p != null && b.null_p < 0.05 ? 0.95 : 0.4}>
          <title>{`${Math.round(b.lo)}–${Math.round(b.hi)} bp: R ${fmt(b.R, 3)} (null ${fmt(b.null_mean, 3)}, p ${fmt(b.null_p, 3)}), ${b.n_molecules} molecules${b.P_max ? `; best period ${Math.round(b.P_max)} bp: R ${fmt(b.R_max_period, 3)}` : ''}`}</title>
        </rect>
        <line x1={i * bw + 1} x2={i * bw + bw - 1} y1={height - 1 - (pmax / top) * (height - 2)} y2={height - 1 - (pmax / top) * (height - 2)}
          stroke="currentColor" strokeOpacity={0.55} />
      </g>;
    })}
  </svg>;
}

export function fmt(v: number | null | undefined, digits = 2): string {
  return v == null || !Number.isFinite(v) ? '—' : v.toFixed(digits);
}
