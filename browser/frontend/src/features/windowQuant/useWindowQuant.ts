/**
 * Quantify a window, live: the spec and window from the store, the view and groups as the Plots "current view" reads
 * them (usePlotTargets), the measures from the registry, each source's per-read units loaded once per request key
 * (spec changes that don't change the reads, such as enrichment or the comparison, only recompute), then the engine.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useBrowserStore } from '../../stores/browserStore';
import { getClusterLabel } from '../../components/tracks/ReadTrack';
import { usePlotTargets } from '../plots/usePlotTargets';
import type { EnrichmentBaseline } from '../../utils/plotSetYScale';
import { baselineFor, buildGroups, cellReads, computeQuant, type QuantGroupDef, type QuantResult } from './engine';
import { hubProviders, onHubProvidersChanged } from '../hub/hubState';
import { listMeasures, measureSources, onMeasureSourcesChanged, unitParts, type MeasureContext, type MeasureData, type MeasureDef } from './measures';
import { activeLayerMeasureIds, layerMeasureId } from './sources';
import { defaultMetaprofileTogglesKey } from '../../utils/defaultMetaprofile';
import { useAxisAnchor } from './AxisControls';
import { onProfileReadPool, profileReadPoolVersion } from '../../utils/profileReadPool';
import { effectiveBounds, isMetaChrom, type QuantSpec, type QuantWindow } from './spec';

export interface WindowQuantState {
  ctx: MeasureContext | null;
  /** The registry's measures, grouped by source. */
  catalog: Array<{ source: string; label: string; measures: MeasureDef[] }>;
  /** The measures quantified (picked, or the active layers), available ones only. */
  measures: MeasureDef[];
  groups: QuantGroupDef[];
  bounds: ReturnType<typeof effectiveBounds> | null;
  result: QuantResult | null;
  sampled: Record<string, { used: number }>;
  loading: boolean;
  error: string | null;
  /** Why nothing can be computed (no groups, no measure). */
  blocker: string | null;
  requestKey: string;
  /** Live-lifted datasets in scope, left out (usePlotTargets): the card says so. */
  liftedLeftOut: string[];
  readSource: 'panel' | 'fetch' | null;
  binBp: number | null;
  /** The spec as computed (clusters fall back to datasets where nothing is clustered). */
  spec: QuantSpec;
  /** The axis anchor (relative windows and labels), when one resolves here. */
  anchor: import('./axisFrame').ResolvedAnchor | null;
  frame: import('./axisFrame').AxisFrame;
  /** The reads behind a cell (per dataset): members for a share, the reads covering the bounds otherwise. */
  readsFor: (measure: string, group: string) => Record<string, string[]>;
}

const LOADS = new Map<string, Record<string, MeasureData>>();
const NO_EXTRAS: Record<string, unknown> = {};

