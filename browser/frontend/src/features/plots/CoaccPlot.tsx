/**
 * Co-accessibility in Plots (the Co-accessibility panel moved here in 3.1.0): the position × position matrix of the
 * view (GET /api/coacc/matrix/data, the same endpoint and numbers), one per dataset or the datasets pooled, counting
 * the reads the panel counted (targeted panels, cluster focus and read filters: useCoaccScope); Compare A − B on one
 * grid (utils/coaccDifference); signal, layer, normalisation, scaling, bins, minimum reads; genes on the edge, the
 * panel's orientation; JSON / TSV / Python exports; the track under the reads (strip, arcs, virtual 4C). Colours follow the colormap rule: signed values (correlation, A − B) on the comparative
 * RdBu centred on 0, the others on magma; the picker overrides. Results land in the Gallery (cells kept exactly while
 * the matrix is small enough) and redraw from it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { reportGroupCount } from './compareState';
import { useBrowserStore } from '../../stores/browserStore';
import { useCoaccScope } from '../../components/controls/co-accessibility/useCoaccScope';
import { useLocusGenes } from '../../hooks/useLocusGenes';
import { panelReversed } from '../../hooks/usePanelDisplayStore';
import { buildCoaccPythonCommand } from '../../utils/coaccessibilityExport';
import { downloadTextFile, exportTimestamp, formatTsv, safeFilenamePart } from '../../utils/analysisExport';
import { getCoaccMatrixData, type CoaccMatrixData } from '../../api/coaccessibility';
import { subtractCoacc } from '../../utils/coaccDifference';
import { HeatmapRowsChart, heatmapRange, squareChartHeight, type HeatmapRowsChartProps } from '../../components/charts/HeatmapRowsChart';

/** The largest square side that fits the window's height (the matrix is seen whole without scrolling). */
export const coaccMaxSide = (): number => Math.max(240, Math.min(900, (typeof window !== 'undefined' ? window.innerHeight : 900) - 260));
import type { FootprintSizesTarget } from '../../components/controls/cluster-detail/useFootprintSizeData';
import { AnalysisStatus } from '../../components/controls/shared';
import { plotFreshness } from './follow';
import { stableDiffKey } from './differentialData';
import type { SuppliedData } from './gallery';
import { COACC_NORMALIZATIONS, formatLocus, plotDisplayName, type PlotSpec } from './plotModel';

export interface CoaccBlock { id: string; title: string; color?: string; data: CoaccMatrixData }
export interface CoaccEntry { key: string; locus: { chrom: string; start: number; end: number; genome: string | null }; blocks: CoaccBlock[]; seeded?: boolean }
export interface CoaccResult { entry: CoaccEntry; plot: PlotSpec; supplied: SuppliedData | null }

/** Cells kept in a Gallery card at most (a larger matrix's card recomputes on Open). */
export const MAX_STORED_COACC_CELLS = 250_000;

/** The values as coloured: log (pseudocount the smallest positive value) or sqrt, negatives at the low end (as the
 *  panel's server-drawn matrix: services/contact_rendering); linear unchanged. */
export function scaleCoaccMatrix(m: (number | null)[][], scaling: 'linear' | 'log' | 'sqrt'): (number | null)[][] {
  if (scaling === 'linear') return m;
  let pc = Infinity;
  if (scaling === 'log') for (const row of m) for (const v of row) if (v != null && v > 0 && v < pc) pc = v;
  if (!Number.isFinite(pc)) pc = 1;
  return m.map(row => row.map(v => (v == null || !Number.isFinite(v) ? null : scaling === 'log' ? Math.log(Math.max(v, 0) + pc) : Math.sqrt(Math.max(v, 0)))));
}

/** "coverage 3–120 (median 40) · ": co-covering reads per cell ('' without coverage). */
export function coverageText(cov: (number | null)[][]): string {
  const v: number[] = [];
  for (const row of cov ?? []) for (const x of row) if (x != null && Number.isFinite(x)) v.push(x);
  if (!v.length) return '';
  v.sort((a, b) => a - b);
  const med = v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
  return `coverage ${v[0]}–${v[v.length - 1]} (median ${med}) · `;
}

/** The share of blank cells (under the minimum reads, or no coverage). */
export function maskedFraction(m: (number | null)[][]): number {
  let blank = 0, all = 0;
  for (const row of m) for (const v of row) { all++; if (v == null || !Number.isFinite(v)) blank++; }
  return all ? blank / all : 0;
}

