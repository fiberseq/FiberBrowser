import { QcFailReadToggle } from '../sidebar/view/FootprintReadFilters';
import { useEffect, useMemo, useRef, useState } from 'react';
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
import {
  qualityLabel, stateScoreLayers, stateSupportCutoff, withStateSupportCutoff, STATE_SCORE,
  FIRE_FDR_PRESETS, FIRE_LAYER, FIRE_SCORE, fireAqForFdr, fireFdrLabel, fireFilterState, isFireFilter, withFireFilter,
} from './qualityControls';

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

/** Toolbar summary: the FIRE filter (off, or its threshold and FDR), other filters on, and the largest cut. */
export function QualitySummary() {
  const filters = useBrowserStore(s => s.activeColormap.qualityFilters ?? []);
  const active = filters.filter(f => f.enabled && f.minValue > 0);
  // Count only while a filter is on and the summary is on screen (the group's
  // hover card or the More menu: not while it is folded away; the open
  // controls count for themselves).
  const shown = useToolbarSummaryShown();
  const { impact } = useQualityImpact({ enabled: active.length > 0 && shown });
  // Every FIRE row reads as one filter (Labeling can add several).
  const fireState = fireFilterState(filters);
  const fire = fireState.on ? { layer: FIRE_LAYER, qualityName: FIRE_SCORE, minValue: fireState.minValue!, enabled: true } : null;
  const others = active.filter(f => !isFireFilter(f));
  // The built-in FIRE accessibility cutoff: say so rather than its number alone.
  const isDefault = fire != null && DEFAULT_COLORMAP.qualityFilters.some(d => filterKey(d) === filterKey(fire));
  const fireText = fire == null
    ? 'FIRE off'
    : `${isDefault ? 'FIRE default' : 'FIRE'} · aq ≥ ${fire.minValue} · FDR ${fireFdrLabel(fire.minValue)}`;
  const fireTitle = fire == null
    ? 'The FIRE accessibility filter is off: every MSP is drawn and counted'
    : `FIRE MSPs with aq ≥ ${fire.minValue} (precision ${(fire.minValue / 255).toFixed(2)}, FDR ${fireFdrLabel(fire.minValue)})`;
  const worst = (impact?.filters ?? [])
    .filter(f => f.total > 0)
    .map(f => ({ f, removed: 100 - percent(f.kept, f.total) }))
    .sort((a, b) => b.removed - a.removed)[0];
  return (
    <span className="flex items-center gap-1 whitespace-nowrap" data-testid="quality-summary">
      <span className={fire ? 'text-gray-600 dark:text-gray-300' : 'text-gray-500 dark:text-gray-400'} title={fireTitle} data-testid="quality-summary-fire">
        {fireText}
      </span>
      {others.length > 0 && (
        <span className="text-gray-600 dark:text-gray-300">+{others.length} filter{others.length === 1 ? '' : 's'}</span>
      )}
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
 * Quality, where quality filters are fully edited; nothing when the data in
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

const NO_FILTERS: LayerQualityFilter[] = [];

/** Wait this long after the FIRE slider last moved before applying it (each change reloads reads). */
export const FIRE_SLIDER_COMMIT_MS = 300;

const SLIDER_MIN = 128;
const SLIDER_MAX = 254;

/**
 * The FIRE accessibility filter, in the toolbar: on/off (the row is kept when
 * off, so it comes back at the same threshold), the aq threshold with its FDR,
 * and what it keeps in view. A missing row is re-added at the default.
 */
export function FireFilterControl({ impact }: { impact: QualityImpactResponse | null }) {
  const { filters, hasFireData, setQualityFilters } = useBrowserStore(useShallow(s => ({
    filters: s.activeColormap.qualityFilters ?? NO_FILTERS,
    hasFireData: s.datasets.some(d => Boolean(d.available_layers?.fire)),
    setQualityFilters: s.setQualityFilters,
  })));
  const fallback = DEFAULT_COLORMAP.qualityFilters.find(f => f.layer === FIRE_LAYER && f.qualityName === FIRE_SCORE)!;
  // All FIRE rows are one control: on when any is on, at the cutoff in effect.
  const state = fireFilterState(filters);
  const on = state.on;
  const value = state.minValue ?? fallback.minValue;
  // A slider move not yet applied (null: none). It is shown only while pending,
  // and dropped whenever the filters change by any other way (a session, Labeling,
  // the toggle), so what is shown is always what filters.
  const [draft, setDraft] = useState<number | null>(null);
  const timer = useRef<number | null>(null);
  const cancelPending = () => {
    if (timer.current != null) { window.clearTimeout(timer.current); timer.current = null; }
    setDraft(null);
  };
  useEffect(() => { cancelPending(); }, [filters]);
  useEffect(() => () => { if (timer.current != null) window.clearTimeout(timer.current); }, []);

  const write = (next: { minValue: number; enabled: boolean }) => {
    const current = useBrowserStore.getState().activeColormap.qualityFilters ?? [];
    setQualityFilters(withFireFilter(current, next));
  };
  const commit = (v: number) => {
    const pending = timer.current != null;
    if (timer.current != null) { window.clearTimeout(timer.current); timer.current = null; }
    const current = fireFilterState(useBrowserStore.getState().activeColormap.qualityFilters ?? []);
    const single = (useBrowserStore.getState().activeColormap.qualityFilters ?? []).filter(isFireFilter).length === 1;
    if (!pending && current.on && current.minValue === v && single) return;
    write({ minValue: v, enabled: true });
  };
  const schedule = (v: number) => {
    setDraft(v);
    if (timer.current != null) window.clearTimeout(timer.current);
    // The filters this move started from: if they change before it applies, it is dropped.
    const from = useBrowserStore.getState().activeColormap.qualityFilters;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      if (useBrowserStore.getState().activeColormap.qualityFilters !== from) { setDraft(null); return; }
      write({ minValue: v, enabled: true });
    }, FIRE_SLIDER_COMMIT_MS);
  };
  const release = (v: number) => { if (timer.current != null) commit(v); };
  // On/off discards a slider move not yet applied: it switches the threshold in effect.
  const toggle = (next: boolean) => {
    cancelPending();
    if (!state.present) { if (next) write({ minValue: fallback.minValue, enabled: true }); return; }
    write({ minValue: value, enabled: next });
  };

  const effective = { layer: FIRE_LAYER, qualityName: FIRE_SCORE, minValue: value };
  const i = on ? impact?.filters.find(x => filterKey(x) === filterKey(effective)) : undefined;
  const kept = i && i.total > 0 ? percent(i.kept, i.total) : null;
  const shown = on && draft != null ? draft : value;
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="fire-filter-control">
      <label className="flex items-center gap-1 font-medium text-gray-700 dark:text-gray-200"
        title="Hide FIRE MSPs below the score cutoff (aq = 255 × FIRE precision). Off keeps the threshold for when it is turned back on.">
        <input type="checkbox" className="rounded" checked={on} onChange={e => toggle(e.target.checked)} data-testid="fire-filter-toggle" />
        FIRE
      </label>
      <span className={on ? 'text-gray-500 dark:text-gray-400' : 'text-gray-400 dark:text-gray-500'}>aq ≥</span>
      <input
        type="range" min={Math.min(SLIDER_MIN, shown)} max={Math.max(SLIDER_MAX, shown)} step={1} value={shown} disabled={!on}
        onChange={e => schedule(Number(e.target.value))}
        onPointerUp={e => release(Number((e.target as HTMLInputElement).value))}
        onKeyUp={e => release(Number((e.target as HTMLInputElement).value))}
        className="w-16 min-[1440px]:w-20" aria-label="FIRE score cutoff (aq)" data-testid="fire-filter-slider"
      />
      <span className={`tabular-nums ${on ? 'text-gray-700 dark:text-gray-200' : 'text-gray-400 dark:text-gray-500'}`} data-testid="fire-filter-value"
        title={`precision ${(shown / 255).toFixed(3)}`}>
        {shown} <span className="text-gray-500 dark:text-gray-400">(FDR {fireFdrLabel(shown)})</span>
      </span>
      {/* Narrow windows (below 1440 px): no presets and shorter words, so the open group stays one
          line and the reads keep their height budget (a taller toolbar folds other open groups). */}
      <span className="hidden items-center gap-0.5 min-[1440px]:flex" role="group" aria-label="FIRE FDR presets">
        {FIRE_FDR_PRESETS.map(fdr => {
          const aq = fireAqForFdr(fdr);
          const current = on && shown === aq;
          return (
            <button key={fdr} type="button" disabled={!on} aria-pressed={current} onClick={() => commit(aq)}
              title={`FDR ${Math.round(fdr * 100)}%: aq ≥ ${aq}`} data-testid={`fire-fdr-preset-${Math.round(fdr * 100)}`}
              className={`rounded border px-1 py-0 tabular-nums disabled:opacity-50 ${current
                ? 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200'
                : 'border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/10'}`}>
              {Math.round(fdr * 100)}%
            </button>
          );
        })}
      </span>
      {!hasFireData ? (
        <span className="whitespace-nowrap italic text-gray-400 dark:text-gray-500" title="No loaded dataset has FIRE scores" data-testid="fire-filter-nodata">no FIRE scores<span className="hidden min-[1440px]:inline"> in loaded data</span></span>
      ) : on && (
        kept != null
          ? <span className={`whitespace-nowrap tabular-nums text-gray-600 dark:text-gray-300 ${kept < 50 ? 'text-amber-700 dark:text-amber-300' : ''}`}
              title={`keeps ${i!.kept.toLocaleString()} of ${i!.total.toLocaleString()} FIRE calls in view`} data-testid="fire-filter-kept">
              keeps {kept}%<span className="hidden min-[1440px]:inline"> of calls in view</span>
            </span>
          : i && i.total === 0
            ? null
            : <span className="text-gray-400">counting…</span>
      )}
    </div>
  );
}

