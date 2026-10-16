import { useMemo, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useContainerWidth } from '../../../hooks/useContainerWidth';
import type { Gene } from '../../../types';
import { formatTick, mergeTranscripts, niceStep, packLanes, ticks, type OverviewGene } from './regionLayout';

// Gene strands as the gene track draws them.
const STRAND_COLOR: Record<string, string> = { '+': '#2563eb', '-': '#dc2626' };
const OTHER_STRAND = '#6b7280';
const PAD = 8;          // left/right inset of the drawing, px
const LABEL_FONT = 11;
const TICK_FONT = 10;

function formatBp(value: number) {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)} Mb`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)} kb`;
  return `${value} bp`;
}

function clickFraction(event: MouseEvent<SVGSVGElement>, inner: number) {
  const rect = event.currentTarget.getBoundingClientRect();
  // The SVG is drawn in CSS pixels at its own width (rect.width may differ under UI zoom).
  const scale = rect.width > 0 ? event.currentTarget.clientWidth / rect.width : 1;
  const x = (event.clientX - rect.left) * (Number.isFinite(scale) && scale > 0 ? scale : 1) - PAD;
  return Math.max(0, Math.min(1, x / Math.max(1, inner)));
}

/**
 * The whole chromosome as a bar: where the view is (a solid marker), the zoom
 * window around it (a light band) and position ticks. Click to move the view.
 */
export function ChromosomeMap({
  chrom, size, viewStart, viewEnd, windowStart, windowEnd, onNavigate,
}: {
  chrom: string;
  size: number;
  viewStart: number;
  viewEnd: number;
  windowStart: number;
  windowEnd: number;
  onNavigate: (center: number) => void;
}) {
  const [width, ref] = useContainerWidth(320);
  const inner = Math.max(40, width - PAD * 2);
  const toX = (bp: number) => PAD + (size > 0 ? Math.max(0, Math.min(1, bp / size)) : 0) * inner;
  const step = niceStep(size, Math.max(2, Math.floor(inner / 90)));
  const tickList = size > 0 ? ticks(0, size, step) : [];
  const viewX = toX(viewStart);
  const viewW = Math.max(3, toX(viewEnd) - viewX);
  const winX = toX(windowStart);
  const winW = Math.max(3, toX(windowEnd) - winX);
  const height = 58;
  const barY = 24;

  const onKey = (event: KeyboardEvent<SVGSVGElement>) => {
    if (!size) return;
    const center = (viewStart + viewEnd) / 2;
    const stepBp = event.shiftKey ? size / 12 : Math.max(1, viewEnd - viewStart);
    if (event.key === 'ArrowLeft') onNavigate(center - stepBp);
    else if (event.key === 'ArrowRight') onNavigate(center + stepBp);
    else if (event.key === 'Home') onNavigate(0);
    else if (event.key === 'End') onNavigate(size);
    else return;
    event.preventDefault();
  };

  return (
    <div ref={ref} className="w-full rounded-fb border border-line bg-surface" data-testid="regions-chromosome-map">
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="block cursor-crosshair select-none rounded-fb focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-500"
        role="slider"
        tabIndex={size ? 0 : -1}
        aria-label={`Position on ${chrom || 'the chromosome'}; click to move the view there`}
        aria-valuemin={0}
        aria-valuemax={size}
        aria-valuenow={Math.round((viewStart + viewEnd) / 2)}
        onClick={event => { if (size) onNavigate(clickFraction(event, inner) * size); }}
        onKeyDown={onKey}
      >
        <text x={PAD} y={14} fontSize={12} fontWeight={600} className="fill-ink">{chrom || 'No chromosome'}</text>
        {size > 0 && (
          <text x={width - PAD} y={14} fontSize={TICK_FONT} textAnchor="end" className="fill-ink-muted">{formatBp(size)}</text>
        )}
        <rect x={PAD} y={barY} width={inner} height={8} rx={4} className="fill-gray-200 dark:fill-white/15" />
        {size > 0 && (
          <>
            <rect x={winX} y={barY - 3} width={winW} height={14} rx={2} className="fill-teal-500/25 dark:fill-teal-400/25" data-testid="regions-chromosome-window">
              <title>{`Zoom window: ${chrom}:${Math.round(windowStart).toLocaleString()}-${Math.round(windowEnd).toLocaleString()}`}</title>
            </rect>
            <rect x={viewX} y={barY - 5} width={viewW} height={18} rx={1.5} className="fill-teal-700 dark:fill-teal-400" data-testid="regions-chromosome-view">
              <title>{`View: ${chrom}:${Math.round(viewStart).toLocaleString()}-${Math.round(viewEnd).toLocaleString()}`}</title>
            </rect>
            {tickList.map(p => (
              <g key={p}>
                <line x1={toX(p)} x2={toX(p)} y1={barY + 12} y2={barY + 16} className="stroke-gray-300 dark:stroke-white/25" strokeWidth={1} />
                <text
                  x={Math.max(PAD, Math.min(width - PAD, toX(p)))}
                  y={barY + 28}
                  fontSize={TICK_FONT}
                  textAnchor={p === 0 ? 'start' : toX(p) > width - PAD - 20 ? 'end' : 'middle'}
                  className="fill-ink-muted"
                >
                  {formatTick(p, step)}
                </text>
              </g>
            ))}
          </>
        )}
      </svg>
    </div>
  );
}

