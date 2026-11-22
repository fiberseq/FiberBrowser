/**
 * Size enrichment / V-plot pooled over BED anchors (POST /api/plots/bed_sizes): the regions counted in chunks with
 * progress and Cancel (the plot's Random N reads first find the per-dataset key cut), the pooled raw counts finished
 * once on the server, then drawn by the size plots' own figure (sizeFigure: magma / viridis single, RdBu comparisons).
 * x is bp from the anchor; minus-strand regions are flipped. The header says what it measures and the seed.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBrowserStore } from '../../stores/browserStore';
import { fetchJson } from '../../api/sharedFetch';
import { SizeEnrichmentChart } from '../../components/charts/SizeEnrichmentChart';
import { ChartSaveButton } from '../../components/charts/ChartSaveButton';
import type { FootprintSizeData } from '../../api/clustering';
import type { FootprintSizeEntry, FootprintSizePlot, FootprintSizesTarget } from '../../components/controls/cluster-detail/useFootprintSizeData';
import { AnalysisStatus } from '../../components/controls/shared';
import { footprintSizeLayerLabel } from '../../utils/footprintSizeSettings';
import { plotFreshness } from './follow';
import { figureDraw, isComparing, requestSettings, sizeFigure, thumbnail } from './sizeFigure';
import { effectiveSizeSettings, plotDisplayName, samplingText, type PlotSpec } from './plotModel';
import type { RegionSet } from './bedRegions';
import { BED_CHUNK_REGIONS, type BedProgress } from './bedData';
import { BedProgressLine } from './BedPlot';
import { COMPARE_MODES, type CompareMode } from './compare';
import type { SizePlotResult } from './SizePlot';
import { boxMean, boxSummarySpec, ciText, resolveCi, summaryMeasures } from './summary';
import { SummaryChart } from './SummaryChart';
import { compareStateLine, reportGroupCount } from './compareState';
import { CompareStateText } from './ProfileSummaryBlock';
import { MeasuresHeader, shortHeader } from './MeasuresHeader';

type CountGroup = { matrix: number[][]; row: number[]; col: number[]; n_reads: number };

export function bedSizesKey(plot: PlotSpec, sets: RegionSet[], target: FootprintSizesTarget, sampleSeed: string, settingsKey: string): string {
  const b = plot.bed, s = effectiveSizeSettings(plot);
  return JSON.stringify({ kind: 'fiberbrowser.bed_sizes.v1', sets: sets.map(x => [x.id, x.path, x.regions.length]), sub: [b.subsample, b.n, b.maxRegions], anchor: [b.anchor, b.flankBp],
    reads: b.readsPerRegion, occ: b.occlusionRead === 'off' ? 'off' : 'centre', source: plot.source, datasets: [...new Set(target.panels.map(p => p.datasetId))], group: plot.groupBy,
    size: [s.sizeMin, s.sizeMax, s.sizeBin, s.posBin, s.mode, s.normalization, s.sigmaSizeBp, s.sigmaPosBp, s.minFootprints], sampling: plot.sampling, sampleSeed, settingsKey,
    // Compare finishes raw counts (requestSettings), so turning it on or off is a different result.
    counts: plot.compare === 'log2ratio' || plot.compare === 'diff',
    // An enrichment comparison (A vs B) finishes the normalised matrices instead: a different result.
    enr: plot.sizeCompareOn ?? null, mode: plot.compareMode, ab: plot.compareAB, op: plot.compare });
}

/** The finish settings of a BED size plot with `nGroups` groups: counts when comparing (the groups are summed into
 *  "rest" and "all" and compared as the view's size plots are), the plot's normalisation otherwise. */
export function bedFinishSettings(plot: PlotSpec, nGroups: number) {
  return requestSettings(plot, nGroups);
}

/** Add one chunk's raw counts into the running totals (exact sums). */
export function addCounts(into: Record<string, CountGroup>, part: Record<string, CountGroup>): Record<string, CountGroup> {
  for (const [k, g] of Object.entries(part)) {
    const t = into[k];
    if (!t) { into[k] = { matrix: g.matrix.map(r => [...r]), row: [...g.row], col: [...g.col], n_reads: g.n_reads }; continue; }
    g.matrix.forEach((r, i) => r.forEach((v, j) => { t.matrix[i][j] += v; }));
    g.row.forEach((v, i) => { t.row[i] += v; });
    g.col.forEach((v, i) => { t.col[i] += v; });
    t.n_reads += g.n_reads;
  }
  return into;
}

