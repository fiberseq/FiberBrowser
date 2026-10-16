import { useMemo, useState } from 'react';
import type { AccessibilityElement } from '../api';
import { distanceToArcCurve, genomeToMicrocScreen, normalizedArcStrength, type ArcCurveGeometry, type ArcStrengthScale } from '../../../utils/microcMath';
import { ANTI_COLOR, CO_COLOR, elementColor, pairTooltip, variantColor, type ElementArc } from '../accessibilityView';
import { assignLanes, type ShownElement } from '../nfrPairsLayout';

/** Where arcs are drawn: above `upBase` (open together) and below `downBase` (rarely together), each in its room. */
export interface ArcFrame {
  start: number; end: number; sidebarWidth: number; trackWidth: number; isReversed?: boolean;
  upBase: number; upRoom: number; downBase: number; downRoom: number;
}

export interface ArcCurve { arc: ElementArc; curve: ArcCurveGeometry }

/** The arcs in view as quadratic curves: height ~ |adjusted log2 OR| on an absolute scale (0 to the largest effect,
 * at least 2 log2 units) so heights compare across views. */
export function arcCurves(arcs: readonly ElementArc[], frame: ArcFrame): ArcCurve[] {
  const max = Math.max(2, ...arcs.map(a => a.strength));
  const scale: ArcStrengthScale = { minVisibleStrength: 0, maxVisibleStrength: max, strengthRange: max };
  const x = (pos: number) => genomeToMicrocScreen(pos, frame.start, frame.end, frame.sidebarWidth, frame.trackWidth, !!frame.isReversed);
  return arcs.filter(arc => arc.end >= frame.start && arc.start <= frame.end).map(arc => {
    const [x1, x2] = [x(arc.start), x(arc.end)].sort((p, q) => p - q);
    const norm = normalizedArcStrength(arc, scale, false);
    const up = arc.side === 'up';
    const base = up ? frame.upBase : frame.downBase;
    const room = Math.max(4, up ? frame.upRoom : frame.downRoom);
    // a quadratic's peak is half its control point's offset: the strongest arc fills the room
    return { arc, curve: { x1, x2, midX: (x1 + x2) / 2, baselineY: base, controlY: base + (up ? -2 : 2) * norm * room, normalizedStrength: norm } };
  });
}

/** The arc nearest a point (svg pixels), if within `tolerance`. */
export function nearestArc(curves: readonly ArcCurve[], px: number, py: number, tolerance = 8): ElementArc | null {
  let best: { arc: ElementArc; d: number } | null = null;
  for (const { arc, curve } of curves) {
    const d = distanceToArcCurve({ x: px, y: py }, curve, 24);
    if (!best || d < best.d) best = { arc, d };
  }
  return best && best.d <= tolerance ? best.arc : null;
}

/** The tooltip's names: the drawn elements and the arc's own two (a folded NFR draws its variants). */
export function withEnds(byId: Map<string, AccessibilityElement>, arc: ElementArc): Map<string, AccessibilityElement> {
  const out = new Map(byId);
  for (const e of [arc.a, arc.b]) if (e) out.set(e.id, e);
  return out;
}

const pairKeyOf = (arc: ElementArc) => `${arc.pair.a}|${arc.pair.b}`;

/** Whether an arc touches a hovered element: the element itself, or (an NFR id) any of its variants. */
export function arcTouches(arc: ElementArc, hovered: string | null | undefined): boolean {
  return !!hovered && [arc.pair.a, arc.pair.b].some(id => id === hovered || (!hovered.includes(':') && id.split(':')[0] === hovered));
}

/** The arcs as paths (`nfr-arc`, its run pair in `data-pair`): the selected or hovered ones on top in strength. */
export function ArcPaths({ curves, selected, hoverArc, hovered, onPick }: {
  curves: readonly ArcCurve[]; selected?: string | null; hoverArc?: ElementArc | null; hovered?: string | null;
  onPick?: (a: string, b: string) => void;
}) {
  return (
    <>
      {curves.map(({ arc, curve }) => {
        const key = pairKeyOf(arc);
        const touches = arcTouches(arc, hovered);
        const on = hoverArc === arc || selected === key || touches;
        const faded = !!hovered && !touches && hoverArc !== arc;
        return (
          <path key={`${key}|${curve.x1}|${curve.x2}`} data-testid="nfr-arc" data-side={arc.side} data-pair={key} data-selected={selected === key ? 'true' : undefined}
            onClick={onPick ? ev => { ev.stopPropagation(); onPick(arc.pair.a, arc.pair.b); } : undefined}
            d={`M ${curve.x1} ${curve.baselineY} Q ${curve.midX} ${curve.controlY} ${curve.x2} ${curve.baselineY}`} fill="none"
            stroke={arc.side === 'up' ? CO_COLOR : ANTI_COLOR} strokeOpacity={faded ? 0.15 : arc.significant ? (on ? 1 : 0.8) : 0.3}
            strokeWidth={on ? arc.lineWidth + 1.5 : arc.lineWidth}
            strokeDasharray={arc.dash === 'dotted' ? '2 3' : arc.dash === 'dashed' ? '7 4' : undefined} strokeLinecap="round" />
        );
      })}
    </>
  );
}

