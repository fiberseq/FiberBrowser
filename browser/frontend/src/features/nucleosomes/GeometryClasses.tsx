/**
 * Shared geometries as classes, in the look and behaviour of the Footprints class list (RecallerClassList) and the NFR
 * card (variant lanes): pool → find → compare.
 *
 * - The map: one lane per geometry over the analysed window (the NFR card's ClassLanes), edge spread as whiskers,
 *   open ends as arrows, folded geometries outlined under their parent.
 * - The list: one row per geometry (Footprints' row: inspect arrow, swatch, name, width, one line per series with the
 *   shared tier bar: full carriers solid, + partly through a folded child lighter, and the numbers in aligned columns),
 *   high- and low-regularity geometries told apart by hue (warm / cool, as the read lane) and a kind badge.
 * - A click on a geometry focuses it (as a click on a footprint class highlights it): its carriers are highlighted in
 *   the reads, the other patches in the patch lane dim; alt-click adds to the focus. Shift / ctrl / cmd-click selects it
 *   for the main toolbar's Cluster, Sort and Filter (the feature hub's identity: geoHub.ts), as NFR variants and
 *   footprint classes are selected. The star saves it (savedGeometries.ts). Inspect opens its details under the
 *   list (span, edge spread, density-matched shares, member stack, nested pairs, read actions).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useBrowserStore } from '../../stores/browserStore';
import { featureKey, useFeatureStore } from '../../stores/featureStore';
import { useNucGeoFocusStore } from '../../stores/nucGeoFocusStore';
import { nucGeoColor } from '../../utils/nucLayers';
import { applyReadGroups } from '../../utils/readGroups';
import { useContainerWidth } from '../../hooks/useContainerWidth';
import { ClassLanes } from '../../components/charts/ClassLanes';
import { TierBar } from '../../components/controls/shared/TierBar';
import { AnalysisButton, AnalysisToggleGroup } from '../../components/controls/shared/AnalysisControls';
import { DisclosureChevron } from '../../components/ui/Disclosure';
import { HowItWorks } from '../../components/ui/HowItWorks';
import { ChartBox, fmt } from './charts';
import { carriersOf, clickGeometry, focusKeyOf, refocusAfter } from './geoActions';
import { useReadActionsStore } from '../../stores/readActionsStore';
import { geoChrom, geoDatasetCounts, geoFeatureRef } from './geoHub';
import { sameChrom } from '../../utils/chromAliases';
import { formatTsv } from '../../utils/analysisExport';
import type { NucGeoRun } from './geoRuns';
import { matchSaved } from './savedGeometries';
import { geometryTolerance } from './SavedGeometryCard';
import type { RegSeries } from './RegularityView';
import type { NucGeometryResult, NucGeometryRow, NucNestedRow, NucPatchKind } from './types';

const NO_SAVED: import('./savedGeometries').SavedGeometry[] = [];
const pct = (v: number | null | undefined, d = 0) => (v == null || !Number.isFinite(v) ? '–' : `${(100 * v).toFixed(d)}%`);
const pp = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '' : `+${Math.round(100 * v)} pp`);
/** Below this list width a row puts its per-series lines under the class (as the Footprints list). */
const NARROW_PX = 600;

export const kindOf = (g: NucGeometryRow): NucPatchKind => g.kind ?? 'high';
/** A geometry's 1-based number within its kind, and its root's (the colour). */
export const numberOf = (g: NucGeometryRow, index: number) => g.number ?? index + 1;
export const rootOf = (g: NucGeometryRow, index: number) => g.rootNumber ?? (g.parentIndex != null ? g.parentIndex + 1 : index + 1);
export const geometryColor = (g: NucGeometryRow, index: number) => nucGeoColor(rootOf(g, index), kindOf(g));
export const KIND_LABEL: Record<NucPatchKind, string> = { high: 'high regularity', low: 'low regularity' };

/** Display order: roots in their found order, each followed by the geometries folded into it; high before low. */
export function geometryOrder(G: NucGeometryRow[]): number[] {
  const idx = G.map((_g, i) => i);
  const rank = (k: NucPatchKind) => (k === 'high' ? 0 : 1);
  return idx.sort((a, b) => {
    const pa = G[a].parentIndex ?? a, pb = G[b].parentIndex ?? b;
    return rank(kindOf(G[a])) - rank(kindOf(G[b])) || pa - pb
      || Number(G[a].parentIndex != null) - Number(G[b].parentIndex != null) || a - b;
  });
}

