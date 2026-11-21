// GeometryFeatureTrack - the regularity geometry track above a dataset panel's reads (the NFR track's counterpart):
// each shared geometry of the newest nucleosome panel analysis that pooled this panel's dataset and covers its view,
// as a chip over its span. High-regularity geometries in warm colours on the upper lanes, low-regularity ones in cool
// colours below, folded geometries paler. Hover links the chip with the panel's row; a click focuses the geometry (its
// carriers highlighted in the reads, as in the panel); shift-click selects it for the main toolbar's Cluster, Sort and
// Filter.
import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { usePanelDisplayStore as useBrowserStore } from '../../hooks/usePanelDisplayStore';
import { featureKey, useFeatureStore } from '../../stores/featureStore';
import { useNucGeoFocusStore } from '../../stores/nucGeoFocusStore';
import { sameChrom } from '../../utils/chromAliases';
import { trackX } from '../../utils/consensusTrack';
import { DisclosureChevron } from '../../components/ui/Disclosure';
import { HoverLabel, useTrackLabels } from '../../components/tracks/TrackLabels';
import { TRACK_BACKGROUND } from '../../components/tracks/TrackContainerConstants';
import { clickGeometry, focusKeyOf } from './geoActions';
import { geoColour, geoFeatureRef, geoKindOf } from './geoHub';
import { geoRunFor, runGeoChrom, useNucGeoRuns, type NucGeoRun } from './geoRuns';
import type { NucGeometryRow } from './types';

export const GEO_TRACK_TYPE = 'nuc-geometries';
export const GEO_TRACK_HEADER = 18;
export const GEO_TRACK_LANE = 13;

/** Lanes per kind: high first, then low; within a kind, geometries that overlap go on separate lanes. */
/** Which screen ends of a geometry are open (left, right): the genomic ends, swapped in a reversed view. */
export function openScreenEnds(g: { openLeft?: boolean; openRight?: boolean }, reversed: boolean): [boolean, boolean] {
  const l = !!g.openLeft, r = !!g.openRight;
  return reversed ? [r, l] : [l, r];
}

export function geometryTrackLanes(G: readonly NucGeometryRow[]): { lanes: number[]; count: number; highLanes: number } {
  const lanes = new Array<number>(G.length).fill(0);
  let offset = 0, highLanes = 0;
  for (const kind of ['high', 'low'] as const) {
    const idx = G.map((g, i) => (geoKindOf(g) === kind ? i : -1)).filter(i => i >= 0)
      .sort((a, b) => G[a].start - G[b].start || G[b].end - G[a].end);
    const ends: number[] = [];
    for (const i of idx) {
      let lane = ends.findIndex(e => e <= G[i].start);
      if (lane < 0) { lane = ends.length; ends.push(0); }
      ends[lane] = G[i].end;
      lanes[i] = offset + lane;
    }
    offset += ends.length;
    if (kind === 'high') highLanes = ends.length;
  }
  return { lanes, count: Math.max(1, offset), highLanes };
}

export function geometryTrackHeight(laneCount: number): number {
  return GEO_TRACK_HEADER + 4 + laneCount * GEO_TRACK_LANE + 4;
}

function setCollapsed(panelId: string, collapsed: boolean) {
  useBrowserStore.setState(s => ({
    panels: s.panels.map(p => (p.id === panelId ? { ...p, subTracks: p.subTracks.map(t => (t.type === GEO_TRACK_TYPE ? { ...t, collapsed } : t)) } : p)),
  }));
}

const kb = (v: number) => `${(v / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 })} kb`;

/** The run the track draws for this dataset and region (hook: re-renders when a panel's analysis changes). */
export function useGeoRunFor(datasetId: string | null | undefined, chrom: string, start: number, end: number): NucGeoRun | null {
  const runs = useNucGeoRuns(s => s.runs);
  return useMemo(() => geoRunFor(runs, datasetId, chrom, start, end, sameChrom), [runs, datasetId, chrom, start, end]);
}

