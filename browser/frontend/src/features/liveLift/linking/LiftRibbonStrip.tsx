/**
 * The ribbon strip at the top of a linked source panel (DESIGN_LIVE_LIFT.md §5.2): between the live-lift panel above
 * (top edge: its axis, with expanded insertions and its orientation) and this panel (bottom edge: its own view and
 * orientation). Primary correspondences filled, alternatives outlined, '-' runs crossed and coloured, wedges where
 * the map has a gap, hatched bands where an edge corresponds to nothing. The hovered molecule draws its line.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../../stores/browserStore';
import { panelReversed } from '../../../hooks/usePanelDisplayStore';
import { makeAxis } from '../../differences/axis';
import { liveLiftViewKey } from '../../differences/persistence';
import { liveLiftHaplotypeColor } from '../palette';
import type { PanelConfig } from '../../../types';
import { useLiftHover } from './hover';
import { linearX, ribbonGeometry, type LiftPiecesResponse } from './ribbon';
import { mapSpan } from './navigation';

export const LIFT_RIBBON_HEIGHT = 44;
const MINUS_COLOUR = { light: '#7c3aed', dark: '#c4b5fd' };
const EMPTY: never[] = [];

/** Where the lifted panel's data area is, relative to this strip (it may sit in another column, or be gone). */
function useLiftPanelBox(liftPanelId: string, strip: React.RefObject<HTMLDivElement | null>, gutter: number) {
  const [box, setBox] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const el = document.querySelector(`[data-track-panel="${CSS.escape(liftPanelId)}"][data-track-type="reads"]`);
      const own = strip.current?.getBoundingClientRect();
      if (!el || !own) { setBox(b => (b === null ? b : null)); return; }
      const r = el.getBoundingClientRect();
      const next = { left: r.left + gutter - own.left, width: Math.max(1, r.width - gutter) };
      setBox(b => (b && Math.abs(b.left - next.left) < 0.5 && Math.abs(b.width - next.width) < 0.5 ? b : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    const el = document.querySelector(`[data-track-panel="${CSS.escape(liftPanelId)}"][data-track-type="reads"]`);
    if (el) ro.observe(el);
    if (strip.current) ro.observe(strip.current);
    window.addEventListener('scroll', measure, true);
    const timer = setInterval(measure, 1000);   // a panel mounted later, a row scrolled sideways
    return () => { ro.disconnect(); window.removeEventListener('scroll', measure, true); clearInterval(timer); };
  }, [liftPanelId, strip, gutter]);
  return box;
}