export function geometriesTsv(res: NucGeometryResult, order: number[], series: RegSeries[], pos: (v: number) => string): string {
  const head = ['geometry', 'kind', 'part_of', 'chrom', 'start', 'end', 'span', 'width_bp', 'open_left', 'open_right', 'molecules',
    'patches', 'start_spread_bp', 'end_spread_bp', 'score', 'period_bp',
    ...series.flatMap(s => [`${s.label} full`, `${s.label} partly`, `${s.label} molecules`, `${s.label} of callable`]),
    ...Object.keys(res.geometries[0]?.densityMatched ?? {}).map(d => `of callable, density matched ${d}`)];
  const rows = order.map(i => {
    const g = res.geometries[i];
    return [g.id, kindOf(g), g.parent ?? '', geoChrom(g, res), g.start, g.end, `${pos(g.start)} to ${pos(g.end)}`, g.width,
      Number(g.openLeft), Number(g.openRight), g.molecules, g.patches, g.startMad ?? '', g.endMad ?? '', g.score ?? '', g.period > 0 ? g.period : '',
      ...series.flatMap(s => { const o = g.perObservation[s.obsId]; return [o?.fullShare ?? '', o?.partialShare ?? '', o?.molecules ?? '', o?.callableShare ?? '']; }),
      ...Object.values(g.densityMatched ?? {}).map(v => v ?? '')];
  });
  // escaped cells (series labels are dataset names: a tab or newline never breaks the columns)
  return `# window: ${res.window ? `${res.window.chrom}:${res.window.start + 1}-${res.window.end}` : ''}\n${formatTsv([head, ...rows])}`;
}

/** Group the read panels by geometry: per kind, each read in the root of the first geometry it carries (folded
 * children join their parent; partial carriers too), reads carrying none last. */
export function groupReadsByGeometry(res: NucGeometryResult, series: RegSeries[], kind: NucPatchKind, span: (g: NucGeometryRow) => string) {
  const G = res.geometries;
  const byDataset: Record<string, Record<string, number>> = {};
  const stateKeys: Record<string, string[]> = {};
  for (const s of series) (stateKeys[s.datasetId] ??= []).includes(s.stateKey) || stateKeys[s.datasetId].push(s.stateKey);
  const none = G.length;
  for (const [ds, a] of Object.entries(res.assignments)) {
    const grp = kind === 'low' ? a.groupLow ?? {} : a.group;
    byDataset[ds] = Object.fromEntries(Object.entries(grp).map(([q, g]) => [q, g > 0 ? g - 1 : none]));
  }
  const roots = G.map((g, i) => (g.parentIndex == null && kindOf(g) === kind ? i : -1)).filter(i => i >= 0);
  const labels: Record<number, string> = { [none]: kind === 'low' ? 'no low-regularity geometry' : 'no high-regularity geometry' };
  for (const i of roots) labels[i] = `${G[i].id} ${span(G[i])}`;
  applyReadGroups({ byDataset, order: [...roots, none], patterns: {}, regions: [], labels }, stateKeys,
    kind === 'low' ? 'Group by low-regularity geometry' : 'Group by high-regularity geometry');
}

/** Group the read panels by one geometry: carries it, carries it partly (a folded child), the rest. */
function groupReadsByOne(res: NucGeometryResult, series: RegSeries[], index: number) {
  const g = res.geometries[index];
  const full = carriersOf(res, new Set([index + 1]), false);
  const any = carriersOf(res, new Set([index + 1]), true);
  const byDataset: Record<string, Record<string, number>> = {};
  const stateKeys: Record<string, string[]> = {};
  for (const s of series) (stateKeys[s.datasetId] ??= []).includes(s.stateKey) || stateKeys[s.datasetId].push(s.stateKey);
  for (const [ds, a] of Object.entries(res.assignments)) {
    const f = new Set(full[ds] ?? []), p = new Set(any[ds] ?? []);
    byDataset[ds] = Object.fromEntries(Object.keys(a.group).map(q => [q, f.has(q) ? 0 : p.has(q) ? 1 : 2]));
  }
  applyReadGroups({ byDataset, order: [0, 1, 2], patterns: {}, regions: [],
    labels: { 0: `carries ${g.id}`, 1: `${g.id} partly`, 2: `no ${g.id}` } }, stateKeys, `Group by ${g.id}`);
}