export const coaccRequestKey = (plot: PlotSpec, target: FootprintSizesTarget, sampleSeed: string | null, settingsKey: string, scope: string | null = null, refresh = 0): string => JSON.stringify({
  kind: 'fiberbrowser.coacc.v1', view: [target.chrom, target.start, target.end, target.genome], group: plot.groupBy,
  // Scaling is display only: it never asks again.
  datasets: [...new Set(target.panels.map(p => p.datasetId))], s: { ...plot.coacc, scaling: undefined }, sampleSeed, settingsKey, scope, refresh: refresh || undefined,
  sampling: plot.sampling.mode === 'random' ? [plot.sampling.n, plot.sampling.seed] : null,
});

/** The blocks drawn: each dataset (or the pooled one), or A − B of two (signed). */
export function coaccFigure(plot: PlotSpec, blocks: CoaccBlock[]): { blocks: Array<{ id: string; title: string; color?: string; matrix: (number | null)[][]; start: number; binBp: number; reads: string }>; signed: boolean; error: string | null } {
  const norm = COACC_NORMALIZATIONS.find(n => n.value === plot.coacc.normalization);
  if (plot.compare === 'diff' && blocks.length >= 2) {
    const ids = blocks.map(b => b.id);
    const a = blocks.find(b => b.id === plot.compareAB?.[0]) ?? blocks[0];
    const b = blocks.find(x => x.id === plot.compareAB?.[1] && x.id !== a.id && ids.includes(x.id)) ?? blocks.find(x => x.id !== a.id)!;
    const d = subtractCoacc(a.data, b.data);
    if ('error' in d) return { blocks: [], signed: true, error: d.error };
    return { blocks: [{ id: `${a.id}~${b.id}`, title: `${a.title} − ${b.title}`, matrix: d.matrix, start: d.start, binBp: d.bin_size, reads: `${d.readsA.toLocaleString()} / ${d.readsB.toLocaleString()} reads` }], signed: true, error: null };
  }
  return { blocks: blocks.map(b => ({ id: b.id, title: b.title, ...(b.color ? { color: b.color } : {}), matrix: b.data.matrix, start: b.data.start, binBp: b.data.bin_size, reads: `${b.data.n_reads.toLocaleString()} reads` })),
    signed: !!norm?.signed, error: null };
}

/** The chart props (one block per matrix, rows labelled by position) on the colormap rule's slot. */
export function coaccChart(plot: PlotSpec, fig: ReturnType<typeof coaccFigure>, width: number, dark = false, maxSide = coaccMaxSide(),
  extra: { genes?: HeatmapRowsChartProps['edgeGenes']; reversed?: boolean } = {}): HeatmapRowsChartProps | null {
  if (!fig.blocks.length) return null;
  const slot = fig.signed ? 'comparative' : 'enrichment';
  const c = plot.size.colormaps[slot];
  const scaling = plot.coacc.scaling ?? 'linear';
  const blocks = fig.blocks.map(b => ({ id: b.id, title: `${b.title} · ${b.reads}`, ...(b.color ? { color: b.color } : {}),
    rows: scaleCoaccMatrix(b.matrix, scaling).map((row, i) => ({ label: (b.start + i * b.binBp).toLocaleString('en-US'), values: row })) }));
  const b0 = fig.blocks[0];
  const signedShown = fig.signed && scaling === 'linear';
  // Square matrices (x and y are the same positions): one square per block, side by side on one scale, the side the
  // shorter of the width and a height that fits the window (maxSide); never stretched to the card.
  const title = plotDisplayName(plot);
  return {
    blocks, start: fig.blocks[0].start, binBp: fig.blocks[0].binBp, width, height: squareChartHeight({ blocks, title }, width, maxSide), square: true,
    ...(extra.genes?.length ? { edgeGenes: extra.genes, region: [b0.start, b0.start + (b0.matrix.length || 0) * b0.binBp] as [number, number] } : {}), ...(extra.reversed ? { reversed: true } : {}),
    title, valueLabel: plot.compare === 'diff' ? `A − B (${COACC_NORMALIZATIONS.find(x => x.value === plot.coacc.normalization)?.label.toLowerCase()})` : COACC_NORMALIZATIONS.find(x => x.value === plot.coacc.normalization)?.label ?? '',
    colormap: c.name, reverse: c.reverse, signed: signedShown, range: heatmapRange(blocks, signedShown), filename: plotDisplayName(plot).replace(/[^\w.-]+/g, '_').slice(0, 80), dark, xLabel: 'position (bp)',
  };
}

