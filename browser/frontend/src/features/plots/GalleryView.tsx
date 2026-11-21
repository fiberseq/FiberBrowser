/**
 * The Plots Gallery view: the plots the user kept, as cards (thumbnail, title, type, locus, datasets, time), each
 * kept card's versions under it, the open plot's working card ("Current", Keep to add it) and the older auto-saved
 * cards of old sessions (collapsed, Clear). Rename, Duplicate, delete, Open (go back to where it was made), Re-run
 * (same settings, current view) and export (PNG / SVG / PDF / TSV). Comparing a working card keeps it. Select 2–4 cards to compare them side by side: one colour scale when they are the
 * same kind of plot, otherwise each on its own scale, labelled. "Export selected" writes one PDF, a page per plot.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChartSaveButton } from '../../components/charts/ChartSaveButton';
import { useBrowserStore } from '../../stores/browserStore';
import { SizeEnrichmentChart } from '../../components/charts/SizeEnrichmentChart';
import { drawChartsToPdf } from '../../utils/chartVectorExport';
import { colorScaleFor, ratioScale, sizeMatrixTsv } from '../../utils/footprintSizeMatrix';
import { clearLegacy, keptEntries, legacyEntries, removeEntry, setCap, unpackByPanel, unpackProfile, updateEntry, useGalleryStore, workingEntries, workingIsKept, type GalleryEntry } from './gallery';
import { useShallow } from 'zustand/react/shallow';
import { profileCharts, profileFigure, profileFigureDraw, profileTsv } from './profileFigure';
import { histogramFigure } from './sizeHistogram';
import { ProfileLinesChart } from '../../components/charts/ProfileLinesChart';
import { drawHeatmapRows, heatmapRange, HeatmapRowsChart, type HeatmapRowsChartProps } from '../../components/charts/HeatmapRowsChart';
import { heatmapFigure, heatmapTsv } from './heatmapData';
import { histogramAxis } from './sizeHistogram';
import { diffTsv } from './differentialData';
import { diffFigureDraw } from './diffCharts';
import { suppliedGroups, suppliedMatricesTsv, suppliedTicks, suppliedTsv, suppliedXs } from './supplied';
import { suppliedMatrixChart } from './SuppliedPlot';
import { coaccChart, coaccFigure, coaccFromSupplied } from './CoaccPlot';
import { unpackHeatmap } from './HeatmapPlot';
import { closePlotCard, duplicateGalleryEntry, keepPlotEntry, openEntry, remakeEntry } from './galleryActions';
import { newPlot } from './plotModel';
import { describePlot, effectiveSizeSettings, formatLocus, plotDisplayName, plotTypeInfo } from './plotModel';
import { figureDraw, sizeFigure, storedPlots, type SizeFigure } from './sizeFigure';

const BTN = 'inline-flex h-6 items-center justify-center rounded px-1.5 text-[11px] text-gray-600 ring-1 ring-inset ring-gray-200 hover:bg-gray-50 disabled:opacity-40 dark:text-gray-300 dark:ring-white/15 dark:hover:bg-white/5';

const unpacked = new WeakMap<GalleryEntry, ReturnType<typeof unpackByPanel>>();
function dataOf(e: GalleryEntry) {
  let d = unpacked.get(e);
  if (!d) { d = unpackByPanel(e.data); unpacked.set(e, d); }
  return d;
}

/** An entry's charts, drawn from its stored data. */
export function storedFigure(e: GalleryEntry, width = 240, height = 300): SizeFigure {
  return sizeFigure({ plot: e.plot, plots: storedPlots(e.items, dataOf(e)), start: e.computedFor.start, width, height });
}

export const entryTitle = (e: GalleryEntry): string => e.name.trim() || plotDisplayName(e.plot);
const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** A supplied card's charts, from its exact values. */
function suppliedChartsOf(e: GalleryEntry, width = 600) {
  const spec = e.plot.supplied!;
  const groups = suppliedGroups(e.supplied!);
  const fig = profileFigure(e.plot, groups, spec.dx);
  const n = Math.max(0, ...groups.map(g => g.raw.signal.length));
  return profileCharts({ ...fig, yLabel: fig.comparing ? fig.yLabel : spec.yLabel }, { start: spec.x0, binBp: spec.dx, width, height: fig.comparing ? 200 : 260,
    filename: entryTitle(e).replace(/[^\w.-]+/g, '_'), xLabel: spec.xLabel, xTicks: suppliedTicks(spec, n, suppliedXs(spec, e.supplied!)), xs: suppliedXs(spec, e.supplied!), subtitle: `From ${spec.origin}` });
}