function SeriesLine({ g, s, color, faded }: { g: NucGeometryRow; s: RegSeries; color: string; faded: boolean }) {
  const o = g.perObservation[s.obsId];
  const full = o?.fullShare ?? null, part = o?.partialShare ?? null;
  const title = o ? `${s.label}: ${pct(full, 1)} carry ${g.id} in full (${o.full} of ${o.molecules} molecules)`
    + `${o.partial ? `; ${pct(part, 1)} carry it partly, through a folded geometry (${o.partial})` : ''}; ${o.callable} callable; median patch score ${fmt(o.score, 2)}`
    : `${s.label}: not in this series`;
  return (
    <span className="flex min-w-0 items-center gap-1.5 leading-[13px]" data-testid="nuc-geo-series-line" data-series={s.obsId}>
      <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full" style={{ backgroundColor: s.seriesColor }} aria-hidden="true" />
      <span className="min-w-[3rem] flex-1"><TierBar value={full} edge={part ? (full ?? 0) + part : null} color={color} faded={faded} title={title} testId="nuc-geo-bar" /></span>
      <span className="shrink-0 whitespace-nowrap text-right text-[10px] tabular-nums text-gray-600 dark:text-gray-300" data-testid="nuc-geo-share" title={title}>
        <span className="inline-block w-[2.6rem] font-medium text-gray-800 dark:text-gray-100">{pct(full)}</span>
        <span className="inline-block w-[3rem]">{part ? ` ${pp(part)}` : ''}</span>
        <span className="inline-block w-[2.4rem] text-ink-muted">{o?.score != null ? fmt(o.score, 2) : ''}</span>
      </span>
    </span>
  );
}

