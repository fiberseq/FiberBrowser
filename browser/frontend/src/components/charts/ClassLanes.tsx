/**
 * Stacked lanes of a region's classes: one bar per class over a tinted region, its edge spread as faint whiskers at
 * both ends, its name after the bar. The NFR card's variant lanes and the nucleosome panel's shared geometries use it
 * (one look for "classes found in the pooled reads").
 */
export interface ClassLane {
  id: string;
  name: string;
  /** Consensus edges (reference). */
  L: number;
  R: number;
  /** Edge spread (bp, drawn as whiskers either side of each edge). */
  Lsd?: number | null;
  Rsd?: number | null;
  color: string;
  /** 0..1: the bar's fill strength (e.g. prevalence). */
  strength?: number;
  /** Drawn as an outline over a pale fill (a class folded into another), indented under its parent. */
  nested?: boolean;
  /** Open ends (a read or view edge cuts the class): an arrow instead of a whisker. */
  openLeft?: boolean;
  openRight?: boolean;
  title?: string;
}

/** Pixels kept free at either side of the lanes (open-end chevrons). */
export const CLASS_LANES_INSET = 8;
// Fallback fills (presentation attributes; the theme classes override them on screen). A standalone export without
// the page's stylesheet would otherwise fill these black.
const TINT_FILL = '#f5f3ff';
const LABEL_FILL = '#6b7280';
const AXIS_FILL = '#9ca3af';

/** The rendered width of a 9 px label, estimated (average glyph ~5.4 px). */
export function labelWidth(name: string): number {
  return Math.ceil(name.length * 5.4);
}

export function ClassLanes({ lanes, width, region, highlight, onPick, picked, testId = 'class-lanes', ariaLabel, format,
  tintClassName = 'fill-fuchsia-50 dark:fill-fuchsia-900/20' }: {
  lanes: ClassLane[];
  width: number;
  /** The tinted span behind the lanes (an NFR, the analysed window). */
  region?: { start: number; end: number } | null;
  /** The hovered class: the others dim. */
  highlight?: string | null;
  /** Click on a lane (a class's row action). */
  onPick?: (id: string, additive: boolean) => void;
  /** Classes marked as selected (ringed). */
  picked?: ReadonlySet<string>;
  testId?: string;
  ariaLabel: string;
  format: (pos: number) => string;
  /** The region tint in the panel's colour (default: the NFR panel's fuchsia). */
  tintClassName?: string;
}) {
  const ext = lanes.flatMap(v => [v.L - (v.Lsd ?? 0), v.R + (v.Rsd ?? 0)]);
  const lo = Math.min(region?.start ?? Infinity, ...ext) - 40;
  const hi = Math.max(region?.end ?? -Infinity, ...ext) + 40;
  const lane = 13, top = 4, h = top + Math.max(1, lanes.length) * lane + 14;
  // A pixel inset either side, so an open-end chevron at the outermost edge stays inside the drawing.
  const inset = CLASS_LANES_INSET;
  const x = (p: number) => inset + ((p - lo) / Math.max(1, hi - lo)) * Math.max(1, width - 2 * inset);
  return (
    <svg width={width} height={h} role="img" aria-label={ariaLabel} data-testid={testId}>
      {region && <rect x={x(region.start)} y={0} width={Math.max(1, x(region.end) - x(region.start))} height={h - 12} rx={3}
        fill={TINT_FILL} className={tintClassName} />}
      {lanes.map((v, i) => {
        const y = top + i * lane;
        const dim = highlight && highlight !== v.id;
        const ring = picked?.has(v.id);
        const op = v.strength == null ? 0.85 : 0.35 + 0.55 * Math.min(1, v.strength * 1.4);
        return (
          <g key={v.id} opacity={dim ? 0.35 : 1} data-testid={`${testId}-lane`} data-class={v.id}
            style={onPick ? { cursor: 'pointer' } : undefined}
            onClick={onPick ? e => onPick(v.id, e.metaKey || e.ctrlKey || e.shiftKey) : undefined}>
            {v.Lsd != null && !v.openLeft && <line x1={x(v.L - v.Lsd)} x2={x(v.L + v.Lsd)} y1={y + 4.5} y2={y + 4.5} stroke={v.color} strokeOpacity={0.45} strokeWidth={1} />}
            {v.Rsd != null && !v.openRight && <line x1={x(v.R - v.Rsd)} x2={x(v.R + v.Rsd)} y1={y + 4.5} y2={y + 4.5} stroke={v.color} strokeOpacity={0.45} strokeWidth={1} />}
            <rect x={x(v.L)} y={y} width={Math.max(2, x(v.R) - x(v.L))} height={9} rx={2} fill={v.color}
              fillOpacity={v.nested ? 0.25 : op} stroke={ring ? 'currentColor' : v.nested ? v.color : 'none'} strokeWidth={ring ? 1.5 : 1}>
              <title>{v.title ?? `${v.name}: ${format(v.L)}–${format(v.R)}`}</title>
            </rect>
            {v.openLeft && <text x={x(v.L) - 1} y={y + 8} fontSize={9} textAnchor="end" fill={v.color} data-testid={`${testId}-open-left`}>‹</text>}
            {v.openRight && <text x={x(v.R) + 1} y={y + 8} fontSize={9} fill={v.color} data-testid={`${testId}-open-right`}>›</text>}
            {/* the name after the bar, or before it where the bar reaches the right edge (its estimated width: a long
                name such as "G2 ⊂ G1" needs more than a fixed allowance) */}
            {(() => {
              const need = labelWidth(v.name) + 8;
              const right = x(v.R) + need <= width, left = x(v.L) - need >= 0;
              const lx = right ? x(v.R) + (v.openRight ? 8 : 3) : left ? x(v.L) - (v.openLeft ? 8 : 3) : width - 2;
              return <text x={lx} y={y + 8} fontSize={9} fill={LABEL_FILL} className="fill-gray-500 dark:fill-gray-400" textAnchor={right ? 'start' : 'end'}>{v.name}</text>;
            })()}
          </g>
        );
      })}
      <text x={0} y={h - 2} fontSize={9} fill={AXIS_FILL} className="fill-gray-400">{format(lo)}</text>
      <text x={width} y={h - 2} fontSize={9} textAnchor="end" fill={AXIS_FILL} className="fill-gray-400">{format(hi)}</text>
    </svg>
  );
}