export function LiftRibbonStrip({ panel, width, height, sidebarWidth }: { panel: PanelConfig; width: number; height: number; sidebarWidth: number }) {
  const link = panel.liftLink!;
  const ref = useRef<HTMLDivElement>(null);
  const { chrom, start, end, dark, dataset, liftReversed, sourceReversed, expansions, liftPanel } = useBrowserStore(useShallow(s => {
    const lp = s.panels.find(p => p.id === link.liftPanelId);
    return {
      chrom: s.chrom, start: s.start, end: s.end, dark: s.darkMode,
      dataset: s.datasets.find(d => d.id === link.datasetId),
      liftReversed: panelReversed(s, link.liftPanelId), sourceReversed: panelReversed(s, panel.id),
      expansions: s.liveLiftExpansions?.[liveLiftViewKey(lp)] ?? EMPTY, liftPanel: lp,
    };
  }));
  const hover = useLiftHover(s => s.hover);
  const box = useLiftPanelBox(link.liftPanelId, ref, sidebarWidth);
  const view = panel.viewportOverride;
  const dataW = Math.max(1, width - sidebarWidth);
  const key = dataset?.live_lift?.key ?? '';
  const [pieces, setPieces] = useState<LiftPiecesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!dataset?.live_lift || end <= start) return;
    const controller = new AbortController();
    const bpPerPx = (end - start) / Math.max(1, box?.width ?? dataW);
    const params = new URLSearchParams({ dataset_id: dataset.id, chrom, start: String(Math.max(0, Math.floor(start))),
      end: String(Math.ceil(end)), hap: link.hap, min_bp: String(Math.max(0, Math.floor(bpPerPx / 2))) });
    const timer = setTimeout(() => {
      fetch(`/api/lift/pieces?${params}`, { signal: controller.signal })
        .then(async r => { if (!r.ok) throw new Error(r.status === 413 ? 'Zoom in to see the ribbon' : `ribbon: ${r.status}`); return r.json(); })
        .then((r: LiftPiecesResponse) => { setPieces(r); setError(null); })
        .catch(e => { if (!controller.signal.aborted) setError(String(e.message ?? e)); });
    }, 80);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [dataset?.id, key, chrom, start, end, link.hap, box?.width, dataW]); // eslint-disable-line react-hooks/exhaustive-deps

  const geometry = useMemo(() => {
    if (!pieces || !view || !box || pieces.chrom !== chrom) return null;
    const axis = makeAxis(start, end, box.width, liftReversed,
      expansions.filter(e => e.chrom === chrom && (e.referenceScope ?? 'main-reference') === (liftPanel?.genome ?? 'main-reference')));
    const topX = (t: number) => box.left + axis.toX(t);
    const bottomX = linearX(view.start, view.end, dataW, sourceReversed, sidebarWidth);
    return ribbonGeometry({ pieces: pieces.pieces, gaps: pieces.gaps, topX, bottomX, contig: view.chrom, height,
      target: { start, end }, source: { start: view.start, end: view.end } });
  }, [pieces, view, box, chrom, start, end, liftReversed, expansions, liftPanel?.genome, dataW, sourceReversed, sidebarWidth, height]);

  // The hovered molecule: a line between corresponding points of it (its visible middle on one side, mapped).
  const hoverLine = useMemo(() => {
    if (!hover || hover.datasetId !== link.datasetId || !view || !box || !key) return null;
    let t: number | null = null, q: number | null = null;
    const own = hover.panelId === link.liftPanelId || hover.target ? 'target' : 'source';
    if (own === 'target' && hover.target?.chrom === chrom) {
      const lo = Math.max(hover.target.start, start), hi = Math.min(hover.target.end, end);
      if (hi <= lo) return null;
      t = Math.floor((lo + hi) / 2);
      const m = mapSpan(link.datasetId, key, 'toSource', { chrom, start: t, end: t + 1 }, { hap: link.hap, preferChain: link.chain ?? null });
      if (m.status === 'mapped' && m.mapping.chrom === view.chrom) q = m.mapping.start;
    } else if (hover.source?.chrom === view.chrom) {
      const lo = Math.max(hover.source.start, view.start), hi = Math.min(hover.source.end, view.end);
      if (hi <= lo) return null;
      q = Math.floor((lo + hi) / 2);
      const m = mapSpan(link.datasetId, key, 'toTarget', { chrom: view.chrom, start: q, end: q + 1 }, { preferChain: link.chain ?? null });
      if (m.status === 'mapped' && m.mapping.chrom === chrom) t = m.mapping.start;
    }
    if (t == null || q == null) return null;
    const axis = makeAxis(start, end, box.width, liftReversed,
      expansions.filter(e => e.chrom === chrom && (e.referenceScope ?? 'main-reference') === (liftPanel?.genome ?? 'main-reference')));
    return { top: box.left + axis.toX(t), bottom: linearX(view.start, view.end, dataW, sourceReversed, sidebarWidth)(q) };
  }, [hover, link.datasetId, link.liftPanelId, link.hap, link.chain, view, box, key, chrom, start, end, liftReversed, expansions, liftPanel?.genome, dataW, sourceReversed, sidebarWidth]);

  const hapColour = liveLiftHaplotypeColor(link.hapLabel, dark);
  const minusColour = MINUS_COLOUR[dark ? 'dark' : 'light'];
  const counts = geometry ? geometry.shapes.reduce<Record<string, number>>((n, s) => ({ ...n, [s.kind]: (n[s.kind] ?? 0) + 1 }), {}) : {};
  const pid = panel.id.replace(/[^a-zA-Z0-9_-]/g, '');
  return (
    <div ref={ref} className="relative overflow-hidden" style={{ width, height }} data-testid="lift-ribbon"
      data-panel-id={panel.id} data-ribbon-shapes={geometry ? JSON.stringify(counts) : undefined}
      data-ribbon-hover={hoverLine ? 'true' : undefined}
      title={geometry ? undefined : error ?? (box ? 'Loading the map…' : 'The live-lift panel is not shown')}>
      <svg width={width} height={height} style={{ position: 'absolute', left: 0, top: 0 }} aria-label={`Lift map ribbon: ${link.hapLabel} source ↔ the lifted panel`}>
        <defs>
          <pattern id={`ribbon-hatch-${pid}`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" stroke={dark ? '#64748b' : '#94a3b8'} strokeWidth="2" />
          </pattern>
          <pattern id={`ribbon-ins-${pid}`} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
            <line x1="0" y1="0" x2="0" y2="4" stroke={hapColour} strokeWidth="1.5" />
          </pattern>
        </defs>
        {geometry?.shapes.map((s, i) => {
          const d = `M${s.points.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('L')}Z`;
          const colour = s.minus ? minusColour : hapColour;
          const common = { d, 'data-ribbon-kind': s.kind, 'data-minus': s.minus ? 'true' : undefined } as Record<string, unknown>;
          switch (s.kind) {
            case 'primary':
              return <path key={i} {...common} fill={colour} fillOpacity={s.minus ? 0.3 : 0.22} stroke={colour} strokeOpacity={0.55} strokeWidth={0.75}><title>{s.title}</title></path>;
            case 'alternative':
              return <path key={i} {...common} fill="none" stroke={colour} strokeOpacity={0.8} strokeWidth={1} strokeDasharray="3 2"><title>{s.title}</title></path>;
            case 'source_insertion':
              return <path key={i} {...common} fill={`url(#ribbon-ins-${pid})`} stroke={hapColour} strokeWidth={0.75}><title>{s.title}</title></path>;
            case 'target_insertion':
              return <path key={i} {...common} fill={dark ? '#475569' : '#cbd5e1'} fillOpacity={0.7} stroke={dark ? '#94a3b8' : '#64748b'} strokeWidth={0.5}><title>{s.title}</title></path>;
            case 'gap':
              return <path key={i} {...common} fill={`url(#ribbon-hatch-${pid})`} fillOpacity={0.6} stroke="none"><title>{s.title}</title></path>;
            default:
              return <path key={i} {...common} fill={`url(#ribbon-hatch-${pid})`} stroke="none"><title>{s.title}</title></path>;
          }
        })}
        {hoverLine && <line x1={hoverLine.top} y1={0} x2={hoverLine.bottom} y2={height} stroke={dark ? '#fde047' : '#ca8a04'} strokeWidth={2}
          data-testid="lift-ribbon-hover-line" />}
      </svg>
      {geometry && geometry.elsewhere > 0 && (
        <span className="absolute right-1 top-0.5 rounded bg-white/80 px-1 text-[10px] text-gray-600 dark:bg-gray-900/80 dark:text-gray-300"
          title={`Also corresponds to ${geometry.elsewhereContigs.join(', ')} (not this panel's contig)`}>
          +{geometry.elsewhere} on {geometry.elsewhereContigs.length === 1 ? geometry.elsewhereContigs[0] : `${geometry.elsewhereContigs.length} contigs`}
        </span>
      )}
      {!geometry && error && <span className="absolute left-1 top-0.5 text-[10px] text-gray-500">{error}</span>}
    </div>
  );
}