/** A lane's height for `count` lanes in `room` pixels (5-12 px). */
export const laneHeight = (count: number, room: number) => Math.max(5, Math.min(12, Math.floor(room / Math.max(1, count))));

/**
 * NFR pair arcs, Micro-C style: one arc per tested element pair between the drawn elements' centres. Above the
 * elements: open together more often than expected (openness-adjusted log2 OR > 0); below: rarely together. Height ~
 * |adjusted log2 OR|, width ~ -log10 q; dotted: a footprint class inside the NFR variant, dashed: at its edge.
 * The elements sit on lanes between the two (nfrPairsLayout: an NFR folded to one, or unfolded into its variants,
 * overlapping ones on lanes of their own); a folded NFR with pairs inside says how many.
 */
export function ElementArcs({ arcs, elements, start, end, width, height, sidebarWidth = 0, testId = 'nfr-arcs', onPick, selected, onElement, elementHint, focus, hovered, onElementHover, onToggle, inner }: {
  arcs: ElementArc[]; elements: (AccessibilityElement | ShownElement)[]; start: number; end: number; width: number; height: number;
  sidebarWidth?: number; testId?: string;
  /** Click on (near) an arc: inspect that pair. */
  onPick?: (a: string, b: string) => void;
  /** The pair shown in the detail card ('a|b'). */
  selected?: string | null;
  /** Click an element: select it (a second one: the pair). */
  onElement?: (id: string, event: React.MouseEvent) => void;
  /** What a click on an element does, for its tooltip. */
  elementHint?: (element: AccessibilityElement) => string | null;
  /** The selected element (its id) or NFR ('N5'): drawn emphasised. */
  focus?: string | null;
  /** An element hovered here or on the NFR track: its arcs drawn on top, the others faded. */
  hovered?: string | null;
  onElementHover?: (id: string | null) => void;
  /** Fold or unfold an NFR (the ▸ / ▾ beside it). */
  onToggle?: (nfrId: string, open: boolean) => void;
  /** Pairs inside each folded NFR (no arc while folded). */
  inner?: Map<string, number>;
}) {
  const [hover, setHover] = useState<{ arc: ElementArc; x: number; y: number } | null>(null);
  const trackWidth = Math.max(10, width - sidebarWidth);
  const { lanes, count } = useMemo(() => assignLanes(elements), [elements]);
  const lane = laneHeight(count, Math.round(height * 0.3));
  const bandH = count * lane;
  const bandTop = Math.round((height - bandH) / 2);
  const frame: ArcFrame = useMemo(() => ({
    start, end, sidebarWidth, trackWidth, upBase: bandTop - 1, upRoom: bandTop - 6, downBase: bandTop + bandH + 1, downRoom: height - bandTop - bandH - 6,
  }), [start, end, sidebarWidth, trackWidth, bandTop, bandH, height]);
  const curves = useMemo(() => arcCurves(arcs, frame), [arcs, frame]);
  const byId = useMemo(() => new Map(elements.map(e => [e.id, e as AccessibilityElement])), [elements]);
  const x = (pos: number) => sidebarWidth + ((pos - start) / Math.max(1, end - start)) * trackWidth;
  const [selA, selB] = selected ? selected.split('|') : [];
  const point = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { px: (e.clientX - rect.left) * (width / Math.max(1, rect.width)), py: (e.clientY - rect.top) * (height / Math.max(1, rect.height)) };
  };
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const { px, py } = point(e);
    const arc = nearestArc(curves, px, py);
    setHover(arc ? { arc, x: px, y: py } : null);
  };
  const onClick = (e: React.MouseEvent<SVGSVGElement>) => {
    const { px, py } = point(e);
    const arc = nearestArc(curves, px, py);
    if (arc && onPick) onPick(arc.pair.a, arc.pair.b);
  };
  const toggled = new Set<string>();

  return (
    <div className="relative" style={{ width, height }} data-testid={testId}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} data-figure-svg="" onMouseMove={onMove} onMouseLeave={() => setHover(null)}
        onClick={onPick ? onClick : undefined} style={{ cursor: onPick && hover ? 'pointer' : undefined }}
        role="img" aria-label={`${arcs.length} NFR pair arcs${onPick ? '; click an arc to inspect that pair' : ''}`}>
        <line x1={sidebarWidth} x2={width} y1={bandTop - 1} y2={bandTop - 1} stroke="currentColor" strokeOpacity={0.2} />
        <line x1={sidebarWidth} x2={width} y1={bandTop + bandH + 1} y2={bandTop + bandH + 1} stroke="currentColor" strokeOpacity={0.2} />
        <ArcPaths curves={curves} selected={selected} hoverArc={hover?.arc} hovered={hovered} onPick={onPick} />
        {elements.filter(e => e.end >= start && e.start <= end).map(e => {
          const shown = e as ShownElement;
          const members = shown.members ?? [e.id];
          const on = !!focus && (focus === e.id || (!focus.includes(':') && e.nfr === focus && e.kind !== 'tf'));
          const inPair = !!selected && members.some(m => m === selA || m === selB);
          const x0 = x(Math.max(start, e.start)), w = Math.max(2, x(Math.min(end, e.end)) - x0);
          const y = bandTop + (lanes.get(e.id) ?? 0) * lane;
          const h = Math.max(3, lane - 2);
          const folded = !!shown.group && !shown.group.expanded;
          // an unfolded NFR's variants take the variant colours (as on the NFR track and the read groups)
          const unfoldedVariant = !!shown.group?.expanded && e.subtype === 'variant';
          const nInner = folded ? inner?.get(e.id) ?? 0 : 0;
          // the ▸ / ▾ of an NFR: once, left of its first drawn element
          const toggle = onToggle && shown.group && !toggled.has(shown.group.nfr) ? shown.group : null;
          if (toggle) toggled.add(toggle.nfr);
          const hint = !onElement ? '' : elementHint ? (elementHint(e) ? ` (${elementHint(e)})` : '')
            : on ? ' (click: deselect)' : focus ? ' (click: inspect the pair with the selected element)' : ' (click: select; then click another for the pair)';
          return (
            <g key={e.id}>
              <rect data-testid="nfr-element" data-element={e.id} data-focus={on ? 'true' : undefined} data-in-pair={inPair ? 'true' : undefined}
                data-folded={folded ? 'true' : undefined} x={x0} width={w} y={y + 1} height={h} rx={1.5} fill={unfoldedVariant ? variantColor(e.id.split(':')[1]) : elementColor(e)}
                fillOpacity={on || inPair ? 1 : e.kind === 'tf' ? 0.8 : folded ? 0.75 : 0.6}
                stroke={on || inPair ? 'currentColor' : undefined} strokeOpacity={on || inPair ? 0.7 : undefined} strokeWidth={on || inPair ? 1.5 : undefined}
                style={onElement ? { cursor: 'pointer' } : undefined}
                onMouseEnter={onElementHover ? () => onElementHover(e.id) : undefined} onMouseLeave={onElementHover ? () => onElementHover(null) : undefined}
                onDoubleClick={onToggle && shown.group ? ev => { ev.stopPropagation(); onToggle(shown.group!.nfr, !shown.group!.expanded); } : undefined}
                onClick={onElement ? ev => { ev.stopPropagation(); onElement(e.id, ev); } : undefined}>
                <title>{`${e.label}: ${Math.round(e.start).toLocaleString()}–${Math.round(e.end).toLocaleString()}${hint}${shown.group ? ` · double-click: ${folded ? 'show its variants' : 'fold to one'}` : ''}`}</title>
              </rect>
              {unfoldedVariant && w > 22 && h >= 8 && (
                <text x={x0 + 3} y={y + 1 + h - 2} fontSize={Math.min(10, h - 1)} fill="white" pointerEvents="none">{w > 60 ? e.id.replace(':', ' ') : e.id.split(':')[1]}</text>
              )}
              {folded && w > 34 && h >= 8 && (
                <text x={x0 + 3} y={y + 1 + h - 2} fontSize={Math.min(10, h - 1)} fill="white" pointerEvents="none">{`${shown.group!.nfr} · ${shown.group!.size}`}</text>
              )}
              {nInner > 0 && (
                <text data-testid="nfr-inner-pairs" data-nfr={e.id} x={x0 + w / 2} y={y - 1} textAnchor="middle" fontSize={9} fill={CO_COLOR} pointerEvents="none">
                  {`${nInner} inside`}
                </text>
              )}
              {toggle && (
                <g role="button" tabIndex={0} aria-expanded={toggle.expanded} aria-label={`${toggle.expanded ? 'Fold' : 'Show the variants of'} ${toggle.nfr}`}
                  data-testid="nfr-element-toggle" data-nfr={toggle.nfr} style={{ cursor: 'pointer' }}
                  onClick={ev => { ev.stopPropagation(); onToggle!(toggle.nfr, !toggle.expanded); }}
                  onKeyDown={ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onToggle!(toggle.nfr, !toggle.expanded); } }}>
                  <rect x={Math.max(0, x0 - 12)} y={y} width={11} height={Math.max(10, lane)} fill="transparent" />
                  <text x={Math.max(0, x0 - 12) + 1} y={y + Math.max(8, lane - 2)} fontSize={10} fill="currentColor" fillOpacity={0.7}>{toggle.expanded ? '▾' : '▸'}</text>
                </g>
              )}
            </g>
          );
        })}
      </svg>
      {hover && (
        <div data-testid="nfr-arc-tooltip" className="pointer-events-none absolute z-30 max-w-[340px] whitespace-pre-line rounded border border-gray-200 bg-white/95 px-2 py-1 text-[11px] leading-snug text-gray-800 shadow-md dark:border-gray-700 dark:bg-gray-900/95 dark:text-gray-100"
          style={{ left: Math.min(Math.max(0, hover.x + 10), Math.max(0, width - 340)), top: hover.y > height / 2 ? Math.max(0, hover.y - 110) : hover.y + 10 }}>
          {pairTooltip(hover.arc.pair, withEnds(byId, hover.arc))}
        </div>
      )}
    </div>
  );
}
