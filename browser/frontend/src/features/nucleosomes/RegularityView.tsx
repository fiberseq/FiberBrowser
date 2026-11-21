/**
 * The Regularity view: single-fibre nucleosome regularity (FiberHMM fiberhmm.nuc.regularity, the `nucreg` layer) per
 * cluster and dataset (pool → find → compare). Its parameters recompute the layer the read lane, Cluster and Sort use
 * (tiles only: never a recalibration). Charts: score distribution against the dataset's random-packing reference,
 * mean score along the region, local repeat length, score against m6A density, masked m6A autocorrelation, and a
 * summary table.
 */
import { linesToSupplied, openSuppliedPlot } from '../plots/supplied';
import type { PlotLocus, PlotType } from '../plots/plotModel';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useBrowserStore } from '../../stores/browserStore';
import { useFrozenWhileInactive, usePanelActive } from '../../hooks/usePanelDisplayStore';
import { getClusterColor, getClusterLabel } from '../../components/tracks/read-track/constants';
import { NUC_REG_RAMP } from '../../utils/nucLayers';
import { REG_PERIOD_CHANNEL, REG_SCORE_CHANNEL, channelLabel, clusterProfileChannelOptions, isPatchChannel, isRegularityChannel } from '../../utils/clusterViewChannels';
import { isSupersededNuc, nucRegularity } from './api';
import { autoAnalyseVetoed, holdNucRefresh, isLiveJob, isNucBusy, resyncAfterSuperseded, useNucBusy, useNucJob } from './nucJob';
import { observationViews } from './planner';
import { AUTO_ANALYSE_OPTIONS, AUTO_SETTLE_MS, DEFAULT_AUTO_ANALYSE, autoAnalyseAction, consumeAutoAnalyse, datasetsToAnalyse } from './firstOpen';
import { DEFAULT_REG_PARAMS, requestRegParams, seriesIdentity, seriesView, shownRegParams } from './regParams';
import { idSetHas, qnameOfId, recordKey } from '../../utils/recordKeys';
import { Info, MetricTitle } from './PanelPrimitives';
import { ChartBox, fmt } from './charts';
import { linesTsv } from '../../utils/svgChartExport';
import { NumField, PatchGeometryView, Row, Select } from './PatchGeometryView';
import { AnalysisStatus } from '../../components/controls/shared/AnalysisStatus';
import type { NucAutoAnalyse, NucCohort, NucObservation, NucPanelState, NucReferenceSource, NucRegularityObservation, NucRegularityParams, NucRegularityResult } from './types';
import { cohortOf } from './types';

export { DEFAULT_REG_PARAMS };

/** One series of the view: an observation, or one cluster of it. */
export interface RegSeries extends NucObservation { cluster?: number; seriesColor: string; dash?: string; datasetIndex: number }

const DASHES = ['', '5 3', '1.5 2', '6 2 1.5 2'];

/** Split each observation by its panel's cluster assignments (one series per cluster and dataset); unclustered
 * observations stay whole in their own colour. A dash per dataset tells datasets apart when clusters share colours. */
export function regularitySeries(observations: NucObservation[],
  clusterAssignments: Record<string, Record<string, number>>): RegSeries[] {
  const datasets = [...new Set(observations.map(o => o.datasetId))];
  const out: RegSeries[] = [];
  for (const o of observations) {
    const datasetIndex = datasets.indexOf(o.datasetId);
    const dash = datasets.length > 1 ? DASHES[datasetIndex % DASHES.length] : '';
    const assigned = clusterAssignments[o.stateKey] ?? {};
    const allowed = o.readIds ? new Set(o.readIds) : null;
    const byCluster = new Map<number, string[]>();
    for (const [readId, cluster] of Object.entries(assigned)) {
      // Negative labels are sentinels (a graph run's non-carriers), never a cluster.
      if (!Number.isFinite(cluster) || cluster < 0) continue;
      // Identity-aware: a graph or live-lift run labels record keys, a kept read is its QNAME.
      if (allowed && !idSetHas(allowed, [readId, qnameOfId(readId)], recordKey(readId))) continue;
      const list = byCluster.get(cluster);
      if (list) list.push(readId); else byCluster.set(cluster, [readId]);
    }
    if (!byCluster.size) {
      out.push({ ...o, seriesColor: o.color, dash, datasetIndex });
      continue;
    }
    for (const cluster of [...byCluster.keys()].sort((a, b) => a - b)) {
      out.push({ ...o, obsId: `${o.obsId}::c${cluster}`, label: `${o.label} · ${getClusterLabel(cluster, true)}`,
        readIds: byCluster.get(cluster)!, cluster, seriesColor: getClusterColor(cluster), dash, datasetIndex });
    }
  }
  return out;
}

interface Line { key: string; label: string; color: string; dash?: string; points: Array<[number, number | null]>; width?: number }

const W = 300, H = 120, PAD = { l: 30, r: 6, t: 6, b: 18 };

function ticks(lo: number, hi: number, n = 4): number[] {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / n, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) ?? raw;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Number(v.toFixed(6)));
  return out;
}

/** Lines on one axis pair (inline SVG; currentColor axes; hover titles). */
/** Where a chart's lines open in Plots (supplied series: Plots draws these values, Compare and export there). */
export interface OpenInPlotsTarget { name: string; origin: string; type?: PlotType; locus: PlotLocus | null; datasets: string[]; measures?: string }

