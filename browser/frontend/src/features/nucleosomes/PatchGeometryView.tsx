/**
 * The Regularity view's discrete calls: regular patches on each molecule (FiberHMM fiberhmm.nuc.patches on the nucreg
 * tiles), of two kinds: high-regularity patches (above the random-packing reference) and low-regularity patches (the
 * mirror hysteresis below it), and the shared geometries of each kind across the pooled datasets
 * (fiberhmm.nuc.geometries; pool → find → compare), every parameter adjustable.
 *
 * Laid out as the Footprints and NFR panels lay out their classes: cards with a title and their actions, the class
 * list (GeometryClasses: lanes, rows with per-series tier bars, inspect, click to highlight), compare tables in the
 * Footprints compare-table look, and the association with an open region or a TF site (density matched; FiberHMM's
 * co-occurrence test).
 *
 * Laid out by the panel's tabs: the Geometries tab leads with a per-series summary (score above random, share in
 * patches) and the class card; the Charts tab holds every chart and detail table; the Site tab the association. Every
 * parameter sits in the one settings drawer. Nothing is computed while patch calling is off (on by default); the read
 * lane's Patches layer is switched on so each read shows its patches in its geometry's colour.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useBrowserStore } from '../../stores/browserStore';
import { NUC_PATCH_COLOR, NUC_PATCH_LOW_COLOR } from '../../utils/nucLayers';
import { downloadTextFile, exportTimestamp } from '../../utils/analysisExport';
import { AnalysisButton, AnalysisCard, AnalysisExportGroup } from '../../components/controls/shared/AnalysisControls';
import { AnalysisStatus } from '../../components/controls/shared/AnalysisStatus';
import { DisclosureChevron } from '../../components/ui/Disclosure';
import { geometryRequestBody, isSupersededNuc, nucGeometries } from './api';
import { holdNucRefresh, isLiveJob, resyncAfterSuperseded, useNucJob } from './nucJob';
import { seriesIdentity } from './regParams';
import { keepsGeometriesOutOfView, releaseGeoRun, useNucGeoRuns, type NucGeoRun } from './geoRuns';
import { dropGeoSelection, geoChrom, reconcileGeoSelection } from './geoHub';
import { sameChrom } from '../../utils/chromAliases';
import { SavedGeometries } from './SavedGeometryCard';
import { MetricTitle } from './PanelPrimitives';
import { ChartBox, fmt } from './charts';
import { LineChart, referenceSourceText, referenceSourceTitle, type RegSeries } from './RegularityView';
import { GeometryClasses, NestedTable, StackView, geometriesTsv, geometryColor, geometryOrder, groupReadsByGeometry, kindOf } from './GeometryClasses';
import type { NucCohort, NucRegTab, NucRegularityObservation, NucGeometryResult, NucGeometryRow, NucLowPatchParams, NucPanelState, NucPatchKind, NucPatchParams, NucPatchSettings, NucRegularityParams } from './types';

/** FiberHMM's defaults (provisional; the owner chooses after testing). */
export const DEFAULT_PATCH_PARAMS: Required<Omit<NucPatchParams, 'max_geometries' | 'merged_bp' | 'core_bp' | 'low'>> = {
  enter: 2.0, extend: 1.25, min_tiles: 2,
  edges: 'snap', snap_rule: 'open', open_bp: 300, search_bp: 1000, nuc_min_bp: 90, tol_frac: 0.25,
  tol_bp: 500, min_share: 0.03, min_molecules: 3, fold: 'near', near_max_bp: 1250, edge_min_bp: 500,
  stack_per_geometry: 40, profile_min_molecules: 8, share_min_molecules: 10,
  site_open_bp: 300, site_nuc_min_bp: 90, site_min_share: 0.08, site_min_gap_bp: 1000, site_max: 8,
  flank_near_bp: 1000, flank_far_bp: 3000, tf_window_bp: 100, carriers: 'full',
};
/** FiberHMM's LowPatchParams defaults: start at or below −1.5, extend while at or below −0.75 (log2 relative to the
 * random-packing reference median): about the reference's own 7th and 25th percentiles, the high side's 0.75 gap. */
export const DEFAULT_LOW_PARAMS: Required<NucLowPatchParams> = {
  enter: -1.5, extend: -0.75, min_tiles: 2, edges: 'snap', snap_rule: 'open', open_bp: 300, search_bp: 1000, nuc_min_bp: 90, tol_frac: 0.25,
};
type Params = typeof DEFAULT_PATCH_PARAMS;
type LowParams = typeof DEFAULT_LOW_PARAMS;

/** The request's patch parameters: low-regularity calling is on unless switched off (`low: null`). */
export function requestPatchParams(params: NucPatchParams | undefined): NucPatchParams {
  const p = { ...(params ?? {}) };
  return { ...p, low: p.low === null ? null : { ...(p.low ?? {}) } };
}