/** A result's cells as a Gallery card's supplied matrices (null when too large to keep). */
export function coaccSupplied(entry: CoaccEntry): SuppliedData | null {
  const cells = entry.blocks.reduce((a, b) => a + b.data.matrix.length * (b.data.matrix[0]?.length ?? 0), 0);
  if (cells > MAX_STORED_COACC_CELLS) return null;
  return { series: [], matrices: entry.blocks.map(b => ({ id: b.id, title: b.title, ...(b.color ? { color: b.color } : {}),
    rows: b.data.matrix.map((row, i) => ({ label: i === 0 ? JSON.stringify({ start: b.data.start, bin: b.data.bin_size, n: b.data.n_reads, norm: b.data.normalization, chrom: b.data.chrom, end: b.data.end }) : '', values: row })) })) };
}

/** A Gallery card's matrices back as blocks (the label of row 0 carries the grid). */
export function coaccFromSupplied(key: string, locus: CoaccEntry['locus'], s: SuppliedData): CoaccEntry | null {
  if (!s.matrices?.length) return null;
  const blocks = s.matrices.map(m => {
    const meta = JSON.parse(m.rows[0]?.label ?? '{}') as { start: number; bin: number; n: number; norm: string; chrom: string; end: number };
    const matrix = m.rows.map(r => r.values);
    return { id: m.id, title: m.title, ...(m.color ? { color: m.color } : {}), data: { matrix, coverage: [], chrom: meta.chrom, start: meta.start, end: meta.end, bin_size: meta.bin,
      n_bins: matrix.length, n_reads: meta.n, normalization: meta.norm, marginal_accessibility: [] } as CoaccMatrixData };
  });
  return { key, locus, blocks, seeded: true };
}

