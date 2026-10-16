// NfrFeatureTrack - the NFR track above a dataset panel's reads: each NFR of a Find variants run on this region, folded
// to one bar or unfolded into its variants (on lanes where they overlap), with the NFR pair arcs of the shown run drawn
// over it (open together above, rarely together below). One fold state and one selection with the panel's NFR pairs
// tab (accessibilityStore `expanded`, `focus`): a click selects an NFR or variant there, a second click (or an arc)
// inspects the pair in the panel. Like the footprint class channel: hover highlights the variant in the Accessibility
// panel (and the panel's rows highlight it here), shift-click selects it (several with shift) for the main toolbar's
// Cluster, Sort and Filter.
import { useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { AccessibilityResult, NfrRegionResult, NfrVariant } from './api';
import { useAccessibilityStore } from './accessibilityStore';
import { usePanelDisplayStore as useBrowserStore } from '../../hooks/usePanelDisplayStore';
import { featureKey, useFeatureStore, type FeatureRef } from '../../stores/featureStore';
import { useNfrRunsStore, type NfrRun } from './nfrRunsStore';
import { bp, elementColor, filteredArcs, nfrColor, pairTooltip, pct, variantColor, type ElementArc } from './accessibilityView';
import { assignLanes, shownArcs, shownElements } from './nfrPairsLayout';
import { pickElement } from './nfrSelection';
import { arcCurves, ArcPaths, nearestArc, withEnds } from './accessibility/ElementArcs';
import { sameChrom } from '../../utils/chromAliases';
import { trackX } from '../../utils/consensusTrack';
import { showNfr } from './nfrLinks';
import { requestSplitForFeatures } from '../../utils/splitPanels';
import { useSplitPanelStore } from '../../stores/splitPanelStore';
import { DisclosureChevron } from '../../components/ui/Disclosure';
import { HoverLabel, useTrackLabels } from '../../components/tracks/TrackLabels';
import { TRACK_BACKGROUND } from '../../components/tracks/TrackContainerConstants';

export const NFR_FEATURE_HEADER = 18;
export const NFR_FEATURE_LANE = 13;
/** Room for four variant lanes; the row scrolls when an NFR has more (and can be resized). */
export const NFR_FEATURE_HEIGHT = NFR_FEATURE_HEADER + 4 * NFR_FEATURE_LANE + 6;
/** Room for the pair arcs over the bars (above: open together; below: rarely together). */
export const NFR_ARC_ROOM = 72;

/** NFRs folded unless unfolded; an NFR with one variant is that variant. Lanes per NFR (its variants where they
 * overlap): the most any unfolded NFR needs, at least one. */
export function nfrTrackLanes(nfrs: readonly NfrRegionResult[], expanded: readonly string[]): { count: number; lanes: Map<string, number> } {
  const lanes = new Map<string, number>();
  let count = 1;
  for (const n of nfrs) {
    if (n.variants.length > 1 && !expanded.includes(n.id)) continue;
    const packed = assignLanes(n.variants.map(v => ({ id: v.id, kind: 'nfr' as const, start: v.L, end: v.R })));
    for (const [id, lane] of packed.lanes) lanes.set(id, lane);
    count = Math.max(count, packed.count);
  }
  return { count, lanes };
}

/** The track's height when the user has not set one: its lanes, and room for the arcs when they are drawn. */
export function nfrTrackHeight(laneCount: number, arcs: boolean, classLane = false): number {
  return NFR_FEATURE_HEADER + 4 + (laneCount + (classLane ? 0.5 : 0)) * NFR_FEATURE_LANE + 6 + (arcs ? NFR_ARC_ROOM : 0);
}

/** The run a panel draws: the shown run if it covers the panel's dataset and view, else the newest that does. */
export function nfrRunFor(runs: Record<string, NfrRun>, shownJobId: string | null, datasetId: string | null | undefined,
  chrom: string, start: number, end: number): NfrRun | null {
  if (!datasetId) return null;
  const fits = (r: NfrRun) => r.datasetIds.includes(datasetId) && sameChrom(r.result.region.chrom, chrom)
    && r.result.region.start < end && r.result.region.end > start && r.result.nfrs.some(n => n.variants.length || n.status === 'ok');
  const shown = shownJobId ? runs[shownJobId] : undefined;
  if (shown && fits(shown)) return shown;
  return Object.values(runs).filter(fits).sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
}

export function variantRef(run: Pick<NfrRun, 'jobId' | 'result'>, v: NfrVariant): FeatureRef {
  return nfrVariantFeature(run.jobId, run.result.region.chrom, v);
}

/** The feature of an NFR variant of a run (also from a saved NFR's stored geometry: no result needed). */
export function nfrVariantFeature(jobId: string, chrom: string, v: Pick<NfrVariant, 'id' | 'nfr' | 'name' | 'L' | 'R'>): FeatureRef {
  return { kind: 'nfr-variant', source: jobId, id: v.id, chrom, start: v.L, end: v.R, label: `${v.nfr} ${v.name}`, colour: variantColor(v.name) };
}

export function nfrRef(run: Pick<NfrRun, 'jobId' | 'result'>, n: NfrRegionResult): FeatureRef {
  const lo = Math.min(n.start, ...n.variants.map(v => v.L)), hi = Math.max(n.end, ...n.variants.map(v => v.R));
  return { kind: 'nfr', source: run.jobId, id: n.id, chrom: run.result.region.chrom, start: lo, end: hi, label: n.id, colour: nfrColor(n.id) };
}

/** Click: focus it in the panel (the selection stays as it is); shift / ctrl / cmd: add to (or take out of) the selection. */
export function clickFeature(ref: FeatureRef, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }, focus: () => void) {
  if (e.shiftKey || e.ctrlKey || e.metaKey) useBrowserStore.getState().selectFeature(ref, true);
  else focus();
}