/** The chart's lines as supplied series in Plots (the values exactly; dashes kept). */
export function openLinesInPlots(lines: Line[], xLabel: string, yLabel: string, t: OpenInPlotsTarget): string | null {
  const { xs, series } = linesToSupplied(lines);
  const dash = new Map(lines.map(l => [l.key, l.dash ? l.dash.split(/[ ,]+/).map(Number).filter(Number.isFinite) : undefined]));
  return openSuppliedPlot({
    type: t.type ?? 'nuc-spacing', name: t.name, datasets: t.datasets, xs,
    spec: { origin: t.origin, x0: xs[0] ?? 0, dx: xs.length > 1 ? xs[1] - xs[0] : 1, xLabel, yLabel, ...(t.measures ? { measures: t.measures } : {}) },
    series: series.map(sr => ({ ...sr, ...(dash.get(sr.id)?.length ? { dash: dash.get(sr.id) } : {}) })),
    locus: t.locus ?? { chrom: '', start: 0, end: 1, genome: null },
  });
}

export function LineChart({ lines, xLabel, yLabel, testId, xFormat = v => String(v), yDomain, openInPlots }: {
  lines: Line[]; xLabel: string; yLabel: string; testId?: string; xFormat?: (v: number) => string; yDomain?: [number, number];
  /** Offer "Open in Plots" for these lines. */
  openInPlots?: OpenInPlotsTarget;
}) {
  const pts = lines.flatMap(l => l.points.filter(p => p[1] != null)) as Array<[number, number]>;
  if (!pts.length) return <p className="text-ink-muted" data-testid={testId}>—</p>;
  const chart = <LineChartSvg lines={lines} xLabel={xLabel} yLabel={yLabel} testId={testId} xFormat={xFormat} yDomain={yDomain} pts={pts} />;
  if (!openInPlots) return chart;
  return <div className="flex flex-col">
    {chart}
    <button type="button" data-testid={`${testId ?? 'nuc-chart'}-open-in-plots`} className="self-end rounded border border-gray-200 px-1.5 py-0.5 text-[10px] text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300"
      title="Open in Plots: these lines as a plot (Compare A − B or log2 between series, smoothing, export, the Gallery). The values are this panel's; re-run here to recompute."
      onClick={() => openLinesInPlots(lines, xLabel, yLabel, openInPlots)}>Open in Plots</button>
  </div>;
}

function LineChartSvg({ lines, xLabel, yLabel, testId, xFormat, yDomain, pts }: {
  lines: Line[]; xLabel: string; yLabel: string; testId?: string; xFormat: (v: number) => string; yDomain?: [number, number]; pts: Array<[number, number]>;
}) {
  const x0 = Math.min(...pts.map(p => p[0])), x1 = Math.max(...pts.map(p => p[0]));
  let [y0, y1] = yDomain ?? [Math.min(...pts.map(p => p[1])), Math.max(...pts.map(p => p[1]))];
  if (!yDomain) { const pad = (y1 - y0) * 0.06 || 0.5; y0 -= pad; y1 += pad; }
  const sx = (v: number) => PAD.l + (x1 > x0 ? (v - x0) / (x1 - x0) : 0.5) * (W - PAD.l - PAD.r);
  const sy = (v: number) => H - PAD.b - (y1 > y0 ? (v - y0) / (y1 - y0) : 0.5) * (H - PAD.t - PAD.b);
  const path = (l: Line) => {
    let d = '', open = false;
    for (const [x, y] of l.points) {
      if (y == null) { open = false; continue; }
      d += `${open ? 'L' : 'M'}${sx(x).toFixed(1)},${sy(Math.max(y0, Math.min(y1, y))).toFixed(1)}`;
      open = true;
    }
    return d;
  };
  return <ChartBox filename={`nucleosome_${(testId ?? 'chart').replace(/^nuc-/, '').replace(/-/g, '_')}`} dataTsv={() => linesTsv(lines, xLabel, yLabel)} className="w-full max-w-[420px]">
  <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-[420px]" role="img" aria-label={`${yLabel} by ${xLabel}`} data-testid={testId}>
    {ticks(y0, y1).map(v => <g key={`y${v}`}><line x1={PAD.l} x2={W - PAD.r} y1={sy(v)} y2={sy(v)} stroke="currentColor" strokeOpacity={0.08} />
      <text x={PAD.l - 3} y={sy(v) + 3} fontSize={7} textAnchor="end" fill="currentColor" opacity={0.6}>{Number(v.toFixed(2))}</text></g>)}
    {ticks(x0, x1).map(v => <text key={`x${v}`} x={sx(v)} y={H - 6} fontSize={7} textAnchor="middle" fill="currentColor" opacity={0.6}>{xFormat(v)}</text>)}
    <text x={W - PAD.r} y={H - 0.5} fontSize={7} textAnchor="end" fill="currentColor" opacity={0.6}>{xLabel}</text>
    <text x={2} y={PAD.t + 2} fontSize={7} fill="currentColor" opacity={0.6}>{yLabel}</text>
    {lines.map(l => <path key={l.key} d={path(l)} fill="none" stroke={l.color} strokeWidth={l.width ?? 1.6} strokeDasharray={l.dash || undefined}
      strokeLinejoin="round" strokeLinecap="round"><title>{l.label}</title></path>)}
  </svg></ChartBox>;
}