/**
 * The genes in the zoom window around the view, packed into lanes with their
 * names, under a position ruler, with the current view as a band. Click a
 * gene to go to it, or anywhere else to centre the view there.
 */
export function ZoomWindowMap({
  chrom, windowStart, windowEnd, viewStart, viewEnd, genes, maxLanes, onNavigate, onFocusGene,
}: {
  chrom: string;
  windowStart: number;
  windowEnd: number;
  viewStart: number;
  viewEnd: number;
  genes: Gene[];
  maxLanes: number;
  onNavigate: (center: number) => void;
  onFocusGene: (gene: OverviewGene) => void;
}) {
  const [width, ref] = useContainerWidth(320);
  const inner = Math.max(40, width - PAD * 2);
  const span = Math.max(1, windowEnd - windowStart);
  const toX = (bp: number) => PAD + ((bp - windowStart) / span) * inner;
  const merged = useMemo(() => mergeTranscripts(genes.map(g => ({ ...g, name: g.name || g.id }))), [genes]);
  // Drawn clipped to the window; tooltips and navigation use the gene's own bounds.
  const { placed, hidden, lanes } = packLanes(
    merged.map(gene => ({ name: gene.name, start: Math.max(gene.start, windowStart), end: Math.min(gene.end, windowEnd), gene })),
    toX,
    { maxLanes, charWidth: LABEL_FONT * 0.6 },
  );
  const [focusedGene, setFocusedGene] = useState<string | null>(null);
  const viewSpan = Math.max(1, viewEnd - viewStart);
  const onKey = (event: KeyboardEvent<SVGSVGElement>) => {
    const center = (viewStart + viewEnd) / 2;
    if (event.key === 'ArrowLeft') onNavigate(center - viewSpan / 2);
    else if (event.key === 'ArrowRight') onNavigate(center + viewSpan / 2);
    else return;
    event.preventDefault();
  };
  const step = niceStep(span, Math.max(2, Math.floor(inner / 100)));
  const tickList = ticks(windowStart, windowEnd, step);
  const rulerH = 22;
  const laneH = 30;
  const height = rulerH + Math.max(1, lanes) * laneH + 6;
  const viewX = toX(Math.max(windowStart, viewStart));
  const viewW = Math.max(2, toX(Math.min(windowEnd, viewEnd)) - viewX);

  return (
    <div className="w-full space-y-1">
      <div ref={ref} className="w-full overflow-hidden rounded-fb border border-line bg-surface" data-tour="regions-lens" data-testid="regions-zoom-map">
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          className="block cursor-crosshair select-none rounded-fb focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-500"
          role="group"
          tabIndex={0}
          aria-label={`Genes in ${chrom}:${Math.round(windowStart).toLocaleString()}-${Math.round(windowEnd).toLocaleString()}; click to move the view, arrow keys to pan, Tab to the genes`}
          onClick={event => onNavigate(windowStart + clickFraction(event, inner) * span)}
          onKeyDown={onKey}
        >
          {/* The current view */}
          <rect x={viewX} y={rulerH - 4} width={viewW} height={height - rulerH + 4} className="fill-teal-500/15 stroke-teal-600/70 dark:fill-teal-400/15 dark:stroke-teal-400/70" strokeWidth={1} data-testid="regions-zoom-view">
            <title>{`View: ${chrom}:${Math.round(viewStart).toLocaleString()}-${Math.round(viewEnd).toLocaleString()}`}</title>
          </rect>
          {/* Ruler */}
          <line x1={PAD} x2={PAD + inner} y1={rulerH - 4} y2={rulerH - 4} className="stroke-gray-300 dark:stroke-white/20" strokeWidth={1} />
          {tickList.map(p => (
            <g key={p}>
              <line x1={toX(p)} x2={toX(p)} y1={rulerH - 8} y2={rulerH - 4} className="stroke-gray-400 dark:stroke-white/30" strokeWidth={1} />
              <text x={toX(p)} y={rulerH - 11} fontSize={TICK_FONT} textAnchor="middle" className="fill-ink-muted">{formatTick(p, step)}</text>
            </g>
          ))}
          {/* Genes */}
          {placed.map(({ item: { gene: item }, lane, x1, x2 }) => {
            const y = rulerH + lane * laneH + 6;
            const color = STRAND_COLOR[item.strand] ?? OTHER_STRAND;
            const focused = focusedGene === item.id;
            const w = Math.max(2, x2 - x1);
            const arrows: number[] = [];
            for (let x = x1 + 10; x < x2 - 6 && arrows.length < 60; x += 22) arrows.push(x);
            return (
              <g
                key={`${item.id}-${lane}`}
                className="cursor-pointer outline-none"
                role="button"
                tabIndex={0}
                aria-label={`${item.name}, ${item.strand} strand, ${item.start.toLocaleString()} to ${item.end.toLocaleString()}: go to this gene`}
                onClick={event => { event.stopPropagation(); onFocusGene(item); }}
                onKeyDown={event => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault(); event.stopPropagation(); onFocusGene(item);
                }}
                onFocus={() => setFocusedGene(item.id)}
                onBlur={() => setFocusedGene(current => (current === item.id ? null : current))}
                data-testid="regions-zoom-gene"
              >
                {focused && (
                  <rect x={x1 - 3} y={y - 3} width={w + 6} height={26} rx={3} fill="none" strokeWidth={2} className="stroke-brand-500" />
                )}
                <title>{`${item.name} · ${item.strand} strand · ${item.start.toLocaleString()}-${item.end.toLocaleString()} (${formatBp(item.end - item.start)})`}</title>
                <rect x={x1} y={y} width={w} height={8} rx={2} fill={color} />
                {arrows.map(x => (
                  <path
                    key={x}
                    d={item.strand === '-' ? `M ${x + 2} ${y + 1.5} L ${x - 1} ${y + 4} L ${x + 2} ${y + 6.5}` : `M ${x - 2} ${y + 1.5} L ${x + 1} ${y + 4} L ${x - 2} ${y + 6.5}`}
                    fill="none"
                    stroke="#ffffff"
                    strokeWidth={1.2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                ))}
                <text x={Math.max(PAD, x1)} y={y + 20} fontSize={LABEL_FONT} className="fill-ink" style={{ fontStyle: 'italic' }}>
                  {item.name}
                </text>
              </g>
            );
          })}
          {placed.length === 0 && (
            <text x={width / 2} y={rulerH + laneH / 2 + 4} fontSize={LABEL_FONT} textAnchor="middle" className="fill-ink-muted">
              No genes in this window
            </text>
          )}
        </svg>
      </div>
      <div className="flex items-center justify-between gap-2 text-[11px] text-ink-muted">
        <span className="truncate font-mono">{chrom}:{Math.round(windowStart).toLocaleString()}-{Math.round(windowEnd).toLocaleString()}</span>
        <span className="shrink-0" data-testid="regions-zoom-count">
          {merged.length} gene{merged.length === 1 ? '' : 's'}{hidden > 0 ? ` · ${hidden} not drawn` : ''}
        </span>
      </div>
    </div>
  );
}