/** A profile card's charts, drawn from its stored data. */
function profileChartsOf(e: GalleryEntry, width = 600) {
  const p = unpackProfile(e.profile!);
  const histogram = e.plot.type === 'size-histogram';
  const fig = histogram ? histogramFigure(e.plot, p.groups) : profileFigure(e.plot, p.groups, p.binBp);
  const start = histogram ? e.plot.hist.sizeMin : e.computedFor.start;
  return { fig, binBp: p.binBp, start, charts: profileCharts(fig, { start, binBp: p.binBp, width, height: fig.comparing ? 200 : 260, filename: entryTitle(e).replace(/[^\w.-]+/g, '_'),
    ...(histogram ? histogramAxis(e.plot.hist) : {}) }) };
}

/** A heatmap card's chart, drawn from its stored data. */
function heatmapChartOf(e: GalleryEntry, width = 600): { props: HeatmapRowsChartProps; tsv: () => string } {
  const entry = unpackHeatmap(e.heatmap!, e.requestKey, e.computedFor);
  const fig = heatmapFigure(e.plot, entry);
  const rows = fig.blocks.reduce((n, b) => n + b.rows.length, 0);
  return {
    props: { blocks: fig.blocks, start: entry.start, binBp: entry.binBp, relative: entry.mode === 'features', width, height: Math.max(220, Math.min(600, 60 + rows * 3)),
      valueLabel: fig.valueLabel, colormap: fig.colormap, reverse: fig.reverse, signed: fig.signed, range: heatmapRange(fig.blocks, fig.signed), filename: entryTitle(e).replace(/[^\w.-]+/g, '_') },
    tsv: () => heatmapTsv({ ...e.plot, name: entryTitle(e) }, fig, entry, formatLocus(e.computedFor)),
  };
}

const diffEntryOf = (e: GalleryEntry) => ({ key: e.requestKey, locus: e.computedFor, rows: e.diff!.rows, groups: e.diff!.groups, test: e.diff!.test, density: e.diff!.density });
const diffFigureOf = (e: GalleryEntry, chartWidth = 300) => diffFigureDraw(e.diff!.rows, { chartWidth, chartHeight: 240, qMax: e.plot.diff.qMax, deltaMin: e.plot.diff.deltaMin,
  labels: { A: e.diff!.groups.A.label, B: e.diff!.groups.B.label }, heading: `${entryTitle(e)} · ${formatLocus(e.computedFor)}` });

/** A drawn figure (differential cards) as a canvas. */
function FigureCanvas({ fig, testId }: { fig: { w: number; h: number; draw: (ctx: CanvasRenderingContext2D) => void }; testId: string }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = fig.w * dpr; c.height = fig.h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    fig.draw(ctx);
  }, [fig]);
  return <canvas ref={ref} style={{ width: fig.w, height: fig.h }} data-testid={testId} />;
}

const suppliedMatrixOnly = (e: GalleryEntry) => !!e.supplied?.matrices?.length && !e.supplied.series.length;