/** The plot's Random N reads as a per-dataset key cut: the N-th smallest key of the reads the counting uses. */
export function keyCuts(names: Record<string, Array<[string, string]>>, n: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [ds, rows] of Object.entries(names)) {
    const keys = [...new Map(rows.map(([nm, k]) => [nm, BigInt(k)])).entries()].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[0] < b[0] ? -1 : 1));
    if (keys.length > n) out[ds] = keys[n - 1][1].toString();
  }
  return out;
}

export function BedSizePlot({ plot, sets, target, width, sampleSeed, settingsKey, seed, onResult, onCompare }: {
  plot: PlotSpec; sets: RegionSet[]; target: FootprintSizesTarget; width: number; sampleSeed: string; settingsKey: string;
  seed?: FootprintSizeEntry | null; onResult?: (r: SizePlotResult) => void; onCompare?: (patch: Partial<Pick<PlotSpec, 'compareMode' | 'compareAB'>>) => void;
}) {
  const dark = useBrowserStore(s => s.darkMode);
  const datasets = useBrowserStore(s => s.datasets);
  const chosen = useMemo(() => sets.filter(s => plot.bed.setIds.includes(s.id)), [sets, plot.bed.setIds]);
  const requestKey = useMemo(() => bedSizesKey(plot, chosen, target, sampleSeed, settingsKey), [plot, chosen, target, sampleSeed, settingsKey]);
  const [entry, setEntry] = useState<FootprintSizeEntry | null>(seed ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const [progress, setProgress] = useState<BedProgress | null>(null);
  const [counts, setCounts] = useState<Array<{ id: string; total: number; read: number }>>([]);
  const [cancelledKey, setCancelledKey] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const ctl = useRef<AbortController | null>(null);
  // The Random N reads cut of the last run (the bootstrap reads the same reads).
  const keyMaxRef = useRef<Record<string, string>>({});
  const entryRef = useRef(entry);
  entryRef.current = entry;
  useEffect(() => { if (seed) setEntry(seed); }, [seed]);
  const cancel = useCallback(() => { ctl.current?.abort(); ctl.current = null; setCancelledKey(requestKey); setLoading(false); }, [requestKey]);
  const s = effectiveSizeSettings(plot);
  const b = plot.bed;

  useEffect(() => {
    if (!chosen.length || !target.panels.length || cancelledKey === requestKey) return;
    if (entryRef.current?.key === requestKey || seed?.key === requestKey) { setLoading(false); return; }
    const controller = new AbortController();
    ctl.current = controller;
    const key = requestKey;
    const startedAt = Date.now();
    setLoading(true); setError(null); setProgress({ done: 0, total: null, startedAt });
    const body = {
      sets: chosen.map(x => ({ id: x.id, regions: x.regions })), dataset_ids: [...new Set(target.panels.map(p => p.datasetId))], anchor: b.anchor, flank_bp: b.flankBp,
      subsample: b.subsample, n: b.n, seed: plot.sampling.seed, max_regions: b.maxRegions, reads_per_region: b.readsPerRegion, sample_seed: sampleSeed,
      layer: plot.source, size_min: s.sizeMin, size_max: s.sizeMax, size_bin: s.sizeBin, pos_bin: s.posBin, mode: s.mode,
      occlusion: b.occlusionRead === 'off' ? 'off' : 'centre', pooled: plot.groupBy === 'none',
    };
    const post = <T,>(extra: object) => fetchJson<T>('/api/plots/bed_sizes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal, body: JSON.stringify({ ...body, ...extra }) });
    (async () => {
      const random = plot.sampling.mode === 'random';
      let keyMax: Record<string, string> = {};
      let total: number | null = null;
      if (random) {
        const names: Record<string, Array<[string, string]>> = {};
        for (let off = 0; total == null || off < total; off += BED_CHUNK_REGIONS) {
          const r = await post<{ success: boolean; jobs_total: number; names: Record<string, Array<[string, string]>> }>({ phase: 'names', job_offset: off, job_limit: BED_CHUNK_REGIONS });
          if (!r.success) return null;
          total = r.jobs_total;
          for (const [ds, rows] of Object.entries(r.names)) (names[ds] ??= []).push(...rows);
          setProgress({ done: Math.min(total, off + BED_CHUNK_REGIONS), total: total * 2, startedAt });
        }
        keyMax = keyCuts(names, plot.sampling.n);
      }
      keyMaxRef.current = keyMax;
      const sums: Record<string, CountGroup> = {};
      let setsInfo: Array<{ id: string; total: number; read: number }> = [];
      let t2: number | null = null;
      for (let off = 0; t2 == null || off < t2; off += BED_CHUNK_REGIONS) {
        const r = await post<{ success: boolean; jobs_total: number; groups: Record<string, CountGroup>; sets: typeof setsInfo }>({ phase: 'count', job_offset: off, job_limit: BED_CHUNK_REGIONS, key_max: keyMax });
        if (!r.success) return null;
        t2 = r.jobs_total;
        setsInfo = r.sets;
        addCounts(sums, r.groups);
        const done = Math.min(t2, off + BED_CHUNK_REGIONS);
        setProgress(random ? { done: t2 + done, total: t2 * 2, startedAt } : { done, total: t2, startedAt });
        if (!t2) break;
      }
      const f = bedFinishSettings(plot, Object.keys(sums).length);
      const fin = await post<{ success: boolean; groups: Array<{ id: string; matrix: (number | null)[][]; n_reads: number; n_footprints: number }> }>({
        phase: 'finish', groups: Object.entries(sums).map(([id, g]) => ({ id, ...g })), normalization: f.normalization, sigma_size_bp: f.sigmaSizeBp, sigma_pos_bp: f.sigmaPosBp,
        row_min_footprints: f.minFootprints });
      return { fin: fin.groups, setsInfo, f };
    })()
      .then(res => {
        if (!res || controller.signal.aborted) return;
        const byPanel: Record<string, Record<string, FootprintSizeData>> = {};
        for (const g of res.fin) {
          const [set, ds] = [g.id.slice(0, g.id.lastIndexOf('|')), g.id.slice(g.id.lastIndexOf('|') + 1)];
          (byPanel[set] ??= {})[ds] = { matrix: g.matrix, size_min: s.sizeMin, size_max: s.sizeMin + Math.floor((s.sizeMax - s.sizeMin) / s.sizeBin) * s.sizeBin, size_bin: s.sizeBin, pos_bin: s.posBin,
            mode: s.mode, normalization: res.f.normalization, row_min_footprints: res.f.minFootprints, sigma_size_bp: res.f.sigmaSizeBp, sigma_pos_bp: res.f.sigmaPosBp, group_by: 'all',
            n_reads: g.n_reads, n_footprints: g.n_footprints, layer: plot.source };
        }
        setCounts(res.setsInfo);
        setEntry({ key, locus: { chrom: chosen[0]?.regions[0]?.[0] ?? '', start: -b.flankBp, end: b.flankBp, genome: null }, byPanel });
      })
      .catch(err => { if (!controller.signal.aborted && err?.name !== 'AbortError') setError({ key, message: `BED size plot could not be computed: ${err instanceof Error ? err.message : String(err)}` }); })
      .finally(() => { if (!controller.signal.aborted) { setLoading(false); setProgress(null); } if (ctl.current === controller) ctl.current = null; });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey, seed, attempt, cancelledKey]);

  const fresh = plotFreshness({ resultKey: entry?.key ?? null, wantKey: requestKey, pending: false, loading, error: error && error.key === requestKey ? error.message : null });
  const dsLabel = (ds: string) => (ds === '*' ? 'All datasets' : datasets.find(d => d.id === ds)?.label ?? ds);
  const plots: FootprintSizePlot[] = useMemo(() => {
    if (!fresh.showResult || !entry) return [];
    const multi = new Set(Object.values(entry.byPanel).flatMap(m => Object.keys(m))).size > 1;
    return chosen.flatMap(set => Object.entries(entry.byPanel[set.id] ?? {}).map(([ds, data]) => ({ id: `${set.id}|${ds}`, title: multi ? `${set.name} · ${dsLabel(ds)}` : set.name, color: set.color, data })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fresh.showResult, entry, chosen, datasets]);
  const cell = Math.max(220, Math.min(320, Math.floor((width - 10 * Math.max(0, Math.min(3, plots.length) - 1)) / Math.max(1, Math.min(3, plots.length)))));
  const figure = useMemo(() => sizeFigure({ plot, plots, start: -b.flankBp, width: cell, height: 280, dark, stale: fresh.stale }), [plot, plots, b.flankBp, cell, dark, fresh.stale]);
  const usedRegions = counts.reduce((a, c) => a + c.read, 0);
  // The box mean's seeded bootstrap (server: every region at once; units regions by default, reads as the option).
  const box = boxSummarySpec(s, plot.summary, { start: -b.flankBp, end: b.flankBp, anchored: true });
  const bootMethod = box.note ? 'none' as const : resolveCi('box-mean', plot.summary);
  const bootSeed = plot.summary.bootSeed ?? plot.sampling.seed;
  // No box bootstrap while comparing: the summary is off then (compareState.summaryBlocker).
  const bootKey = plot.summary.on && bootMethod === 'bootstrap' && entry && fresh.state === 'current' && !isComparing(plot, plots.length)
    ? JSON.stringify([entry.key, plot.summary.resamples, bootSeed, plot.summary.unit, plot.summary.sizeFrom, plot.summary.sizeTo, box.win.from, box.win.to, box.transform]) : null;
  const [boot, setBoot] = useState<{ key: string; intervals: Record<string, { lo: number | null; hi: number | null; units: number }> } | null>(null);
  useEffect(() => {
    if (!bootKey || boot?.key === bootKey) return;
    const controller = new AbortController();
    const body = {
      sets: chosen.map(x => ({ id: x.id, regions: x.regions })), dataset_ids: [...new Set(target.panels.map(p => p.datasetId))], anchor: b.anchor, flank_bp: b.flankBp,
      subsample: b.subsample, n: b.n, seed: plot.sampling.seed, max_regions: b.maxRegions, reads_per_region: b.readsPerRegion, sample_seed: sampleSeed,
      layer: plot.source, size_min: s.sizeMin, size_max: s.sizeMax, size_bin: s.sizeBin, pos_bin: s.posBin, mode: s.mode,
      occlusion: b.occlusionRead === 'off' ? 'off' : 'centre', pooled: plot.groupBy === 'none', key_max: keyMaxRef.current,
      phase: 'bootstrap', normalization: s.normalization, sigma_size_bp: s.sigmaSizeBp, sigma_pos_bp: s.sigmaPosBp, row_min_footprints: s.minFootprints,
      box: { size_from: plot.summary.sizeFrom, size_to: plot.summary.sizeTo, pos_from: box.win.from, pos_to: box.win.to, transform: box.transform },
      resamples: plot.summary.resamples, boot_seed: bootSeed, unit: plot.summary.unit,
    };
    fetchJson<{ success: boolean; intervals: Record<string, { lo: number | null; hi: number | null; units: number }> }>('/api/plots/bed_sizes',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal, body: JSON.stringify(body) })
      .then(r => { if (r.success && !controller.signal.aborted) setBoot({ key: bootKey, intervals: r.intervals }); })
      .catch(() => { /* no interval: the header says so */ });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bootKey]);
  const intervals = boot && boot.key === bootKey ? boot.intervals : null;
  const ciLine = bootMethod === 'bootstrap'
    ? (intervals ? ciText('bootstrap', plot.summary, bootSeed, plot.summary.unit === 'reads' ? 'reads' : 'regions', false, 'box-mean') : bootKey ? 'bootstrap 95% (computing…)' : 'interval not available')
    : bootMethod === 'none' ? 'no interval' : undefined;
  const measures = `${footprintSizeLayerLabel(plot.source)} ${plot.type === 'vplot' ? 'V-plot' : 'size enrichment'} pooled over ${usedRegions.toLocaleString('en-US')} BED regions (±${b.flankBp.toLocaleString('en-US')} bp around the ${b.anchor}, minus strand flipped${b.occlusionRead !== 'off' ? ', reads with a nucleosome over the centre left out' : ''}); ${s.mode === 'span' ? 'full footprint' : 'midpoint'}, ${s.normalization}, ${s.sizeBin} × ${s.posBin} bp bins; up to ${b.readsPerRegion} reads per region; ${samplingText(plot.sampling)}`;
  const whole = useMemo(() => figureDraw(figure.charts, `${plotDisplayName(plot)} · ${measures}`, { cols: Math.min(3, figure.charts.length), dark }), [figure, plot, measures, dark]);
  const reported = useRef<string | null>(null);
  useEffect(() => {
    if (fresh.state !== 'current' || !entry || entry.seeded || !onResult || !plots.length) return;
    const id = `${plot.id}|${entry.key}`;
    if (reported.current === id) return;
    reported.current = id;
    onResult({ entry, plot, items: plots.map(p => ({ id: p.id, title: p.title, color: p.color })), thumb: thumbnail(figure.charts[0]) });
  }, [fresh.state, entry, plot, plots, figure, onResult]);
  const comparing = isComparing(plot, plots.length);
  // The builder's Compare reads how many groups the plot drew.
  const drawnGroups = fresh.state === 'current' && entry ? plots.length : null;
  useEffect(() => { if (drawnGroups != null) reportGroupCount(plot, drawnGroups); }, [drawnGroups, plot]);
  const stateLine = comparing && !fresh.stale ? compareStateLine({ compare: plot.compare, mode: figure.mode, pairs: figure.comparisons, summary: plot.summary.on ? 'blocked' : null }) : null;
  return (
    <div className="flex min-h-0 flex-col gap-2" data-testid="plots-bed-size-plot" data-state={cancelledKey === requestKey ? 'cancelled' : fresh.state} data-plots={plots.length}
      data-seeded={entry?.seeded && fresh.state === 'current' ? 'true' : undefined}>
      <MeasuresHeader testId="plots-size-measures" short={shortHeader(plot, `${usedRegions.toLocaleString('en-US')} BED regions`)} details={measures} />
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        {loading && progress && cancelledKey !== requestKey && <BedProgressLine progress={progress} onCancel={cancel} />}
        {cancelledKey === requestKey && <span className="inline-flex items-center gap-2 text-amber-800" role="status" data-testid="plots-bed-cancelled">Cancelled.
          <button type="button" className="rounded border border-amber-300 px-1.5 py-0.5 font-semibold" onClick={() => { setCancelledKey(null); setAttempt(a => a + 1); }} data-testid="plots-bed-retry">Read again</button></span>}
        {fresh.state === 'error' && <span className="text-red-600" data-testid="plots-error">{error?.message}</span>}
        {plots.length > 0 && <span className="text-ink-secondary" data-testid="plots-bed-counts">{counts.map(c => `${chosen.find(x => x.id === c.id)?.name ?? c.id}: ${c.read.toLocaleString()} of ${c.total.toLocaleString()} regions`).join(' — ')}</span>}
        {plots.length > 0 && (
          <span className="ml-auto inline-flex items-center gap-1" data-testid="plots-export">
            <span className="text-ink-secondary">Export</span>
            <ChartSaveButton inline filename={plotDisplayName(plot).replace(/[^\w.-]+/g, '_').slice(0, 80)} drawFn={ctx => whole.draw(ctx)} width={whole.w} height={whole.h}
              dataTsv={() => [`# measures: ${measures}`, ...plots.map(p => `# ${p.title}\n${p.data.matrix.map(r => r.map(v => (v == null ? 'NA' : String(v))).join('\t')).join('\n')}`)].join('\n')} />
          </span>
        )}
      </div>
      {comparing && plots.length >= 2 && (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]" data-testid="plots-compare-picker">
          <span className="font-medium">Compare</span>
          <select aria-label="Compare mode" value={plot.compareMode} data-testid="plots-compare-mode" onChange={e => onCompare?.({ compareMode: e.target.value as CompareMode })} className="input-tool min-h-0 py-0.5 text-[11px]">
            {COMPARE_MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </div>
      )}
      <CompareStateText text={stateLine} />
      {!chosen.length && <AnalysisStatus kind="empty" center>Add a BED file by path and tick it (More options › Where: BED region sets).</AnalysisStatus>}
      {figure.charts.length > 0 && (
        <div className={`flex flex-wrap gap-[10px] ${fresh.stale ? 'pointer-events-none opacity-40 grayscale' : ''}`} data-testid="plots-size-panels">
          {figure.charts.map(({ key, kind, ...props }) => <SizeEnrichmentChart key={key} testId={kind === 'compare' ? 'plots-size-compare' : 'plots-size-panel'} {...props} />)}
        </div>
      )}
      {plot.summary.on && plots.length > 0 && !comparing && (
        <SummaryChart values={plots.map(p => {
          const v = boxMean(p.data.matrix, p.data, -b.flankBp, plot.summary, { from: box.win.from, to: box.win.to, transform: box.transform });
          const iv = intervals?.[p.id];
          return { id: p.id, title: p.title, ...(p.color ? { color: p.color } : {}), ...v, ...(iv ? { lo: iv.lo, hi: iv.hi } : {}) };
        })}
          chart={plot.summary.chart} dark={dark} reference={box.reference} note={box.note}
          yLabel={box.transform === 'log2' ? 'log2 enrichment' : box.transform === 'log1p' ? 'log1p count' : 'mean value in the box'} filename={`${plotDisplayName(plot).replace(/[^\w.-]+/g, '_').slice(0, 60)}_summary`}
          measures={summaryMeasures('box-mean', box.sEff, 'the plot above', ciLine, { scale: box.scale, isDefault: box.win.isDefault })} />
      )}
    </div>
  );
}