export function GeometryClasses({ res, run, series, pos, span, kinds, kindFilter, setKindFilter, loading = false, took = null,
  list = 'all', setList, savedCount = 0, savedView = null }: {
  res: NucGeometryResult; run: NucGeoRun | null; series: RegSeries[]; pos: (v: number) => string; span: (g: NucGeometryRow) => string;
  kinds: NucPatchKind[]; kindFilter: 'all' | NucPatchKind; setKindFilter: (k: 'all' | NucPatchKind) => void;
  /** A new answer is computing (the list on show stays until it lands). */
  loading?: boolean;
  /** Seconds the last answer took (in the count's tooltip). */
  took?: number | null;
  /** All geometries of this analysis, or the saved ones (`savedView` is drawn in place of the map and list). */
  list?: 'all' | 'saved'; setList?: (v: 'all' | 'saved') => void; savedCount?: number; savedView?: ReactNode;
}) {
  const G = res.geometries;
  const order = useMemo(() => geometryOrder(G).filter(i => kindFilter === 'all' || kindOf(G[i]) === kindFilter), [res, kindFilter]);   // eslint-disable-line react-hooks/exhaustive-deps
  const focused = useNucGeoFocusStore(s => s.focused);
  const [inspecting, setInspecting] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [listWidth, listRef] = useContainerWidth(420);
  const [mapWidth, mapRef] = useContainerWidth(420);
  const narrow = listWidth < NARROW_PX;
  const keyOf = (i: number) => focusKeyOf(G, i);
  const isFocused = (i: number) => focused.has(keyOf(i));
  // Selection (the toolbar's, shift-click) and hover (shared with the geometry track above the reads), by feature key.
  const selectedFeatures = useBrowserStore(s => s.selectedFeatures);
  const hoveredFeature = useFeatureStore(s => s.hovered);
  const saved = useBrowserStore(s => s.savedNucGeometries ?? NO_SAVED);
  const refs = useMemo(() => (run ? G.map((g, i) => geoFeatureRef(useBrowserStore.getState(), run, g, i)) : null), [run, G]);
  const selectedKeys = useMemo(() => new Set(selectedFeatures.map(featureKey)), [selectedFeatures]);
  const isSelected = (i: number) => !!refs && selectedKeys.has(featureKey(refs[i]));
  const hoveredIndex = refs && hoveredFeature ? refs.findIndex(r => featureKey(r) === featureKey(hoveredFeature)) : -1;
  const tol = geometryTolerance(res);
  const savedIndex = useMemo(() => new Set(saved.map(e => matchSaved(e, res.window?.chrom, G, tol)).filter((i): i is number => i != null)), [saved, res, G, tol]);   // eslint-disable-line react-hooks/exhaustive-deps
  const star = (i: number) => {
    const g = G[i];
    const st = useBrowserStore.getState();
    const at = (st.savedNucGeometries ?? []).find(e => matchSaved(e, res.window?.chrom, G, tol) === i);
    if (at) { st.removeSavedNucGeometry(at.id); return; }
    // Per dataset (its series summed): the full share now, and the m6A density-matched share.
    // (Each molecule once: overlapping panels of a dataset never double-count; geoHub.geoDatasetCounts.)
    const sums = geoDatasetCounts(g, Object.fromEntries(series.map(x => [x.obsId, x.datasetId])));
    const dsShares = Object.fromEntries(Object.entries(sums).map(([ds, v]) => [ds,
      { full: v.molecules ? v.full / v.molecules : null, densityMatched: g.densityMatched?.[ds] ?? null }]));
    st.addSavedNucGeometry({ label: g.id, kind: kindOf(g), chrom: geoChrom(g, res), start: g.start, end: g.end,
      openLeft: g.openLeft, openRight: g.openRight, color: geometryColor(g, i), shares: dsShares,
      params: { ...(res.params?.patch ?? {}), ...(res.params?.geometry ?? {}) }, tolBp: tol });
  };
  // A new analysis renumbers geometries: the focus follows the same geometries (stable ids) or is cleared, with its
  // read highlight.
  const prevRes = useRef<NucGeometryResult | null>(null);
  useEffect(() => {
    if (prevRes.current && prevRes.current !== res) refocusAfter(prevRes.current, res);
    prevRes.current = res;
  }, [res]);
  // Gone (collapsed, another tab, another view): its focus and the carriers it highlighted go too.
  useEffect(() => () => {
    if (!useNucGeoFocusStore.getState().focused.size) return;
    useNucGeoFocusStore.getState().clear();
    useReadActionsStore.getState().clearHighlight();
  }, []);

  /** A click: focus it (alt: add to the focus), or select it (shift / ctrl / cmd) for Cluster, Sort and Filter. */
  const click = (i: number, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey?: boolean }) => clickGeometry(run, res, i, e);
  const byId = new Map(G.map((g, i) => [g.id, i]));
  const counts = { high: G.filter(g => kindOf(g) === 'high').length, low: G.filter(g => kindOf(g) === 'low').length };
  // The map is drawn over the analysis window: geometries on another chromosome (observations on several) stay in the
  // list, never placed on this window's axis.
  const onWindow = (i: number) => !res.window || sameChrom(geoChrom(G[i], res), res.window.chrom);
  const lanes = order.filter(onWindow).map(i => {
    const g = G[i];
    const share = Math.max(0, ...series.map(s => g.perObservation[s.obsId]?.fullShare ?? 0));
    return { id: g.id, name: g.parent ? `${g.id} ⊂ ${g.parent}` : g.id, L: g.start, R: g.end, Lsd: g.startMad, Rsd: g.endMad,
      color: geometryColor(g, i), strength: share, nested: g.parentIndex != null, openLeft: g.openLeft, openRight: g.openRight,
      title: `${g.id} (${KIND_LABEL[kindOf(g)]})${g.parent ? `, part of ${g.parent}` : ''}: ${span(g)}, ${(g.width / 1000).toFixed(2)} kb; edges ±${fmt(g.startMad, 0)} / ±${fmt(g.endMad, 0)} bp` };
  });
  const pickedIds = new Set(order.filter(isFocused).map(i => G[i].id));

  return (
    <div className="space-y-1.5 text-[11px]" data-testid="nuc-geo-classes">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-gray-600 dark:text-gray-300">
        {setList && <AnalysisToggleGroup theme="emerald" label="Show" value={list} onChange={v => setList(v ?? 'all')}
          options={[{ value: 'all', label: 'All' }, { value: 'saved', label: `Saved${savedCount ? ` (${savedCount})` : ''}`, title: 'Saved geometries (the star), matched to this analysis by their edges' }]} />}
        {list === 'all' && kinds.includes('low') && <AnalysisToggleGroup theme="emerald" label="Kind" value={kindFilter} onChange={v => setKindFilter(v ?? 'all')}
          options={[{ value: 'all', label: 'Both' }, { value: 'high', label: 'High', title: 'High-regularity geometries (warm colours)' },
            { value: 'low', label: 'Low', title: 'Low-regularity geometries (cool colours)' }]} />}
        {list === 'all' && <span data-testid="nuc-geo-count" title={`${res.nMolecules.toLocaleString()} molecules · ${kinds.includes('low') && res.nPatchesByKind
          ? `${(res.nPatchesByKind.high ?? 0).toLocaleString()} high and ${(res.nPatchesByKind.low ?? 0).toLocaleString()} low patches` : `${res.nPatches.toLocaleString()} patches`}${res.cached ? ' (cached)' : ''}${took != null ? ` · ${took.toFixed(1)} s` : ''}`}>
          {G.length} geometr{G.length === 1 ? 'y' : 'ies'}{kinds.includes('low') ? ` · ${counts.high} high · ${counts.low} low` : ''}
          {G.some(g => g.parentIndex != null) ? ` · ${G.filter(g => g.parentIndex != null).length} folded` : ''}
          <span className="sr-only" data-testid="nuc-patch-status"> from {res.nMolecules.toLocaleString()} molecules{kinds.includes('low') && res.nPatchesByKind
            ? `, ${(res.nPatchesByKind.high ?? 0).toLocaleString()} high and ${(res.nPatchesByKind.low ?? 0).toLocaleString()} low patches`
            : `, ${res.nPatches.toLocaleString()} patches`}</span></span>}
        {loading && <span className="text-ink-muted" role="status">Updating…</span>}
      </div>
      {list === 'saved' ? savedView : <>
      <div ref={mapRef} className="w-full" data-testid="nuc-geo-map">
        {order.length ? <ChartBox filename="nucleosome_geometry_map"><ClassLanes lanes={lanes} width={Math.max(200, mapWidth)} region={res.window} highlight={hover ?? (hoveredIndex >= 0 ? G[hoveredIndex].id : null)} picked={pickedIds}
          onPick={(id, add) => { const i = byId.get(id); if (i != null) click(i, { shiftKey: add, ctrlKey: false, metaKey: false }); }} testId="nuc-geo-lanes" format={pos}
          tintClassName="fill-emerald-50/60 dark:fill-emerald-900/20"
          ariaLabel={`${order.length} shared geometries across the window`} /></ChartBox>
          : <p className="text-gray-500" data-testid="nuc-geo-empty">No geometry reaches the minimum share; lower it or widen the tolerance (Settings).</p>}
      </div>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-gray-600 dark:text-gray-300" data-testid="nuc-geo-legend">
        <span className="inline-flex flex-wrap items-center gap-x-2" data-testid="nuc-geo-series-legend">
          {series.map(s => <span key={s.obsId} className="inline-flex items-center gap-1 whitespace-nowrap"><span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: s.seriesColor }} />{s.label}</span>)}</span>
        <span className="text-ink-muted">·</span>
        <span className="whitespace-nowrap" title="Each series' line: the share of its molecules carrying the geometry in full, then the points carrying it partly (through a geometry folded into it), then the median patch score above random packing">
          <span className="mr-0.5 inline-block h-2 w-2 rounded-sm align-[-1px] bg-gray-500 opacity-95" />full % · <span className="mr-0.5 inline-block h-2 w-2 rounded-sm align-[-1px] bg-gray-500 opacity-45" />+ partly pp · score</span>
        <span className="whitespace-nowrap">‹ › open end</span>
      </p>
      <div ref={listRef} className={`${inspecting ? '' : 'max-h-80 overflow-auto'} rounded border border-gray-200 dark:border-gray-700`} data-testid="nuc-geo-table" data-layout={narrow ? 'narrow' : 'wide'}>
        {!order.length && <p className="px-2 py-1 text-gray-500">No shared geometry at these settings.</p>}
        {order.map(i => {
          const g = G[i];
          const color = geometryColor(g, i);
          const folded = g.parentIndex != null;
          const marked = isFocused(i);
          const picked = isSelected(i);
          const starred = savedIndex.has(i);
          const open = inspecting === g.id;
          const lines = (
            <span className={`flex min-w-0 flex-col ${narrow ? 'w-full pl-7' : 'min-w-[12.5rem] flex-1'}`} data-testid="nuc-geo-row-stats">
              {series.map(s => <SeriesLine key={s.obsId} g={g} s={s} color={color} faded={folded} />)}
            </span>
          );
          return (
            <div key={g.id}>
            <div data-testid="nuc-geo-row" data-geometry={g.id} data-kind={kindOf(g)} data-selected={marked || undefined}
              data-feature-selected={picked || undefined} data-hovered={hoveredIndex === i || undefined}
              onMouseEnter={() => { setHover(g.id); if (refs) useFeatureStore.getState().setHover(refs[i]); }}
              onMouseLeave={() => { setHover(null); useFeatureStore.getState().setHover(null); }}
              className={`flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-l-4 border-b-gray-100 px-2 py-0.5 last:border-b-0 dark:border-b-gray-800 ${marked ? 'border-l-emerald-600 bg-emerald-50 dark:border-l-emerald-400 dark:bg-emerald-950/40' : picked ? 'border-l-gray-800 dark:border-l-gray-200' : 'border-l-transparent'} ${hoveredIndex === i && !marked ? 'bg-gray-50 dark:bg-white/[0.04]' : ''}`}>
              <button type="button" onClick={() => setInspecting(open ? null : g.id)} aria-expanded={open} aria-label={`${open ? 'Close' : 'Inspect'} ${g.id}`}
                data-testid="nuc-geo-inspect" title="Inspect: span, edges, density-matched shares, member patches, nested pairs and read actions"
                className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800">
                <DisclosureChevron open={open} />
              </button>
              <button type="button" className={`flex w-[7.5rem] flex-shrink-0 items-center gap-1 whitespace-nowrap text-left ${folded ? 'pl-3' : ''}`} aria-pressed={marked}
                data-testid="nuc-geo-name" onClick={e => click(i, e)}
                title={`Highlight ${g.id}'s carriers in the reads and dim the other patches in the patch lane (Alt-click adds); Shift-click selects it for Cluster, Sort and Filter (main toolbar)${folded ? `; folded into ${g.parent}` : ''}`}>
                <span className="h-2.5 w-2.5 flex-shrink-0 rounded-sm" style={{ backgroundColor: color, opacity: folded ? 0.55 : 1 }} />
                <span className={`font-medium text-gray-800 dark:text-gray-100 ${picked ? 'underline decoration-2 underline-offset-2' : ''}`}>{g.id}</span>
                {g.parent && <span className="text-[10px] text-ink-muted" data-testid="nuc-geo-parent">part of {g.parent}</span>}
                {!g.parent && g.children.length > 0 && <span className="text-[10px] text-ink-muted">⊃ {g.children.join(', ')}</span>}
              </button>
              <button type="button" onClick={() => star(i)} aria-pressed={starred} data-testid="nuc-geo-star" data-starred={starred || undefined}
                aria-label={`${starred ? 'Remove' : 'Save'} ${g.id}`} title={starred ? `Saved: remove ${g.id} from the saved geometries` : `Save ${g.id} (kept with the session; matched to later analyses by its edges)`}
                className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-[13px] leading-none hover:bg-gray-100 dark:hover:bg-gray-800 ${starred ? 'text-amber-500' : 'text-gray-400'}`}>
                {starred ? '★' : '☆'}</button>
              <span className={`flex-shrink-0 rounded px-1 text-[10px] leading-4 ${kindOf(g) === 'low' ? 'bg-sky-50 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200' : 'bg-rose-50 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200'}`}
                data-testid="nuc-geo-kind" title={KIND_LABEL[kindOf(g)]}>{kindOf(g)}</span>
              <span className="w-[10.5rem] flex-shrink-0 truncate tabular-nums text-gray-600 dark:text-gray-300" title={`${span(g)} · ${g.width.toLocaleString()} bp`}>
                {span(g)} <span className="text-ink-muted">· {(g.width / 1000).toFixed(2)} kb</span></span>
              {narrow ? <span className="flex-1" /> : lines}
              <span className="w-[4.5rem] flex-shrink-0 text-right tabular-nums text-[10px] text-gray-500" data-testid="nuc-geo-spread"
                title="Edge spread: median distance of the member patches' edges from the consensus (start / end; open ends left out)">
                ±{g.openLeft ? '–' : fmt(g.startMad, 0)} / {g.openRight ? '–' : fmt(g.endMad, 0)}</span>
              {narrow && lines}
            </div>
            {open && <div className="border-b border-b-gray-100 px-1 py-1 dark:border-b-gray-800"><GeometryInspect res={res} index={i} series={series} pos={pos} span={span} width={Math.max(260, listWidth - 30)}
              onClose={() => setInspecting(null)} /></div>}
            </div>
          );
        })}
      </div>
      <HowItWorks summary="How to read this" testId="nuc-geo-how-to-read">
        <p>A <strong>geometry</strong> is a span many molecules share as one patch: every series is pooled, patches whose two ends both
        lie within the tolerance of the most common (start, end) form a geometry if enough molecules carry them, and its span is the
        median of its members’ ends. High- and low-regularity patches form their own geometries (G1, G2, … warm colours; L1, L2, … cool colours).</p>
        <p>Each series’ line shows the share of its molecules carrying the geometry in full (solid) and, lighter, the points that carry it
        partly: they carry a shorter geometry folded into it (nested, one end shared). The last number is the median patch score above
        random packing. The whiskers on the map are the edge spread; ‹ › mark ends cut by a read or the window.</p>
        <p>Click a geometry (on the map, its name or its chip above the reads) to highlight its carriers in the reads and dim the other
        patches in the patch lane; the arrow inspects it. Shift-click selects it for the main toolbar’s Cluster, Sort and Filter, and the
        Feature hub lists it with the other features, so its carriage can be tested against TF occupancy, NFR state and other features in
        the hub’s Assoc tab. The star saves it. Group reads by geometry puts each read in the geometry it carries.</p>
      </HowItWorks>
      </>}
    </div>
  );
}

function GeometryInspect({ res, index, series, pos, span, width, onClose }: {
  res: NucGeometryResult; index: number; series: RegSeries[]; pos: (v: number) => string; span: (g: NucGeometryRow) => string; width: number; onClose: () => void;
}) {
  const G = res.geometries;
  const g = G[index];
  const color = geometryColor(g, index);
  const family = [index, ...G.map((h, j) => (h.parentIndex === index ? j : -1)).filter(j => j >= 0)];
  const nested = res.nested.filter(z => z.child === g.id || z.parent === g.id);
  const datasets = Object.keys(g.densityMatched ?? {});
  const dsLabel = (id: string) => useBrowserStore.getState().datasets.find(d => d.id === id)?.label ?? id;
  return (
    <div className="min-w-0 space-y-1.5 rounded border border-emerald-200 bg-gray-50/70 px-2 py-1.5 dark:border-emerald-900 dark:bg-white/[0.03]"
      data-testid="nuc-geo-inspect-panel" data-geometry={g.id} role="region" aria-label={`Inspect ${g.id}`}
      onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="h-2.5 w-2.5 flex-shrink-0 rounded-sm" style={{ backgroundColor: color }} />
        <span className="font-medium text-gray-800 dark:text-gray-100">{g.id}</span>
        <span className="text-ink-muted">{KIND_LABEL[kindOf(g)]}{g.parent ? ` · part of ${g.parent}` : ''}</span>
        <AnalysisButton theme="emerald" variant="quiet" data-testid="nuc-geo-group-one" onClick={() => groupReadsByOne(res, series, index)}
          title={`Group each panel's reads: carries ${g.id}, carries it partly, the rest`}>Group reads by {g.id}</AnalysisButton>
        <AnalysisButton theme="emerald" variant="quiet" data-testid="nuc-geo-go" onClick={() => {
          const pad = Math.round(g.width * 0.25);
          const c = geoChrom(g, res);
          if (c) useBrowserStore.getState().setViewport(c, Math.max(0, g.start - pad), g.end + pad);
        }} title="Show this geometry's span in the read panels">Go to span</AnalysisButton>
        <button type="button" className="ml-auto rounded px-1 text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800" data-testid="nuc-geo-inspect-close"
          onClick={onClose} aria-label={`Close ${g.id}`}>Close</button>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] tabular-nums text-gray-700 dark:text-gray-200" data-testid="nuc-geo-inspect-facts">
        <span>{span(g)} · {g.width.toLocaleString()} bp</span>
        <span>{g.molecules.toLocaleString()} molecules · {g.patches.toLocaleString()} patches</span>
        <span title="Median distance of the member patches' edges from the consensus">edges ±{fmt(g.startMad, 0)} / ±{fmt(g.endMad, 0)} bp</span>
        <span>median score {fmt(g.score, 2)}{g.period > 0 ? ` · repeat ${g.period} bp` : ''}</span>
        {g.openLeft || g.openRight ? <span>open {[g.openLeft ? 'left' : '', g.openRight ? 'right' : ''].filter(Boolean).join(' and ')}</span> : null}
        {datasets.length > 0 && <span data-testid="nuc-geo-dm" title={datasets.length > 1
          ? 'Carriers among callable molecules (carrying, partly or absent), per dataset within pooled m6A/kb quintiles, weighted to the pooled distribution (fiberhmm-scan share_dm)'
          : 'Carriers among callable molecules (carrying, partly or absent); one dataset, so nothing to density match (fiberhmm-scan share_dm)'}>
          {datasets.length > 1 ? 'of callable, density matched' : 'of callable'}: {datasets.map(d => `${dsLabel(d)} ${pct(g.densityMatched[d], 1)}`).join(' · ')}</span>}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] tabular-nums text-gray-600 dark:text-gray-300">
        {series.map(s => { const o = g.perObservation[s.obsId]; return o ? <span key={s.obsId}><span style={{ color: s.seriesColor }}>●</span> {s.label}: {o.full} full · {o.partial} partly · {o.callable} callable of {o.molecules}</span> : null; })}
      </div>
      <StackView res={res} indices={family} pos={pos} width={width} />
      {nested.length > 0 && <NestedTable rows={nested} pos={pos} testId="nuc-geo-inspect-nested" />}
    </div>
  );
}

