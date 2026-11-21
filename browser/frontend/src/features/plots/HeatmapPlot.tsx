/**
 * Heatmap in the Plots workspace, per region (regionHeatmap.ts): one row per selected feature, its signal across a
 * window centred on it, the metaprofile on top on the same x axis; sorted by mean / centre / k-means clusters (row
 * blocks, a profile per cluster, Save cluster as BED set) / position / BED column. BED regions go through BedPlot,
 * the same figure. Magma from 0; Compare RdBu_r centred on 0 (per-region A − B or log2; the profile shows the groups).
 * Same stale guard, Gallery hand-off and export as the other types. A click moves the shared locus there.
 * The retired reads × position mode (Where = current view) opens as stored, with a note.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { reportGroupCount } from './compareState';
import { useBrowserStore } from '../../stores/browserStore';
import { HeatmapRowsChart, drawHeatmapRows, heatmapRange, type HeatmapRowsChartProps } from '../../components/charts/HeatmapRowsChart';
import { ChartSaveButton } from '../../components/charts/ChartSaveButton';
import type { FootprintSizesClusters, FootprintSizesTarget } from '../../components/controls/cluster-detail/useFootprintSizeData';
import { AnalysisStatus } from '../../components/controls/shared';
import { COMPARE_MODES, compareBlocker, type CompareMode } from './compare';
import { plotFreshness } from './follow';
import type { ReadGroupDef } from './readGroups';
import { packMatrix, resultIdentity, unpackMatrix, type PackedHeatmap } from './gallery';
import { formatLocus, plotDisplayName, type PlotSpec } from './plotModel';
import { heatmapFigure, heatmapTsv, useHeatmapData, type HeatmapEntry } from './heatmapData';
import { PrereqButton } from './prereqActions';
import { regionHeatmapHeader } from './regionHeatmap';
import { RegionHeatmapActions } from './RegionHeatmapActions';
import { footprintSizeLayerLabel } from '../../utils/footprintSizeSettings';
import { MeasuresHeader, shortHeader } from './MeasuresHeader';

export interface HeatmapResult { entry: HeatmapEntry; plot: PlotSpec; thumb: string; packed: PackedHeatmap }

/** A heatmap entry packed for the Gallery (reads: the sorted rows thinned to twice the row cap). */
export function packHeatmap(e: HeatmapEntry, maxRows: number): PackedHeatmap {
  const base = { mode: e.mode, binBp: e.binBp, start: e.start, groups: e.groups };
  if (e.mode === 'reads') {
    const rows = e.rows ?? [];
    const keep = rows.length > maxRows * 2 ? rows.filter((_, i) => i % Math.ceil(rows.length / (maxRows * 2)) === 0) : rows;
    return { ...base, rows: { group: keep.map(r => r.group), start: keep.map(r => r.start), mean: keep.map(r => r.mean), values: packMatrix(keep.map(r => r.values)) } };
  }
  const feats = e.features ?? [];
  return {
    ...base,
    features: {
      meta: feats.map(f => f.feature), nReads: feats.flatMap(f => f.raws.map(r => r.nReads)),
      coverage: packMatrix(feats.flatMap(f => f.raws.map(r => Array.from(r.coverage)))), signal: packMatrix(feats.flatMap(f => f.raws.map(r => Array.from(r.signal)))),
    },
  };
}

export function unpackHeatmap(p: PackedHeatmap, key: string, locus: HeatmapEntry['locus']): HeatmapEntry {
  const e: HeatmapEntry = { key, locus, mode: p.mode, binBp: p.binBp, start: p.start, groups: p.groups, seeded: true };
  if (p.mode === 'reads' && p.rows) {
    const values = unpackMatrix(p.rows.values);
    e.rows = values.map((v, i) => ({ group: p.rows!.group[i], start: p.rows!.start[i], mean: p.rows!.mean[i], values: v, label: `read ${i + 1}` }));
  } else if (p.features) {
    const cov = unpackMatrix(p.features.coverage), sig = unpackMatrix(p.features.signal);
    const g = p.groups.length;
    e.features = p.features.meta.map((feature, fi) => ({
      feature, raws: p.groups.map((gr, gi) => ({
        group: gr.id, nReads: p.features!.nReads[fi * g + gi] ?? 0,
        coverage: Float64Array.from((cov[fi * g + gi] ?? []).map(v => v ?? 0)), signal: Float64Array.from((sig[fi * g + gi] ?? []).map(v => v ?? 0)),
      })),
    }));
  }
  return e;
}