function ScatterChart({ series, testId }: { series: Array<{ key: string; label: string; color: string; points: Array<[number, number]> }>; testId?: string }) {
  const pts = series.flatMap(s => s.points);
  if (!pts.length) return <p className="text-ink-muted" data-testid={testId}>—</p>;
  const xs = pts.map(p => p[1]).sort((a, b) => a - b), ys = pts.map(p => p[0]).sort((a, b) => a - b);
  const q = (v: number[], f: number) => v[Math.min(v.length - 1, Math.max(0, Math.round(f * (v.length - 1))))];
  const x0 = q(xs, 0.005), x1 = q(xs, 0.995), y0 = q(ys, 0.005), y1 = q(ys, 0.995);
  const sx = (v: number) => PAD.l + (x1 > x0 ? (v - x0) / (x1 - x0) : 0.5) * (W - PAD.l - PAD.r);
  const sy = (v: number) => H - PAD.b - (y1 > y0 ? (v - y0) / (y1 - y0) : 0.5) * (H - PAD.t - PAD.b);
  return <ChartBox filename="nucleosome_score_m6a" className="w-full max-w-[420px]"
    dataTsv={() => ['series\tlabel\tm6a_per_kb\tscore', ...series.flatMap(s => s.points.map(([y, x]) => `${s.key}\t${s.label}\t${x}\t${y}`))].join('\n') + '\n'}>
  <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-[420px]" role="img" aria-label="regularity score against m6A per kb" data-testid={testId}>
    {ticks(y0, y1).map(v => <g key={`y${v}`}><line x1={PAD.l} x2={W - PAD.r} y1={sy(v)} y2={sy(v)} stroke="currentColor" strokeOpacity={0.08} />
      <text x={PAD.l - 3} y={sy(v) + 3} fontSize={7} textAnchor="end" fill="currentColor" opacity={0.6}>{Number(v.toFixed(2))}</text></g>)}
    {ticks(x0, x1).map(v => <text key={`x${v}`} x={sx(v)} y={H - 6} fontSize={7} textAnchor="middle" fill="currentColor" opacity={0.6}>{Number(v.toFixed(1))}</text>)}
    <text x={W - PAD.r} y={H - 0.5} fontSize={7} textAnchor="end" fill="currentColor" opacity={0.6}>m6A per kb</text>
    <text x={2} y={PAD.t + 2} fontSize={7} fill="currentColor" opacity={0.6}>score</text>
    {series.map(s => <g key={s.key} fill={s.color} fillOpacity={0.45}><title>{s.label}</title>
      {s.points.map(([y, x], i) => x >= x0 && x <= x1 && y >= y0 && y <= y1
        ? <circle key={i} cx={sx(x)} cy={sy(y)} r={1.6} /> : null)}</g>)}
  </svg></ChartBox>;
}

function Legend({ items }: { items: Array<{ key: string; label: string; color: string; dash?: string; note?: string }> }) {
  return <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]" data-testid="nuc-reg-legend">{items.map(i =>
    <span key={i.key} className="inline-flex items-center gap-1"><svg width={18} height={6} aria-hidden="true">
      <line x1={0} x2={18} y1={3} y2={3} stroke={i.color} strokeWidth={2} strokeDasharray={i.dash || undefined} /></svg>
      {i.label}{i.note ? <span className="text-ink-muted"> {i.note}</span> : null}</span>)}</div>;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Where a dataset's random-packing reference came from, in a few words (shown next to its median). */
export function referenceSourceText(src?: NucReferenceSource | null): string {
  if (!src) return '';
  if (src.kind === 'scan') return `; ${src.label ?? 'a scan'}’s reference`;
  if (src.kind === 'override') return '; set by hand';
  const parts = [`calibration population${src.regions ? ` of ${src.regions} windows` : ''}`];
  if (src.files && src.files > 1) parts.push(`${src.files} files pooled`);
  if (src.perWidth) parts.push('per window width');
  return `; ${parts.join(', ')}`;
}

export function referenceSourceTitle(src?: NucReferenceSource | null): string {
  if (!src) return '';
  if (src.kind === 'calibration') return 'The dataset’s random-packing reference, from its calibration population (the same molecules and settings fiberhmm-scan uses: every view is read against the same reference). '
    + (src.reason ? `Not usable: ${src.reason}.` : '');
  return src.kind === 'scan' ? 'Adopted from an open scan’s calibration record.' : 'A reference median set by hand.';
}

