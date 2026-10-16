import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../../stores/browserStore';
import { useConsensusViewStore } from '../../../stores/consensusViewStore';
import { DEFAULT_COLORMAP, type LayerQualityFilter } from '../../../types';
import { getQualityImpact, type QualityImpactResponse } from '../../../api/quality';
import { sharedRequest, sharedResult } from '../../../api/sharedRequest';
import { useToolbarSummaryShown } from '../ToolbarGroups';
import { useViewReadsReady } from '../../../hooks/useViewReadsReady';
import { getLayerLabel } from '../../../utils/layerColors';
import { openLabelingPanel } from '../../../utils/openLabeling';
import { qualityLabel, stateScoreLayers, stateSupportCutoff, withStateSupportCutoff, STATE_SCORE } from './qualityControls';

const EDGE_MODES = [
  { mode: 'strict', label: 'Strict', title: 'Conservative boundaries: the span every edge estimate agrees on' },
  { mode: 'soft', label: 'Soft', title: 'A gradient between the conservative and liberal boundaries, by edge confidence' },
  { mode: 'loose', label: 'Loose', title: 'Liberal boundaries: extend each edge as far as it could reach' },
] as const;

/** Wait this long after the view last moved before counting (panning asks nothing). */
export const QUALITY_IMPACT_SETTLE_MS = 400;

function filterKey(f: { layer: string; qualityName?: string; quality_name?: string; minValue?: number; min_value?: number }) {
  return `${f.layer}:${f.qualityName ?? f.quality_name}:${f.minValue ?? f.min_value}`;
}

/**
 * Quality filters in view: what each removes, plus the scores the data carries.
 * `enabled: false` skips the request (it loads reads for the whole view).
 */
