/**
 * Clusters › Footprint sizes: footprint size (y) by position (x), one plot per dataset (all reads, no clustering
 * needed) or per cluster, side by side on one colour scale, with an optional log2 ratio of two of them.
 *
 * Views (one click each; FOOTPRINT_SIZE_VIEW_PRESETS): Size enrichment, the default (full footprint, each size row
 * over its mean across the window, Gaussian smoothing), and V-plot (midpoints, counts). Every knob is a setting
 * (utils/footprintSizeSettings, saved with the session). One request per round to /api/cluster/vplot
 * (group_by 'all' or per cluster, raw values).
 */
import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../../stores/browserStore';
import { SizeEnrichmentChart } from '../../charts/SizeEnrichmentChart';
import {
  ALL_FOOTPRINTS, FOOTPRINT_SIZE_NORMALIZATION_LABELS, FOOTPRINT_SIZE_NORMALIZATIONS, FOOTPRINT_SIZE_VIEW_HELP, footprintSizeCaption,
  colorSlotOf, DEFAULT_FOOTPRINT_SIZE_COLORMAPS, footprintSizeLayerOptions, footprintSizeSummary, isEnrichment, matchingView, withView,
  type FootprintSizeNormalization, type FootprintSizeSettings, type FootprintSizeView,
} from '../../../utils/footprintSizeSettings';
import {
  colorScaleFor, densityNote, displayMatrix, ratioMatrix, ratioScale, sizeMatrixTsv, type SizeMatrix,
} from '../../../utils/footprintSizeMatrix';
import { getLayerColor } from '../../../utils/layerColors';
import { FOOTPRINT_SIZE_COLORMAP_LABELS, FOOTPRINT_SIZE_COLORMAPS, type FootprintSizeColormap } from '../../../utils/footprintSizeColormaps';
import { downloadTextFile } from '../../../utils/analysisExport';
import { AnalysisSelect, AnalysisSettingsSection, AnalysisStatus } from '../shared';
import {
  footprintSizePlots, useFootprintSizeData,
  type FootprintSizePlot, type FootprintSizesClusters, type FootprintSizesTarget,
} from './useFootprintSizeData';
import { pickedClusterData, useClusterPicks } from './clusterPicks';
import { ClusterPickChips } from './ClusterPickChips';
import { openPlots } from '../../../features/plots/workspace';
import { useLayerColorVersion } from '../../../features/layerColours/state';

export type { FootprintSizePanel, FootprintSizesTarget } from './useFootprintSizeData';

export interface FootprintSizesViewProps {
  /** All reads, per dataset (always available). */
  allReads: FootprintSizesTarget;
  /** Per cluster (only with clusters). */
  clusters?: FootprintSizesClusters | null;
  chartWidth: number;
  isFullView?: boolean;
  sampleSeed?: string;
  /** Quality filters and layer inference (the reads the plots rest on). */
  settingsKey?: string;
  /** Shown above the plots (e.g. panels at another locus left out). */
  note?: string | null;
}

type Plot = FootprintSizePlot;

export const SIZE_BINS = [1, 2, 5, 10, 20, 50];
export const POS_BINS = [1, 2, 5, 10, 20, 50, 100];
export const SIZE_PRESETS = [
  { value: '10-300', label: 'All (10-300)' },
  { value: '10-120', label: 'Small FP (10-120)' },
  { value: '35-80', label: 'TF-size (35-80)' },
  { value: '80-240', label: 'Nuc (80-240)' },
  { value: '10-600', label: 'Wide (10-600)' },
];
export const COLOR_MAX_ENRICH = [{ value: 0, label: 'Auto' }, ...[1.5, 2, 3, 4, 8].map(v => ({ value: v, label: `${v}x` }))];