function ParamControls({ params, setParams, cohort, setCohort, auto, setAuto }: {
  params: typeof DEFAULT_REG_PARAMS; setParams: (p: Partial<typeof DEFAULT_REG_PARAMS>) => void;
  cohort: NucCohort; setCohort: (v: NucCohort) => void;
  auto: NucAutoAnalyse; setAuto: (v: NucAutoAnalyse) => void;
}) {
  const field = (key: 'window_bp' | 'step_bp' | 'min_calls' | 'mask_open_bp' | 'thin_per_kb' | 'end_min_bp' | 'short_min_bp', label: string, title: string, min = 0, step = 1) =>
    <NumField label={label} value={params[key]} min={min} step={step} testId={`nuc-reg-${key}`} title={title} onChange={v => setParams({ [key]: v })} />;
  return <div className="flex flex-col gap-1.5" data-testid="nuc-reg-controls">
    <Row label="Regularity score" testId="nuc-reg-score-row">
      <Select label="signal" value={params.signal} testId="nuc-reg-signal" options={[['m6a', 'm6A'], ['occupancy', 'Footprints']]}
        onChange={v => setParams({ signal: v })} title="m6A calls, or footprint occupancy (1 inside a nucleosome call)" />
      {field('window_bp', 'window', 'Window length (bp) of each spectrum', 64, 100)}
      {field('step_bp', 'step', 'Distance (bp) between window centres: the tile width', 10, 50)}
      <label className="inline-flex items-center gap-1 text-gray-500 dark:text-gray-400" title="Repeat lengths (bp) the peak is searched in">band
        <input type="number" value={params.band_bp[0]} min={60} step={5} className="input-tool min-h-0 w-12 rounded px-1 py-0.5 text-[11px]"
          data-testid="nuc-reg-band-lo" onChange={e => { const v = Number(e.target.value); if (v > 0 && v < params.band_bp[1]) setParams({ band_bp: [v, params.band_bp[1]] }); }} />–
        <input type="number" value={params.band_bp[1]} max={355} step={5} className="input-tool min-h-0 w-12 rounded px-1 py-0.5 text-[11px]"
          data-testid="nuc-reg-band-hi" onChange={e => { const v = Number(e.target.value); if (v > params.band_bp[0] && v <= 355) setParams({ band_bp: [params.band_bp[0], v] }); }} /></label>
      {field('min_calls', 'min calls', 'm6A windows need at least this many calls', 1)}
      {field('mask_open_bp', 'open mask', 'Mask open stretches at least this long (bp) before the spectrum; 0 = off', 0, 50)}
      {field('thin_per_kb', 'thin to', 'Thin m6A calls to this many per kb before scoring; 0 = off', 0, 5)}
      <Select label="ends" value={params.ends} testId="nuc-reg-ends" options={[['blank', 'blank'], ['extend', 'extend'], ['truncated', 'truncated']]}
        onChange={v => setParams({ ends: v })}
        title="Read ends: blank scores full windows only (the first and last ~875 bp of a read and reads under one window get no tile); extend paints the outer tiles out to the read ends; truncated scores windows cut at the read end down to a minimum width" />
      {params.ends === 'truncated' && field('end_min_bp', 'end min', 'Narrowest cut window (bp) scored at a read end', 64, 100)}
      {params.ends === 'truncated' && field('short_min_bp', 'short min', 'Narrowest window (bp) scored on reads shorter than the window', 64, 100)}
      <button type="button" className="ml-auto text-ink-muted underline" data-testid="nuc-reg-defaults" onClick={() => setParams(DEFAULT_REG_PARAMS)}>Score defaults</button>
    </Row>
    <Row label="Molecules" testId="nuc-reg-cohort-row">
      <Select label="" value={cohort} testId="nuc-reg-cohort" options={[['overlapping', 'overlapping the window'], ['spanning', 'spanning the window']]}
        onChange={setCohort} title="Which molecules count: every molecule overlapping the window (default; fiberhmm-scan's default cohort too) or only those spanning the whole window. Counts, the geometry threshold and shares follow it." />
      <Select label="auto-Analyse" value={auto} testId="nuc-reg-auto" options={AUTO_ANALYSE_OPTIONS.map(([v, label]) => [v, label] as [NucAutoAnalyse, string])}
        onChange={setAuto} title={`Start Analyse by itself on a view without nucleosome calls. ${AUTO_ANALYSE_OPTIONS.map(o => `${o[1]}: ${o[2]}`).join('. ')}.`} />
    </Row>
  </div>;
}

function RampKey({ scale }: { scale?: { zero: number; top: number; reference: boolean } }) {
  return <span className="inline-flex items-center gap-1 text-[11px] text-ink-secondary" data-testid="nuc-reg-ramp"
    title="Read lane colours: the random-packing median of the dataset (pale) to its observed 95th percentile (deep blue)">
    <span className="h-2 w-20 rounded-sm" style={{ background: `linear-gradient(90deg, ${NUC_REG_RAMP.join(',')})` }} />
    {scale ? `${scale.zero.toFixed(1)} → ${scale.top.toFixed(1)}${scale.reference ? '' : ' (typical)'}` : ''}</span>;
}

/** Views (panel, datasets and windows) whose automatic Analyse was started: never started twice for the same view. */
const AUTO_ANALYSED = new Set<string>();
/** Each panel's last answer and the request it answers (a remount for the same request shows it, no request). */
const LAST_ANSWER = new Map<string, { key: string; result: NucRegularityResult }>();