/** Member patches of geometries (a sample per geometry), stacked under each consensus span. */
export function StackView({ res, indices, pos, width }: { res: NucGeometryResult; indices: number[]; pos: (v: number) => string; width: number }) {
  const G = res.geometries;
  // Over the analysis window, or over the geometries' own span when they are on another chromosome.
  const own = indices.length && res.window && indices.every(gi => G[gi] && !sameChrom(geoChrom(G[gi], res), res.window!.chrom));
  const win = own ? { chrom: geoChrom(G[indices[0]], res), start: Math.min(...indices.map(gi => G[gi].start)), end: Math.max(...indices.map(gi => G[gi].end)) }
    : res.window!;
  const W = Math.max(260, width), L = 70, lane = 2.4, gap = 10;
  const blocks = indices.map(gi => ({ gi, s: res.stack[gi] })).filter(b => b.s);
  const H = 14 + blocks.reduce((a, b) => a + Math.max(1, b.s.patches.length) * lane + gap + 8, 0);
  const sx = (v: number) => L + (Math.max(win.start, Math.min(win.end, v)) - win.start) / Math.max(1, win.end - win.start) * (W - L - 6);
  let y = 14;
  const ticks = Array.from({ length: 5 }, (_, i) => win.start + (win.end - win.start) * i / 4);
  return <svg width={W} height={H} role="img" aria-label="Member patches" data-testid="nuc-geo-stack" className="text-gray-700 dark:text-gray-200">
    {ticks.map(t => <g key={t}><line x1={sx(t)} x2={sx(t)} y1={10} y2={H} stroke="currentColor" strokeOpacity={0.08} />
      <text x={sx(t)} y={8} fontSize={8} textAnchor="middle" fill="currentColor" opacity={0.6}>{pos(t)}</text></g>)}
    {blocks.map(({ gi, s }) => {
      const g = G[gi];
      const col = geometryColor(g, gi);
      const top = y;
      const h = Math.max(1, s.patches.length) * lane;
      y += h + gap + 8;
      return <g key={g.id}>
        <text x={2} y={top + 8} fontSize={9} fill="currentColor">{g.id}{g.parent ? ` ⊂ ${g.parent}` : ''}</text>
        <text x={2} y={top + 18} fontSize={8} fill="currentColor" opacity={0.6}>{s.n} patches</text>
        <rect x={sx(g.start)} y={top - 3} width={Math.max(1, sx(g.end) - sx(g.start))} height={2} fill={col} />
        <rect x={sx(g.start)} y={top} width={Math.max(1, sx(g.end) - sx(g.start))} height={h + 3} fill={col} fillOpacity={0.12} />
        {s.patches.map(([a, b], q) => <rect key={q} x={sx(a)} y={top + 1.5 + q * lane} width={Math.max(1, sx(b) - sx(a))} height={lane - 0.8} fill={col} />)}
      </g>;
    })}
  </svg>;
}