export function heatmapThumbnail(props: HeatmapRowsChartProps | null, w = 168, h = 104): string {
  if (!props || typeof document === 'undefined') return '';
  try {
    const canvas = document.createElement('canvas');
    canvas.width = w * 2; canvas.height = h * 2;
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    drawHeatmapRows(ctx, w, h, { ...props, width: w, height: h, title: undefined, subtitle: undefined });
    const url = canvas.toDataURL('image/jpeg', 0.72);
    return url.startsWith('data:image/jpeg') ? url : '';
  } catch {
    return '';
  }
}

export interface HeatmapPlotProps {
  plot: PlotSpec;
  target: FootprintSizesTarget;
  clusters: FootprintSizesClusters | null;
  pending: boolean;
  width: number;
  sampleSeed: string;
  settingsKey: string;
  wanted?: { chrom: string; start: number; end: number } | null;
  onPosition?: (chrom: string, pos: number) => void;
  onCompare?: (patch: Partial<Pick<PlotSpec, 'compareMode' | 'compareAB'>>) => void;
  /** The retired mode's way out: Where = selected features. */
  onWhere?: (where: PlotSpec['where']) => void;
  seed?: HeatmapEntry | null;
  onResult?: (r: HeatmapResult) => void;
  readGroups?: ReadGroupDef[] | null;
  groupsSig?: string;
  groupsBlocker?: string | null;
}

const NO_PANELS: FootprintSizesTarget['panels'] = [];