function entryTsv(e: GalleryEntry): string {
  if (e.plot.type === 'co-accessibility' && !e.plot.supplied && e.supplied) {
    const entry = coaccFromSupplied(e.requestKey, e.computedFor, e.supplied);
    return entry ? [`# plot: ${entryTitle(e)}`, `# computed_for: ${formatLocus(e.computedFor)}`, `# value: ${e.plot.coacc.normalization}`,
      ...entry.blocks.flatMap(b => [`# block: ${b.title} (${b.data.n_reads} reads, ${b.data.bin_size} bp bins from ${b.data.start})`,
        ...b.data.matrix.map(row => row.map(v => (v == null ? 'NA' : String(v))).join('\t'))])].join('\n') : '';
  }
  if (e.supplied && e.plot.supplied && suppliedMatrixOnly(e)) return suppliedMatricesTsv(entryTitle(e), e.plot.supplied, e.supplied);
  if (e.supplied && e.plot.supplied) return suppliedTsv(entryTitle(e), e.plot.supplied, e.supplied);
  if (e.diff) return diffTsv(diffEntryOf(e), e.plot.diff.qMax, e.plot.diff.deltaMin);
  if (e.heatmap) return heatmapChartOf(e).tsv();
  if (e.profile) {
    const { fig, binBp, start } = profileChartsOf(e);
    return profileTsv({ ...e.plot, name: entryTitle(e) }, fig, start, binBp, formatLocus(e.computedFor));
  }
  const fig = storedFigure(e);
  const plots = storedPlots(e.items, dataOf(e));
  const s = effectiveSizeSettings(e.plot);
  const parts = [`# plot: ${entryTitle(e)}`, `# computed_for: ${formatLocus(e.computedFor)}`, `# datasets: ${e.datasets.join(', ')}`];
  const ref = plots[0]?.data;
  if (fig.comparing && ref) {
    for (const c of fig.comparisons) parts.push(sizeMatrixTsv(c.matrix, { sizeMin: ref.size_min, sizeMax: ref.size_max, sizeBin: ref.size_bin, posBin: ref.pos_bin, nReads: 0, nFootprints: 0 },
      s, { title: c.label, chrom: e.computedFor.chrom, start: e.computedFor.start, value: e.plot.compare === 'diff' ? 'A - B of footprint size shares (each side over its total)' : 'log2 ratio of footprint size distributions', comparative: true }));
  } else {
    for (const p of plots) parts.push(sizeMatrixTsv(p.data.matrix, { sizeMin: p.data.size_min, sizeMax: p.data.size_max, sizeBin: p.data.size_bin, posBin: p.data.pos_bin,
      nReads: p.data.n_reads, nFootprints: p.data.n_footprints }, s, { title: p.title, chrom: e.computedFor.chrom, start: e.computedFor.start }));
  }
  return parts.join('\n');
}

function coaccChartOf(e: GalleryEntry, width = 600) {
  const entry = coaccFromSupplied(e.requestKey, e.computedFor, e.supplied!);
  return entry ? coaccChart(e.plot, coaccFigure(e.plot, entry.blocks), width) : null;
}

export function entryFigure(e: GalleryEntry) {
  if (e.plot.type === 'co-accessibility' && !e.plot.supplied && e.supplied) {
    const c = coaccChartOf(e);
    if (c) return { w: c.width, h: c.height, draw: (ctx: CanvasRenderingContext2D) => drawHeatmapRows(ctx, c.width, c.height, c) };
  }
  if (e.supplied && e.plot.supplied && suppliedMatrixOnly(e)) {
    const c = suppliedMatrixChart(e.plot, e.supplied, 600);
    return { w: c.width, h: c.height, draw: (ctx: CanvasRenderingContext2D) => drawHeatmapRows(ctx, c.width, c.height, c) };
  }
  if (e.supplied && e.plot.supplied) return profileFigureDraw(suppliedChartsOf(e), `${entryTitle(e)} · ${formatLocus(e.computedFor)}`);
  if (e.diff) return diffFigureOf(e);
  if (e.heatmap) {
    const { props } = heatmapChartOf(e);
    return { w: props.width, h: props.height, draw: (ctx: CanvasRenderingContext2D) => drawHeatmapRows(ctx, props.width, props.height, { ...props, title: `${entryTitle(e)} · ${formatLocus(e.computedFor)}` }) };
  }
  if (e.profile) return profileFigureDraw(profileChartsOf(e).charts, `${entryTitle(e)} · ${formatLocus(e.computedFor)}`);
  const fig = storedFigure(e);
  return figureDraw(fig.charts, `${entryTitle(e)} · ${formatLocus(e.computedFor)}`, { cols: Math.min(4, fig.charts.length) });
}