export function GeometryFeatureTrack({ width, height, datasetId, panelId, collapsed = false, sidebarWidth = 0, overrideChrom, overrideStart, overrideEnd }: {
  width: number; height: number; datasetId: string; panelId: string; collapsed?: boolean; sidebarWidth?: number;
  overrideChrom?: string; overrideStart?: number; overrideEnd?: number;
}) {
  const overlayLabels = useTrackLabels();
  const view = useBrowserStore(useShallow(s => ({ chrom: s.chrom, start: s.start, end: s.end, isReversed: s.isReversed })));
  const chrom = overrideChrom ?? view.chrom, start = overrideStart ?? view.start, end = overrideEnd ?? view.end;
  const run = useGeoRunFor(datasetId, chrom, start, end);
  const selected = useBrowserStore(s => s.selectedFeatures);
  const hovered = useFeatureStore(s => s.hovered);
  const focused = useNucGeoFocusStore(s => s.focused);
  const selectedKeys = useMemo(() => new Set(selected.map(featureKey)), [selected]);
  if (!run) return null;
  const res = run.result;
  const G = res.geometries;
  const { lanes, count, highLanes } = geometryTrackLanes(G);
  const shown = G.map((g, i) => i).filter(i => sameChrom(runGeoChrom(G[i], run), chrom) && G[i].start < end && G[i].end > start);
  const nHigh = shown.filter(i => geoKindOf(G[i]) === 'high').length, nLow = shown.length - nHigh;
  const label = `Regularity geometries (${nHigh} high${nLow ? `, ${nLow} low` : ''})`;
  const x = (p: number) => trackX(Math.max(start, Math.min(end, p)), start, end, width, sidebarWidth, view.isReversed);
  const span = (a: number, b: number) => { const p = x(a), q = x(b); return { x: Math.min(p, q), w: Math.max(2, Math.abs(q - p)) }; };
  const body = Math.max(0, height - GEO_TRACK_HEADER);
  const lane = Math.max(7, Math.min(20, (body - 8) / count));
  const svgHeight = 4 + count * lane + 4;
  const refs = shown.map(i => geoFeatureRef(useBrowserStore.getState(), run, G[i], i));
  const hoveredHere = hovered && refs.find(r => featureKey(r) === featureKey(hovered));
  const readout = hoveredHere ? `${hoveredHere.label} · click to highlight its carriers · shift-click to select for Cluster` : null;
  const title = 'Shared regularity geometries of the nucleosome panel (high regularity: warm colours, upper lanes; low regularity: '
    + 'cool colours, lower lanes; folded geometries paler). Click to highlight the carriers in the reads; shift-click selects them for '
    + 'Cluster, Sort and Filter (main toolbar).';
  return (
    <section data-testid={`nuc-geo-track-${datasetId}`} data-figure-fill={TRACK_BACKGROUND.signal} data-panel={run.panelId}
      className="relative border-y border-slate-200 text-slate-600" style={{ height, width, background: TRACK_BACKGROUND.signal }}>
      <div className="flex min-w-0 items-center gap-1 pl-1 text-[11px]" style={{ height: GEO_TRACK_HEADER, paddingRight: 52 }}>
        <button type="button" className="flex items-center gap-1 text-slate-600 hover:text-slate-900" data-testid="nuc-geo-track-toggle"
          aria-expanded={!collapsed} title={collapsed ? 'Show the regularity geometries' : 'Collapse the geometry track to its header'}
          onClick={() => setCollapsed(panelId, !collapsed)}>
          <DisclosureChevron open={!collapsed} />
          {overlayLabels.clean ? null : <span data-figure-text={label}>{label}</span>}
        </button>
        {overlayLabels.hover && <HoverLabel title={title} style={{ left: 22 }}>{readout ?? `${label} · shift-click to select`}</HoverLabel>}
        {readout && !overlayLabels.hover && (
          <span className="min-w-0 truncate rounded bg-white/90 px-1 text-[10px] text-slate-700" data-testid="nuc-geo-track-readout" role="status">{readout}</span>
        )}
      </div>
      {!collapsed && (
        <div style={{ height: body, overflowY: 'auto', overflowX: 'hidden' }}>
          <svg width={width} height={svgHeight} aria-label={`Regularity geometries ${datasetId}`} data-figure-svg="">
            {highLanes > 0 && highLanes < count && <line x1={sidebarWidth} x2={width} y1={4 + highLanes * lane - 0.5} y2={4 + highLanes * lane - 0.5}
              stroke="#cbd5e1" strokeDasharray="2 3" />}
            {shown.map((i, k) => {
              const g = G[i];
              const ref = refs[k];
              const key = featureKey(ref);
              const sel = selectedKeys.has(key), hov = !!hovered && featureKey(hovered) === key;
              const foc = focused.has(focusKeyOf(G, i));
              const r = span(g.start, g.end);
              const y = 4 + lanes[i] * lane;
              const h = Math.max(4, lane - 3);
              const folded = g.parentIndex != null;
              const colour = geoColour(g, i);
              const share = Math.max(0, ...Object.values(g.perObservation).map(o => o.fullShare ?? 0));
              return (
                <g key={g.id} role="button" tabIndex={0} aria-pressed={sel}
                  aria-label={`${g.id}, ${geoKindOf(g)} regularity, ${kb(g.start)} to ${kb(g.end)}`}
                  data-testid="nuc-geo-chip" data-geometry={g.id} data-kind={geoKindOf(g)} data-feature-key={key}
                  data-selected={sel || undefined} data-focus={foc || undefined} data-hovered={hov || undefined}
                  className="cursor-pointer focus:outline-none"
                  onMouseEnter={() => useFeatureStore.getState().setHover(ref)} onMouseLeave={() => useFeatureStore.getState().setHover(null)}
                  onClick={e => { e.stopPropagation(); clickGeometry(run, res, i, e); }}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); clickGeometry(run, res, i, e); } }}>
                  <title>{`${g.id} (${geoKindOf(g)} regularity${g.parent ? `, folded into ${g.parent}` : ''}): ${g.start.toLocaleString()}–${g.end.toLocaleString()} `
                    + `(${(g.width / 1000).toFixed(2)} kb), carried in full by up to ${Math.round(100 * share)}% of a series' molecules. `
                    + 'Click: highlight its carriers; shift-click: select it for Cluster, Sort and Filter.'}</title>
                  <rect x={r.x} y={y} width={r.w} height={h} rx={2} fill={colour} fillOpacity={folded ? 0.5 : 0.9}
                    stroke={sel || hov || foc ? '#111827' : '#ffffff'} strokeWidth={sel ? 2.5 : foc ? 2 : hov ? 1.5 : 0.75} />
                  {sel && <rect x={r.x} y={y + h} width={r.w} height={2} fill="#111827" pointerEvents="none" />}
                  {(() => {
                    // Open ends in screen terms: a reversed view draws the genomic left end on the right. Each end has
                    // its own chevron (a window-spanning geometry shows both).
                    const [scrL, scrR] = openScreenEnds(g, view.isReversed);
                    const fs = Math.min(9, h);
                    return <>
                      {scrL && <text x={r.x + 1} y={y + h - 1.5} fontSize={fs} fill="white" pointerEvents="none" data-testid="nuc-geo-open-left">‹</text>}
                      {scrR && <text x={r.x + r.w - 6} y={y + h - 1.5} fontSize={fs} fill="white" pointerEvents="none" data-testid="nuc-geo-open-right">›</text>}
                    </>;
                  })()}
                  {r.w > 22 && lane >= 10 && <text x={r.x + (openScreenEnds(g, view.isReversed)[0] ? 7 : 3)} y={y + Math.min(lane - 4, 11)} fontSize={Math.min(10.5, lane - 3.5)} fill="white" pointerEvents="none">
                    {r.w > 70 && g.parent ? `${g.id} ⊂ ${g.parent}` : g.id}</text>}
                </g>
              );
            })}
          </svg>
        </div>
      )}
    </section>
  );
}