export function RegularityView({ observations, settings, setSettings, revision, includeDuplicates, panelId, analysing = false, onAnalyse,
  settingsOpen = false, onTodo, extraSettings = null }: {
  observations: NucObservation[]; settings: NucPanelState; setSettings: (patch: Partial<NucPanelState>) => void;
  revision: string; includeDuplicates: boolean;
  panelId?: string;
  /** The panel's Analyse is running. */
  analysing?: boolean;
  /** Analyse these datasets in this view (no nucleosome calls yet); the panel's own Analyse. `user`: a click;
   * otherwise an automatic start. Never submitted while any Analyse runs (the server runs one at a time and a new
   * request would replace the running one). Resolves once submitted. */
  onAnalyse?: (datasets: string[], user?: boolean) => Promise<void> | void;
  /** The settings drawer is open (the panel header's Settings). */
  settingsOpen?: boolean;
  /** This view's datasets still without nucleosome calls (the header's Analyse this view analyses them first). */
  onTodo?: (datasets: string[]) => void;
  /** More rows for the settings drawer (the panel's Columns). */
  extraSettings?: ReactNode;
}) {
  // (hidden by full view: as when it was hidden; nothing is asked meanwhile)
  const clusterAssignments = useFrozenWhileInactive(useBrowserStore(s => s.clusterAssignments));
  const panelActive = usePanelActive();
  const series = useMemo(() => regularitySeries(observations, clusterAssignments), [observations, clusterAssignments]);
  const reg = settings.regularity ?? {};
  // The controls show the panel's own settings over FiberHMM's defaults, and every request sends exactly those (all
  // of them): an answer never depends on what another tab or session asked last.
  const params = shownRegParams(reg.params);
  const requestParams = requestRegParams(reg.params);
  const paramsKey = JSON.stringify(requestParams);
  const cohort = cohortOf(reg);
  const auto: NucAutoAnalyse = reg.autoAnalyse ?? DEFAULT_AUTO_ANALYSE;
  const autoRef = useRef(auto);
  autoRef.current = auto;
  const [result, setResult] = useState<NucRegularityResult | null>(null);
  /** The request the result answers (series, revision, parameters): an older view's answer never offers a button. */
  const [resultKey, setResultKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const ctl = useRef<AbortController | null>(null);
  // Membership enters through a digest of the read ids: two equal-sized cohorts are different requests.
  const seriesKey = seriesIdentity(series);
  // The view (datasets and windows): a cluster, filter or hidden-column change keeps it.
  const viewKey = seriesView(series);
  const requestKey = `${seriesKey}|${paramsKey}|${cohort}|${revision}|${includeDuplicates}`;
  const viewRef = useRef(viewKey);
  viewRef.current = viewKey;
  const jobLive = useNucJob(s => isLiveJob(s.job));
  /** Running or being submitted (any caller): never a second submission. */
  const busy = useNucBusy();
  /** The automatic Analyse this panel started in 'every' mode: cancelled when the view moves on before it ends. */
  const autoJob = useRef<{ view: string; jobId: string | null; keys: string[] } | null>(null);
  const cancelSuperseded = () => {
    const a = autoJob.current;
    if (!a || a.view === viewRef.current) return;
    autoJob.current = null;
    for (const k of a.keys) AUTO_ANALYSED.delete(k);     // coming back to that view starts it again
    const st = useNucJob.getState();
    if (a.jobId && st.job?.job_id === a.jobId && st.panelId === panelId && isLiveJob(st.job)) void st.cancel();
  };
  useEffect(() => { cancelSuperseded(); }, [viewKey]);   // eslint-disable-line react-hooks/exhaustive-deps
  // Its last answer is kept only across an export (mounted again for the same request); any other unmount asks again.
  useEffect(() => () => { if (panelId && !useBrowserStore.getState().exportInProgress) LAST_ANSWER.delete(panelId); }, [panelId]);
  const viewSince = useRef(Date.now());
  useEffect(() => { viewSince.current = Date.now(); }, [viewKey]);
  useEffect(() => {
    if (!series.length) { setResult(null); setLoading(false); return; }
    // Mounted again for the very request it last answered (a figure export lays the panel out and back): its answer,
    // without asking the server again.
    const kept = panelId ? LAST_ANSWER.get(panelId) : undefined;
    if (kept && kept.key === requestKey) { setResult(kept.result); setResultKey(requestKey); setLoading(false); return; }
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    // One read reload per settings change: the patch section's request answers too (nucJob.holdNucRefresh).
    const release = holdNucRefresh();
    // Superseded (an Analyse of these datasets, or this panel's newer request): not an error. The answer on show and
    // "Updating…" stay; the Analyse's end moves the revision and this effect asks again, once.
    let superseded = false;
    const timer = setTimeout(() => {
      setLoading(true);
      nucRegularity(series, requestParams, cohort, includeDuplicates, c.signal, false, panelId)
        .then(res => {
          if (c.signal.aborted) return;
          setResult(res); setResultKey(requestKey); setError('');
          if (panelId) LAST_ANSWER.set(panelId, { key: requestKey, result: res });
          // Opening the view asks for regularity: the lane is switched on (unless the user turned it off). New tiles or
          // parameters: read tracks fetch rows carrying them. Both once this change's answers are all in, together.
          const showLane = res.observations.some(o => (o.molecules ?? 0) > 0) ? () => {
            const st = useBrowserStore.getState();
            if (!Object.prototype.hasOwnProperty.call(st.enabledModTypes, 'nucreg')) st.toggleModType('nucreg' as never, true);
          } : undefined;
          void release(res.updatedDatasets, showLane);
        })
        .catch(e => {
          if (c.signal.aborted) return;
          if (isSupersededNuc(e)) { superseded = true; void resyncAfterSuperseded(panelId); return; }
          setError(String(e?.message ?? e));
        })
        .finally(() => { void release(); if (!c.signal.aborted && !superseded) setLoading(false); });
    }, 600);
    return () => { clearTimeout(timer); c.abort(); void release(); };
  }, [seriesKey, paramsKey, cohort, revision, includeDuplicates]);   // eslint-disable-line react-hooks/exhaustive-deps

  // The automatic Analyse: decided from this view's answer, the Auto-Analyse mode and whether an Analyse runs, and
  // decided again whenever any of them changes (a mode change acts on the current view; the end of another panel's
  // Analyse lets a waiting view start). A pending start is dropped when the view, the mode or the job state changes.
  const [autoPending, setAutoPending] = useState(false);
  const answered = !!result && resultKey === requestKey;
  useEffect(() => {
    // never started from a panel hidden by full view: decided again when it is shown
    if (!panelActive || !answered || !result || !onAnalyse || !result.observations.some(o => !o.error)) return;
    const panelKey = panelId ?? 'panel';
    const view = viewKey;
    const missing = datasetsToAnalyse(result.observations);
    if (!missing.length) { consumeAutoAnalyse(auto, panelKey); return; }   // an analysed view uses up 'first'
    // (views whose Analyse the user cancelled are left alone until the user chooses Analyse there)
    const todo = missing.filter(d => !AUTO_ANALYSED.has(`${panelKey}|${view}|${d}`)
      && !autoAnalyseVetoed(observationViews(series.filter(x => x.datasetId === d))));
    if (autoAnalyseAction(auto, panelKey, todo) !== 'run' || busy) return;
    const wait = auto === 'every' ? Math.max(0, AUTO_SETTLE_MS - (Date.now() - viewSince.current)) : 0;
    const start = () => {
      setAutoPending(false);
      const mode = autoRef.current;
      if (viewRef.current !== view || isNucBusy() || autoAnalyseAction(mode, panelKey, todo) !== 'run') return;
      consumeAutoAnalyse(mode, panelKey);
      const keys = todo.map(d => `${panelKey}|${view}|${d}`);
      for (const k of keys) AUTO_ANALYSED.add(k);
      void Promise.resolve(onAnalyse(todo)).then(() => {
        const st = useNucJob.getState();
        const jobId = st.panelId === panelId && isLiveJob(st.job) ? st.job?.job_id ?? null : null;
        if (!jobId && st.error) { for (const k of keys) AUTO_ANALYSED.delete(k); return; }   // not started
        if (mode === 'every') { autoJob.current = { view, jobId, keys }; cancelSuperseded(); }   // the view moved meanwhile
      });
    };
    if (wait <= 0) { start(); return; }
    setAutoPending(true);
    const timer = setTimeout(start, wait);
    return () => { clearTimeout(timer); setAutoPending(false); };
  }, [answered, result, auto, busy, viewKey, panelActive]);   // eslint-disable-line react-hooks/exhaustive-deps

  // An answer for this very view, with no nucleosome calls: offer the Analyse (not while an automatic one is about to
  // start; disabled while any Analyse runs, which this view's then follows).
  const todoNow = answered && result ? datasetsToAnalyse(result.observations) : [];
  const needsAnalyse = todoNow.length > 0 && !analysing && !loading && !autoPending;
  const otherRunning = jobLive && !analysing;
  const todoKey = todoNow.join('\u0000');
  useEffect(() => { onTodo?.(todoNow); }, [todoKey]);   // eslint-disable-line react-hooks/exhaustive-deps

  const setParams = (patch: Partial<typeof DEFAULT_REG_PARAMS>) => {
    const next = { ...params, ...patch };
    setSettings({ regularity: { ...reg, params: {
      ...next, mask_open_bp: next.mask_open_bp > 0 ? next.mask_open_bp : null, thin_per_kb: next.thin_per_kb > 0 ? next.thin_per_kb : null,
    } } });
  };
  const byObs = new Map((result?.observations ?? []).map(o => [o.obsId, o]));
  const rows = series.map(s => ({ s, r: byObs.get(s.obsId) })).filter((x): x is { s: RegSeries; r: NucRegularityObservation } => Boolean(x.r));
  const ok = rows.filter(x => !x.r.error && (x.r.molecules ?? 0) > 0);
  const datasets = result?.datasets ?? {};
  const datasetIds = [...new Set(series.map(s => s.datasetId))];
  const dsLabel = (id: string) => useBrowserStore.getState().datasets.find(d => d.id === id)?.label ?? id;
  const firstScale = datasetIds.map(id => datasets[id]?.scale).find(Boolean);
  const legend = ok.map(({ s }) => ({ key: s.obsId, label: s.label, color: s.seriesColor, dash: s.dash }));
  const density = (counts: number[]) => { const t = counts.reduce((a, b) => a + b, 0) || 1; return counts.map(c => c / t); };
  const mids = (edges: number[]) => edges.slice(0, -1).map((e, i) => (e + edges[i + 1]) / 2);

  const scoreLines: Line[] = [
    ...datasetIds.flatMap((id, i) => {
      const ref = datasets[id]?.reference;
      if (!ref?.hist) return [];
      const m = mids(ref.hist.edges);
      return [{ key: `ref-${id}`, label: `${dsLabel(id)} · random packing`, color: '#9ca3af', dash: datasetIds.length > 1 ? (DASHES[i % DASHES.length] || '3 2') : '3 2',
        points: density(ref.hist.counts).map((v, k) => [m[k], v] as [number, number]), width: 1.4 }];
    }),
    ...ok.map(({ s, r }) => ({ key: s.obsId, label: s.label, color: s.seriesColor, dash: s.dash,
      points: r.scores ? density(r.scores.counts).map((v, k) => [mids(r.scores!.edges)[k], v] as [number, number]) : [] })),
  ];
  // Along the region: regularity score (default), its period, or any layer channel per cluster (the cluster
  // metaprofiles the read panels computed for these molecules; unclustered: the panel's own metaprofile).
  // (An older session's patch-share choice falls back to the score: see trackOptions.)
  const trackChannel = reg.trackChannel && !isPatchChannel(reg.trackChannel) ? reg.trackChannel : REG_SCORE_CHANNEL;
  const clusterProfiles = useBrowserStore(s => s.clusterProfiles);
  const datasetProfiles = useBrowserStore(s => s.datasetProfiles);
  const allDatasets = useBrowserStore(s => s.datasets);
  const trackOptions = useMemo(() => {
    const ids = new Set(series.map(x => x.datasetId));
    // Patch shares are not offered here: they come from the geometry route, and the patch section below draws them
    // per series ("Share in a patch along the locus"); no stored profile holds them.
    const opts = clusterProfileChannelOptions(allDatasets.filter(d => ids.has(d.id))).filter(o => !isPatchChannel(o.key));
    // Regularity first: it is this view's own measure.
    return [...opts.filter(o => isRegularityChannel(o.key)), ...opts.filter(o => !isRegularityChannel(o.key))];
  }, [allDatasets, series]);
  const layerPoints = (s: RegSeries): Array<[number, number | null]> => {
    const data = s.cluster !== undefined ? clusterProfiles[s.stateKey]?.[s.cluster]?.[trackChannel]
      : datasetProfiles[s.stateKey]?.layers?.[trackChannel];
    if (!data?.length) return [];
    const w = (s.end - s.start) / data.length;
    return data.map((v, k) => [s.start + (k + 0.5) * w, Number.isFinite(v) ? v : null]);
  };
  const trackLines: Line[] = isRegularityChannel(trackChannel)
    ? ok.map(({ s, r }) => {
      const values = trackChannel === REG_PERIOD_CHANNEL ? r.track?.period : r.track?.mean;
      return { key: s.obsId, label: s.label, color: s.seriesColor, dash: s.dash,
        points: r.track && values ? values.map((v, k) => [(r.track!.edges[k] + r.track!.edges[k + 1]) / 2, v] as [number, number | null]) : [] };
    })
    : series.map(s => ({ key: s.obsId, label: s.label, color: s.seriesColor, dash: s.dash, points: layerPoints(s) }));
  const trackYLabel = trackChannel === REG_SCORE_CHANNEL ? 'mean score' : trackChannel === REG_PERIOD_CHANNEL ? 'repeat length (bp)' : `${channelLabel(trackChannel)} (share)`;
  const periodLines: Line[] = ok.map(({ s, r }) => ({ key: s.obsId, label: s.label, color: s.seriesColor, dash: s.dash,
    points: r.periods ? density(r.periods.counts).map((v, k) => [r.periods!.values[k], v] as [number, number]) : [] }));
  const acfLines: Line[] = ok.filter(x => x.r.acf?.mean).map(({ s, r }) => ({ key: s.obsId, label: s.label, color: s.seriesColor, dash: s.dash,
    points: r.acf!.lags.map((lag, k) => [lag, lag >= 30 ? r.acf!.mean![k] : null] as [number, number | null]) }));

  // Open in Plots: these charts' lines as supplied series, pinned to the view they were computed for.
  const plotsLocus: PlotLocus | null = series[0] ? { chrom: series[0].chrom, start: series[0].start, end: series[0].end, genome: null } : null;
  const plotsTarget = (name: string, type: PlotType, measures: string) => ({ name, origin: `Nucleosomes › ${name}`, type, locus: plotsLocus, datasets: datasetIds.map(dsLabel), measures });
  const cohortText = `every ${cohort === 'spanning' ? 'spanning' : 'overlapping'} molecule of each series in the view (one per molecule, read filters applied)`;
  const tab = reg.view ?? 'geometries';
  const patchesOpen = reg.patches?.open ?? true;
  const scoreSettings = <>{extraSettings}<ParamControls params={params} setParams={setParams} cohort={cohort}
    setCohort={v => setSettings({ regularity: { ...reg, cohort: v, spanning: v === 'spanning' } })}
    auto={auto} setAuto={v => setSettings({ regularity: { ...reg, autoAnalyse: v } })} /></>;
  // Errors always; the wait for an Analyse and the offer only while patch calling is off (otherwise the patch
  // section's one status line says it).
  const regState = <>
    {error && <p role="status" className="text-red-700 dark:text-red-300" data-testid="nuc-reg-error">{error}</p>}
    {rows.filter(x => x.r.error).map(({ s, r }) => <p key={s.obsId} className="text-amber-700 dark:text-amber-300">{s.label}: {r.error}</p>)}
    {!patchesOpen && !ok.length && analysing && <div data-testid="nuc-reg-analysing"><AnalysisStatus kind="loading">Analysing this view: nucleosome calls first, then the regularity tiles.</AnalysisStatus></div>}
    {!patchesOpen && needsAnalyse && !ok.length && <p className="text-ink-secondary" data-testid="nuc-reg-needs-analyse">
      This view has no nucleosome calls yet{todoNow.length < datasetIds.length ? ` for ${todoNow.map(dsLabel).join(', ')}` : ''}.{otherRunning ? ' Another Analyse is running; this view can be analysed when it ends.' : ' Choose Analyse this view.'}</p>}
    {!patchesOpen && result && !ok.length && !loading && !analysing && !needsAnalyse && <p className="text-ink-secondary" data-testid="nuc-reg-empty">No regularity tiles in this view yet. Choose Analyse this view first.</p>}
  </>;
  const regInfo = <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-ink-secondary" role="status">
    <RampKey scale={firstScale} />
    {datasetIds.map(id => { const ref = datasets[id]?.reference; return ref ? <span key={id} data-testid="nuc-reg-reference"
      title={`${ref.n_windows.toLocaleString()} windows from ${ref.n_molecules} molecules${referenceSourceText(datasets[id]?.source)}. ${referenceSourceTitle(datasets[id]?.source)}`}>
      {dsLabel(id)}: random packing median {fmt(ref.median, 2)}</span> : null; })}
    {loading && <span>Updating…</span>}
  </div>;
  const regCharts = ok.length ? [
    <section key="scores" data-testid="nuc-reg-scores"><MetricTitle title="Score distribution"><p>Tile scores in the window (log2), as shares of tiles; grey dashed: the random-packing reference of each dataset.</p></MetricTitle>
      <LineChart lines={scoreLines} xLabel="score (log2)" yLabel="share" testId="nuc-reg-scores-chart" openInPlots={plotsTarget('Score distribution', 'size-histogram', `log2 tile scores of ${cohortText}, every tile of each molecule; 0.25 bins from −2 to 9 (outside dropped); share of tiles`)} /></section>,
    <section key="track" data-testid="nuc-reg-track"><div className="mb-1 flex flex-wrap items-center gap-1 font-medium text-ink-secondary">Along the region
      <select value={trackChannel} data-testid="nuc-reg-track-channel" title="What the line shows along the region, per cluster and dataset"
        className="rounded border border-line bg-transparent px-1 py-0.5 text-[11px] font-normal dark:border-white/10"
        onChange={e => setSettings({ regularity: { ...reg, trackChannel: e.target.value === REG_SCORE_CHANNEL ? undefined : e.target.value } })}>
        {trackOptions.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
      </select>
      <Info label="Along the region"><p>Mean tile score by position (reference coordinates), from tiles centred in each bin. Regularity period: the tiles' mean local repeat length. A layer: each cluster's metaprofile of that layer (share of its molecules covered at each position).</p></Info></div>
      <LineChart lines={trackLines} xLabel="position" yLabel={trackYLabel} testId="nuc-reg-track-chart" xFormat={v => `${(v / 1000).toFixed(1)}k`} openInPlots={plotsTarget('Along the region', 'metaprofile', isRegularityChannel(trackChannel) ? `mean tile score (or period) of ${cohortText}, tiles binned by their centre` : `each cluster's metaprofile of the layer (share of its molecules covered)`)} /></section>,
    <section key="periods" data-testid="nuc-reg-periods"><MetricTitle title="Local repeat length"><p>The period of each tile’s spectral peak, at the periods the spectrum resolves.</p></MetricTitle>
      <LineChart lines={periodLines} xLabel="repeat length (bp)" yLabel="share" testId="nuc-reg-periods-chart" openInPlots={plotsTarget('Local repeat length', 'nuc-spacing', `the decoded period of every tile of ${cohortText}, at the periods the spectrum resolves; share of tiles`)} /></section>,
    <section key="scatter" data-testid="nuc-reg-scatter"><MetricTitle title="Score and m6A density"><p>Each point is a molecule: its median tile score in the window against its m6A calls per kb there. ρ is Spearman’s correlation over all molecules.</p></MetricTitle>
      <ScatterChart series={ok.map(({ s, r }) => ({ key: s.obsId, label: s.label, color: s.seriesColor, points: r.scatter?.points ?? [] }))} testId="nuc-reg-scatter-chart" />
      <div className="text-[11px] text-ink-secondary">{ok.map(({ s, r }) => <span key={s.obsId} className="mr-2 inline-block" data-testid="nuc-reg-spearman"><span style={{ color: s.seriesColor }}>●</span> {s.label}: ρ {fmt(r.scatter?.spearman, 2)}</span>)}</div></section>,
    <section key="acf" data-testid="nuc-reg-acf"><MetricTitle title="m6A autocorrelation"><p>Mean autocorrelation of m6A calls per molecule, with open stretches of 300 bp or more masked and calls thinned to 25 per kb, so molecules of different density compare.</p></MetricTitle>
      <LineChart lines={acfLines} xLabel="lag (bp)" yLabel="ACF" testId="nuc-reg-acf-chart" openInPlots={plotsTarget('m6A autocorrelation', 'nuc-spacing', `mean masked m6A autocorrelation over the first 200 molecules of each series (open stretches ≥ 300 bp masked, 25 calls per kb); lags 0–1000 bp in 5 bp, below 30 bp blank`)} /></section>,
  ] : [];
  const regTable = ok.length > 0 && <div className="overflow-x-auto"><table className="min-w-full text-[11px]" data-testid="nuc-reg-table">
    <thead><tr className="text-left text-ink-secondary">
      {['Regularity', 'Molecules', 'm6A / kb', 'Footprint median', 'Merged (>230 bp)', 'Spacing', 'Score above random', 'Repeat length'].map(h => <th key={h} className="px-1.5 py-1 font-medium">{h}</th>)}
    </tr></thead>
    <tbody>{ok.map(({ s, r }) => { const m = r.summary; return <tr key={s.obsId} className="border-t border-line dark:border-white/10" data-testid="nuc-reg-row">
      <td className="px-1.5 py-1"><span className="mr-1 inline-block h-2 w-2 rounded-sm" style={{ background: s.seriesColor }} />{s.label}</td>
      <td className="px-1.5 py-1">{m?.molecules ?? 0}</td>
      <td className="px-1.5 py-1">{fmt(num(m?.m6aPerKb), 1)}</td>
      <td className="px-1.5 py-1">{m?.footprintMedian != null ? `${Math.round(m.footprintMedian)} bp` : '—'}</td>
      <td className="px-1.5 py-1">{m?.mergedPct != null ? `${m.mergedPct.toFixed(1)}%` : '—'}</td>
      <td className="px-1.5 py-1">{m?.spacingMedian != null ? `${Math.round(m.spacingMedian)} bp` : '—'}</td>
      <td className="px-1.5 py-1" title={`median score ${fmt(m?.score, 2)}`}>{m?.scoreAboveRef != null ? `${m.scoreAboveRef >= 0 ? '+' : '−'}${Math.abs(m.scoreAboveRef).toFixed(2)}` : fmt(m?.score, 2)}</td>
      <td className="px-1.5 py-1">{m?.repeatLength != null ? `${Math.round(m.repeatLength)} bp` : '—'}</td>
    </tr>; })}</tbody>
  </table></div>;

  return <div className="flex flex-col gap-2.5" data-testid="nuc-regularity">
    <PatchGeometryView series={series} regParams={requestParams} cohort={cohort} settings={settings} setSettings={setSettings}
      revision={revision} includeDuplicates={includeDuplicates} panelId={panelId} analysing={analysing}
      needsAnalyse={needsAnalyse ? todoNow : null}
      regularityState={!answered ? (error ? 'error' : 'loading') : todoNow.length ? 'needs-analyse' : 'ready'} regularityError={error}
      tab={tab} settingsOpen={settingsOpen} scoreSettings={scoreSettings} regState={regState} regInfo={regInfo}
      regSummary={ok.map(({ s, r }) => ({ s, m: r.summary }))} regCharts={regCharts} regTable={regTable}
      legend={ok.length > 0 ? <Legend items={legend} /> : null} />
  </div>;
}