export function useQualityImpact({ enabled: wanted = true }: { enabled?: boolean } = {}): { impact: QualityImpactResponse | null; loading: boolean } {
  // Recount after a data refresh or a new footprint-class result at the same locus.
  const consensusRevision = useConsensusViewStore(s => `${s.jobId ?? ''}:${s.curation?.revision ?? 0}`);
  const { chrom, start, end, filters, datasetIds, maxRegionForReads, refreshGeneration } = useBrowserStore(useShallow(s => ({
    chrom: s.chrom, start: s.start, end: s.end, maxRegionForReads: s.maxRegionForReads, refreshGeneration: s.refreshGeneration,
    filters: s.activeColormap.qualityFilters ?? [],
    datasetIds: s.datasets.map(d => d.id).join(','),
  })));
  const [impact, setImpact] = useState<QualityImpactResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const enabled = useMemo(() => filters.filter(f => f.enabled && f.minValue > 0), [filters]);
  const revision = `${refreshGeneration}|${consensusRevision}`;
  const key = `quality-impact|${chrom}:${start}-${end}|${datasetIds}|${enabled.map(filterKey).join(',')}|${maxRegionForReads}|${revision}`;
  // The view's reads first: the count waits for them (and the server reuses them).
  const readsReady = useViewReadsReady();
  useEffect(() => {
    // Beyond "show reads up to", reads aren't loaded: don't count them either.
    if (!wanted || !chrom || !datasetIds || end - start > maxRegionForReads) { setImpact(null); setLoading(false); return; }
    // Counted already (this view, these filters and data): no request.
    const known = sharedResult<QualityImpactResponse>(key);
    if (known) { setImpact(known); setLoading(false); return; }
    setImpact(null); // never show counts for a different view or data
    setLoading(true);
    if (!readsReady) return;
    const controller = new AbortController();
    // Once the view has settled; a view left before then is never asked about, and
    // one left while counting aborts its request (the server stops counting).
    const timer = window.setTimeout(() => {
      sharedRequest(key, signal => getQualityImpact(chrom, start, end, enabled, datasetIds.split(','), signal, revision),
        controller.signal, { keep: result => Boolean(result?.success) })
        .then(result => { if (!controller.signal.aborted) setImpact(result); })
        .catch(() => { if (!controller.signal.aborted) setImpact(null); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, QUALITY_IMPACT_SETTLE_MS);
    return () => { controller.abort(); window.clearTimeout(timer); };
  // key captures chrom/start/end/datasets/filters/revision
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, wanted, readsReady]);
  return { impact, loading };
}

function percent(kept: number, total: number) {
  return total > 0 ? Math.round((100 * kept) / total) : 100;
}

/** Open Labeling > Quality, the full filter editor. */
export function openQualityEditor() {
  openLabelingPanel('quality');
}

/** Toolbar summary: "off", or how many filters are on and the largest cut. */
export function QualitySummary() {
  const filters = useBrowserStore(s => s.activeColormap.qualityFilters ?? []);
  const active = filters.filter(f => f.enabled && f.minValue > 0);
  // Count only while a filter is on and the summary is on screen (the group's
  // hover card or the More menu: not while it is folded away; the open
  // controls count for themselves).
  const shown = useToolbarSummaryShown();
  const { impact } = useQualityImpact({ enabled: active.length > 0 && shown });
  if (active.length === 0) return <span className="text-gray-500 dark:text-gray-400">off</span>;
  // Only the built-in FIRE accessibility cutoff: say so rather than "1 on".
  const isDefault = active.length === 1 && DEFAULT_COLORMAP.qualityFilters.some(d => filterKey(d) === filterKey(active[0]));
  const worst = (impact?.filters ?? [])
    .filter(f => f.total > 0)
    .map(f => ({ f, removed: 100 - percent(f.kept, f.total) }))
    .sort((a, b) => b.removed - a.removed)[0];
  return (
    <span className="flex items-center gap-1 whitespace-nowrap" data-testid="quality-summary">
      <span className="text-gray-600 dark:text-gray-300" title={isDefault ? 'The default FIRE accessibility cutoff (aq ≥ 230, about 0.9 precision)' : undefined}>
        {isDefault ? `FIRE default · ${qualityLabel(active[0].qualityName)} ≥ ${active[0].minValue}` : `${active.length} filter${active.length === 1 ? '' : 's'} on`}
      </span>
      {worst && worst.removed >= 10 && (
        <span className="rounded bg-amber-50 px-1 text-[11px] text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
          title={`${qualityLabel(worst.f.quality_name)} ≥ ${worst.f.min_value} keeps ${worst.f.kept.toLocaleString()} of ${worst.f.total.toLocaleString()} ${getLayerLabel(worst.f.layers[0] ?? worst.f.layer)} calls in view`}>
          −{worst.removed}% {getLayerLabel(worst.f.layers[0] ?? worst.f.layer)}
        </span>
      )}
    </span>
  );
}

function plainLayer(layer: string) {
  return layer === '*' ? 'All' : getLayerLabel(layer);
}

/**
 * Footprint-class support cutoff: one setting written to every class layer in
 * view (its rows also appear in the filter list below it). Shown in Labeling >
 * Quality, the one place quality filters are edited; nothing when the data in
 * view carries no class support score.
 */
export function ClassSupportCutoff() {
  const { filters, setQualityFilters } = useBrowserStore(useShallow(s => ({
    filters: s.activeColormap.qualityFilters ?? [],
    setQualityFilters: s.setQualityFilters,
  })));
  const { impact } = useQualityImpact();
  // Layers with class support in view, plus any already filtered (they may be out of view now).
  const stateLayers = [...new Set([...stateScoreLayers(impact?.available ?? {}),
    ...filters.filter(f => f.qualityName === STATE_SCORE).map(f => f.layer)])].sort();
  const cutoff = stateSupportCutoff(filters);
  const [draft, setDraft] = useState<number>(cutoff ?? 128);
  useEffect(() => { if (cutoff != null) setDraft(cutoff); }, [cutoff]);
  if (stateLayers.length === 0) return null;
  const stateImpact = impact?.filters.filter(i => i.quality_name === STATE_SCORE) ?? [];
  const stateTotal = stateImpact.reduce((n, i) => n + i.total, 0);
  const stateKept = stateImpact.reduce((n, i) => n + i.kept, 0);
  const setCutoff = (value: number | null) => setQualityFilters(withStateSupportCutoff(filters, stateLayers, value));
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px]" data-testid="class-support-cutoff"
      title="Footprint-class support (q0, 0-255) declared by the producer; calibration is in the BAM header">
      <label className="flex items-center gap-1 font-medium text-gray-700 dark:text-gray-200">
        <input type="checkbox" checked={cutoff != null} onChange={e => setCutoff(e.target.checked ? draft : null)} data-testid="state-support-toggle" />
        Footprint-class support ≥
      </label>
      <input
        type="range" min={5} max={250} step={5} value={cutoff ?? draft} disabled={cutoff == null}
        onChange={e => { const v = Number(e.target.value); setDraft(v); setCutoff(v); }}
        className="min-w-[5rem] flex-1" aria-label="Class support cutoff"
      />
      <span className="w-7 text-right tabular-nums text-gray-600 dark:text-gray-300">{cutoff ?? draft}</span>
      {cutoff != null && stateTotal > 0 && (
        <span className="basis-full text-[11px] text-gray-500">keeps {stateKept.toLocaleString()} of {stateTotal.toLocaleString()} class calls in view ({percent(stateKept, stateTotal)}%)</span>
      )}
    </div>
  );
}

/**
 * The toolbar's Quality group, open: what the filters in effect keep in view
 * (read-only), how footprint edges are drawn, and a link to Labeling > Quality,
 * the one place filters are edited.
 */
export function QualityQuickControls() {
  const { filters, edgeAmbiguity, setEdgeAmbiguity } = useBrowserStore(useShallow(s => ({
    filters: s.activeColormap.qualityFilters ?? [],
    edgeAmbiguity: s.activeColormap.edgeAmbiguity ?? DEFAULT_COLORMAP.edgeAmbiguity,
    setEdgeAmbiguity: s.setEdgeAmbiguity,
  })));
  const { impact } = useQualityImpact();
  const active = filters.filter(f => f.enabled && f.minValue > 0);
  const impactFor = (f: LayerQualityFilter) => impact?.filters.find(i => filterKey(i) === filterKey(f));
  const cutoff = stateSupportCutoff(filters);
  const stateImpact = impact?.filters.filter(i => i.quality_name === STATE_SCORE) ?? [];
  const stateTotal = stateImpact.reduce((n, i) => n + i.total, 0);
  const stateKept = stateImpact.reduce((n, i) => n + i.kept, 0);
  // One line per filter in effect; the class-support rows (one per class layer) read as one.
  const lines: Array<{ key: string; text: string; kept: number | null; title?: string }> = [];
  if (cutoff != null) {
    lines.push({ key: 'q0', text: `Footprint-class support ≥ ${cutoff}`, kept: stateTotal > 0 ? percent(stateKept, stateTotal) : null,
      title: stateTotal > 0 ? `keeps ${stateKept.toLocaleString()} of ${stateTotal.toLocaleString()} class calls in view` : undefined });
  }
  for (const f of active.filter(f => f.qualityName !== STATE_SCORE)) {
    const i = impactFor(f);
    lines.push({ key: filterKey(f), text: `${plainLayer(f.layer)} ${qualityLabel(f.qualityName)} ≥ ${f.minValue}`,
      kept: i && i.total > 0 ? percent(i.kept, i.total) : null,
      title: i && i.total > 0 ? `keeps ${i.kept.toLocaleString()} of ${i.total.toLocaleString()} ${plainLayer(f.layer)} calls in view` : undefined });
  }
  // The group's header already names a single filter: don't say it twice.
  const single = lines.length === 1 && active.length === 1;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]" data-testid="quality-controls-toolbar">
      {lines.length === 0 ? (
        <span className="text-gray-500 dark:text-gray-400">No quality filters: every call is drawn and counted.</span>
      ) : (
        lines.map(line => (
          <span key={line.key} className="whitespace-nowrap text-gray-600 dark:text-gray-300" title={line.title} data-testid="quality-filter-line">
            {!single && <>{line.text} · </>}
            {line.kept != null
              ? <span className={`tabular-nums ${line.kept < 50 ? 'text-amber-700 dark:text-amber-300' : ''}`}>keeps {line.kept}% of calls in view</span>
              : <span className="text-gray-400">counting…</span>}
          </span>
        ))
      )}

      <div className="flex items-center gap-1" role="group" aria-label="Footprint edges">
        <span className="mr-0.5 text-gray-500 dark:text-gray-400" title="How footprint edges are drawn where the data are unsure of the boundary">Edges</span>
        {EDGE_MODES.map(m => (
          <button
            key={m.mode}
            type="button"
            title={m.title}
            aria-pressed={edgeAmbiguity.mode === m.mode}
            onClick={() => setEdgeAmbiguity({ mode: m.mode })}
            className={`rounded border px-1.5 py-0.5 ${edgeAmbiguity.mode === m.mode
              ? 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200'
              : 'border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/10'}`}
          >
            {m.label}
          </button>
        ))}
      </div>

      <button type="button" onClick={openQualityEditor} data-testid="quality-edit-link"
        title="Quality filters are set in one place: Labeling > Quality"
        className="whitespace-nowrap text-[11px] text-blue-600 hover:underline dark:text-blue-300">
        Edit filters…
      </button>
    </div>
  );
}