/**
 * The toolbar's Quality group, open: the FIRE filter (on/off, threshold), an
 * on/off box for every other filter with what it keeps in view, how footprint
 * edges are drawn, and a link to Labeling > Quality, where filters are added
 * and fully edited.
 */
export function QualityQuickControls() {
  const { filters, edgeAmbiguity, setEdgeAmbiguity, setQualityFilters } = useBrowserStore(useShallow(s => ({
    filters: s.activeColormap.qualityFilters ?? [],
    edgeAmbiguity: s.activeColormap.edgeAmbiguity ?? DEFAULT_COLORMAP.edgeAmbiguity,
    setEdgeAmbiguity: s.setEdgeAmbiguity,
    setQualityFilters: s.setQualityFilters,
  })));
  const { impact } = useQualityImpact();
  const impactFor = (f: LayerQualityFilter) => impact?.filters.find(i => filterKey(i) === filterKey(f));
  // Every other filter with a cutoff, on or off (an unticked one stays listed, to tick again).
  const stateRows = filters.filter(f => f.qualityName === STATE_SCORE && f.minValue > 0);
  const stateOn = stateRows.some(f => f.enabled);
  const cutoff = stateSupportCutoff(filters) ?? (stateRows.length ? Math.min(...stateRows.map(f => f.minValue)) : null);
  const stateImpact = impact?.filters.filter(i => i.quality_name === STATE_SCORE) ?? [];
  const stateTotal = stateImpact.reduce((n, i) => n + i.total, 0);
  const stateKept = stateImpact.reduce((n, i) => n + i.kept, 0);
  const setEnabled = (match: (f: LayerQualityFilter, index: number) => boolean, enabled: boolean) =>
    setQualityFilters(filters.map((f, index) => (match(f, index) ? { ...f, enabled } : f)));
  // One line per other filter; the class-support rows (one per class layer) read as one.
  const lines: Array<{ key: string; text: string; on: boolean; kept: number | null; title?: string; toggle: (on: boolean) => void }> = [];
  if (cutoff != null) {
    lines.push({ key: 'q0', text: `Footprint-class support ≥ ${cutoff}`, on: stateOn,
      kept: stateOn && stateTotal > 0 ? percent(stateKept, stateTotal) : null,
      title: stateOn && stateTotal > 0 ? `keeps ${stateKept.toLocaleString()} of ${stateTotal.toLocaleString()} class calls in view` : undefined,
      toggle: on => setEnabled(f => f.qualityName === STATE_SCORE, on) });
  }
  filters.forEach((f, index) => {
    if (isFireFilter(f) || f.qualityName === STATE_SCORE || !(f.minValue > 0)) return;
    const i = f.enabled ? impactFor(f) : undefined;
    lines.push({ key: `${index}:${filterKey(f)}`, text: `${plainLayer(f.layer)} ${qualityLabel(f.qualityName)} ≥ ${f.minValue}`, on: f.enabled,
      kept: i && i.total > 0 ? percent(i.kept, i.total) : null,
      title: i && i.total > 0 ? `keeps ${i.kept.toLocaleString()} of ${i.total.toLocaleString()} ${plainLayer(f.layer)} calls in view` : undefined,
      toggle: on => setEnabled((_, j) => j === index, on) });
  });

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]" data-testid="quality-controls-toolbar">
      <QcFailReadToggle />
      <FireFilterControl impact={impact} />
      {lines.map(line => (
        <label key={line.key} className={`flex items-center gap-1 whitespace-nowrap ${line.on ? 'text-gray-600 dark:text-gray-300' : 'text-gray-400 dark:text-gray-500'}`}
          title={line.title} data-testid="quality-filter-line">
          <input type="checkbox" className="rounded" checked={line.on} onChange={e => line.toggle(e.target.checked)} data-testid="quality-filter-enable" />
          <span>{line.text}</span>
          {line.on && (line.kept != null
            ? <span className={`tabular-nums ${line.kept < 50 ? 'text-amber-700 dark:text-amber-300' : ''}`}>· keeps {line.kept}%<span className="hidden min-[1440px]:inline"> of calls in view</span></span>
            : <span className="text-gray-400">· counting…</span>)}
        </label>
      ))}

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
        title="Add and fully edit quality filters in Labeling > Quality"
        className="whitespace-nowrap text-[11px] text-blue-600 hover:underline dark:text-blue-300">
        Edit filters…
      </button>
    </div>
  );
}