export function GalleryCard({ e, selected, onSelect, compact = false }: { e: GalleryEntry; selected?: boolean; onSelect?: (on: boolean) => void; compact?: boolean }) {
  const set = (fn: (g: ReturnType<typeof useGalleryStore.getState>) => ReturnType<typeof useGalleryStore.getState>) => useGalleryStore.setState(g => fn(g), true);
  const [renaming, setRenaming] = useState<string | null>(null);
  const fig = useMemo(() => entryFigure(e), [e]);
  const kept = e.status === 'kept' || workingIsKept(e);
  const close = () => {
    if (e.status !== 'working') { set(g => removeEntry(g, e.id)); return; }
    // A working card is its plot: closing it closes the plot (a new plot takes the builder when it was the open one).
    closePlotCard(e.plotId ?? '');
    const st = useBrowserStore.getState();
    if (st.plotsWorkspace.current.id === e.plotId) st.setPlotsWorkspace(ws => ({ ...ws, current: newPlot({ type: e.plot.type }), openedFrom: null }));
  };
  return (
    <div data-testid="gallery-card" data-entry-id={e.id} data-status={e.status} data-starred={kept ? 'true' : 'false'} data-version={e.status === 'kept' && e.parentId ? 'true' : undefined}
      className={`flex flex-col gap-1 rounded-lg bg-white p-2 text-[11px] shadow-[0_0_0_1px_#dfe3eb] dark:bg-white/5 dark:shadow-[0_0_0_1px_rgba(255,255,255,0.1)] ${selected ? 'ring-2 ring-amber-700' : ''}`}>
      <div className="relative">
        {e.thumb
          ? <img src={e.thumb} alt={`Thumbnail: ${entryTitle(e)}`} className="h-[104px] w-full rounded object-cover" data-testid="gallery-thumb" />
          : <div className="flex h-[104px] w-full items-center justify-center rounded bg-gray-50 text-[10px] text-gray-400 dark:bg-white/5">{plotTypeInfo(e.plot.type).label}</div>}
        {e.status === 'kept' ? (
          <span className="absolute right-1 top-1 rounded bg-white/90 px-1 text-[13px] leading-5 text-amber-500 shadow-sm dark:bg-gray-900/80" data-testid="gallery-kept" title="Kept in the Gallery">★</span>
        ) : (
          <button type="button" aria-pressed={kept} title={kept ? 'Kept: this plot as it is now is in the Gallery' : 'Keep: save this plot to the Gallery'}
            data-testid="gallery-star" disabled={kept} onClick={() => { keepPlotEntry(e.id); }}
            className={`absolute right-1 top-1 rounded bg-white/90 px-1 text-[11px] font-semibold leading-5 shadow-sm dark:bg-gray-900/80 ${kept ? 'text-amber-500' : 'text-gray-500 hover:text-amber-600'}`}>{kept ? '★ Kept' : '☆ Keep'}</button>
        )}
        {e.status === 'working' && (
          <span className="absolute bottom-1 left-1 rounded bg-amber-600 px-1 text-[9px] font-semibold uppercase text-white" data-testid="gallery-live"
            title="The open plot: updated in place as you change it or pan. Keep saves a copy to the Gallery.">Current</span>
        )}
      {onSelect && (
          <label className="absolute left-1 top-1 rounded bg-white/90 px-1 shadow-sm dark:bg-gray-900/80" title="Select to compare or export">
            <input type="checkbox" checked={!!selected} onChange={ev => onSelect(ev.target.checked)} data-testid="gallery-select" className="h-3 w-3 accent-amber-700" />
          </label>
        )}
      </div>
      {renaming != null ? (
        <input autoFocus value={renaming} aria-label="Plot name" data-testid="gallery-rename-input" className="input-tool min-h-0 py-0.5 text-[11px]"
          onChange={ev => setRenaming(ev.target.value)} onBlur={() => {
            const name = renaming.trim();
            set(g => updateEntry(g, e.id, { name }));
            // The same field as the plot's own name: renaming the card of the plot in the builder renames that plot.
            const st = useBrowserStore.getState();
            if (st.plotsWorkspace.current.id === e.plot.id) st.updateCurrentPlot({ name });
            setRenaming(null);
          }}
          onKeyDown={ev => { if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur(); if (ev.key === 'Escape') setRenaming(null); }} />
      ) : (
        <button type="button" className="truncate text-left font-semibold text-gray-800 hover:underline dark:text-gray-100" title="Rename" data-testid="gallery-name"
          onClick={() => setRenaming(e.name || entryTitle(e))}>{entryTitle(e)}</button>
      )}
      {!compact && <div className="text-[10px] text-gray-500 dark:text-gray-400" data-testid="gallery-meta">{describePlot(e.plot)}</div>}
      <div className="text-[10px] text-gray-500 dark:text-gray-400">
        <span className="font-mono">{formatLocus(e.computedFor)}</span>{e.datasets.length ? ` · ${e.datasets.join(', ')}` : ''} · {time(e.createdAt)}{e.status === 'kept' && e.parentId ? ' · version' : ''}
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-1">
        <button type="button" className={BTN} data-testid="gallery-open" onClick={() => openEntry(e.id)}
          title="Open: go back to where you were (browser state restored, one undo step) and edit the plot">Open</button>
        <button type="button" className={BTN} data-testid="gallery-remake" onClick={() => remakeEntry(e.id)}
          title={e.plot.where === 'view'
            ? 'Re-run at current view: a new card from these settings at the current location; this card stays as it is'
            : 'Re-run for this set: a new card from these settings on the same set, as the data are now; this card stays as it is'}>
          {e.plot.where === 'view' ? 'Re-run at current view' : 'Re-run for this set'}
        </button>
        {!compact && (
          <span className="inline-flex" data-testid="gallery-export">
            <ChartSaveButton inline filename={`plot_${entryTitle(e).replace(/[^\w.-]+/g, '_')}`} drawFn={ctx => fig.draw(ctx)} width={fig.w} height={fig.h} dataTsv={() => entryTsv(e)} />
          </span>
        )}
        {!compact && (
          <button type="button" className={BTN} data-testid="gallery-duplicate" onClick={() => { duplicateGalleryEntry(e.id); }} title="Duplicate: a kept copy of this card">Duplicate</button>
        )}
        <button type="button" className={`${BTN} ml-auto`} data-testid="gallery-delete" onClick={close}
          title={e.status === 'working' ? 'Close this plot (kept copies stay in the Gallery)' : 'Delete from the Gallery'}>✕</button>
      </div>
    </div>
  );
}