const sgn = (v: number | null | undefined, d = 2) => (v == null || !Number.isFinite(v) ? '–' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(d)}`);

/** Nested pairs: one array, partly covered (the Footprints compare table's look). */
export function NestedTable({ rows, pos, testId = 'nuc-geo-nested' }: { rows: NucNestedRow[]; pos: (v: number) => string; testId?: string }) {
  return <div className="max-h-72 overflow-auto rounded border border-gray-200 dark:border-gray-700">
    <table className="w-full border-collapse text-[11px] tabular-nums" data-testid={testId}>
      <thead className="sticky top-0 bg-gray-50 text-gray-500 dark:bg-gray-900 dark:text-gray-400">
        <tr>{['Short', 'inside', 'Shared end', 'Other end moves', 'Rest of the long span', 'score: short only', 'long carriers', 'no geometry', 'Folded']
          .map(h => <th key={h} className="px-1 py-0.5 text-left font-medium">{h}</th>)}</tr>
      </thead>
      <tbody>{!rows.length && <tr><td colSpan={9} className="px-1 py-0.5 text-gray-500">No nested geometries at these settings.</td></tr>}
        {rows.map(z => <tr key={`${z.child}-${z.parent}`} className="border-t border-gray-100 dark:border-gray-800" data-testid="nuc-geo-nested-row">
          <td className="px-1 py-0.5 font-medium">{z.child}</td><td className="px-1">{z.parent}</td><td className="px-1 text-gray-500">{z.shared}</td>
          <td className="px-1">{z.moved.toLocaleString()} bp{z.near ? '' : ' *'}</td>
          <td className="whitespace-nowrap px-1 text-gray-500">{pos(z.rest[0])} to {pos(z.rest[1])}</td>
          <td className="px-1">{sgn(z.shortOnly)}</td><td className="px-1">{sgn(z.longCarriers)}</td><td className="px-1">{sgn(z.noGeometry)}</td>
          <td className="px-1">{z.folded ? 'yes' : 'no'}</td></tr>)}</tbody>
    </table>
    <p className="px-1 py-0.5 text-[10px] text-ink-muted">Scores: median over molecules of the mean window score above random packing over the part of the long span the short geometry doesn’t cover. * the other end moves more than the near limit.</p>
  </div>;
}