function setCollapsed(panelId: string, collapsed: boolean) {
  useBrowserStore.setState(s => ({
    panels: s.panels.map(p => (p.id === panelId ? { ...p, subTracks: p.subTracks.map(t => (t.type === 'nfr-variants' ? { ...t, collapsed } : t)) } : p)),
  }));
}


const NO_IDS: string[] = [];

export function NfrFeatureTrack({ width, height, datasetId, panelId, collapsed = false, sidebarWidth = 0, overrideChrom, overrideStart, overrideEnd }: {
  width: number; height: number; datasetId: string; panelId: string; collapsed?: boolean; sidebarWidth?: number;
  overrideChrom?: string; overrideStart?: number; overrideEnd?: number;
}) {
  const overlayLabels = useTrackLabels();
  const view = useBrowserStore(useShallow(s => ({ chrom: s.chrom, start: s.start, end: s.end, isReversed: s.isReversed })));
  const chrom = overrideChrom ?? view.chrom, start = overrideStart ?? view.start, end = overrideEnd ?? view.end;
  const runs = useNfrRunsStore(s => s.nfrRuns);
  const hovered = useFeatureStore(s => s.hovered);
  const shownJob = useAccessibilityStore(s => s.jobId);
  const acc = useAccessibilityStore(useShallow(s => ({
    result: s.result, showArcs: s.showArcs, showClassArcs: s.showClassArcs, qMax: s.qMax, minEffect: s.minEffect, topN: s.topN,
    focus: s.focus, inspected: s.inspected, hoveredElement: s.hoveredElement,
  })));
  const selected = useBrowserStore(s => s.selectedFeatures);
  const run = nfrRunFor(runs, shownJob, datasetId, chrom, start, end);
  const expanded = useAccessibilityStore(s => (run ? s.expanded[run.jobId] : undefined)) ?? NO_IDS;
  // The pairs belong to the run the panel shows: only its arcs, its selection and its pair are drawn here.
  const isShown = !!run && run.jobId === shownJob && !!acc.result;
  const arcsOn = isShown && acc.showArcs;
  const drawn = useMemo(() => (isShown ? shownElements(acc.result, expanded, acc.showClassArcs) : []), [isShown, acc.result, expanded, acc.showClassArcs]);
  const { arcs, inner } = useMemo(() => (arcsOn
    ? shownArcs(filteredArcs(acc.result, { qMax: acc.qMax, minEffect: acc.minEffect, topN: acc.topN, focus: acc.focus, includeClasses: acc.showClassArcs }), drawn)
    : { arcs: [], inner: new Map<string, number>() }), [arcsOn, acc.result, acc.qMax, acc.minEffect, acc.topN, acc.focus, acc.showClassArcs, drawn]);
  const [hoverArc, setHoverArc] = useState<{ arc: ElementArc; x: number; y: number } | null>(null);
  const selectedHere = run ? selected.filter(f => f.kind !== 'fp-class' && f.source === run.jobId) : [];
  const selectedKeys = useMemo(() => new Set(selected.map(featureKey)), [selected]);
  const hoveredKey = hovered ? featureKey(hovered) : null;
  if (!run) return null;
  const result: AccessibilityResult = run.result;
  const nfrs = result.nfrs.filter(n => {
    const lo = Math.min(n.start, ...n.variants.map(v => v.L)), hi = Math.max(n.end, ...n.variants.map(v => v.R));
    return lo < end && hi > start;
  });
  const foldable = nfrs.filter(n => n.variants.length > 1);
  const { count: laneCount, lanes: variantLane } = nfrTrackLanes(nfrs, expanded);
  const classes = arcsOn ? drawn.filter(e => e.kind === 'tf' && e.end > start && e.start < end) : [];
  const x = (p: number) => trackX(Math.max(start, Math.min(end, p)), start, end, width, sidebarWidth, view.isReversed);
  const span = (a: number, b: number) => { const p = x(a), q = x(b); return { x: Math.min(p, q), w: Math.max(2, Math.abs(q - p)) }; };
  // An NFR's drawn extent (its bar and its variants), and where its ▾ goes: left of it, else right, else inside it,
  // whichever covers no other NFR's extent (a ▾ over a neighbour's variant took its clicks).
  const extentOf = (n: NfrRegionResult) => {
    const ref = nfrRef(run!, n);
    const a = Math.min(ref.start!, ...n.variants.map(v => v.L)), b = Math.max(ref.end!, ...n.variants.map(v => v.R));
    return span(a, b);
  };
  const unfoldedToggleX = (n: NfrRegionResult): number => {
    const own = extentOf(n);
    const others = nfrs.filter(o => o.id !== n.id).map(extentOf);
    const free = (x0: number) => x0 >= sidebarWidth && x0 + 11 <= width && !others.some(o => x0 < o.x + o.w && x0 + 11 > o.x);
    const band = span(nfrRef(run!, n).start!, nfrRef(run!, n).end!);
    return [band.x - 12, own.x - 12, own.x + own.w + 1, band.x].find(free) ?? band.x;
  };
  const variantCount = nfrs.reduce((n, r) => n + r.variants.length, 0);
  const label = `NFR variants (${nfrs.length} NFR${nfrs.length === 1 ? '' : 's'}, ${variantCount} variant${variantCount === 1 ? '' : 's'})`;
  // The hovered variant (or NFR) of this run, as a readout in the header: what it is, and what a click does.
  const hoveredHere = hovered && hovered.source === run.jobId && (hovered.kind === 'nfr-variant' || hovered.kind === 'nfr') ? hovered : null;
  const clickWords = arcsOn ? 'click to select, another for the pair' : 'click to show';
  const readout = hoveredHere ? `${hoveredHere.label ?? hoveredHere.id} · ${clickWords} · Shift-click to select for Cluster` : null;
  const title = `Find NFR variants run ${run.jobId.slice(0, 8)} on ${result.region.chrom}:${bp(result.region.start)}–${bp(result.region.end)}. `
    + (arcsOn ? 'Arcs: NFR pairs of the run the NFRs panel shows (above: open together; below: rarely together). Click an NFR or variant to select it, a second one or an arc to inspect the pair in the panel. '
      : 'Click a variant to show it in the Accessibility panel. ')
    + '▸ shows an NFR\'s variants; shift-click selects several for Cluster, Sort and Filter (main toolbar).';
  const reveal = (n: NfrRegionResult, variantId?: string) => showNfr(run.jobId, n.id, false, variantId);
  const toPanelPairs = () => {
    useAccessibilityStore.getState().setPanelView({ panelTab: 'coaccess', pairsMode: 'elements' });
    useBrowserStore.getState().openAnalysisPanel('accessibility');
  };
  // A click: with the arcs here, select (a second element: the pair, in the panel; on its NFRs tab the card shows too);
  // without them (or another run), show it in the panel as before. Shift / ctrl / cmd: the toolbar's selection.
  const clickElement = (id: string, ref: FeatureRef, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }, n: NfrRegionResult, variantId?: string) => {
    if (e.shiftKey || e.ctrlKey || e.metaKey) { useBrowserStore.getState().selectFeature(ref, true); return; }
    if (!arcsOn) { reveal(n, variantId); return; }
    if (pickElement(id) === 'pair') toPanelPairs();
    else if (useAccessibilityStore.getState().panelTab === 'nfrs') reveal(n, variantId);
  };
  const fold = (nfrId: string, open: boolean) => useAccessibilityStore.getState().setExpanded(run.jobId, nfrId, open);
  const allOpen = foldable.length > 0 && foldable.every(n => expanded.includes(n.id));
  // Rows: arcs above (open together), the bars on their lanes (and the footprint classes the arcs reach), arcs below.
  const body = Math.max(0, height - NFR_FEATURE_HEADER);
  const arcRoom = arcsOn ? Math.min(NFR_ARC_ROOM, Math.round(body * 0.6)) : 0;
  const classRow = classes.length ? 6 : 0;
  const lane = Math.max(7, Math.min(22, (body - arcRoom - 4 - classRow) / laneCount));
  const upRoom = Math.round(arcRoom * 0.62), downRoom = arcRoom - upRoom;
  const barsTop = upRoom;
  const barsH = 4 + laneCount * lane + classRow;
  const svgHeight = barsTop + barsH + downRoom;
  const curves = arcsOn ? arcCurves(arcs, {
    start, end, sidebarWidth, trackWidth: Math.max(0, width - sidebarWidth), isReversed: view.isReversed,
    upBase: barsTop, upRoom: upRoom - 3, downBase: barsTop + barsH, downRoom: downRoom - 3,
  }) : [];
  const focusId = isShown ? acc.focus : null;
  const inspected = isShown && acc.inspected?.jobId === run.jobId && acc.inspected.split.kind === 'pair' ? acc.inspected.split : null;
  const selectedPair = inspected ? `${inspected.a}|${inspected.b}` : null;
  const inPair = (members: string[]) => !!inspected && members.some(m => m === inspected.a || m === inspected.b);
  const byId = new Map((acc.result?.elements ?? []).map(e => [e.id, e]));
  const svgPoint = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { px: (e.clientX - r.left) * (width / Math.max(1, r.width)), py: (e.clientY - r.top) * (svgHeight / Math.max(1, r.height)) };
  };
  return (
    <section data-testid={`nfr-feature-track-${datasetId}`} data-figure-fill={TRACK_BACKGROUND.signal} data-run={run.jobId} data-arcs={arcsOn ? 'true' : undefined}
      className="relative border-y border-slate-200 text-slate-600" style={{ height, width, background: TRACK_BACKGROUND.signal }}>
      {/* Room on the right for the row's own controls (– and ×), so "Split into panels" is never under them. */}
      <div className="flex min-w-0 items-center gap-1 pl-1 text-[11px]" style={{ height: NFR_FEATURE_HEADER, paddingRight: 52 }}>
        <button type="button" className="flex items-center gap-1 text-slate-600 hover:text-slate-900" data-testid="nfr-feature-track-toggle"
          aria-expanded={!collapsed} title={collapsed ? 'Show the NFR variants' : 'Collapse the NFR channel to its header'}
          onClick={() => setCollapsed(panelId, !collapsed)}>
          <DisclosureChevron open={!collapsed} />
          {overlayLabels.clean ? null : <span data-figure-text={label}>{label}</span>}
        </button>
        {foldable.length > 0 && !collapsed && (!overlayLabels.clean || overlayLabels.hover) && (
          <button type="button" data-testid="nfr-feature-fold-all" aria-pressed={allOpen}
            className="z-[6] order-last ml-auto flex-shrink-0 whitespace-nowrap rounded bg-white/90 px-1 text-[10px] text-slate-600 hover:bg-slate-200 hover:text-slate-900"
            title={allOpen ? 'Fold every NFR to one bar (here and in the NFRs panel)' : 'Show every NFR\'s variants (here and in the NFRs panel)'}
            onClick={() => foldable.forEach(n => fold(n.id, !allOpen))}>{allOpen ? 'Fold variants' : 'Show variants'}</button>
        )}
        {overlayLabels.hover && <HoverLabel title={title} style={{ left: 22 }}>{readout ?? `${label} · shift-click to select`}</HoverLabel>}
        {readout && !overlayLabels.hover && (
          <span className="min-w-0 truncate rounded bg-white/90 px-1 text-[10px] text-slate-700" data-testid="nfr-feature-readout" role="status">{readout}</span>
        )}
        {!overlayLabels.clean || overlayLabels.hover ? (
          <button type="button" data-testid="nfr-feature-split" className={`z-[6] order-last ${foldable.length > 0 && !collapsed ? 'ml-1' : 'ml-auto'} flex-shrink-0 whitespace-nowrap rounded bg-white/90 px-1 text-[10px] text-slate-600 hover:bg-slate-200 hover:text-slate-900`}
            title={selectedHere.length ? `Split into panels by ${selectedHere.map(f => f.label ?? f.id).join(', ')}: one read panel per group`
              : nfrs.length === 1 ? `Split into panels by ${nfrs[0].id}'s variants: one read panel per variant` : 'Select variants (shift-click) to split the reads into panels by them'}
            disabled={!selectedHere.length && nfrs.length !== 1}
            onClick={() => {
              const error = selectedHere.length ? requestSplitForFeatures(selectedHere)
                : (useSplitPanelStore.getState().request({ kind: 'configurations', jobId: run.jobId, nfrId: nfrs[0].id, result: run.result }, [panelId]), null);
              if (error) useBrowserStore.getState().setError(error);
            }}>Split into panels</button>
        ) : null}
      </div>
      {!collapsed && (
        <div style={{ height: Math.max(0, height - NFR_FEATURE_HEADER), overflowY: 'auto', overflowX: 'hidden' }}>
          <svg width={width} height={svgHeight} aria-label={`NFR variants ${datasetId}`} data-figure-svg=""
            onMouseMove={arcsOn ? e => { const { px, py } = svgPoint(e); const arc = nearestArc(curves, px, py); setHoverArc(arc ? { arc, x: px, y: py } : null); } : undefined}
            onMouseLeave={arcsOn ? () => setHoverArc(null) : undefined}
            onClick={arcsOn ? e => {
              const { px, py } = svgPoint(e);
              const arc = nearestArc(curves, px, py);
              if (arc) { useAccessibilityStore.getState().requestPair(run.jobId, arc.pair.a, arc.pair.b); toPanelPairs(); }
            } : undefined}
            style={{ cursor: hoverArc ? 'pointer' : undefined }}>
            {/* An unfolded NFR's ▾: drawn first (under every NFR), where it covers no other NFR's bar or variants. */}
            {nfrs.filter(n => n.variants.length > 1 && expanded.includes(n.id)).map(n => {
              const toggleX = unfoldedToggleX(n);
              return (
                <g key={`fold-${n.id}`} role="button" tabIndex={0} aria-expanded aria-label={`Fold ${n.id}`}
                  data-testid="nfr-feature-fold" data-nfr={n.id} className="cursor-pointer focus:outline-none"
                  onClick={e => { e.stopPropagation(); fold(n.id, false); }}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fold(n.id, false); } }}>
                  <title>{`Fold ${n.id} to one bar`}</title>
                  <rect x={toggleX} y={barsTop + 1} width={11} height={Math.max(10, lane)} fill="transparent" />
                  <text x={toggleX + 2} y={barsTop + Math.max(9, lane - 1)} fontSize={10} fill="#334155">▾</text>
                </g>
              );
            })}
            {nfrs.map(n => {
              const ref = nfrRef(run, n);
              const band = span(ref.start!, ref.end!);
              const key = featureKey(ref);
              const isSelected = selectedKeys.has(key), isHovered = hoveredKey === key;
              const folded = n.variants.length > 1 && !expanded.includes(n.id);
              const nfrPicked = focusId === n.id;
              const members = n.variants.map(v => v.id);
              // ▸ inside the folded bar (an unfolded NFR's ▾ is drawn under all NFRs, above)
              const toggleX = band.x;
              return (
                <g key={n.id} data-nfr-id={n.id}>
                  <rect data-testid="nfr-feature-nfr" data-feature-key={key} data-selected={isSelected || undefined}
                    x={band.x} y={barsTop + 1} width={band.w} height={barsH - classRow - 2} rx={3} fill={nfrColor(n.id)} fillOpacity={isHovered ? 0.16 : 0.08}
                    stroke={isSelected ? '#111827' : isHovered ? nfrColor(n.id) : 'none'} strokeWidth={isSelected ? 2 : 1} className="cursor-pointer"
                    onMouseEnter={() => useFeatureStore.getState().setHover(ref)} onMouseLeave={() => useFeatureStore.getState().setHover(null)}
                    onClick={e => { e.stopPropagation(); clickElement(n.id, ref, e, n); }}>
                    <title>{`${n.id} ${bp(ref.start!)}–${bp(ref.end!)}: ${n.variants.length} variant${n.variants.length === 1 ? '' : 's'}, ${n.callable.toLocaleString()} of ${n.reads.toLocaleString()} reads callable. Click: ${arcsOn ? 'select it' : 'show in the Accessibility panel'}; shift-click: select the NFR.`}</title>
                  </rect>
                  {folded && (() => {
                    const y = barsTop + 3;
                    const h = Math.max(4, lane - 3);
                    const ring = nfrPicked || inPair(members);
                    return (
                      <g role="button" tabIndex={0} aria-pressed={nfrPicked} aria-label={`${n.id}, ${n.variants.length} variants (folded)`}
                        data-testid="nfr-feature-folded" data-nfr={n.id} data-focus={nfrPicked || undefined} data-in-pair={inPair(members) || undefined} className="cursor-pointer focus:outline-none"
                        onMouseEnter={() => useFeatureStore.getState().setHover(ref)} onMouseLeave={() => useFeatureStore.getState().setHover(null)}
                        onClick={e => { e.stopPropagation(); clickElement(n.id, ref, e, n); }}
                        onDoubleClick={e => { e.stopPropagation(); fold(n.id, true); }}
                        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); clickElement(n.id, ref, e, n); } }}>
                        <title>{`${n.id}: ${n.variants.length} variants folded to one (${n.variants.map(v => v.name).join(', ')}). ▸ or double-click shows them.`}</title>
                        <rect x={band.x} y={y} width={band.w} height={h} rx={2} fill={nfrColor(n.id)} fillOpacity={0.85}
                          stroke={ring ? '#111827' : '#ffffff'} strokeWidth={ring ? 2 : 0.75} />
                        {band.w > 40 && lane >= 10 && <text x={band.x + 13} y={y + Math.min(lane - 4, 12)} fontSize={Math.min(11, lane - 3.5)} fill="white" pointerEvents="none">{band.w > 90 ? `${n.id} · ${n.variants.length} variants` : n.id}</text>}
                        {(inner.get(n.id) ?? 0) > 0 && (
                          <text data-testid="nfr-feature-inner" x={band.x + band.w / 2} y={y - 2} textAnchor="middle" fontSize={9} fill="#c2410c" pointerEvents="none">
                            {`${inner.get(n.id)} pair${inner.get(n.id) === 1 ? '' : 's'} inside ▸`}
                          </text>
                        )}
                      </g>
                    );
                  })()}
                  {!folded && n.variants.map(v => {
                    const vref = variantRef(run, v);
                    const vkey = featureKey(vref);
                    const r = span(v.L, v.R);
                    const sel = selectedKeys.has(vkey), hov = hoveredKey === vkey;
                    const picked = focusId === v.id || nfrPicked;
                    const paired = inPair([v.id]);
                    const y = barsTop + 3 + (variantLane.get(v.id) ?? 0) * lane;
                    const colour = variantColor(v.name);
                    return (
                      <g key={v.id} role="button" tabIndex={0} aria-pressed={sel} aria-label={`${n.id} ${v.name} ${v.relation}, ${bp(v.L)}–${bp(v.R)}, ${pct(v.prevalence)}`}
                        data-testid="nfr-feature-variant" data-feature-key={vkey} data-variant={v.id} data-selected={sel || undefined} data-hovered={hov || undefined}
                        data-focus={picked || undefined} data-in-pair={paired || undefined}
                        className="cursor-pointer focus:outline-none"
                        onMouseEnter={() => useFeatureStore.getState().setHover(vref)} onMouseLeave={() => useFeatureStore.getState().setHover(null)}
                        onClick={e => { e.stopPropagation(); clickElement(v.id, vref, e, n, v.id); }}
                        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); clickElement(v.id, vref, e, n, v.id); } }}>
                        <title>{`${n.id} ${v.name} ${v.relation}: ${bp(v.L)}–${bp(v.R)} (${bp(v.width)} bp), ${pct(v.prevalence)} of callable reads`}</title>
                        <rect x={r.x} y={y} width={r.w} height={Math.max(4, lane - 3)} rx={2} fill={colour}
                          fillOpacity={hoveredKey && !hov && hoveredKey.startsWith('nfr-variant') ? 0.35 : 0.9}
                          stroke={sel || hov || picked || paired ? '#111827' : '#ffffff'} strokeWidth={sel ? 2.5 : picked || paired ? 2 : hov ? 1.5 : 0.75} />
                        {sel && <rect x={r.x} y={y + Math.max(4, lane - 3)} width={r.w} height={2} fill="#111827" pointerEvents="none" />}
                        {r.w > 26 && lane >= 10 && <text x={r.x + 3} y={y + Math.min(lane - 4, 12)} fontSize={Math.min(11, lane - 3.5)} fill="white" pointerEvents="none">{r.w > 70 ? `${n.id} ${v.name}` : v.name}</text>}
                      </g>
                    );
                  })}
                  {n.variants.length > 1 && folded && (
                    <g role="button" tabIndex={0} aria-expanded={!folded} aria-label={`${folded ? 'Show the variants of' : 'Fold'} ${n.id}`}
                      data-testid="nfr-feature-fold" data-nfr={n.id} className="cursor-pointer focus:outline-none"
                      onClick={e => { e.stopPropagation(); fold(n.id, folded); }}
                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fold(n.id, folded); } }}>
                      <title>{folded ? `Show ${n.id}'s ${n.variants.length} variants (here and in the NFRs panel)` : `Fold ${n.id} to one bar`}</title>
                      <rect x={toggleX} y={barsTop + 1} width={11} height={Math.max(10, lane)} fill="transparent" />
                      <text x={toggleX + 2} y={barsTop + Math.max(9, lane - 1)} fontSize={10} fill={folded ? 'white' : '#334155'}>{folded ? '▸' : '▾'}</text>
                    </g>
                  )}
                </g>
              );
            })}
            {classes.map(c => {
              const r = span(c.start, c.end);
              return <rect key={c.id} data-testid="nfr-feature-class" data-element={c.id} x={r.x} y={barsTop + barsH - classRow} width={r.w} height={classRow - 1} rx={1}
                fill={elementColor(c)} fillOpacity={focusId === c.id || inPair([c.id]) ? 1 : 0.7}
                onClick={e => { e.stopPropagation(); if (pickElement(c.id) === 'pair') toPanelPairs(); }} className="cursor-pointer"><title>{`${c.label} (footprint class): click to select`}</title></rect>;
            })}
            {arcsOn && (
              <g data-testid="nfr-arc-track">
                <ArcPaths curves={curves} selected={selectedPair} hoverArc={hoverArc?.arc} hovered={acc.hoveredElement}
                  onPick={(a, b) => { useAccessibilityStore.getState().requestPair(run.jobId, a, b); toPanelPairs(); }} />
              </g>
            )}
          </svg>
          {hoverArc && (
            <div data-testid="nfr-arc-tooltip" className="pointer-events-none absolute z-30 max-w-[340px] whitespace-pre-line rounded border border-gray-200 bg-white/95 px-2 py-1 text-[11px] leading-snug text-gray-800 shadow-md"
              style={{ left: Math.min(Math.max(0, hoverArc.x + 10), Math.max(0, width - 340)), top: NFR_FEATURE_HEADER + (hoverArc.y > svgHeight / 2 ? Math.max(0, hoverArc.y - 110) : hoverArc.y + 10) }}>
              {pairTooltip(hoverArc.arc.pair, withEnds(byId, hoverArc.arc))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