export function HeatmapPlot({ plot, target, clusters, pending: viewPending, width, sampleSeed, settingsKey, wanted, onPosition, onCompare, onWhere, seed, onResult, readGroups = null, groupsSig = '', groupsBlocker = null }: HeatmapPlotProps) {
  const dark = useBrowserStore(s => s.darkMode);
  const featureMode = plot.where === 'features';
  // A features heatmap reads the selection, not the view: moving the view leaves it alone.
  const pending = featureMode ? false : viewPending;
  const byCluster = plot.groupBy === 'cluster';
  const clustersGone = byCluster && !(clusters && clusters.panels.length);
  const shownTarget = useMemo(() => (clustersGone ? { ...target, panels: NO_PANELS } : target), [clustersGone, target]);
  const { entry, requestKey, loading, error, features } = useHeatmapData({ plot, target: readGroups && !readGroups.length ? { ...shownTarget, panels: NO_PANELS } : shownTarget, clusters: byCluster ? clusters : null, sampleSeed, settingsKey, enabled: !pending, seed, readGroups, groupsSig });
  const fresh = plotFreshness({ resultKey: entry?.key ?? null, wantKey: requestKey, pending, loading, error });
  const shown = fresh.showResult && entry ? entry : null;
  const figure = useMemo(() => (shown ? heatmapFigure(plot, shown) : null), [plot, shown]);
  const locusText = formatLocus(shown?.locus ?? null);
  const nRows = figure?.blocks.reduce((n, b) => n + b.rows.length, 0) ?? 0;
  const retired = plot.where === 'view' || plot.where === 'random';
  const header = shown && !retired ? regionHeatmapHeader({ source: footprintSizeLayerLabel(plot.source), regions: (shown.features ?? []).length, what: 'selected features',
    window: `±${Math.round(plot.heatmap.windowBp / 2).toLocaleString('en-US')} bp`, sort: plot.heatmap, seed: plot.sampling.seed, clusters: figure?.clusters?.length ?? null }) : '';
  const chart: HeatmapRowsChartProps | null = figure && shown ? {
    blocks: figure.blocks, start: shown.start, binBp: shown.binBp, relative: shown.mode === 'features', width: Math.max(360, width),
    height: Math.max(220, Math.min(820, 60 + nRows * 3 + (figure.profile ? 112 : 0))), valueLabel: figure.valueLabel, colormap: figure.colormap, reverse: figure.reverse, signed: figure.signed,
    range: heatmapRange(figure.blocks, figure.signed), dark, profile: figure.profile, subtitleInExportOnly: true,
    subtitle: fresh.stale ? '—' : shown.mode === 'reads' ? `${(shown.rows ?? []).length.toLocaleString()} reads · ${nRows.toLocaleString()} rows drawn (retired mode, as stored)` : (header ? shortHeader(plot, `${(shown.features ?? []).length} selected features`) : ''),
    filename: plotDisplayName(plot).replace(/[^\w.-]+/g, '_').slice(0, 80),
  } : null;
  const tsv = useCallback(() => (figure && shown ? heatmapTsv(plot, figure, shown, locusText) : ''), [figure, shown, plot, locusText]);

  const reported = useRef<string | null>(null);
  useEffect(() => {
    if (fresh.state !== 'current' || !entry || entry.seeded || !onResult || !chart) return;
    const id = `${plot.id}|${entry.key}|${resultIdentity(plot)}`;
    if (reported.current === id) return;
    reported.current = id;
    onResult({ entry, plot, thumb: heatmapThumbnail(chart), packed: packHeatmap(entry, plot.heatmap.maxRows) });
  }, [fresh.state, entry, plot, chart, onResult]);

  const groups = shown?.groups ?? [];
  // The builder's Compare reads how many groups the plot drew.
  const knownEmpty = featureMode && (clustersGone || (!!readGroups && !readGroups.length) || !target.panels.length || !features.length);
  const drawnGroups = knownEmpty ? 0 : fresh.state === 'current' && shown && featureMode ? groups.length : null;
  const reloading = featureMode && !knownEmpty && fresh.state === 'updating';
  useEffect(() => { if (drawnGroups != null || reloading) reportGroupCount(plot, drawnGroups); }, [drawnGroups, reloading, plot]);
  const blocker = plot.compare !== 'off' && featureMode && fresh.state === 'current' && !clustersGone ? compareBlocker(groups.length, plot.groupBy) : null;
  const shownWanted = pending && wanted ? wanted : shownTarget;

  return (
    <div className="flex min-h-0 flex-col gap-2" data-testid="plots-heatmap-plot" data-state={clustersGone ? 'no-clusters' : fresh.state}
      data-rows={featureMode ? 'features' : 'reads'} data-computed-for={shown && fresh.state === 'current' ? locusText : ''}
      data-comparing={figure?.comparing ? figure.mode ?? '' : ''} data-row-count={nRows} data-seeded={entry?.seeded && fresh.state === 'current' ? 'true' : undefined}>
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        {fresh.state === 'current' && shown && (
          <span className="text-ink-secondary" data-testid="plots-computed-for">
            {entry?.seeded ? 'From the Gallery · ' : ''}{featureMode ? `${(shown.features ?? []).length} selected features` : <>Computed for <b className="font-semibold">{locusText}</b></>}
          </span>
        )}
        {fresh.state === 'updating' && !clustersGone && (
          <span className="font-medium text-amber-700 dark:text-amber-300" data-testid="plots-updating" role="status">
            Updating… {featureMode ? `${features.length} features` : `→ ${formatLocus(shownWanted)}`}
          </span>
        )}
        {fresh.state === 'error' && <span className="text-red-600" data-testid="plots-error">{error}</span>}
        {chart && !fresh.stale && (
          <span className="ml-auto inline-flex items-center gap-1" data-testid="plots-export">
            <span className="text-ink-secondary">Export</span>
            <ChartSaveButton inline filename={`${chart.filename}_${featureMode ? 'features' : `${target.chrom}_${target.start + 1}`}`} drawFn={(ctx, w, h) => drawHeatmapRows(ctx, w, h, chart)}
              width={chart.width} height={chart.height} dataTsv={tsv} />
          </span>
        )}
      </div>
      {clustersGone && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-[12px] text-amber-900" data-testid="plots-no-clusters" role="status">
          <b>No clusters here.</b> This heatmap is grouped by cluster, and the reads here are not clustered. Cluster them, open the clustered plot from the Gallery, or group by dataset.
        </div>
      )}
      {retired && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-[12px] text-amber-900" data-testid="plots-heatmap-retired" role="status">
          <span>The reads × position heatmap was retired (it redrew the read track).{shown ? ' This card shows it as stored.' : ''} The heatmap is per region now: selected features or BED regions.</span>
          <button type="button" data-testid="plots-heatmap-to-features" onClick={() => onWhere?.('features')} className="rounded bg-amber-600 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-amber-700">Use selected features</button>
        </div>
      )}
      {shown && header && <MeasuresHeader testId="plots-heatmap-measures" short={shortHeader(plot, `${(shown.features ?? []).length} selected features`)} details={header} />}
      <RegionHeatmapActions figure={figure} base={plotDisplayName(plot)} />
      {featureMode && !features.length && (
        <AnalysisStatus kind="empty" center><span className="inline-flex flex-wrap items-center gap-2">No selected features to draw features × position. <PrereqButton kind="select-peaks" /></span></AnalysisStatus>
      )}
      {readGroups && groupsBlocker && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-[12px] text-amber-900" data-testid="plots-groups-blocker" role="status">{groupsBlocker}</div>
      )}
      {figure?.note && !retired && <div className="text-[11px] text-amber-700 dark:text-amber-300" data-testid="plots-heatmap-note">{figure.note}</div>}
      {featureMode && plot.compare !== 'off' && groups.length >= 2 && (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]" data-testid="plots-compare-picker">
          <span className="font-medium">Compare</span>
          <select aria-label="Compare mode" value={plot.compareMode} data-testid="plots-compare-mode" onChange={e => onCompare?.({ compareMode: e.target.value as CompareMode })}
            className="input-tool min-h-0 py-0.5 text-[11px]">
            {COMPARE_MODES.map(m => <option key={m.value} value={m.value}>{m.value === 'auto' ? `Default (${figure?.mode === 'a-vs-b' ? 'A vs B' : 'each vs rest'})` : m.label}</option>)}
          </select>
          <span className="text-ink-secondary">{plot.compare === 'diff' ? 'A − B' : 'log2(A / B)'} per feature; RdBu centred on 0, one range.</span>
        </div>
      )}
      {blocker && <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-[12px] text-amber-900" data-testid="plots-compare-blocker" role="status">{blocker}</div>}
      {!fresh.showResult && fresh.state === 'updating' && <AnalysisStatus kind="loading" compact>Computing {plotDisplayName(plot)}…</AnalysisStatus>}
      {chart && (
        <div className={fresh.stale ? 'pointer-events-none opacity-40 grayscale' : ''} aria-busy={fresh.stale || undefined}>
          <HeatmapRowsChart {...chart} testId="plots-heatmap-chart" dataTsv={tsv}
            onCellClick={fresh.stale || !onPosition ? undefined : (b, r, pos) => {
              if (!shown) return;
              if (shown.mode === 'reads') { onPosition(shown.locus.chrom, pos); return; }
              const label = figure!.blocks[b]?.rows[r]?.label;
              const f = (shown.features ?? []).find(x => x.feature.label === label)?.feature;
              if (f) onPosition(f.chrom, Math.round((f.start + f.end) / 2) + pos);
            }} />
        </div>
      )}
      {fresh.state === 'current' && shown && nRows === 0 && <AnalysisStatus kind="empty" center>No reads with this source here.</AnalysisStatus>}
      <div className="text-[11px] text-ink-secondary" data-testid="plots-caption">
        {featureMode
          ? `Each row a selected feature, ±${Math.round(plot.heatmap.windowBp / 2)} bp around its centre, ${plot.profile.binBp} bp bins, Gaussian σ ${plot.profile.sigmaBp} bp; the metaprofile of each group on top.`
          : 'Retired mode: reads × position over the view, as stored.'}
      </div>
    </div>
  );
}