function Segmented<T extends string>({ value, options, onChange, testId, label }: {
  value: T | null; options: Array<{ value: T; label: string; title: string }>; onChange: (v: T) => void; testId: string; label: string;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-md border border-cyan-200 bg-white p-0.5 dark:border-cyan-900/60 dark:bg-gray-900" data-testid={testId}>
      {options.map(o => (
        <button key={o.value} type="button" title={o.title} aria-pressed={value === o.value} data-testid={`${testId}-${o.value}`}
          onClick={() => onChange(o.value)}
          className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${value === o.value
            ? 'bg-cyan-600 text-white' : 'text-gray-600 hover:bg-cyan-50 dark:text-gray-300 dark:hover:bg-cyan-950/40'}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A number box that commits on blur or Enter (typing "250" does not snap at "2"). */
export function CommitNumber({ value, onCommit, min, ariaLabel, className, testId }: {
  value: number; onCommit: (v: number) => void; min: number; ariaLabel: string; className: string; testId?: string;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => { setText(String(value)); }, [value]);
  const commit = () => { const v = Number(text); if (Number.isFinite(v) && v >= min && v !== value) onCommit(v); else setText(String(value)); };
  return (
    <input type="number" value={text} min={min} aria-label={ariaLabel} data-testid={testId} className={className}
      onChange={e => setText(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') commit(); }} />
  );
}

export function SigmaInput({ label, value, onChange, testId, title }: { label: string; value: number; onChange: (v: number) => void; testId: string; title: string }) {
  return (
    <label className="inline-flex items-center gap-1 cursor-help" title={title}>
      <span>{label}</span>
      <input type="number" min={0} step={5} value={value} data-testid={testId} aria-label={`Gaussian sigma, ${label}, bp`}
        onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v) && v >= 0) onChange(v); }}
        className="input-tool w-14 min-h-0 py-0.5 text-[11px]" />
      <span>bp</span>
    </label>
  );
}

export function FootprintSizesView({ allReads, clusters, chartWidth, isFullView, sampleSeed, settingsKey = '', note }: FootprintSizesViewProps) {
  // Re-render when the user's layer colours change (Labels → Layer colours).
  const layerColorVersion = useLayerColorVersion();
  const settings = useBrowserStore(s => s.footprintSizeSettings);
  const setSettings = useBrowserStore(s => s.setFootprintSizeSettings);
  const dark = useBrowserStore(s => s.darkMode);
  const datasets = useBrowserStore(s => s.datasets);
  // Min footprints' uncalled-read rule: the plots are of the reads the read track shows.
  const layerOptions = useMemo(() => footprintSizeLayerOptions(datasets, settings.layer), [datasets, settings.layer, layerColorVersion]);
  const [showSettings, setShowSettings] = useState(false);
  const useClusters = !!clusters && clusters.panels.length > 0 && settings.groupBy === 'clusters';
  const target = useClusters ? clusters! : allReads;
  const picks = useClusterPicks(useClusters ? clusters!.panels.map(p => p.key) : []);

  const { entry, requestKey, loading, error } = useFootprintSizeData({
    target, useClusters, clusters, settings, sampleSeed, settingsKey,
  });

  const byPanel = entry?.key === requestKey ? entry.byPanel : null;
  const shownClusters = useClusters ? pickedClusterData(clusters!.visible, picks.picked) : [];

  // The plots, in panel order: one per dataset (panels sharing a dataset show it once), or per cluster.
  const plots: Plot[] = useMemo(() => footprintSizePlots(byPanel, target.panels, useClusters, shownClusters),
    [byPanel, target.panels, useClusters, shownClusters]);

  const display = useMemo(() => plots.map(p => displayMatrix(p.data.matrix, settings)), [plots, settings]);
  const sharedScale = useMemo(() => colorScaleFor(display, settings), [display, settings]);
  const note2 = densityNote(plots.map(p => ({ label: p.title, nReads: p.data.n_reads, nFootprints: p.data.n_footprints })));

  const ratio = settings.ratio && plots.find(p => p.id === settings.ratio![0]) && plots.find(p => p.id === settings.ratio![1])
    ? settings.ratio : null;
  const ratioPlot = useMemo(() => {
    if (!ratio) return null;
    const a = plots.find(p => p.id === ratio[0])!;
    const b = plots.find(p => p.id === ratio[1])!;
    const m = ratioMatrix(a.data.matrix, b.data.matrix, settings, a.data.n_footprints, b.data.n_footprints);
    return { a, b, m, scale: ratioScale(m, settings) };
  }, [ratio, plots, settings]);

  // Side by side while each plot keeps at least 230 px (a narrow panel wraps).
  const cols = Math.max(1, Math.min((plots.length + (ratio ? 1 : 0)) || 1, Math.floor((chartWidth + 8) / 238)));
  const plotW = Math.max(230, Math.floor((chartWidth - (cols - 1) * 8) / cols));
  const plotH = isFullView ? 300 : 240;
  const view = matchingView(settings);
  const enrichment = isEnrichment(settings.normalization);
  const colorSlot = colorSlotOf(settings);
  const colormap = settings.colormaps[colorSlot];
  const comparativeMap = settings.colormaps.comparative;
  const colormapOptions = (slot: 'comparative' | 'enrichment' | 'vplot') => FOOTPRINT_SIZE_COLORMAPS.map(c => ({
    value: c, label: `${FOOTPRINT_SIZE_COLORMAP_LABELS[c]}${c === DEFAULT_FOOTPRINT_SIZE_COLORMAPS[slot].name ? ' (default)' : ''}`,
  }));
  const valueLabel = enrichment ? 'enrichment' : 'footprints';
  const stamp = settings.view === 'enrichment' ? 'size_enrichment' : 'vplot';
  const tsvOf = (p: Plot) => sizeMatrixTsv(p.data.matrix, {
    sizeMin: p.data.size_min, sizeMax: p.data.size_max, sizeBin: p.data.size_bin, posBin: p.data.pos_bin,
    nReads: p.data.n_reads, nFootprints: p.data.n_footprints,
  }, settings, { title: p.title, chrom: target.chrom, start: target.start });
  const exportAll = () => {
    const parts = plots.map(tsvOf);
    if (ratioPlot) {
      parts.push(sizeMatrixTsv(ratioPlot.m, { sizeMin: ratioPlot.a.data.size_min, sizeMax: ratioPlot.a.data.size_max, sizeBin: ratioPlot.a.data.size_bin,
        posBin: ratioPlot.a.data.pos_bin, nReads: 0, nFootprints: 0 }, settings,
      { title: `log2 ratio ${ratioPlot.a.title} / ${ratioPlot.b.title}`, chrom: target.chrom, start: target.start,
        value: enrichment ? 'log2 ratio of enrichment' : 'log2 ratio of footprint fractions (counts / footprints)', comparative: true }));
    }
    downloadTextFile(parts.join('\n'), `footprint_${stamp}_${target.chrom}_${target.start + 1}-${target.end}.tsv`, 'text/tab-separated-values');
  };
  const set = (patch: Partial<FootprintSizeSettings>) => setSettings(patch);
  const presetValue = `${settings.sizeMin}-${settings.sizeMax}`;
  const presets = SIZE_PRESETS.some(o => o.value === presetValue) ? SIZE_PRESETS : [...SIZE_PRESETS, { value: presetValue, label: `Custom (${presetValue})` }];

  return (
    <div className="space-y-2" data-testid="footprint-sizes" data-view={view ?? 'custom'} data-group={useClusters ? 'clusters' : 'datasets'}
      data-normalization={settings.normalization} data-mode={settings.mode}>
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-gray-600 dark:text-gray-300">
        <Segmented<FootprintSizeView> label="View" testId="footprint-sizes-view" value={view}
          onChange={v => setSettings(withView(settings, v))}
          options={[
            { value: 'enrichment', label: 'Size enrichment', title: FOOTPRINT_SIZE_VIEW_HELP.enrichment },
            { value: 'vplot', label: 'V-plot', title: FOOTPRINT_SIZE_VIEW_HELP.vplot },
          ]} />
        {clusters && clusters.panels.length > 0 && (
          <Segmented<'clusters' | 'datasets'> label="One plot per" testId="footprint-sizes-group" value={useClusters ? 'clusters' : 'datasets'}
            onChange={v => set({ groupBy: v })}
            options={[
              { value: 'clusters', label: 'Per cluster', title: 'One plot per cluster of the current clustering.' },
              { value: 'datasets', label: 'Per dataset', title: 'One plot per dataset from all its reads in view (no clustering needed).' },
            ]} />
        )}
        <AnalysisSelect<FootprintSizeNormalization> label="Normalise" value={settings.normalization}
          onChange={v => set({ normalization: v })}
          options={FOOTPRINT_SIZE_NORMALIZATIONS.map(n => ({ value: n, label: FOOTPRINT_SIZE_NORMALIZATION_LABELS[n].label }))}
          title={FOOTPRINT_SIZE_NORMALIZATIONS.map(n => `${FOOTPRINT_SIZE_NORMALIZATION_LABELS[n].label}: ${FOOTPRINT_SIZE_NORMALIZATION_LABELS[n].help}`).join('\n')}
          selectClassName="w-28" />
        <Segmented<'span' | 'midpoint'> label="Footprint as" testId="footprint-sizes-mode" value={settings.mode}
          onChange={v => set({ mode: v })}
          options={[
            { value: 'span', label: 'Full footprint', title: 'Each footprint adds to every position it covers, in the row of its size.' },
            { value: 'midpoint', label: 'Midpoint', title: 'Each footprint counted once, at its centre (the classic V-plot).' },
          ]} />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-600 dark:text-gray-300" data-testid="footprint-sizes-gaussian">
        <span className="font-medium" title="A separable 2-D Gaussian applied to the counts before normalising; each axis has its own sigma, in bp (0 = off).">Gaussian σ</span>
        <SigmaInput label="size" value={settings.sigmaSizeBp} onChange={v => set({ sigmaSizeBp: v })} testId="footprint-sizes-sigma-size"
          title={`Smoothing down the footprint-size axis, in bp (${settings.sizeBin} bp size bins: σ = ${(settings.sigmaSizeBp / settings.sizeBin).toFixed(1)} bins). 0 = off.`} />
        <SigmaInput label="position" value={settings.sigmaPosBp} onChange={v => set({ sigmaPosBp: v })} testId="footprint-sizes-sigma-pos"
          title={`Smoothing along positions, in bp (${settings.posBin} bp position bins: σ = ${(settings.sigmaPosBp / settings.posBin).toFixed(1)} bins). 0 = off.`} />
        <AnalysisSelect<number> label="Size bin" value={settings.sizeBin} onChange={v => set({ sizeBin: v })}
          options={SIZE_BINS.map(v => ({ value: v, label: `${v} bp` }))} selectClassName="w-16" />
        <AnalysisSelect<number> label="Pos bin" value={settings.posBin} onChange={v => set({ posBin: v })}
          options={POS_BINS.map(v => ({ value: v, label: `${v} bp` }))} selectClassName="w-16" />
        <button type="button" data-testid="footprint-sizes-open-in-plots"
          onClick={() => openPlots({
            type: settings.view === 'vplot' ? 'vplot' : 'size-enrichment', source: settings.layer, where: 'view',
            groupBy: useClusters ? 'cluster' : 'dataset', compare: ratio ? 'log2ratio' : 'off', size: { ...settings, ratio: null },
          })}
          className="rounded border border-cyan-200 px-1.5 py-0.5 text-[11px] text-cyan-800 hover:bg-cyan-50 dark:border-cyan-900/60 dark:text-cyan-200 dark:hover:bg-cyan-950/40"
          title="Open in Plots: the same plot with these settings, in the Plots workspace (save, name, pin, export).">
          Open in Plots
        </button>
        {plots.length > 0 && (
          <button type="button" onClick={exportAll} data-testid="footprint-sizes-export-tsv"
            className="ml-auto rounded border border-gray-200 px-1.5 py-0.5 text-[11px] hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
            title="Every plot's matrix (and the ratio, if shown) as TSV, each with its settings in a # header. Each plot's own menu (top right, on hover) saves PNG, SVG or PDF.">
            Export TSV
          </button>
        )}
      </div>
      <AnalysisSettingsSection open={showSettings} onOpenChange={setShowSettings} theme="cyan" title="More settings"
        summary={footprintSizeSummary(settings)} tourId="clusters-vplot-settings">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-500">
          <AnalysisSelect label="Sizes" value={presetValue} onChange={v => { const [lo, hi] = String(v).split('-').map(Number); set({ sizeMin: lo, sizeMax: hi }); }}
            options={presets} selectClassName="w-28" />
          <label className="inline-flex items-center gap-1">Range
            <CommitNumber value={settings.sizeMin} min={0} onCommit={v => set({ sizeMin: v })} className="input-tool w-14 min-h-0 py-0.5 text-[11px]" ariaLabel="Smallest size" />
            -
            <CommitNumber value={settings.sizeMax} min={10} onCommit={v => set({ sizeMax: v })} className="input-tool w-14 min-h-0 py-0.5 text-[11px]" ariaLabel="Largest size" />
            bp
          </label>
          <label className="inline-flex items-center gap-1 cursor-help" title="Size rows (per size row, obs / expected) or positions (per position) drawn from fewer footprints than this are left blank (hatched): a handful of footprints divided by its own mean is noise.">
            Min footprints
            <CommitNumber value={settings.minFootprints} min={0} testId="footprint-sizes-min-footprints" ariaLabel="Min footprints"
              onCommit={v => set({ minFootprints: v })} className="input-tool w-14 min-h-0 py-0.5 text-[11px]" />
          </label>
          <label className="inline-flex items-center gap-1" title={enrichment ? 'Colour by log2 enrichment, centred on 0 (1x): 0.5x and 2x are -1 and +1, equally far from the middle.' : 'Colour counts on a log scale (log1p).'}>
            <input type="checkbox" checked={settings.log} onChange={e => set({ log: e.target.checked })} className="h-3 w-3 accent-cyan-600" data-testid="footprint-sizes-log" />
            {enrichment ? 'log2 colour' : 'Log colour'}
          </label>
          <span data-testid="footprint-sizes-colormap" className="inline-flex">
          <AnalysisSelect<FootprintSizeColormap> label="Colormap" value={colormap.name}
            onChange={v => set({ colormaps: { ...settings.colormaps, [colorSlot]: { ...colormap, name: v } } })}
            options={colormapOptions(colorSlot)}
            selectClassName="w-36"
            title="Colours of these plots, their colour bars and the PNG / SVG / PDF downloads. Size enrichment and V-plot each keep their own pick (defaults: magma, and viridis as V-plots have always used); the log2 ratio plot has its own, beside its picker (default RdBu, centred on 0). A diverging colormap keeps 0 (1x) at its white middle." />
          </span>
          <label className="inline-flex items-center gap-1" title="Run the colormap the other way round (for this view).">
            <input type="checkbox" checked={colormap.reverse} onChange={e => set({ colormaps: { ...settings.colormaps, [colorSlot]: { ...colormap, reverse: e.target.checked } } })} className="h-3 w-3 accent-cyan-600" data-testid="footprint-sizes-colormap-reverse" />
            Reverse
          </label>
          <AnalysisSelect label="Colour range" value={settings.scale} onChange={v => set({ scale: v as FootprintSizeSettings['scale'] })}
            options={[{ value: 'shared', label: 'Shared' }, { value: 'per_panel', label: 'Per plot' }]} selectClassName="w-20"
            title="Shared: one colour range for every plot, so they compare directly. Per plot: each its own." />
          {enrichment && (
            <AnalysisSelect<number> label="Limit" value={settings.colorMax ?? 0} onChange={v => set({ colorMax: v || null })}
              options={COLOR_MAX_ENRICH} selectClassName="w-16" title="The fold change at either end of the colour scale (Auto: the 95th percentile of the fold changes, kept between 1.25x and 4x)." />
          )}
          <div className="flex basis-full flex-wrap items-center gap-1" data-testid="footprint-sizes-layer"
            title="Source of the footprints: All footprints (the Nuc and TF layers together, the default) or one of the layers in the Layers toolbar.">
            <span>Layer</span>
            {layerOptions.map(o => (
              <button key={o.value} type="button" data-layer={o.value} aria-pressed={settings.layer === o.value} title={o.title}
                onClick={() => set({ layer: o.value })}
                className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] ${settings.layer === o.value
                  ? 'border-cyan-500 bg-cyan-50 text-cyan-800 dark:border-cyan-600 dark:bg-cyan-950/40 dark:text-cyan-200'
                  : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50 dark:border-white/10 dark:bg-transparent dark:text-gray-300'}`}>
                {o.value === ALL_FOOTPRINTS
                  ? <span aria-hidden="true" className="inline-flex"><span className="h-2 w-1 rounded-l-sm" style={{ backgroundColor: getLayerColor('nuc') }} /><span className="h-2 w-1 rounded-r-sm" style={{ backgroundColor: getLayerColor('tf') }} /></span>
                  : <span aria-hidden="true" className="h-2 w-2 rounded-sm" style={{ backgroundColor: o.color }} />}
                {o.label}
              </button>
            ))}
          </div>
        </div>
      </AnalysisSettingsSection>
      {note && <div className="text-[11px] text-amber-700 dark:text-amber-300" data-testid="footprint-sizes-note">{note}</div>}
      {useClusters && <ClusterPickChips clusters={clusters!.visible} picks={picks} testId="vplot-picks" />}
      {loading && <AnalysisStatus kind="loading" compact>Computing footprint size plots…</AnalysisStatus>}
      {note2 && <div className="text-[11px] text-amber-700 dark:text-amber-300" data-testid="footprint-sizes-density-note">{note2}</div>}
      {plots.length > 0 && (
        <div className="flex flex-wrap gap-2" data-testid="footprint-sizes-plots">
          {plots.map((p, i) => (
            <SizeEnrichmentChart key={p.id} testId="footprint-sizes-plot"
              matrix={display[i]} rawMatrix={p.data.matrix}
              sizeMin={p.data.size_min} sizeMax={p.data.size_max} sizeBin={p.data.size_bin} posBin={p.data.pos_bin} start={target.start}
              scale={settings.scale === 'shared' ? sharedScale : colorScaleFor([display[i]], settings)}
              width={plotW} height={plotH} title={p.title} accent={p.color}
              subtitle={`${p.data.n_reads.toLocaleString()} reads · ${p.data.n_footprints.toLocaleString()} footprints`}
              filename={`footprint_${stamp}_${p.title.replace(/[^\w.-]+/g, '_')}`} dataTsv={() => tsvOf(p)} dark={dark}
              guides={[80, 147]} valueLabel={valueLabel} />
          ))}
          {ratioPlot && (
            <SizeEnrichmentChart testId="footprint-sizes-ratio" matrix={ratioPlot.m}
              sizeMin={ratioPlot.a.data.size_min} sizeMax={ratioPlot.a.data.size_max} sizeBin={ratioPlot.a.data.size_bin} posBin={ratioPlot.a.data.pos_bin}
              start={target.start} scale={ratioPlot.scale} width={plotW} height={plotH}
              title={`${ratioPlot.a.title} / ${ratioPlot.b.title}`} subtitle={enrichment ? 'log2 ratio of enrichment' : 'log2 ratio of footprint fractions'}
              filename={`footprint_${stamp}_ratio`} dark={dark} guides={[80, 147]} valueLabel="log2 ratio"
              dataTsv={() => sizeMatrixTsv(ratioPlot.m, { sizeMin: ratioPlot.a.data.size_min, sizeMax: ratioPlot.a.data.size_max, sizeBin: ratioPlot.a.data.size_bin,
                posBin: ratioPlot.a.data.pos_bin, nReads: 0, nFootprints: 0 }, settings,
              { title: `log2 ratio ${ratioPlot.a.title} / ${ratioPlot.b.title}`, chrom: target.chrom, start: target.start, value: 'log2 ratio', comparative: true })} />
          )}
        </div>
      )}
      {plots.length >= 2 && (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-gray-600 dark:text-gray-300" data-testid="footprint-sizes-ratio-picker">
          <label className="inline-flex items-center gap-1" title="Add a plot of log2(A / B) per cell. Counts are divided by each plot's footprints first, so the ratio compares distributions, not read numbers.">
            <input type="checkbox" checked={!!ratio} data-testid="footprint-sizes-ratio-toggle"
              onChange={e => set({ ratio: e.target.checked ? [plots[0].id, plots[1].id] : null })} className="h-3 w-3 accent-cyan-600" />
            log2 ratio
          </label>
          {ratio && (
            <>
              <select aria-label="Ratio numerator" value={ratio[0]} onChange={e => set({ ratio: [e.target.value, ratio[1]] })} className="input-tool min-h-0 py-0.5 text-[11px]">
                {plots.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
              </select>
              <span>/</span>
              <select aria-label="Ratio denominator" value={ratio[1]} onChange={e => set({ ratio: [ratio[0], e.target.value] })} className="input-tool min-h-0 py-0.5 text-[11px]">
                {plots.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
              </select>
              <span data-testid="footprint-sizes-ratio-colormap" className="inline-flex">
                <AnalysisSelect<FootprintSizeColormap> label="Colormap" value={comparativeMap.name}
                  onChange={v => set({ colormaps: { ...settings.colormaps, comparative: { ...comparativeMap, name: v } } })}
                  options={colormapOptions('comparative')} selectClassName="w-36"
                  title="Colours of the log2 ratio plot (a comparison: default RdBu, blue lower in the first, red higher, white equal)." />
              </span>
              <label className="inline-flex items-center gap-1" title="Run the ratio plot's colormap the other way round.">
                <input type="checkbox" checked={comparativeMap.reverse} data-testid="footprint-sizes-ratio-colormap-reverse"
                  onChange={e => set({ colormaps: { ...settings.colormaps, comparative: { ...comparativeMap, reverse: e.target.checked } } })} className="h-3 w-3 accent-cyan-600" />
                Reverse
              </label>
            </>
          )}
        </div>
      )}
      {!loading && error && <AnalysisStatus kind="error" compact>{error}</AnalysisStatus>}
      {!loading && !error && byPanel && plots.length === 0 && (
        <AnalysisStatus kind="empty" center>No footprints in this window for these panels.</AnalysisStatus>
      )}
      {!target.panels.length && <AnalysisStatus kind="empty" center>Open a dataset to plot its footprint sizes.</AnalysisStatus>}
      <div className="text-center text-[11px] text-ink-secondary" data-testid="vplot-caption">{footprintSizeCaption(settings)}</div>
    </div>
  );
}