export function CoaccPlot({ plot, target, pending, width, sampleSeed, settingsKey, seed, onResult, onCompare, wanted }: {
  plot: PlotSpec; target: FootprintSizesTarget; pending: boolean; width: number; sampleSeed: string | null; settingsKey: string;
  seed?: CoaccEntry | null; onResult?: (r: CoaccResult) => void; onCompare?: (patch: Partial<Pick<PlotSpec, 'compareAB'>>) => void;
  wanted?: { chrom: string; start: number; end: number } | null;
}) {
  const dark = useBrowserStore(s => s.darkMode);
  // The reads the panel counted: the targeted panels' cluster focus and read filters (per dataset).
  const scope = useCoaccScope();
  const scopeByDataset = scope.effectiveReadIdsByDataset;
  const scopeSig = useMemo(() => (scopeByDataset ? JSON.stringify(Object.entries(scopeByDataset).map(([k, v]) => [k, v.length, v.slice(0, 3), v.slice(-3)])) : null), [scopeByDataset]);
  const [refresh, setRefresh] = useState(0);
  const genesRaw = useLocusGenes(target.chrom, target.start, target.end, target.genome ?? null);
  const genes = useMemo(() => genesRaw.map(g => ({ start: g.start, end: g.end, name: g.name || g.id, strand: g.strand })), [genesRaw]);
  const reversed = useBrowserStore(s => panelReversed(s, null));
  const requestKey = useMemo(() => coaccRequestKey(plot, target, sampleSeed, settingsKey, scopeSig, refresh), [plot, target, sampleSeed, settingsKey, scopeSig, refresh]);
  const [entry, setEntry] = useState<CoaccEntry | null>(seed ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const entryRef = useRef(entry);
  entryRef.current = entry;
  useEffect(() => { if (seed) setEntry(seed); }, [seed]);
  useEffect(() => {
    if (pending) return;
    if (entryRef.current?.key === requestKey) { setLoading(false); return; }
    // A Gallery card answers the request whatever the refresh generation since (as the BED and differential cards).
    if (seed && stableDiffKey(seed.key) === stableDiffKey(requestKey)) {
      const adopted = { ...seed, key: requestKey };
      entryRef.current = adopted;
      setEntry(adopted);
      setLoading(false);
      return;
    }
    const datasets = [...new Set(target.panels.map(p => p.datasetId))];
    if (!datasets.length || target.end <= target.start) return;
    let stale = false;
    const key = requestKey;
    const t = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      const scoped = (ids: string[]) => {
        if (!scopeByDataset) return {};
        const by: Record<string, string[]> = {};
        for (const id of ids) if (scopeByDataset[id]) by[id] = scopeByDataset[id];
        return Object.keys(by).length ? { readIdsByDataset: by } : {};
      };
      const opts = (ids: string[]) => ({ datasetIds: ids, normalization: plot.coacc.normalization, minCoverage: plot.coacc.minCoverage, signalType: plot.coacc.signalType,
        ...(plot.coacc.layer ? { layer: plot.coacc.layer } : {}), ...scoped(ids),
        ...(plot.coacc.binBp ? { binSize: plot.coacc.binBp } : {}), ...(target.genome ? { panelGenome: target.genome } : {}), ...(sampleSeed ? { sampleSeed } : {}),
        ...(plot.sampling.mode === 'random' ? { readSample: { n: plot.sampling.n, seed: plot.sampling.seed } } : {}) });
      const groups = plot.groupBy === 'none'
        ? [{ id: 'all', title: 'All datasets', ids: datasets, color: '#52514e' }]
        : datasets.map(ds => { const p = target.panels.find(x => x.datasetId === ds)!; return { id: ds, title: p.datasetLabel ?? p.label, ids: [ds], color: p.color }; });
      (async () => {
        // The first fixes the grid; the rest are asked on its bin width so A − B lines up.
        const out: CoaccBlock[] = [];
        let bin = plot.coacc.binBp || 0;
        for (const g of groups) {
          const data = await getCoaccMatrixData(target.chrom, target.start, target.end, { ...opts(g.ids), ...(bin ? { binSize: bin } : {}) });
          bin = data.bin_size;
          out.push({ id: g.id, title: g.title, ...(g.color ? { color: g.color } : {}), data });
        }
        return out;
      })()
        .then(blocks => { if (!stale) setEntry({ key, locus: { chrom: target.chrom, start: target.start, end: target.end, genome: target.genome }, blocks }); })
        .catch(err => { if (!stale) setError({ key, message: `Co-accessibility could not be computed: ${err instanceof Error ? err.message : String(err)}` }); })
        .finally(() => { if (!stale) setLoading(false); });
    }, 60);
    return () => { stale = true; window.clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey, pending, seed]);

  const fresh = plotFreshness({ resultKey: entry?.key ?? null, wantKey: requestKey, pending, loading, error: error && error.key === requestKey ? error.message : null });
  const blocks = fresh.showResult && entry ? entry.blocks : [];
  // The builder's Compare reads how many groups the plot drew.
  const drawnGroups = fresh.state === 'current' && entry ? blocks.length : null;
  useEffect(() => { if (drawnGroups != null) reportGroupCount(plot, drawnGroups); }, [drawnGroups, plot]);
  const fig = useMemo(() => coaccFigure(plot, blocks), [plot, blocks]);
  const chart = useMemo(() => coaccChart(plot, fig, Math.max(320, width), dark, coaccMaxSide(), { genes, reversed }), [plot, fig, width, dark, genes, reversed]);
  const datasetIds = useMemo(() => [...new Set(target.panels.map(p => p.datasetId))], [target.panels]);
  const [exportNote, setExportNote] = useState<string | null>(null);
  const fileBase = useCallback((suffix: string) => ['coacc', safeFilenamePart(target.chrom), `${target.start}-${target.end}`, safeFilenamePart(plot.coacc.normalization),
    safeFilenamePart(plot.coacc.layer ?? plot.coacc.signalType), suffix, exportTimestamp()].filter(Boolean).join('_'), [target.chrom, target.start, target.end, plot.coacc]);
  const tsv = useCallback(() => coaccTsv(blocks), [blocks]);
  const exportJson = () => {
    const payload = { kind: 'fiberbrowser.coaccessibility.v1', exported_at: new Date().toISOString(),
      settings: { chrom: target.chrom, start: target.start, end: target.end, group_by: plot.groupBy, ...plot.coacc, sample_seed: sampleSeed,
        sampling: plot.sampling, read_filter: { active: !!scopeByDataset, read_ids_by_dataset: scopeByDataset ?? null } },
      blocks: blocks.map(b => ({ id: b.id, title: b.title, data: b.data })) };
    downloadTextFile(JSON.stringify(payload, null, 2), `${fileBase('matrix')}.json`, 'application/json');
    setExportNote('Exported matrix JSON');
  };
  const exportTsv = () => { downloadTextFile(tsv(), `${fileBase('matrix')}.tsv`, 'text/tab-separated-values'); setExportNote('Exported matrix TSV'); };
  const copyPython = async () => {
    const r = buildCoaccPythonCommand({ chrom: target.chrom, start: target.start, end: target.end, datasetIds, normalization: plot.coacc.normalization, minCoverage: plot.coacc.minCoverage,
      binSize: plot.coacc.binBp, signalType: plot.coacc.signalType as never, layer: plot.coacc.layer, readIds: scope.effectiveReadIds, readIdsByDataset: scopeByDataset, sampleSeed: sampleSeed ?? '' });
    try {
      await navigator.clipboard.writeText(r.command);
      setExportNote(!r.exact ? `${r.omittedReadCount.toLocaleString()} scoped read IDs not copied; export JSON for the exact scope` : 'Copied the Python command');
    } catch { setExportNote('Could not copy the Python command'); }
  };
  const summary = blocks.length ? `${blocks.map(b => `${b.title}: ${b.data.n_reads.toLocaleString()} reads`).join(' · ')} · ${blocks[0].data.n_bins.toLocaleString()} bins of ${blocks[0].data.bin_size.toLocaleString()} bp · ${coverageText(blocks[0].data.coverage)}${Math.round(maskedFraction(blocks[0].data.matrix) * 100)}% masked (< ${plot.coacc.minCoverage} reads)`
    + `${scopeByDataset ? ' · read filter / cluster focus applied' : ' · all reads in view'}${sampleSeed ? ` · seed ${sampleSeed}` : ''}` : '';
  const reported = useRef<string | null>(null);
  useEffect(() => {
    if (fresh.state !== 'current' || !entry || entry.seeded || !onResult) return;
    const id = `${plot.id}|${entry.key}|${plot.compare}`;
    if (reported.current === id) return;
    reported.current = id;
    onResult({ entry, plot, supplied: coaccSupplied(entry) });
  }, [fresh.state, entry, plot, onResult]);
  const shownWanted = pending && wanted ? wanted : target;
  return (
    <div className="flex min-h-0 flex-col gap-2" data-testid="plots-coacc-plot" data-state={fresh.state} data-blocks={fig.blocks.length} data-signed={fig.signed ? 'true' : 'false'}
      data-computed-for={entry && fresh.state === 'current' ? formatLocus(entry.locus) : ''} data-seeded={entry?.seeded && fresh.state === 'current' ? 'true' : undefined}>
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        {fresh.state === 'current' && entry && <span className="text-ink-secondary" data-testid="plots-computed-for">{entry.seeded ? 'From the Gallery · ' : ''}Computed for <b className="font-semibold">{formatLocus(entry.locus)}</b></span>}
        {fresh.state === 'updating' && <span className="font-medium text-amber-700 dark:text-amber-300" data-testid="plots-updating" role="status">Updating… → {formatLocus(shownWanted)}</span>}
        {fresh.state === 'error' && <span className="text-red-600" data-testid="plots-error">{error?.message}</span>}
      </div>
      {plot.compare === 'diff' && blocks.length >= 2 && (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]" data-testid="plots-compare-picker">
          <span className="font-medium">A</span>
          <select aria-label="Compare A" data-testid="plots-compare-a" className="input-tool min-h-0 py-0.5 text-[11px]" value={plot.compareAB?.[0] ?? blocks[0].id}
            onChange={e => onCompare?.({ compareAB: [e.target.value, e.target.value === (plot.compareAB?.[1] ?? blocks[1].id) ? (plot.compareAB?.[0] ?? blocks[0].id) : (plot.compareAB?.[1] ?? blocks[1].id)] })}>
            {blocks.map(b => <option key={b.id} value={b.id}>{b.title}</option>)}
          </select>
          <span>− B</span>
          <select aria-label="Compare B" data-testid="plots-compare-b" className="input-tool min-h-0 py-0.5 text-[11px]" value={plot.compareAB?.[1] ?? blocks[1].id}
            onChange={e => onCompare?.({ compareAB: [(plot.compareAB?.[0] ?? blocks[0].id) === e.target.value ? (plot.compareAB?.[1] ?? blocks[1].id) : (plot.compareAB?.[0] ?? blocks[0].id), e.target.value] })}>
            {blocks.map(b => <option key={b.id} value={b.id}>{b.title}</option>)}
          </select>
          <span className="text-ink-secondary">cell by cell on one grid; RdBu centred on 0, red = higher in A.</span>
        </div>
      )}
      {fig.error && <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-[12px] text-amber-900" role="status" data-testid="plots-compare-blocker">{fig.error}</div>}
      {plot.compare === 'diff' && fresh.state === 'current' && blocks.length < 2 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-[12px] text-amber-900" role="status" data-testid="plots-compare-blocker">A − B needs two datasets (group by dataset).</div>
      )}
      {!fresh.showResult && fresh.state === 'updating' && <AnalysisStatus kind="loading" compact>Computing co-accessibility for {formatLocus(shownWanted)}…</AnalysisStatus>}
      {target.end - target.start > 100_000 && <AnalysisStatus kind="warning" compact>Co-accessibility is limited to about a read length (~15 kb): zoom in for a useful matrix.</AnalysisStatus>}
      <div className="flex flex-wrap items-center gap-1 text-[11px]" data-testid="plots-coacc-actions">
        <button type="button" className="rounded border border-gray-200 px-1.5 py-0.5 hover:bg-gray-50 dark:border-gray-700" data-testid="plots-coacc-refresh" onClick={() => setRefresh(r => r + 1)} title="Recompute the matrix">Refresh</button>
        <button type="button" className="rounded border border-gray-200 px-1.5 py-0.5 hover:bg-gray-50 disabled:opacity-40 dark:border-gray-700" data-testid="plots-coacc-export-json" disabled={!blocks.length} onClick={exportJson} title="The settings, read scope and matrices as JSON (reproducible)">JSON</button>
        <button type="button" className="rounded border border-gray-200 px-1.5 py-0.5 hover:bg-gray-50 disabled:opacity-40 dark:border-gray-700" data-testid="plots-coacc-export-tsv" disabled={!blocks.length} onClick={exportTsv} title="The matrix values as TSV, bin by bin">TSV</button>
        <button type="button" className="rounded border border-gray-200 px-1.5 py-0.5 hover:bg-gray-50 dark:border-gray-700" data-testid="plots-coacc-copy-python" onClick={() => { void copyPython(); }} title="Copy the equivalent BrowserClient command">Python</button>
        {exportNote && <span className="text-ink-secondary" role="status" data-testid="plots-coacc-status">{exportNote}</span>}
      </div>
      {summary && fresh.state === 'current' && <div className="text-[11px] text-ink-secondary" data-testid="plots-coacc-summary">{summary}</div>}
      {chart && <div className={fresh.stale ? 'pointer-events-none opacity-40 grayscale' : ''}><HeatmapRowsChart testId="plots-coacc-chart" {...chart} dataTsv={tsv} /></div>}
      {plot.coacc.scaling !== 'linear' && fig.signed && <div className="text-[10px] text-ink-secondary" data-testid="plots-coacc-log-negative-note">{plot.coacc.scaling === 'log' ? 'Log' : 'Square-root'} scale: negative values are drawn at the low end of the colour scale (they have no {plot.coacc.scaling === 'log' ? 'log' : 'root'}). Linear shows their sign.</div>}
      <div className="text-[11px] text-ink-secondary" data-testid="plots-caption">
        {COACC_NORMALIZATIONS.find(n => n.value === plot.coacc.normalization)?.help} Signal: {plot.coacc.signalType}{plot.coacc.layer ? ` (layer ${plot.coacc.layer})` : ''}; cells under {plot.coacc.minCoverage} co-covering reads blank; {plot.coacc.binBp ? `${plot.coacc.binBp} bp bins` : 'automatic bins'}; {plot.coacc.scaling} colour scale. Reads: the targeted panels, narrowed by their cluster focus and read filters.
      </div>
    </div>
  );
}

/** The matrices as TSV: a block per matrix, bins labelled chrom:start-end, the values exactly (blank: NA). */
export function coaccTsv(blocks: CoaccBlock[]): string {
  return blocks.map(b => {
    const d = b.data;
    const labels = Array.from({ length: d.n_bins }, (_, i) => { const s0 = d.start + i * d.bin_size; return `${d.chrom}:${s0}-${Math.min(d.end, s0 + d.bin_size)}`; });
    return [`# ${b.title} · ${d.normalization} · ${d.n_reads} reads`, formatTsv([['bin', ...labels], ...d.matrix.map((row, i) => [labels[i], ...row.map(v => (v == null ? 'NA' : v))])])].join('\n');
  }).join('\n');
}