/** Selected entries side by side: one scale when they are the same kind of plot, else each on its own (labelled). */
function CompareSideBySide({ entries, width }: { entries: GalleryEntry[]; width: number }) {
  if (entries.some(e => e.profile || e.heatmap || e.diff || e.supplied)) {
    // Profiles (or a mix): each on its own scale, labelled.
    return (
      <div className="flex flex-col gap-3" data-testid="gallery-compare" data-shared-scale="false">
        <div className="text-[11px] text-gray-600 dark:text-gray-300">Each plot on its own scale.</div>
        {entries.map(e => (
          <div key={e.id} className="flex flex-col gap-1" data-testid="gallery-compare-row">
            <div className="text-[12px] font-semibold text-gray-800 dark:text-gray-100">{entryTitle(e)} <span className="font-normal text-gray-500">· {formatLocus(e.computedFor)} · {e.datasets.join(', ')} · own scale</span></div>
            {e.plot.type === 'co-accessibility' && !e.plot.supplied && e.supplied && coaccChartOf(e)
              ? <HeatmapRowsChart testId="gallery-compare-chart" {...coaccChartOf(e, Math.max(320, width - 20))!} />
              : e.supplied && e.plot.supplied && suppliedMatrixOnly(e)
              ? <HeatmapRowsChart testId="gallery-compare-chart" {...suppliedMatrixChart(e.plot, e.supplied, Math.max(320, width - 20))} />
              : e.supplied && e.plot.supplied
              ? suppliedChartsOf(e, Math.max(320, width - 20)).map((c, i) => <ProfileLinesChart key={i} testId="gallery-compare-chart" {...c} />)
              : e.diff
              ? <FigureCanvas testId="gallery-compare-chart" fig={diffFigureOf(e, Math.max(240, Math.floor((width - 30) / 2)))} />
              : e.heatmap
              ? <HeatmapRowsChart testId="gallery-compare-chart" {...heatmapChartOf(e, Math.max(320, width - 20)).props} />
              : e.profile
              ? profileChartsOf(e, Math.max(320, width - 20)).charts.map((c, i) => <ProfileLinesChart key={i} testId="gallery-compare-chart" {...c} />)
              : <div className="flex flex-wrap gap-2">{storedFigure(e, 240, 240).charts.map(({ key, kind: _k, ...props }) => <SizeEnrichmentChart key={key} testId="gallery-compare-chart" {...props} />)}</div>}
          </div>
        ))}
      </div>
    );
  }
  const figs = entries.map(e => storedFigure(e, Math.max(200, Math.floor((width - 20) / Math.min(4, Math.max(1, ...entries.map(x => storedFigure(x).charts.length))))) - 10, 240));
  const kinds = new Set(entries.map(e => {
    const s = effectiveSizeSettings(e.plot);
    return figs[entries.indexOf(e)].comparing ? 'compare' : `${e.plot.type}|${s.normalization}|${s.log}`;
  }));
  const shared = kinds.size === 1;
  let sharedScale: ReturnType<typeof colorScaleFor> | null = null;
  if (shared && figs.length) {
    const all = figs.flatMap(f => f.charts.map(c => c.matrix));
    sharedScale = figs[0].comparing ? ratioScale(all.flat(), entries[0].plot.size) : colorScaleFor(all, effectiveSizeSettings(entries[0].plot));
  }
  return (
    <div className="flex flex-col gap-3" data-testid="gallery-compare" data-shared-scale={shared ? 'true' : 'false'}>
      <div className="text-[11px] text-gray-600 dark:text-gray-300">
        {shared ? 'One colour scale across these plots (same kind of plot).' : 'Different kinds of plot: each is on its own colour scale.'}
      </div>
      {entries.map((e, i) => (
        <div key={e.id} className="flex flex-col gap-1" data-testid="gallery-compare-row">
          <div className="text-[12px] font-semibold text-gray-800 dark:text-gray-100">
            {entryTitle(e)} <span className="font-normal text-gray-500">· {formatLocus(e.computedFor)} · {e.datasets.join(', ')}{shared ? '' : ' · own scale'}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {figs[i].charts.map(({ key, kind: _k, ...props }) => (
              <SizeEnrichmentChart key={key} testId="gallery-compare-chart" {...props} scale={sharedScale ?? props.scale} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Kept cards in Gallery order: newest first, each card's versions (kept from a plot opened from it) right after it. */
export function galleryOrder(kept: GalleryEntry[]): GalleryEntry[] {
  const ids = new Set(kept.map(e => e.id));
  const roots = kept.filter(e => !e.parentId || !ids.has(e.parentId)).reverse();
  const out: GalleryEntry[] = [];
  const add = (e: GalleryEntry) => { out.push(e); kept.filter(v => v.parentId === e.id).reverse().forEach(add); };
  roots.forEach(add);
  return out;
}

export function GalleryView({ width }: { width: number }) {
  const entries = useGalleryStore(g => g.entries);
  const kept = useGalleryStore(useShallow(g => keptEntries(g)));
  const working = useGalleryStore(useShallow(g => workingEntries(g)));
  const legacy = useGalleryStore(useShallow(g => legacyEntries(g)));
  const cap = useGalleryStore(g => g.cap);
  const [selected, setSelected] = useState<string[]>([]);
  const [comparing, setComparing] = useState(false);
  const [legacyOpen, setLegacyOpen] = useState(false);
  const live = selected.filter(id => entries.some(e => e.id === id));
  const chosen = live.map(id => entries.find(e => e.id === id)!);
  const ordered = galleryOrder(kept);
  const select = (e: GalleryEntry) => (on: boolean) => setSelected(s => (on ? [...s.filter(id => id !== e.id), e.id] : s.filter(id => id !== e.id)));
  // Comparing a working (or older auto-saved) card keeps it: what is compared is in the Gallery.
  const startCompare = () => {
    if (comparing) { setComparing(false); return; }
    const ids = chosen.map(e => (e.status === 'kept' ? e.id : keepPlotEntry(e.id)?.id ?? e.id));
    setSelected(ids);
    setComparing(true);
  };
  const exportSelected = () => {
    void drawChartsToPdf(chosen.map(e => { const f = entryFigure(e); return { drawFn: (ctx: CanvasRenderingContext2D) => f.draw(ctx), width: f.w, height: f.h }; }),
      `plots_${new Date().toISOString().slice(0, 10)}.pdf`);
  };
  return (
    <div className="flex flex-col gap-3" data-testid="gallery-view">
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="text-gray-600 dark:text-gray-300" data-testid="gallery-rule">
          Plots you keep ({kept.length}). The open plot updates its Current card as you change it or pan; Keep saves a copy here (Open a kept card and Keep again for a version).
        </span>
        <span className="ml-auto inline-flex items-center gap-1">
          <span className="text-gray-500" data-testid="gallery-selected-count">{live.length} selected</span>
          <button type="button" className={BTN} disabled={!comparing && (live.length < 2 || live.length > 4)} data-testid="gallery-compare-button"
            title="Compare 2–4 selected plots side by side (a Current card compared is kept)" onClick={startCompare}>{comparing ? 'Close compare' : 'Compare side by side'}</button>
          <button type="button" className={BTN} disabled={live.length === 0} data-testid="gallery-export-selected" onClick={exportSelected}
            title="One PDF, a page per selected plot">Export selected (PDF)</button>
          <button type="button" className={BTN} disabled={live.length === 0} onClick={() => { setSelected([]); setComparing(false); }}>Clear</button>
        </span>
      </div>
      {comparing && live.length >= 2 && live.length <= 4 && <CompareSideBySide entries={chosen} width={width} />}
      {working.length > 0 && (
        <section className="flex flex-col gap-1" data-testid="gallery-current">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Current</h3>
          <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))' }}>
            {working.map(e => <GalleryCard key={e.id} e={e} selected={live.includes(e.id)} onSelect={select(e)} />)}
          </div>
        </section>
      )}
      {kept.length === 0 && (
        <p className="text-[12px] text-gray-500" data-testid="gallery-empty">Nothing kept yet. Keep a plot (☆ Keep) to save it here, with the browser state it was made in.</p>
      )}
      <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))' }} data-testid="gallery-grid">
        {ordered.map(e => <GalleryCard key={e.id} e={e} selected={live.includes(e.id)} onSelect={select(e)} />)}
      </div>
      {legacy.length > 0 && (
        <section className="flex flex-col gap-1 border-t border-line/70 pt-2 dark:border-white/10" data-testid="gallery-legacy">
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <button type="button" aria-expanded={legacyOpen} data-testid="gallery-legacy-toggle" onClick={() => setLegacyOpen(o => !o)}
              className="font-semibold text-gray-600 hover:text-gray-900 dark:text-gray-300">{legacyOpen ? '▾' : '▸'} Older auto-saved ({legacy.length})</button>
            <span className="text-gray-500">From before plots were kept explicitly; Keep one to move it to the Gallery.</span>
            <label className="inline-flex items-center gap-1 text-gray-600 dark:text-gray-300" title="Older auto-saved cards beyond this many roll off, oldest first">
              keep the newest
              <input type="number" min={1} max={500} value={cap} aria-label="Gallery cap" data-testid="gallery-cap" className="input-tool w-14 min-h-0 py-0.5 text-[11px]"
                onChange={e => useGalleryStore.setState(g => setCap(g, Number(e.target.value)), true)} />
            </label>
            <button type="button" className={`${BTN} ml-auto`} data-testid="gallery-legacy-clear" onClick={() => useGalleryStore.setState(g => clearLegacy(g), true)}
              title="Delete every older auto-saved card">Clear all</button>
          </div>
          {legacyOpen && (
            <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))' }}>
              {[...legacy].reverse().map(e => <GalleryCard key={e.id} e={e} selected={live.includes(e.id)} onSelect={select(e)} />)}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