const STATE_COLORS = ['#6c757d', '#2a9d8f'];
const pct = (v: number | null | undefined, d = 0) => (v == null || !Number.isFinite(v) ? '–' : `${(100 * v).toFixed(d)}%`);
const sgn = (v: number | null | undefined, d = 2) => (v == null || !Number.isFinite(v) ? '–' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(d)}`);
const input = 'input-tool min-h-0 rounded px-1 py-0.5 text-[11px]';

export function NumField({ label, value, onChange, title, min, max, step, testId, width = 'w-14', suffix }: {
  label: ReactNode; value: number; onChange: (v: number) => void; title: string; min?: number; max?: number; step?: number; testId: string; width?: string; suffix?: ReactNode;
}) {
  return <label className="inline-flex items-center gap-1 text-gray-500 dark:text-gray-400" title={title}>{label}
    <input type="number" value={value} min={min} max={max} step={step} data-testid={testId} className={`${width} ${input}`}
      onChange={e => { const v = Number(e.target.value); if (e.target.value !== '' && Number.isFinite(v) && (min == null || v >= min) && (max == null || v <= max)) onChange(v); }} />
    {suffix}</label>;
}

export function Select<T extends string>({ label, value, options, onChange, title, testId }: {
  label: ReactNode; value: T; options: Array<[T, string]>; onChange: (v: T) => void; title: string; testId: string;
}) {
  return <label className="inline-flex items-center gap-1 text-gray-500 dark:text-gray-400" title={title}>{label}
    <select value={value} data-testid={testId} className={input} onChange={e => onChange(e.target.value as T)}>
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>;
}

/** One labelled row of controls (the Footprints run settings' rows). */
export function Row({ label, swatch, children, testId }: { label: string; swatch?: string; children: ReactNode; testId?: string }) {
  return <div className="flex flex-wrap items-center gap-x-3 gap-y-1" data-testid={testId}>
    <span className="inline-flex w-[8.5rem] flex-shrink-0 items-center gap-1 font-medium text-gray-700 dark:text-gray-200">
      {swatch && <span className="h-2 w-3 rounded-sm" style={{ background: swatch }} />}{label}</span>
    {children}
  </div>;
}

function EdgeControls<P extends { edges: 'snap' | 'grid'; snap_rule: 'open' | 'period'; open_bp: number; tol_frac: number; search_bp: number; nuc_min_bp: number }>(
  { p, set, prefix, details = true }: { p: P; set: (patch: Partial<P>) => void; prefix: string; details?: boolean }) {
  return <>
    <Select label="edges" value={p.edges} testId={`${prefix}-edges`} onChange={v => set({ edges: v } as Partial<P>)}
      options={[['snap', 'snapped to nucleosomes'], ['grid', 'tile grid']]}
      title="Tile grid: first window centre − step/2 to last centre + step/2. Snapped: each closed edge moves to a nucleosome boundary next to a spacing break" />
    {p.edges === 'snap' && details && <>
      <Select label="rule" value={p.snap_rule} testId={`${prefix}-snap-rule`} onChange={v => set({ snap_rule: v } as Partial<P>)}
        options={[['open', 'open linker'], ['period', 'off the period']]}
        title="Open linker: a linker at least the open length (or beyond the outermost footprint). Off the period: dyad spacing off the patch period by more than the tolerance" />
      {p.snap_rule === 'open'
        ? <NumField label="open ≥" value={p.open_bp} min={1} step={25} testId={`${prefix}-open-bp`} onChange={v => set({ open_bp: Math.round(v) } as Partial<P>)} title="An open linker (bp)" />
        : <NumField label="tolerance" value={p.tol_frac} min={0.01} max={0.99} step={0.05} testId={`${prefix}-tol-frac`} onChange={v => set({ tol_frac: v } as Partial<P>)} title="Fraction of the period a spacing may be off before it breaks" />}
      <NumField label="window ±" value={p.search_bp} min={0} step={100} testId={`${prefix}-search-bp`} onChange={v => set({ search_bp: Math.round(v) } as Partial<P>)} title="Breaks are searched within this distance of the grid edge (bp)" />
      <NumField label="nucleosome ≥" value={p.nuc_min_bp} min={1} step={10} testId={`${prefix}-nuc-min`} onChange={v => set({ nuc_min_bp: Math.round(v) } as Partial<P>)} title="Nucleosome-sized footprints (bp)" />
    </>}
  </>;
}

function Controls({ p, set, low, setLow, details = true, setDetails }: { p: Params; set: (patch: Partial<Params>) => void; low: LowParams | null; setLow: (patch: Partial<LowParams> | null) => void;
  /** The snapping details (rule, open linker or tolerance, search window, nucleosome size) of both kinds are shown. */
  details?: boolean; setDetails?: (v: boolean) => void }) {
  return <div className="flex flex-col gap-1.5 text-[11px]" data-testid="nuc-patch-controls">
    <Row label="High regularity" swatch={NUC_PATCH_COLOR} testId="nuc-patch-high-row">
      <NumField label="start ≥" value={p.enter} step={0.25} testId="nuc-patch-enter" onChange={v => set({ enter: v, extend: Math.min(p.extend, v) })}
        title="A high-regularity patch needs a window this far above the random-packing median (log2)" />
      <NumField label="extend ≥" value={p.extend} step={0.25} max={p.enter} testId="nuc-patch-extend" onChange={v => set({ extend: v })}
        title="and extends over windows at least this far above it (never above the start threshold)" />
      <NumField label="at least" value={p.min_tiles} min={1} max={40} step={1} testId="nuc-patch-min-tiles" onChange={v => set({ min_tiles: Math.round(v) })}
        title="Minimum windows per patch" suffix="windows" />
      <EdgeControls p={p} set={set} prefix="nuc-patch" details={details} />
      {setDetails && (p.edges === 'snap' || low?.edges === 'snap') && <button type="button" className="text-ink-muted underline" data-testid="nuc-patch-edge-details"
        aria-expanded={details} onClick={() => setDetails(!details)}>{details ? 'fewer edge settings' : 'edge settings…'}</button>}
    </Row>
    <Row label="Low regularity" swatch={NUC_PATCH_LOW_COLOR} testId="nuc-patch-low-row">
      <label className="inline-flex items-center gap-1 text-gray-500 dark:text-gray-400" title="Also call low-regularity patches: stretches less regular than random packing of the same nucleosomes (the mirror of the high-regularity calls)">
        <input type="checkbox" checked={low != null} data-testid="nuc-patch-low" onChange={e => setLow(e.target.checked ? {} : null)} />call</label>
      {low && <>
        <NumField label="start ≤" value={low.enter} step={0.25} testId="nuc-patch-low-enter" onChange={v => setLow({ enter: v, extend: Math.max(low.extend, v) })}
          title="A low-regularity patch needs a window at most this far relative to the random-packing median (log2; negative: below it)" />
        <NumField label="extend ≤" value={low.extend} step={0.25} min={low.enter} max={Math.min(p.extend - 0.05, 5)} testId="nuc-patch-low-extend" onChange={v => setLow({ extend: v })}
          title="and extends over windows at most this far (never below the start threshold, always below the high extend threshold)" />
        <NumField label="at least" value={low.min_tiles} min={1} max={40} step={1} testId="nuc-patch-low-min-tiles" onChange={v => setLow({ min_tiles: Math.round(v) })}
          title="Minimum windows per low-regularity patch" suffix="windows" />
        <EdgeControls p={low} set={patch => setLow(patch)} prefix="nuc-patch-low" details={details} />
      </>}
    </Row>
    <Row label="Shared geometries" testId="nuc-geo-params-row">
      <NumField label="both ends within" value={p.tol_bp} min={0} step={50} testId="nuc-geo-tol" onChange={v => set({ tol_bp: Math.round(v) })}
        title="Same geometry if both ends are within this distance (bp)" width="w-16" suffix="bp" />
      <NumField label="on ≥" value={Math.round(p.min_share * 1000) / 10} min={0} max={99} step={0.5} testId="nuc-geo-min-share"
        onChange={v => set({ min_share: v / 100 })} title="A geometry needs at least this share of the pooled molecules" suffix="% of molecules" />
      <NumField label="and ≥" value={p.min_molecules} min={1} step={1} testId="nuc-geo-min-molecules" onChange={v => set({ min_molecules: Math.round(v) })} title="and at least this many molecules" />
      <Select label="fold nested" value={p.fold} testId="nuc-geo-fold" onChange={v => set({ fold: v })}
        options={[['none', 'none'], ['near', 'near'], ['all', 'all']]}
        title="A nested geometry (inside a longer one of the same kind, one end shared, the other moved by more than the tolerance) folds into its longest parent: none keeps every geometry; near folds only when the other end moved at most the near limit; all folds every nested pair. Folding never changes the grouping; carriers of a folded child carry the parent partly" />
      {p.fold === 'near' && <NumField label="near: moved ≤" value={p.near_max_bp} min={0} step={250} testId="nuc-geo-near-max" onChange={v => set({ near_max_bp: Math.round(v) })}
        title="Largest move of the other end for the near fold (bp)" width="w-16" />}
      <NumField label="edge slivers <" value={p.edge_min_bp} min={0} step={100} testId="nuc-geo-edge-min" onChange={v => set({ edge_min_bp: Math.round(v) })}
        title="A patch cut by the view edge joins the grouping only when at least this much of it (bp) lies inside the view; shorter slivers would pile up as edge geometries. They stay in the read lane. 0 keeps every patch" width="w-16" suffix="bp left out" />
    </Row>
  </div>;
}

/** The answer for a view not analysed yet: every series lacks a regularity reference (no nucleosome calls). */
export const NOT_ANALYSED = /run Analyse first/i;
export function awaitsAnalyse(res: NucGeometryResult | null, series: Array<{ obsId: string }>): boolean {
  return !!res && series.length > 0 && !res.nMolecules && series.every(s => NOT_ANALYSED.test(res.errors?.[s.obsId] ?? ''));
}

/** Each panel's last geometry answer and the request it answers (a remount for the same request shows it). */
const LAST_GEOMETRIES = new Map<string, { key: string; answer: { series: string; res: NucGeometryResult }; run: NucGeoRun | null }>();

export function PatchGeometryView({ series, regParams, cohort = 'overlapping', settings, setSettings, revision, includeDuplicates, panelId, analysing = false,
  needsAnalyse = null, regularityState = 'ready', regularityError = '', tab = 'geometries', settingsOpen = false, scoreSettings = null,
  regSummary = [], regCharts = [], regTable = null, regInfo = null, regState = null, legend = null }: {
  series: RegSeries[]; regParams?: NucRegularityParams;
  /** Which molecules count (the Regularity view's setting): overlapping the window (default) or spanning it. */
  cohort?: NucCohort; settings: NucPanelState;
  setSettings: (patch: Partial<NucPanelState>) => void; revision: string; includeDuplicates: boolean;
  /** The nucleosome panel (its geometries become a hub set, a track above the reads and the Saved list's matches). */
  panelId?: string;
  /** The panel's Analyse is running for this view (a fresh view: nucleosome calls first). */
  analysing?: boolean;
  /** The view has no nucleosome calls for these datasets and nothing is analysing it (auto-Analyse off or used up):
   * the cards offer "Analyse this view" instead of waiting. */
  needsAnalyse?: string[] | null;
  /** Kept for callers of the older layout: the header's Analyse this view is now the one button. */
  onAnalyseView?: () => void;
  /** The Regularity view's own request for this view: still loading (whether the view needs an Analyse is not
   * known yet), failed, answered with "needs an Analyse", or ready. */
  regularityState?: 'loading' | 'error' | 'needs-analyse' | 'ready';
  regularityError?: string;
  /** Which of the panel's tabs shows: the shared geometries (default), the charts and detail tables, or the
   * association with a site. The requests run whichever shows (the lanes, hub and track need them). */
  tab?: NucRegTab;
  /** The settings drawer is open (the header's Settings): every parameter, grouped by task. */
  settingsOpen?: boolean;
  /** The Regularity view's slots: its score settings (first in the drawer), per-series summary (the summary table's
   * score columns), charts and detail table (Charts tab), reference line, status block and legend. */
  scoreSettings?: ReactNode;
  regSummary?: Array<{ s: RegSeries; m: NucRegularityObservation['summary'] | undefined }>;
  regCharts?: ReactNode[];
  regTable?: ReactNode;
  regInfo?: ReactNode;
  regState?: ReactNode;
  legend?: ReactNode;
}) {
  const reg = settings.regularity ?? {};
  const ps: NucPatchSettings = reg.patches ?? {};
  const open = ps.open ?? true;
  const { low: lowRaw, ...rest } = ps.params ?? {};
  const p: Params = { ...DEFAULT_PATCH_PARAMS, ...rest } as Params;
  const low: LowParams | null = lowRaw === null ? null : { ...DEFAULT_LOW_PARAMS, ...(lowRaw ?? {}) } as LowParams;
  const setPs = (patch: Partial<NucPatchSettings>) => setSettings({ regularity: { ...reg, patches: { ...ps, ...patch } } });
  const setParams = (patch: Partial<Params>) => setPs({ params: { ...(ps.params ?? {}), ...patch } });
  const setLow = (patch: Partial<LowParams> | null) => setPs({ params: { ...(ps.params ?? {}),
    low: patch === null ? null : { ...(ps.params?.low ?? {}), ...patch } } });
  const [answer, setAnswer] = useState<{ series: string; res: NucGeometryResult } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [took, setTook] = useState<number | null>(null);
  const [nestedOpen, setNestedOpen] = useState(false);
  /** Settings drawer: the edge-snapping details; Near a site: its thresholds; Charts: the detail tables. */
  const [edgeDetails, setEdgeDetails] = useState(false);
  const [siteDetails, setSiteDetails] = useState(false);
  const ctl = useRef<AbortController | null>(null);
  // Membership enters through a digest of the read ids (equal-sized cohorts differ).
  const seriesKey = seriesIdentity(series);
  const reqKey = JSON.stringify([ps.params ?? null, ps.reference ?? null, ps.site ?? null, ps.siteState ?? 'nfr', ps.show ?? 'patch', regParams ?? null,
    settings.parameters ?? null]);
  // An answer for other series (another locus, cohort or clusters) is never shown: a settings change keeps the last
  // answer on show while the new one computes.
  const res = answer && answer.series === seriesKey ? answer.res : null;
  const answerKey = JSON.stringify([seriesKey, reqKey, cohort, revision, includeDuplicates]);
  useEffect(() => {
    if (!open || !series.length) { setLoading(false); return; }
    // Mounted again for the request it last answered (a figure export lays the panel out and back): that answer, and
    // the panel's run is still in place.
    const kept = panelId ? LAST_GEOMETRIES.get(panelId) : undefined;
    if (kept && kept.key === answerKey) {
      setAnswer(kept.answer); setLoading(false);
      if (panelId && kept.run && !useNucGeoRuns.getState().runs[panelId]) useNucGeoRuns.getState().setRun(kept.run);
      return;
    }
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    // One read reload per settings change, shared with the Regularity view's request (nucJob.holdNucRefresh).
    const release = holdNucRefresh();
    const asked = seriesKey;
    // Superseded (an Analyse of these datasets, or this panel's newer request): not an error, and the geometries on
    // show (hub set, track, saved matches, overlay identity) stay; the Analyse's end moves the revision and this asks
    // again, once.
    let superseded = false;
    const timer = setTimeout(() => {
      setLoading(true);
      const t0 = performance.now();
      const body = { patches: requestPatchParams(ps.params), regularity: regParams, reference: ps.reference, cohort,
        site: ps.site ?? null, siteState: ps.siteState ?? 'nfr' as const, show: ps.show ?? 'patch' as const, includeDuplicates,
        ...(settings.parameters ? { analysis: settings.parameters } : {}) };
      // The exact body sent: the hub's geometry states replay it on the server.
      const request = geometryRequestBody(series, body);
      nucGeometries(series, body, c.signal, panelId)
        .then(r => {
          if (c.signal.aborted) return;
          setAnswer({ series: asked, res: r }); setError(''); setTook((performance.now() - t0) / 1000);

          // The geometries as features: the hub's set, the track above the reads, the Saved list's matches.
          if (panelId) {
            if (r.window && r.geometries.length) {
              const run = { panelId, request, result: r, datasets: [...new Set(series.map(x => x.datasetId))],
                seriesDataset: Object.fromEntries(series.map(x => [x.obsId, x.datasetId])), origin: ps.origin ?? null, updatedAt: Date.now() };
              useNucGeoRuns.getState().setRun(run);
              LAST_GEOMETRIES.set(panelId, { key: answerKey, answer: { series: asked, res: r }, run });
              // Toolbar selections of this panel's geometries follow the new run (its request), or are dropped.
              reconcileGeoSelection(run);
            } else {
              useNucGeoRuns.getState().dropRun(panelId); if (r.window) dropGeoSelection(panelId);
              LAST_GEOMETRIES.set(panelId, { key: answerKey, answer: { series: asked, res: r }, run: null });
            }
          }
          // The read lane shows the patches while the section is open (switched on with this change's row reload,
          // unless the user turned it off).
          void release(r.updatedDatasets, () => {
            const st = useBrowserStore.getState();
            if (!Object.prototype.hasOwnProperty.call(st.enabledModTypes, 'nucpatch')) st.toggleModType('nucpatch' as never, true);
          });
        })
        .catch(e => {
          if (c.signal.aborted) return;
          if (isSupersededNuc(e)) { superseded = true; void resyncAfterSuperseded(panelId); return; }
          setError(String(e?.message ?? e));
          // A failed request leaves no geometries behind (hub set, track, saved matches).
          if (panelId) useNucGeoRuns.getState().dropRun(panelId);
        })
        .finally(() => { void release(); if (!c.signal.aborted && !superseded) setLoading(false); });
    }, 500);
    return () => { clearTimeout(timer); c.abort(); void release(); };
  }, [open, seriesKey, reqKey, cohort, revision, includeDuplicates]);   // eslint-disable-line react-hooks/exhaustive-deps
  // Collapsed or gone: its geometries leave the hub, the track and the read focus.
  useEffect(() => {
    if (open || !panelId) return;
    useNucGeoRuns.getState().dropRun(panelId);
  }, [open, panelId]);
  // Unmounted: dropped unless the panel still shows them (an export lays the panel out of the figure meanwhile).
  useEffect(() => () => {
    if (!panelId) return;
    releaseGeoRun(panelId, keepsGeometriesOutOfView, useBrowserStore.getState().panels);
    // its last answer is kept only across an export (mounted again for the same request); any other unmount asks again
    if (!useBrowserStore.getState().exportInProgress) LAST_GEOMETRIES.delete(panelId);
  }, [panelId]);

  const openSection = (v: boolean) => {
    setPs({ open: v });
    // Opening asks for patches: show them on the reads.
    if (v) useBrowserStore.getState().toggleModType('nucpatch' as never, true);
  };
  const run: NucGeoRun | null = useNucGeoRuns(st => (panelId ? st.runs[panelId] ?? null : null));
  const job = useNucJob(st => st.job);
  // A fresh view: no nucleosome calls yet, so no regularity reference. The panel's Analyse runs (started at once);
  // its end moves the revision and this asks again.
  // Right after an Analyse the regularity request is still computing the tiles and reference: the same wait.
  const analysingNow = analysing || isLiveJob(job);
  const offer = !!needsAnalyse?.length && !analysingNow;
  // Nothing in the view is analysed: the cards offer the Analyse instead of empty charts and lists.
  const offerOnly = offer && !res?.nMolecules;
  // The view needs an Analyse while another panel's runs (one Analyse at a time): wait for it, never an empty list.
  const waitOther = !!needsAnalyse?.length && !analysing && isLiveJob(job) && !res?.nMolecules;
  // A geometry answer saying "not analysed" waits on the Regularity view's own answer (it decides between the
  // Analyse offer and the reference being computed); if that request failed, its error shows instead of a spinner.
  const regFailed = regularityState === 'error' && awaitsAnalyse(res, series);
  const waiting = !offer && !regFailed && (analysing || waitOther || awaitsAnalyse(res, series)
    || (regularityState === 'loading' && !res?.nMolecules && (!res || loading)));
  const ready = !!res && !!res.window && !waiting && !offerOnly;
  const jobNote = job && isLiveJob(job) ? ` ${Math.min(Object.keys(job.results ?? {}).length + 1, job.datasets.length)} of ${job.datasets.length} samples` : '';
  const origin = ps.origin ?? null;
  const pos = (v: number) => origin != null
    ? `${v - origin >= 0 ? '+' : '−'}${(Math.abs(v - origin) / 1000).toFixed(2)} kb`
    : `${(v / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })}k`;
  const span = (g: NucGeometryRow) => `${g.openLeft ? '≤ ' : ''}${pos(g.start)} to ${pos(g.end)}${g.openRight ? ' +' : ''}`;
  const G = res?.geometries ?? [];
  const kinds: NucPatchKind[] = res?.kinds ?? (low ? ['high', 'low'] : ['high']);
  const kindFilter = ps.kindFilter ?? 'all';
  const order = geometryOrder(G);
  const shown = series.filter(s => res?.patchStats?.[s.obsId]?.molecules);
  const datasets = [...new Set(series.map(s => s.datasetId))];
  const dsLabel = (id: string) => useBrowserStore.getState().datasets.find(d => d.id === id)?.label ?? id;
  const viewCentre = series.length ? Math.round((series[0].start + series[0].end) / 2) : null;
  const lowOn = kinds.includes('low');

  const mid = (edges: number[], k: number) => (edges[k] + edges[k + 1]) / 2;
  const profileLines = res && res.window ? [
    ...order.filter(gi => kindFilter === 'all' || kindOf(G[gi]) === kindFilter).map(gi => ({ key: G[gi].id, label: G[gi].id, color: geometryColor(G[gi], gi),
      dash: G[gi].parentIndex != null ? '4 2' : '', points: (res.profiles.carriers[G[gi].id] ?? []).map((v, k) => [mid(res.profiles.edges, k), v] as [number, number | null]) })),
    { key: 'none', label: 'no geometry', color: '#6b7280', dash: '4 3', width: 1.2,
      points: res.profiles.none.map((v, k) => [mid(res.profiles.edges, k), v] as [number, number | null]) },
    { key: 'enter', label: 'high start threshold', color: NUC_PATCH_COLOR, dash: '1 3', width: 1,
      points: [[res.profiles.edges[0], p.enter], [res.profiles.edges[res.profiles.edges.length - 1], p.enter]] as Array<[number, number | null]> },
    ...(lowOn && low ? [{ key: 'enter-low', label: 'low start threshold', color: NUC_PATCH_LOW_COLOR, dash: '1 3', width: 1,
      points: [[res.profiles.edges[0], low.enter], [res.profiles.edges[res.profiles.edges.length - 1], low.enter]] as Array<[number, number | null]> }] : []),
  ] : [];
  const shareLines = res && res.window ? series.flatMap(s => [
    { key: s.obsId, label: `${s.label} · high`, color: s.seriesColor, dash: s.dash,
      points: (res.profiles.share[s.obsId] ?? []).map((v, k) => [mid(res.profiles.edges, k), v] as [number, number | null]) },
    ...(res.profiles.shareLow ? [{ key: `${s.obsId}-low`, label: `${s.label} · low`, color: s.seriesColor, dash: '2 2', width: 1.2,
      points: (res.profiles.shareLow[s.obsId] ?? []).map((v, k) => [mid(res.profiles.edges, k), v == null ? null : -v] as [number, number | null]) }] : []),
  ]) : [];
  const lengthLines = res ? shown.flatMap(s => {
    const line = (L: { edges: number[]; counts: number[] } | undefined, key: string, label: string, dash?: string) => {
      const T = L?.counts.reduce((a, b) => a + b, 0) || 1;
      return { key, label, color: s.seriesColor, dash, points: (L?.counts ?? []).map((c, k) => [mid(L!.edges, k), c / T] as [number, number]) };
    };
    const st = res.patchStats[s.obsId];
    return [line(st?.lengths, s.obsId, `${s.label} · high`, s.dash), ...(st?.low ? [line(st.low.lengths, `${s.obsId}-low`, `${s.label} · low`, '2 2')] : [])];
  }) : [];
  const assoc = res?.association;
  const stateNames = assoc?.stateNames ?? ['closed', 'open'];
  const assocLines = assoc?.profiles ? assoc.profiles.series.filter(z => z.n >= (p.share_min_molecules || 10)).map(z => {
    const s = series.find(x => x.obsId === z.obsId);
    return { key: `${z.obsId}-${z.state}`, label: `${s?.label ?? z.obsId} · ${stateNames[z.state]} (${z.n})`, color: STATE_COLORS[z.state], dash: s?.dash,
      points: z.values.map((v, k) => [mid(assoc.profiles!.edges, k), v] as [number, number | null]) };
  }) : [];
  const testRows = assoc?.tests?.rows ?? [];
  const testCols = testRows.length ? Object.keys(testRows[0]).filter(k => !['chrom_a', 'chrom_b'].includes(k)).slice(0, 12) : [];
  const exportTsv = () => res && downloadTextFile(geometriesTsv(res, order, shown, pos), `nucleosome_geometries_${exportTimestamp()}.tsv`, 'text/tab-separated-values');
  const thClass = 'px-1 py-0.5 text-left font-medium';
  const tableBox = 'max-h-80 overflow-auto rounded border border-gray-200 dark:border-gray-700';
  const theadClass = 'sticky top-0 bg-gray-50 text-gray-500 dark:bg-gray-900 dark:text-gray-400';

  const list = ps.list ?? 'all';
  const savedCount = useBrowserStore(st => (st.savedNucGeometries ?? []).length);

  // Settings: one drawer for the whole panel (the Regularity view's score settings first, then patches, geometries,
  // the reference and positions). Every parameter stays adjustable; nothing here is on the first screen by default.
  const settingsBox = settingsOpen ? <div className="space-y-1.5 rounded border border-emerald-200 bg-emerald-50/60 p-2 text-[11px] dark:border-emerald-800/40 dark:bg-emerald-900/10"
    data-testid="nuc-settings">
    {scoreSettings}
    <Row label="Patches" testId="nuc-patch-call-row">
      <label className="inline-flex items-center gap-1 text-gray-500 dark:text-gray-400" title="Call high- and low-regularity patches on each molecule and group them into shared geometries (nothing is computed while this is off)">
        <input type="checkbox" checked={open} data-testid="nuc-patches-toggle" onChange={e => openSection(e.target.checked)} />call patches and shared geometries</label>
    </Row>
    {open && <Controls p={p} set={setParams} low={low} setLow={setLow} details={edgeDetails} setDetails={setEdgeDetails} />}
    {open && <Row label="Reference" testId="nuc-patch-ref-row">
      {datasets.map(id => {
        const choice = ps.reference?.[id];
        const adopted = typeof choice === 'string' ? choice : null;
        const scans = res?.scanReferences?.[id] ?? [];
        const src = res?.referenceSources?.[id];
        return <span key={id} className="inline-flex items-center gap-1 text-gray-500 dark:text-gray-400">
          <label className="inline-flex items-center gap-1" title={`Random-packing median the patch thresholds are read against (log2). Empty: the dataset's computed reference (${referenceSourceText(src).replace(/^; /, '') || 'its calibration population'}). ${referenceSourceTitle(src)}`}>
            {dsLabel(id)}
            <input type="number" step={0.05} placeholder={fmt(res?.references?.[id], 2)} value={adopted ? '' : (choice ?? '')} disabled={!!adopted}
              data-testid="nuc-patch-ref" className={`w-16 ${input}`}
              onChange={e => { const v = e.target.value === '' ? null : Number(e.target.value); setPs({ reference: { ...(ps.reference ?? {}), [id]: v != null && Number.isFinite(v) ? v : null } }); }} /></label>
          {(scans.length > 0 || adopted) && <select value={adopted ?? ''} data-testid="nuc-patch-ref-scan" className={input}
            title="Read the patches against an open scan's recorded reference (same regularity settings) instead of the browser's"
            onChange={e => setPs({ reference: { ...(ps.reference ?? {}), [id]: e.target.value || null } })}>
            <option value="">computed here</option>
            {scans.map(c => <option key={c.scanId} value={`scan:${c.scanId}`}>scan {c.label} ({fmt(c.median, 2)})</option>)}
            {adopted && !scans.some(c => `scan:${c.scanId}` === adopted) && <option value={adopted}>{adopted}</option>}</select>}
          <span className="sr-only" data-testid="nuc-patch-ref-source">{referenceSourceText(src).replace(/^; /, '')}</span>
        </span>;
      })}
    </Row>}
    {open && <Row label="Positions" testId="nuc-patch-origin-row">
      <Select label="" value={origin != null ? 'origin' : 'genomic'} testId="nuc-patch-origin"
        options={[['genomic', 'genomic'], ['origin', 'relative to an origin']]}
        onChange={v => setPs({ origin: v === 'origin' ? (viewCentre ?? 0) : null })} title="Show positions relative to an origin (default: the view centre), e.g. a TSS" />
      {origin != null && <NumField label="origin" value={origin} step={1} testId="nuc-patch-origin-pos" width="w-24" onChange={v => setPs({ origin: Math.round(v) })} title="Reference coordinate of the origin" />}
      <button type="button" className="ml-auto text-ink-muted underline" data-testid="nuc-patch-defaults" onClick={() => setPs({ params: {}, reference: {} })}>Patch defaults</button>
    </Row>}
  </div> : null;

  // One status line for the patch section: an error, the wait for an Analyse, or the offer (the header's Analyse this
  // view is the one button). Never an empty list while it waits.
  const errorBlock = !open ? null
    : error ? <AnalysisStatus kind="error"><span data-testid="nuc-patch-error">{error}</span></AnalysisStatus>
      : regFailed ? <AnalysisStatus kind="error"><span data-testid="nuc-patch-error">Regularity could not be computed for this view{regularityError ? `: ${regularityError}` : ''}</span></AnalysisStatus>
        : null;
  const stateBlock = !open ? null
    : waiting ? <div data-testid="nuc-geo-analysing" data-state="analysing"><AnalysisStatus kind="loading"><span data-testid="nuc-patch-analysing">
      {waitOther ? 'Another panel’s Analyse is running; this view follows when it ends.'
        : analysingNow ? `Analysing this view${jobNote ? ` (${jobNote.trim()})` : ''}: nucleosome calls, then regularity tiles, patches and geometries.`
          : 'Computing the regularity tiles; patches and geometries follow.'}</span></AnalysisStatus></div>
      : offer ? <p className="text-ink-secondary" data-testid="nuc-geo-needs-analyse" data-state="needs-analyse">
        {offerOnly ? 'This view has no nucleosome calls yet. Choose Analyse this view.' : 'Some datasets in this view have no nucleosome calls yet. Choose Analyse this view to add them.'}</p>
        : !res && loading && !error ? <div data-testid="nuc-geo-analysing" data-state="loading"><AnalysisStatus kind="loading">Finding shared geometries…</AnalysisStatus></div>
          : null;
  const seriesErrors = res && !waiting && !offer ? Object.entries(res.errors).map(([k, v]) => <p key={k} className="text-[11px] text-amber-700 dark:text-amber-300">{series.find(s => s.obsId === k)?.label ?? k}: {v}</p>) : null;
  const statsReady = !!res && !waiting && !offerOnly;

  /** The first thing read: per series, its molecules, density, score above random and how much of it is in patches. */
  const summaryRows = regSummary.length ? regSummary : series.map(s => ({ s, m: undefined }));
  const summary = (regSummary.length > 0 || (statsReady && shown.length > 0)) && <div className="overflow-x-auto">
    <table className="w-full border-collapse whitespace-nowrap text-[11px] tabular-nums" data-testid="nuc-reg-summary">
      <thead className="text-ink-secondary"><tr>{([['', ''], ['Molecules', 'Molecules in the window (the cohort setting)'], ['m6A/kb', 'Median m6A calls per kb'],
        ['Above random', 'Median tile score above the dataset’s random-packing median (log2)'], ['Repeat', 'Median local repeat length (bp)'],
        ...(open ? [['High', 'In high-regularity patches: share of the window’s scored bases']] : []), ...(open && lowOn ? [['Low', 'In low-regularity patches: share of the window’s scored bases']] : [])] as Array<[string, string]>)
        .map(([h, t]) => <th key={h} className="px-1 py-0.5 text-left font-medium" title={t}>{h === 'High' ? <><span className="mr-1 inline-block h-2 w-2 rounded-sm" style={{ background: NUC_PATCH_COLOR }} />{h}</>
          : h === 'Low' ? <><span className="mr-1 inline-block h-2 w-2 rounded-sm" style={{ background: NUC_PATCH_LOW_COLOR }} />{h}</> : h}</th>)}</tr></thead>
      <tbody>{summaryRows.map(({ s, m }) => { const st = statsReady ? res?.patchStats?.[s.obsId] : undefined; return <tr key={s.obsId} className="border-t border-line dark:border-white/10" data-testid="nuc-reg-summary-row">
        <td className="max-w-[9rem] truncate px-1 py-0.5" title={s.label}><span className="mr-1 inline-block h-2 w-2 rounded-sm" style={{ background: s.seriesColor }} />{s.label}</td>
        <td className="px-1">{m?.molecules ?? st?.molecules ?? '–'}</td>
        <td className="px-1">{fmt(m?.m6aPerKb ?? null, 1)}</td>
        <td className="px-1 font-medium" title={`median score ${fmt(m?.score ?? null, 2)}`}>{m?.scoreAboveRef != null ? sgn(m.scoreAboveRef) : fmt(m?.score ?? null, 2)}</td>
        <td className="px-1">{m?.repeatLength != null ? Math.round(m.repeatLength) : '–'}</td>
        {open && <td className="px-1 font-medium">{pct(st?.shareInPatches)}</td>}
        {open && lowOn && <td className="px-1 font-medium">{pct(st?.low?.shareInPatches)}</td>}
      </tr>; })}</tbody>
    </table></div>;

  const geometryCard = open && res && ready && <AnalysisCard title="Shared geometries" data-testid="nuc-geo-card"
    actions={<>
      <AnalysisButton theme="emerald" variant="quiet" data-testid="nuc-geo-group" disabled={!G.some(g => kindOf(g) === 'high')}
        onClick={() => groupReadsByGeometry(res, series, 'high', span)}
        title="Group each panel's reads by the high-regularity geometry they carry (the root; folded children join their parent; reads carrying none last). Sort within groups as usual">
        Group reads{lowOn ? ': high' : ' by geometry'}</AnalysisButton>
      {lowOn && <AnalysisButton theme="emerald" variant="quiet" data-testid="nuc-geo-group-low" disabled={!G.some(g => kindOf(g) === 'low')}
        onClick={() => groupReadsByGeometry(res, series, 'low', span)}
        title="Group each panel's reads by the low-regularity geometry they carry (reads carrying none last)">low</AnalysisButton>}
      <AnalysisExportGroup><AnalysisButton variant="neutral" data-testid="nuc-geo-export-tsv" disabled={!G.length} onClick={exportTsv}
        title="Every geometry: kind, span, edges, carriers (full and partly) per series, density-matched shares">TSV</AnalysisButton></AnalysisExportGroup>
    </>}>
    <GeometryClasses res={res} run={run} series={shown} pos={pos} span={span} kinds={kinds} kindFilter={kindFilter} setKindFilter={k => setPs({ kindFilter: k })}
      loading={loading} took={took} list={list} setList={v => setPs({ list: v })} savedCount={savedCount}
      savedView={<SavedGeometries res={res} run={run} pos={pos} embedded />} />
    {list === 'all' && <div>
      <button type="button" onClick={() => setNestedOpen(v => !v)} aria-expanded={nestedOpen} data-testid="nuc-geo-nested-toggle"
        className="flex items-center gap-1 text-[11px] text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200">
        <DisclosureChevron open={nestedOpen} /> Nested geometries ({res.nested.length} pair{res.nested.length === 1 ? '' : 's'})</button>
      {nestedOpen && <div className="mt-1.5 space-y-2">
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr))]">
          <section className="max-h-[420px] overflow-y-auto"><ChartBox filename="nucleosome_geometry_members"><StackView res={res} indices={order.filter(gi => (kindFilter === 'all' || kindOf(G[gi]) === kindFilter) && sameChrom(geoChrom(G[gi], res), res.window?.chrom ?? ''))} pos={pos} width={520} /></ChartBox></section>
          <section><MetricTitle title="Carriers' score along the locus"><p>Mean regularity score (above random packing) per position for the molecules carrying each geometry; dashed grey: molecules carrying none; dotted: the start thresholds (red high, navy low).</p></MetricTitle>
            <LineChart lines={profileLines} xLabel="position" yLabel="score above random" testId="nuc-geo-profile" xFormat={pos} /></section>
        </div>
        <NestedTable rows={res.nested} pos={pos} />
      </div>}
    </div>}
  </AnalysisCard>;

  const geoTarget = (name: string, type: 'nuc-spacing' | 'size-histogram' | 'metaprofile', measures: string) => ({ name, origin: `Nucleosomes › ${name}`, type, measures,
    locus: res?.window ? { chrom: res.window.chrom, start: res.window.start, end: res.window.end, genome: null } : null,
    datasets: [...new Set(series.map(sr => useBrowserStore.getState().datasets.find(d => d.id === sr.datasetId)?.label ?? sr.datasetId))] });
  const patchCharts = open && res && res.window && !offerOnly && !waiting ? [
    <section key="share"><MetricTitle title="Share in a patch along the locus"><p>Per window position: the share of each series’ molecules (with a call there) inside a high-regularity patch (above the axis){lowOn ? ' and inside a low-regularity patch (below it, dotted)' : ''}.</p></MetricTitle>
      <LineChart lines={shareLines} xLabel="position" yLabel={lowOn ? 'share: high (+) / low (−)' : 'share in a patch'} testId="nuc-patch-share" xFormat={pos} yDomain={lowOn ? [-1, 1] : [0, 1]} openInPlots={geoTarget('Share in a patch along the locus', 'metaprofile', 'per window position, the share of each series\' molecules with a call there that sit inside a high-regularity patch (low patches below the axis); primary records only')} /></section>,
    <section key="lengths"><MetricTitle title="Patch lengths"><p>Closed patches only (open-ended ones run past the read or view){lowOn ? '; dotted: low-regularity patches' : ''}.</p></MetricTitle>
      <LineChart lines={lengthLines} xLabel="patch length (bp)" yLabel="share" testId="nuc-patch-lengths" openInPlots={geoTarget('Patch lengths', 'size-histogram', 'closed patches only (both ends inside the read and view), reference bp; 250 bp bins 0–8,250 (longer dropped); share of patches; primary records only')} /></section>,
  ] : [];
  const patchTable = open && statsReady && shown.length > 0 && <div className="max-h-60 overflow-auto rounded border border-gray-200 dark:border-gray-700">
    <table className="w-full border-collapse text-[11px] tabular-nums" data-testid="nuc-patch-summary">
      <thead className={theadClass}><tr>{['Patches', 'Kind', 'Molecules', 'Patches / molecule', 'Share in patches', 'Median patch', 'Patch score', 'Reference'].map(h => <th key={h} className={thClass}>{h}</th>)}</tr></thead>
      <tbody>{shown.flatMap(s => {
        const m = res!.patchStats[s.obsId];
        const rows: Array<[NucPatchKind, typeof m]> = [['high', m], ...(m.low ? [['low', { ...m.low }] as [NucPatchKind, typeof m]] : [])];
        return rows.map(([k, st], j) => <tr key={`${s.obsId}-${k}`} className={`${j ? '' : 'border-t'} border-gray-100 dark:border-gray-800`} data-testid="nuc-patch-summary-row" data-kind={k}>
          <td className="px-1 py-0.5">{j ? '' : <><span style={{ color: s.seriesColor }}>●</span> {s.label}</>}</td>
          <td className="px-1"><span className="mr-1 inline-block h-2 w-2 rounded-sm" style={{ background: k === 'low' ? NUC_PATCH_LOW_COLOR : NUC_PATCH_COLOR }} />{k}</td>
          <td className="px-1">{st.molecules}</td><td className="px-1">{fmt(st.perMolecule, 2)}</td><td className="px-1">{pct(st.shareInPatches)}</td>
          <td className="px-1">{st.medianClosed != null ? `${st.medianClosed} bp` : '–'}</td><td className="px-1">{fmt(st.score, 2)}</td>
          <td className="px-1 text-gray-500" title={referenceSourceTitle(res!.referenceSources?.[s.datasetId])}>{j ? '' : fmt(res!.references[s.datasetId], 2)}</td></tr>);
      })}</tbody>
    </table></div>;

  const assocCard = open && res && ready && <AnalysisCard title="Next to an open region or TF site" data-testid="nuc-assoc-card">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]" data-testid="nuc-assoc-controls">
      <Select label="site" value={String(assoc?.site ?? '')} testId="nuc-assoc-site"
        options={[...(assoc?.sites ?? []).map(s => [String(s.pos), `${pos(s.pos)} (open on ${Math.round(100 * s.share)}%)`] as [string, string]),
          ...(assoc?.site != null && !(assoc.sites ?? []).some(s => s.pos === assoc.site) ? [[String(assoc.site), pos(assoc.site)] as [string, string]] : [])]}
        onChange={v => setPs({ site: v === '' ? null : Number(v) })} title="Positions open on many molecules (local maxima of the open share)" />
      <NumField label="or at" value={assoc?.site ?? 0} step={10} testId="nuc-assoc-pos" width="w-24" onChange={v => setPs({ site: Math.round(v) })} title="Any reference position" />
      <Select label="state" value={ps.siteState ?? 'nfr'} testId="nuc-assoc-state" options={[['nfr', 'open / closed'], ['tf', 'TF bound / unbound (open molecules)']]}
        onChange={v => setPs({ siteState: v })} title="Open: an open stretch (≥ the open length between nucleosome-sized footprints) covers the site. TF bound: a TF footprint within the TF window of the site, inside its open stretch" />
      <Select label="show" value={ps.show ?? 'patch'} testId="nuc-assoc-show"
        options={[['patch', 'share in a high patch'], ...(lowOn ? [['low', 'share in a low patch'] as ['low', string]] : []), ['score', 'mean score']]}
        onChange={v => setPs({ show: v })} title="What the profile shows" />
      <Select label="carriers" value={p.carriers} testId="nuc-assoc-carriers" options={[['full', 'full'], ['any', 'full or partly']]}
        onChange={v => setParams({ carriers: v })} title="Which molecules count as carrying a geometry in the test" />
      <button type="button" className="text-ink-muted underline" data-testid="nuc-assoc-details" aria-expanded={siteDetails}
        onClick={() => setSiteDetails(v => !v)}>{siteDetails ? 'fewer settings' : 'thresholds…'}</button>
      {siteDetails && <>
        <NumField label="open ≥" value={p.site_open_bp} min={50} step={25} testId="nuc-assoc-open-bp" onChange={v => setParams({ site_open_bp: Math.round(v) })} title="Open stretch length (bp)" />
        <NumField label="TF window ±" value={p.tf_window_bp} min={0} step={10} testId="nuc-assoc-tf-window" onChange={v => setParams({ tf_window_bp: Math.round(v) })} title="TF footprints within this distance of the site (bp)" />
        <span className="inline-flex items-center gap-1 whitespace-nowrap">
          <NumField label="flanks" value={p.flank_near_bp} min={0} step={250} testId="nuc-assoc-flank-near" onChange={v => setParams({ flank_near_bp: Math.round(v) })} title="Flank windows start this far from the site (bp)" />
          –<NumField label="" value={p.flank_far_bp} min={250} step={250} testId="nuc-assoc-flank-far" onChange={v => setParams({ flank_far_bp: Math.round(v) })} title="and end this far (bp)" /></span>
      </>}
    </div>
    {assoc && !assoc.sites.length && assoc.site == null && <p className="text-[11px] text-ink-secondary">No open region reaches {pct(p.site_min_share)} of molecules here.</p>}
    {assoc?.profiles && <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr))]">
      <section><MetricTitle title={`By state at ${assoc.site != null ? pos(assoc.site) : 'the site'}`}><p>Each series split by the site’s state; groups under the minimum are not drawn.</p></MetricTitle>
        <p className="mb-1 flex flex-wrap gap-x-3 text-[11px] text-gray-600 dark:text-gray-300" data-testid="nuc-assoc-legend">
          {stateNames.map((n, k) => <span key={n} className="inline-flex items-center gap-1"><span className="h-0.5 w-4" style={{ background: STATE_COLORS[k] }} />{n}</span>)}
          {datasets.length > 1 && series.filter((x, k, a) => a.findIndex(y => y.datasetId === x.datasetId) === k).map(x => <span key={x.datasetId} className="inline-flex items-center gap-1">
            <svg width={16} height={4} aria-hidden="true"><line x1={0} x2={16} y1={2} y2={2} stroke="currentColor" strokeWidth={1.5} strokeDasharray={x.dash || undefined} /></svg>{dsLabel(x.datasetId)}</span>)}</p>
        <LineChart lines={assocLines} xLabel="position" yLabel={assoc.show === 'score' ? 'score above random' : assoc.show === 'low' ? 'share in a low patch' : 'share in a high patch'} testId="nuc-assoc-profile" xFormat={pos} /></section>
      <div className={tableBox}><table className="w-full border-collapse text-[11px] tabular-nums" data-testid="nuc-assoc-table">
        <thead className={theadClass}><tr>{['', 'At the site', 'Molecules', 'm6A/kb', 'Upstream in a high patch', 'score', 'Downstream in a high patch', 'score',
          ...(lowOn ? ['Up · down in a low patch'] : []), `${stateNames[1]} − ${stateNames[0]}, m6A/kb matched (up · down)`].map((h, i) => <th key={i} className={thClass}>{h}</th>)}</tr></thead>
        <tbody>{(assoc.table ?? []).map(r => { const s = series.find(x => x.obsId === r.obsId); return <tr key={`${r.obsId}-${r.state}`} className="border-t border-gray-100 dark:border-gray-800">
          <td className="px-1 py-0.5">{s?.label ?? r.obsId}</td><td className="px-1"><span style={{ color: STATE_COLORS[r.state] }}>●</span> {stateNames[r.state]}</td>
          <td className="px-1">{r.molecules}</td><td className="px-1">{fmt(r.m6aPerKb, 0)}</td>
          <td className="px-1">{pct(r.upShare)}</td><td className="px-1">{sgn(r.upScore)}</td>
          <td className="px-1">{pct(r.downShare)}</td><td className="px-1">{sgn(r.downScore)}</td>
          {lowOn && <td className="px-1">{pct(r.upLowShare)} · {pct(r.downLowShare)}</td>}
          <td className="px-1">{r.matched ? `${sgn(r.matched.up != null ? 100 * r.matched.up : null, 0)} · ${sgn(r.matched.down != null ? 100 * r.matched.down : null, 0)} points`
            + (r.matchedLow ? ` (low: ${sgn(r.matchedLow.up != null ? 100 * r.matchedLow.up : null, 0)} · ${sgn(r.matchedLow.down != null ? 100 * r.matchedLow.down : null, 0)})` : '') : ''}</td></tr>; })}</tbody>
      </table></div>
    </div>}
    {assoc?.tests && <div className={tableBox}><table className="w-full border-collapse text-[11px] tabular-nums" data-testid="nuc-assoc-tests">
      <caption className="caption-top px-1 py-0.5 text-left text-[11px] text-ink-secondary">Geometry carriage against the site state: {assoc.tests.method ?? 'FiberHMM co-occurrence'}{assoc.tests.note ? ` — ${assoc.tests.note}` : ''}</caption>
      <thead className={theadClass}><tr>{testCols.map(c => <th key={c} className={thClass}>{c}</th>)}</tr></thead>
      <tbody>{testRows.map((r, i) => <tr key={i} className="border-t border-gray-100 dark:border-gray-800">{testCols.map(c => <td key={c} className="px-1 py-0.5">{typeof r[c] === 'number' ? Number((r[c] as number).toPrecision(3)) : String(r[c] ?? '')}</td>)}</tr>)}</tbody>
    </table></div>}
  </AnalysisCard>;

  const off = !open && <p className="text-[11px] text-ink-secondary" data-testid="nuc-patches-off">Patch calling is off. Switch it on under Settings.</p>;
  const allCharts = [...regCharts, ...patchCharts];

  return <section className="flex flex-col gap-2.5" data-testid="nuc-patches">
    {settingsBox}
    {regState}
    {errorBlock}
    {stateBlock}
    {seriesErrors}
    {tab === 'geometries' && <>
      {summary}
      {off}
      {geometryCard}
      {!ready && open && savedCount > 0 && <SavedGeometries res={null} run={run} pos={pos} />}
    </>}
    {tab === 'charts' && <>
      {regInfo}
      {allCharts.length > 0 && <>{legend}<div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr))]" data-testid="nuc-charts">{allCharts}</div></>}
      {(regTable || patchTable) && <details className="group text-[11px]" data-testid="nuc-tables">
        <summary className="cursor-pointer list-none text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200">
          <span className="inline-block transition-transform group-open:rotate-90">›</span> Detail tables</summary>
        <div className="mt-1 space-y-2">{regTable}{patchTable}</div>
      </details>}
    </>}
    {tab === 'site' && <>{off}{assocCard}</>}
  </section>;
}