export function useWindowQuant(o0: { enabled: boolean; spec: QuantSpec; window: QuantWindow | null; extras?: Record<string, unknown>;
  /** The layers the plots above show (the cluster Profiles tab's channels); absent: the default metaprofile's. */
  activeLayers?: string[] }): WindowQuantState {
  const targets = usePlotTargets();
  // Clusters asked for where nothing is clustered: compare the datasets instead (the header says "per dataset").
  const clusterless = !targets.clusters && (o0.spec.comparison === 'clusters' || o0.spec.comparison === 'clusters-datasets');
  const effSpec = useMemo(() => (clusterless ? { ...o0.spec, comparison: 'datasets' as const } : o0.spec), [o0.spec, clusterless]);
  const o = { ...o0, spec: effSpec };
  const { enabled, spec, window } = o;
  const assignments = useBrowserStore(s => s.clusterAssignments);
  const yBaseline = useBrowserStore(s => (s as unknown as { clusterViewSettings?: { yScale?: { baseline?: EnrichmentBaseline } } }).clusterViewSettings?.yScale?.baseline ?? 'region');
  const hubTick = useBrowserStore(s => s.featureHub);
  // The panels' profile pools (the curves' reads): a new pool for this view reloads the layers.
  const [poolTick, setPoolTick] = useState(profileReadPoolVersion());
  useEffect(() => onProfileReadPool(() => setPoolTick(profileReadPoolVersion())), []);
  // "Active layers" follows the layer switches live (the default metaprofile's toggles), or the plots' own channels.
  const togglesKey = useBrowserStore(s => defaultMetaprofileTogglesKey(s));
  const activeKey = o.activeLayers ? o.activeLayers.join(',') : `default:${togglesKey}`;
  // The hub's sets come from stores of their own (a Find classes run, NFR runs): re-list when any provider changes.
  const [providerTick, setProviderTick] = useState(0);
  useEffect(() => {
    const bump = () => setProviderTick(t => t + 1);
    let subs: Array<() => void> = [];
    const attach = () => { subs.forEach(u => u()); subs = hubProviders().map(p => p.subscribe?.(bump) ?? (() => {})); };
    attach();
    const off = onHubProvidersChanged(() => { attach(); bump(); });
    const offSources = onMeasureSourcesChanged(bump);
    return () => { subs.forEach(u => u()); off(); offSources(); };
  }, []);
  const extras = o.extras ?? NO_EXTRAS;

  const view = targets.allReads;
  const { anchor, frame } = useAxisAnchor(view.end > view.start ? view : null);
  const bounds = useMemo(() => (view.end > view.start ? effectiveBounds(spec, window, view, anchor) : null), [spec.bounds, window, view.chrom, view.start, view.end, anchor]);   // eslint-disable-line react-hooks/exhaustive-deps

  const ctx = useMemo<MeasureContext | null>(() => (bounds ? {
    state: useBrowserStore.getState(), view: { chrom: view.chrom, start: view.start, end: view.end, genome: view.genome }, bounds: { from: bounds.from, to: bounds.to },
    allReads: targets.allReads, clusters: targets.clusters, extras,
  } : null), [bounds, targets.allReads, targets.clusters, extras, hubTick, providerTick, assignments, activeKey]);   // eslint-disable-line react-hooks/exhaustive-deps

  const catalog = useMemo(() => (ctx ? listMeasures(ctx).map(({ source, measures }) => ({ source: source.id, label: source.label, measures })) : []), [ctx]);
  const measures = useMemo(() => {
    if (!ctx) return [];
    const ids = spec.measures.length ? spec.measures
      : o.activeLayers ? o.activeLayers.map(k => layerMeasureId(k === 'footprint' ? 'nuc' : k === 'mod' ? 'm6a' : k))
        .filter(id => catalog.some(c => c.measures.some(m => m.id === id))) : activeLayerMeasureIds(ctx);
    const all = new Map(catalog.flatMap(c => c.measures).map(m => [m.id, m]));
    return ids.map(id => all.get(id)).filter((m): m is MeasureDef => !!m && m.available === true);
  }, [ctx, catalog, spec.measures, activeKey]);   // eslint-disable-line react-hooks/exhaustive-deps

  const groups = useMemo(() => buildGroups(spec.comparison, {
    panels: targets.allReads.panels, clusterPanels: targets.clusters?.panels ?? [], visible: targets.clusters?.visible ?? [],
    clusterLabel: c => getClusterLabel(c, true),
  }), [spec.comparison, targets.allReads, targets.clusters]);

  const blocker = !bounds ? 'No view to quantify.'
    : spec.comparison === 'pools' && !isMetaChrom(view.chrom) ? 'Meta-locus pools: open a meta-locus (a BED file pooled into one locus) first.'
      : spec.bounds === 'sites' && !isMetaChrom(view.chrom) ? 'Sites: open a meta-locus (a BED file pooled into one locus); each read–site pair is then one observation.'
        : !groups.length ? (spec.comparison === 'datasets' || spec.comparison === 'pools' ? 'No dataset panel shows this view.' : 'No clusters here: cluster the reads, or compare datasets.')
          : !measures.length ? 'Pick a measure (none of the picked ones is available here).' : null;

  // Curve-unit layers keep every bin of the view only when the flank or dataset baseline needs them.
  const viewBins = spec.value === 'enrichment' && ['flank', 'dataset'].includes(baselineFor({ kind: 'fraction', windowed: true }, spec, yBaseline));
  const usedSources = new Set(catalog.filter(c => c.measures.some(x => measures.includes(x))).map(c => c.source));
  const sigs = ctx ? measureSources().filter(s => usedSources.has(s.id)).map(s => s.signature?.(ctx) ?? '').join('|') : '';
  const loadKey = JSON.stringify({ v: [view.genome, view.chrom, view.start, view.end], b: bounds ? [bounds.from, bounds.to] : null, m: measures.map(m => m.id),
    p: view.panels.map(p => `${p.key}:${p.datasetId}`), cap: spec.readCap, seed: spec.seed, ff: spec.flankFraction, band: measures.some(m => m.id === 'size:band') ? [spec.sizeFrom, spec.sizeTo] : null, lu: spec.layerUnits, rs: spec.readSource, vb: viewBins, pool: poolTick, sigs });
  const [loaded, setLoaded] = useState<{ key: string; data: Record<string, MeasureData> | null; error: string | null }>({ key: '', data: null, error: null });

  useEffect(() => {
    if (!enabled || blocker || !ctx) return;
    const hit = LOADS.get(loadKey);
    if (hit) { setLoaded({ key: loadKey, data: hit, error: null }); return; }
    const ac = new AbortController();
    const t = setTimeout(async () => {
      try {
        const bySource = new Map<string, MeasureDef[]>();
        const srcOf = new Map(catalog.flatMap(c => c.measures.map(x => [x.id, c.source] as const)));
        for (const m of measures) {
          const src = srcOf.get(m.id);
          if (src) bySource.set(src, [...(bySource.get(src) ?? []), m]);
        }
        const parts = await Promise.all([...bySource].map(([id, ms]) => measureSources().find(s => s.id === id)!.load(ms, {
          ...ctx, readCap: spec.readCap, seed: spec.seed, flankFraction: spec.flankFraction, sizeBand: [spec.sizeFrom, spec.sizeTo], layerUnits: spec.layerUnits, readSource: spec.readSource, viewBins, signal: ac.signal })));
        if (ac.signal.aborted) return;
        const data = Object.assign({}, ...parts) as Record<string, MeasureData>;
        LOADS.set(loadKey, data);
        if (LOADS.size > 12) LOADS.delete(LOADS.keys().next().value as string);
        setLoaded({ key: loadKey, data, error: null });
      } catch (e) {
        if (!ac.signal.aborted) setLoaded({ key: loadKey, data: null, error: e instanceof Error ? e.message : String(e) });
      }
    }, 120);
    return () => { clearTimeout(t); ac.abort(); };
  }, [enabled, loadKey, blocker]);   // eslint-disable-line react-hooks/exhaustive-deps

  const weights = useRef(new Map<string, Uint8Array>());
  const data = loaded.key === loadKey ? loaded.data : null;
  const result = useMemo(() => {
    if (!data || !bounds || blocker) return null;
    if (weights.current.size > 200_000) weights.current = new Map();
    return computeQuant({ spec, measures: measures.map(def => ({ def, data: data[def.id] ?? {} })), groups, assignments: assignments as Record<string, Record<string, number>>,
      boundsBp: bounds.to - bounds.from, seed: spec.bootSeed ?? spec.seed, yScaleBaseline: yBaseline, weights: weights.current });
  }, [data, spec, measures, groups, assignments, bounds, blocker, yBaseline]);

  const readSource = useMemo(() => { const v = Object.values(data ?? {}); return v.some(d => d.readSource === 'panel') ? 'panel' as const : v.some(d => d.readSource === 'fetch') ? 'fetch' as const : null; }, [data]);
  const binBp = useMemo(() => Object.values(data ?? {}).find(d => d.binned)?.binned?.binBp ?? null, [data]);
  const sampled = useMemo(() => {
    const out: Record<string, { used: number }> = {};
    for (const d of Object.values(data ?? {})) for (const [ds, s] of Object.entries(d.sampled ?? {})) out[ds] = { used: Math.max(out[ds]?.used ?? 0, s.used) };
    return out;
  }, [data]);

  const readsFor = (measure: string, group: string): Record<string, string[]> => {
    const g = groups.find(x => x.id === group);
    const m = measures.find(x => x.id === measure);
    return g && m ? cellReads(data?.[measure], m.kind, g, assignments as Record<string, Record<string, number>>) : {};
  };

  return { readsFor, anchor, frame, spec, readSource, binBp, ctx, catalog, measures, groups, bounds, result, sampled, loading: enabled && !blocker && loaded.key !== loadKey, error: loaded.key === loadKey ? loaded.error : null,
    blocker, requestKey: loadKey, liftedLeftOut: targets.liftedLeftOut };
}
