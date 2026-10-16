/**
 * Accessibility (preview): the analysis of an open NFR card (NfrCard): the read controls (group, split into panels,
 * split by combination pattern, select variants as features) and views that compare the NFR's variants side by side
 * in their colours: the motif map, footprint classes, V-plots, phasing, prevalence by group, and the advanced plots
 * (widths, boundary nucleosomes, sequence).
 */
import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  cancelVariantTransfer, getNfrPhasing, getNfrPrevalence, getNfrSequence, getNfrShape, getNfrVPlots, getVariantTransfer, nfrMembersUrl, startVariantTransfer,
  type NfrPhasing, type NfrPrevalence, type NfrShape, type NfrVPlots, type TransferJob, type VariantSequence,
} from '../api';
import { useContainerWidth } from '../../../hooks/useContainerWidth';
import { useBrowserStore } from '../../../stores/browserStore';
import { useAccessibilityStore } from '../accessibilityStore';
import { groupingIsCurrentOn } from '../../../utils/readGroups';
import { downloadTextFile } from '../../../utils/analysisExport';
import { bp, pct, variantColor } from '../accessibilityView';
import { getDatasetDisplayLabel } from '../../../utils/datasetLabels';
import { cardKey, savedVariantsBed, shownVariants, type SavedNfr } from '../savedNfrVariants';
import { cancelJob, getJob, sleep, startJob, useJob, useJobBadges } from '../nfrJobs';
import { getClusterColor, getClusterLabel } from '../../../components/tracks/read-track/constants';
import { OverlayProfileChart } from '../../../components/charts/OverlayProfileChart';
import { VPlotChart } from '../../../components/charts/VPlotChart';
import { ChartMaximizeContext } from '../../../components/charts/ChartMaximizeButton';
import { createPortal } from 'react-dom';
import { AnalysisButton, AnalysisStatus, AnalysisSubTabBar } from '../../../components/controls/shared';
import { JobStatus } from '../../../components/controls/shared/JobStatus';
import { BoundaryPlot, GcTrack, PrevalencePlot, WidthPlot, type PrevalenceGroupRow } from './NfrCharts';
import { featureKey } from '../../../stores/featureStore';
import { nfrVariantFeature } from '../NfrFeatureTrack';
import { useSplitPanelStore } from '../../../stores/splitPanelStore';
import { MAX_COMBINED_FEATURES } from '../../../utils/featureClustering';
import { NfrMotifs } from './NfrMotifs';
import { NfrClasses } from './NfrClasses';
import { NfrJobOwnerContext, useView } from './useNfrView';

const VIEWS = [
  { key: 'motifs' as const, label: 'Motifs' },
  { key: 'classes' as const, label: 'Footprints' },
  { key: 'vplots' as const, label: 'V-plots' },
  { key: 'phasing' as const, label: 'Phasing' },
  { key: 'prevalence' as const, label: 'Prevalence' },
  { key: 'advanced' as const, label: 'Advanced' },
  { key: 'export' as const, label: 'Export' },
];
type View = typeof VIEWS[number]['key'];
/** Read-bootstrap replicates per group (each group is its own EM; 100 keeps the view interactive). */
const PREVALENCE_BOOTSTRAP = 100;
const stem = (e: SavedNfr) => `${e.nfrId}_${e.jobId.slice(0, 8)}`;

/** The read controls of an NFR card (the panel runs them: the same code as the main toolbar). */
export interface SavedReadActions {
  /** Group in this panel: the reads' configurations at this NFR. */
  group: (entry: SavedNfr) => void;
  /** Split by combination pattern of the ticked variants (2-8). */
  splitPatterns: (entry: SavedNfr) => void;
  /** Split into panels: one read panel per variant. */
  splitPanels: (entry: SavedNfr) => void;
  /** What is running ('group:<entry id>', 'patterns:<entry id>', 'panels:<entry id>'). */
  busy: string | null;
  /** The entry whose configurations the read panels show now. */
  groupedEntry: (entry: SavedNfr) => boolean;
}

/** The feature of a saved variant (for the main toolbar's Cluster / Sort / Filter). */
export function savedVariantFeature(e: SavedNfr, v: SavedNfr['variants'][number]) {
  return nfrVariantFeature(e.jobId, e.chrom, { id: v.variantId, nfr: e.nfrId, name: v.name, L: v.start, R: v.end });
}

export function SavedNfrInspect({ entry, stateKeyMap, isFullView }: { entry: SavedNfr; stateKeyMap: Record<string, string[]>; isFullView?: boolean }) {
  // The view lives in the store per card: a link (a class from the Footprints panel) can open the card on a view.
  const key = cardKey(entry.jobId, entry.nfrId);
  const stored = useAccessibilityStore(s => s.cardView[key]);
  const view: View = VIEWS.some(v => v.key === stored) ? stored as View : 'motifs';
  const setView = (v: View) => useAccessibilityStore.getState().setCardView(key, v);
  const [width, ref] = useContainerWidth(360);
  const w = Math.max(260, Math.min(isFullView ? 980 : 760, width));
  const names = shownVariants(entry).map(v => v.name);
  return (
    <div ref={ref} className="space-y-2" data-testid="nfr-saved-inspect">
      {/* Sticky under the panel's tabs and the open card's identity row (NFR-8): the views stay one click away. */}
      <div className="sticky z-[9] -mx-1 bg-surface px-1" data-testid="nfr-card-views-tabs"
        style={{ top: 'calc(var(--nfr-tabs-h, 34px) + var(--nfr-card-head-h, 0px))' }}>
        <AnalysisSubTabBar tabs={VIEWS} activeTab={view} onTabChange={setView} label="Saved NFR views" theme="fuchsia" />
      </div>
      {view === 'motifs' && <NfrMotifs jobId={entry.jobId} nfrId={entry.nfrId} names={names} width={w} datasetIds={entry.datasetIds} />}
      {view === 'classes' && <NfrClasses entry={entry} names={names} />}
      {view === 'vplots' && <VPlotsView entry={entry} names={names} width={w} />}
      {view === 'phasing' && <PhasingView entry={entry} names={names} width={w} />}
      {view === 'prevalence' && <PrevalenceView entry={entry} names={names} width={w} stateKeyMap={stateKeyMap} />}
      {view === 'advanced' && <AdvancedView entry={entry} names={names} width={w} />}
      {view === 'export' && <ExportView entry={entry} />}
    </div>
  );
}

/** An NFR card's read controls, in one "Reads ▾" menu: group, split into panels, split by combination pattern, and the
 * ticked variants as features for the main toolbar. What the read panels hold now shows beside it. */
export function ReadControls({ entry, actions }: { entry: SavedNfr; actions: SavedReadActions }) {
  const shown = shownVariants(entry);
  const features = shown.map(v => savedVariantFeature(entry, v));
  const selectedFeatures = useBrowserStore(st => st.selectedFeatures);
  const keys = new Set(selectedFeatures.map(featureKey));
  const allSelected = features.length > 0 && features.every(f => keys.has(featureKey(f)));
  const patterns = shown.length >= 2 && shown.length <= MAX_COMBINED_FEATURES;
  const busy = (k: string) => actions.busy === `${k}:${entry.id}`;
  const anyBusy = ['group', 'panels', 'patterns'].some(busy);
  const panelBusy = useSplitPanelStore(st => !!st.pending);
  const grouped = actions.groupedEntry(entry);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const items = useRef<HTMLDivElement>(null);
  const enabledItems = () => [...(items.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
  /** Close the menu and give the focus back to Reads ▾ (keyboard users keep their place). */
  const close = (refocus = true) => { setOpen(false); if (refocus) box.current?.querySelector<HTMLButtonElement>('[data-testid="nfr-reads-menu"]')?.focus(); };
  useEffect(() => {
    if (!open) return;
    enabledItems()[0]?.focus();                            // opening puts the focus on the first action
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  const onMenuKey = (e: React.KeyboardEvent) => {
    const list = enabledItems();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape' || e.key === 'Tab') { if (e.key === 'Escape') e.preventDefault(); close(e.key === 'Escape'); return; }
    const to = e.key === 'ArrowDown' ? (at + 1) % list.length : e.key === 'ArrowUp' ? (at - 1 + list.length) % list.length
      : e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : -1;
    if (to >= 0 && list.length) { e.preventDefault(); list[to].focus(); }
  };
  const act = (f: () => void) => () => { close(); f(); };
  const item = 'block w-full rounded px-2 py-1 text-left text-[11px] text-gray-800 hover:bg-fuchsia-50 disabled:opacity-40 dark:text-gray-100 dark:hover:bg-white/10';
  return (
    <div ref={box} className="relative flex flex-wrap items-center gap-1.5" data-testid="nfr-saved-controls">
      <AnalysisButton theme="fuchsia" variant="quiet" data-testid="nfr-reads-menu" aria-haspopup="menu" aria-expanded={open}
        onKeyDown={e => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); setOpen(true); } }}
        onClick={() => setOpen(v => !v)} title="What to do with the reads at this NFR: group them, split them into panels, or select the variants as features">
        {anyBusy ? 'Reads: working…' : 'Reads ▾'}
      </AnalysisButton>
      {grouped && <span className="rounded bg-fuchsia-50 px-1.5 py-px text-[11px] text-fuchsia-800 dark:bg-fuchsia-900/30 dark:text-fuchsia-200" data-testid="nfr-reads-state">Grouped by variant</span>}
      {allSelected && <span className="rounded bg-gray-100 px-1.5 py-px text-[11px] text-gray-700 dark:bg-white/10 dark:text-gray-200" data-testid="nfr-reads-features">{features.length} selected as features</span>}
      <div role="menu" hidden={!open} aria-label="Reads at this NFR" data-testid="nfr-reads-menu-items" ref={items} onKeyDown={onMenuKey}
        className="absolute left-0 top-full z-30 mt-1 w-64 rounded-md border border-gray-200 bg-white p-1 shadow-lg dark:border-gray-700 dark:bg-gray-900">
        <button type="button" role="menuitem" className={item} data-testid="nfr-saved-group" disabled={busy('group')} onClick={act(() => actions.group(entry))}
          title="Colour the reads by what they carry here (their most likely configuration), as a clustering would; Clear returns to the grouping you had">
          {busy('group') ? 'Grouping…' : grouped ? 'Grouped by variant' : 'Group in this panel'}
        </button>
        <button type="button" role="menuitem" className={item} data-testid="nfr-saved-split-panels" disabled={busy('panels') || panelBusy} onClick={act(() => actions.splitPanels(entry))}
          title="One read panel per variant, at this locus and moving with the main view. Each read goes to one group (its most likely configuration), so the panels' read counts differ from the variants' prevalence">
          Split into panels…
        </button>
        <button type="button" role="menuitem" className={item} data-testid="nfr-saved-split-patterns" disabled={!patterns || busy('patterns')} onClick={act(() => actions.splitPatterns(entry))}
          title={patterns ? 'Group the reads by which of the ticked variants they open (one group per pattern)' : `Tick 2–${MAX_COMBINED_FEATURES} variants`}>
          {busy('patterns') ? 'Splitting…' : 'Split by combination pattern'}
        </button>
        <button type="button" role="menuitem" className={item} data-testid="nfr-saved-select-features" disabled={!features.length}
          onClick={act(() => {
            const others = selectedFeatures.filter(f => !features.some(g => featureKey(g) === featureKey(f)));
            useBrowserStore.getState().setSelectedFeatures(allSelected ? others : [...others, ...features]);
          })}
          title="The ticked variants as features for the main toolbar's Cluster, Sort and Filter (or shift-click a variant)">
          {allSelected ? 'Deselect features' : 'Select as features'}
        </button>
      </div>
    </div>
  );
}

function Loading({ what }: { what: string }) {
  return <AnalysisStatus kind="loading">{what}</AnalysisStatus>;
}

/** A short key for read-group membership ({label: {dataset: [names]}}): labels, datasets and every name (FNV-1a). */
export function membershipKey(groups: Record<string, Record<string, string[]>>): string {
  let h = 0x811c9dc5;
  const add = (s: string) => { for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } h ^= 0x1f; };
  let n = 0;
  for (const label of Object.keys(groups).sort()) {
    add(label);
    for (const ds of Object.keys(groups[label]).sort()) {
      add(ds);
      for (const name of [...groups[label][ds]].sort()) { add(name); n++; }
    }
  }
  return `${n}:${h.toString(36)}`;
}

function FeatureTable({ seq, names }: { seq: VariantSequence; names: string[] }) {
  type Row = [string, VariantSequence['flanks']['left'] & { span?: [number, number] }];
  const rows: Row[] = [
    ...names.filter(n => seq.variants[n]).map(n => [n, seq.variants[n]] as Row), ['left flank', seq.flanks.left], ['right flank', seq.flanks.right],
  ];
  return (
    <table className="w-full text-[11px] tabular-nums" data-testid="nfr-seq-features">
      <thead className="text-left text-gray-500">
        <tr><th className="font-medium">Span</th><th className="font-medium">bp</th><th className="font-medium">GC</th>
          <th className="font-medium" title={seq.definitions.cpg_oe}>CpG (o/e)</th><th className="font-medium" title={seq.definitions.tracts}>poly(dA:dT) ≥ 6</th></tr>
      </thead>
      <tbody>
        {rows.map(([n, f]) => (
          <tr key={n} className="border-t border-gray-100 dark:border-white/5">
            <td className={`pr-2 ${seq.variants[n] ? 'font-semibold' : ''}`} style={{ color: seq.variants[n] ? variantColor(n) : undefined }}>
              {n}{f.span ? <span className="ml-1 font-normal text-ink-secondary">{bp(f.span[0])}–{bp(f.span[1])}</span> : null}
            </td>
            <td className="pr-2">{f.bp}</td>
            <td className="pr-2">{f.gc == null ? '–' : `${(f.gc * 100).toFixed(0)}%`}</td>
            <td className="pr-2">{f.cpg}{f.cpg_oe != null ? ` (${f.cpg_oe.toFixed(2)})` : ''}</td>
            <td>{f.tracts.length ? `${f.tracts.length} (${f.tract_bp} bp)` : '–'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The advanced plots: opening widths per variant, the boundary nucleosomes, and the sequence of the open spans. */
function AdvancedView({ entry, names, width }: { entry: SavedNfr; names: string[]; width: number }) {
  const shape = useView<NfrShape>(() => getNfrShape(entry.jobId, entry.nfrId), `${entry.jobId}|${entry.nfrId}|shape`);
  const seq = useView<VariantSequence>(() => getNfrSequence(entry.jobId, entry.nfrId), `${entry.jobId}|${entry.nfrId}|seq`);
  return (
    <div className="space-y-2" data-testid="nfr-advanced-view">
      {shape.loading && <Loading what="Widths and boundary nucleosomes…" />}
      {shape.error && <AnalysisStatus kind="error">{shape.error}</AnalysisStatus>}
      {shape.data && (
        <>
          <div>
            <h4 className="mb-0.5 text-[11px] font-semibold text-gray-700 dark:text-gray-300">Opening width</h4>
            <WidthPlot shape={shape.data} names={names} width={width} fileStem={stem(entry)} />
          </div>
          {shape.data.boundary ? (
            <div>
              <h4 className="mb-0.5 text-[11px] font-semibold text-gray-700 dark:text-gray-300" title="Dyads of the nucleosomes ending at the left edge (−1) and starting at the right edge (+1): median, quartiles, 5–95%">Boundary nucleosomes (−1, +1)</h4>
              <BoundaryPlot shape={shape.data} names={names} width={width} fileStem={stem(entry)} />
            </div>
          ) : <AnalysisStatus kind="info">{shape.data.boundary_note}</AnalysisStatus>}
        </>
      )}
      <h4 className="text-[11px] font-semibold text-gray-700 dark:text-gray-300">Sequence</h4>
      {seq.loading && <Loading what="Reference sequence…" />}
      {seq.error && <AnalysisStatus kind="info">{seq.error}</AnalysisStatus>}
      {seq.data && (
        <>
          <GcTrack seq={seq.data} names={names} width={width} fileStem={stem(entry)} />
          <FeatureTable seq={seq.data} names={names} />
        </>
      )}
    </div>
  );
}

/** Counts -> [0,1] for the V-plot colour scale (log1p, scaled to ``max``: shared across the variants' panels). */
function normalise(m: number[][], max?: number): number[][] {
  let top = max ?? 0;
  if (max == null) for (const r of m) for (const v of r) if (v > top) top = v;
  const d = Math.log1p(top) || 1;
  return m.map(r => r.map(v => Math.min(1, Math.log1p(v) / d)));
}

/** The V-plot grid's defaults: coverage x size (clearer than centre x size), openings up to 1,000 bp. */
export const VPLOT_DEFAULTS = { kind: 'coverage' as const, sizeMax: 1000 };

function VPlotsView({ entry, names, width }: { entry: SavedNfr; names: string[]; width: number }) {
  const [kind, setKind] = useState<'centre' | 'coverage'>(VPLOT_DEFAULTS.kind);
  const [bins, setBins] = useState<{ step: number; size_step: number; pad: number; sizeMax: number | null }>({ step: 10, size_step: 10, pad: 300, sizeMax: VPLOT_DEFAULTS.sizeMax });
  const [big, setBig] = useState<number | null>(null);
  const req = { step: bins.step, size_step: bins.size_step, pad: bins.pad };
  const { data: raw, error, loading } = useView<NfrVPlots>(() => getNfrVPlots(entry.jobId, entry.nfrId, req), `${entry.jobId}|${entry.nfrId}|vplots|${JSON.stringify(req)}`, 'V-plots');
  // An upper size limit trims the rows (the server's grid runs to the widest opening).
  const data = useMemo(() => {
    if (!raw || bins.sizeMax == null || bins.sizeMax >= raw.size[1]) return raw;
    const rows = Math.max(1, Math.ceil((bins.sizeMax - raw.size[0]) / raw.size_step));
    const cut = (m: { centre: number[][]; coverage: number[][] }) => ({ centre: m.centre.slice(0, rows), coverage: m.coverage.slice(0, rows) });
    return { ...raw, size: [raw.size[0], raw.size[0] + rows * raw.size_step] as [number, number], all: cut(raw.all),
      variants: Object.fromEntries(Object.entries(raw.variants).map(([k, v]) => [k, { ...v, ...cut(v) }])) };
  }, [raw, bins.sizeMax]);
  const cols = width >= 560 ? 3 : width >= 360 ? 2 : 1;
  const cell = Math.floor((width - 12 * (cols - 1)) / cols);
  const charts = useMemo(() => {
    if (!data) return [];
    const common = { sizeMin: data.size[0], sizeMax: data.size[1], windowBp: data.window[1] - data.window[0], sizeBin: data.size_step, posBin: data.step,
      xLabels: [bp(data.window[0]), `${bp((data.window[0] + data.window[1]) / 2)}`, bp(data.window[1])] as [string, string, string], guides: [175, 300, 500] };
    const shown = names.filter(n => data.variants[n]);
    let max = 0;
    for (const n of shown) for (const r of data.variants[n][kind]) for (const v of r) if (v > max) max = v;
    return [
      { key: 'all', title: `All openings (${data.count_all.toLocaleString()})`, matrix: normalise(data.all[kind]), color: undefined as string | undefined, ...common },
      ...shown.map(n => ({ key: n, title: `${n} (${data.variants[n].count.toLocaleString()})`, matrix: normalise(data.variants[n][kind], max), color: variantColor(n), ...common })),
    ];
  }, [data, names.join('|'), kind]);
  const notes = (key: string) => ({ nfr: entry.nfrId, variant: key, kind, scale: key === 'all' ? 'log1p, scaled to its maximum' : 'log1p, scaled to the maximum over the variants shown' });
  return (
    <div className="space-y-2" data-testid="nfr-vplots-view">
      <div className="flex items-center gap-1 text-[11px]" role="tablist" aria-label="V-plot kind">
        {(['coverage', 'centre'] as const).map(k => (
          <button key={k} type="button" role="tab" aria-selected={kind === k} onClick={() => setKind(k)} data-testid={`nfr-vplot-kind-${k}`}
            title={k === 'centre' ? 'Each opening adds 1 at its centre' : 'Each opening adds 1 at every position it covers'}
            className={`rounded px-2 py-0.5 ${kind === k ? 'bg-fuchsia-100 font-semibold text-fuchsia-800 dark:bg-fuchsia-900/40 dark:text-fuchsia-200' : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-white/10'}`}>
            {k === 'centre' ? 'Centre × size' : 'Coverage × size'}
          </button>
        ))}
        <span className="ml-auto flex flex-wrap items-center gap-2 text-gray-500" data-testid="nfr-vplot-knobs">
          <label className="flex items-center gap-1" title="Largest opening width shown (bp); empty: all">max size
            <input type="number" min={100} max={5000} step={50} value={bins.sizeMax ?? ''} placeholder="all"
              onChange={e => setBins(b => ({ ...b, sizeMax: e.target.value ? Math.max(100, Number(e.target.value)) : null }))}
              className="w-14 rounded border border-gray-200 bg-white px-1 py-px dark:border-gray-700 dark:bg-gray-900" aria-label="V-plot maximum size" data-testid="nfr-vplot-size-max" />
          </label>
          {([['step', 'pos bin', [5, 10, 20, 50]], ['size_step', 'size bin', [5, 10, 20, 50]]] as const).map(([k, label, opts]) => (
            <label key={k} className="flex items-center gap-1" title={`V-plot ${label} (bp)`}>{label}
              <select value={bins[k]} onChange={e => setBins(b => ({ ...b, [k]: Number(e.target.value) }))} aria-label={`V-plot ${label}`}
                className="rounded border border-gray-200 bg-white px-1 py-px dark:border-gray-700 dark:bg-gray-900">{opts.map(o => <option key={o} value={o}>{o}</option>)}</select>
            </label>
          ))}
          <label className="flex items-center gap-1" title="Flank around the NFR's openings (bp)">flank
            <input type="number" min={0} max={3000} step={50} value={bins.pad} onChange={e => setBins(b => ({ ...b, pad: Math.max(0, Math.min(3000, Number(e.target.value) || 0)) }))}
              className="w-14 rounded border border-gray-200 bg-white px-1 py-px dark:border-gray-700 dark:bg-gray-900" aria-label="V-plot flank" />
          </label>
        </span>
      </div>
      {loading && <Loading what="V-plots…" />}
      {error && <AnalysisStatus kind="error">{error}</AnalysisStatus>}
      {data && (
        <>
          <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
            {charts.map((c, i) => (
              <div key={c.key} data-testid="nfr-vplot" data-variant={c.key} className="rounded" style={c.color ? { boxShadow: `inset 0 3px 0 ${c.color}` } : undefined}
                onDoubleClick={() => setBig(i)}>
                <VPlotChart matrix={c.matrix} sizeMin={c.sizeMin} sizeMax={c.sizeMax} windowBp={c.windowBp} sizeBin={c.sizeBin} posBin={c.posBin}
                  width={cell} height={Math.round(Math.min(170, Math.max(130, cell * 0.6)))} title={c.title} xLabels={c.xLabels} guides={c.guides}
                  filename={`nfr-vplot-${kind}-${c.key}-${stem(entry)}`} positionOrigin={data.window[0]} readable onMaximize={() => setBig(i)}
                  exportNotes={notes(c.key)} />
              </div>
            ))}
          </div>
          <p className="text-[10px] text-ink-secondary" title="Rows: opening width (dashed at the Timer 175 / 300 / 500-bp depths); columns: position (one grid for every panel). The variants' panels share one colour scale, so their densities compare; 'all' has its own.">
            {bp(data.size[0])}–{bp(data.size[1])} bp · double-click or ⤢ to enlarge, ← / → to step through
          </p>
          {big != null && charts[big] && (
            <VPlotViewer charts={charts} index={big} onIndex={setBig} onClose={() => setBig(null)} kind={kind} positionOrigin={data.window[0]}
              filename={c => `nfr-vplot-${kind}-${c}-${stem(entry)}`} notes={notes} />
          )}
        </>
      )}
    </div>
  );
}

type VPlotCell = { key: string; title: string; matrix: number[][]; color: string | undefined; sizeMin: number; sizeMax: number; windowBp: number;
  sizeBin: number; posBin: number; xLabels: [string, string, string]; guides: number[] };

/** One V-plot large; ← / → step through the panel's V-plots (all openings, then each variant), Esc closes. */
function VPlotViewer({ charts, index, onIndex, onClose, kind, positionOrigin, filename, notes }: {
  charts: VPlotCell[]; index: number; onIndex: (i: number) => void; onClose: () => void; kind: string; positionOrigin: number;
  filename: (key: string) => string; notes: (key: string) => Record<string, string>;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') { e.preventDefault(); onIndex((index + 1) % charts.length); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); onIndex((index - 1 + charts.length) % charts.length); }
      else if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, charts.length, onIndex, onClose]);
  const c = charts[index];
  const w = Math.min(980, Math.floor(window.innerWidth * 0.8));
  const h = Math.min(640, Math.floor(window.innerHeight * 0.7));
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={`V-plot ${c.title}`} data-testid="nfr-vplot-viewer" className="fixed inset-0 z-[100] flex items-center justify-center"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative rounded-lg bg-white p-3 shadow-2xl dark:bg-gray-900">
        <div className="mb-2 flex items-center gap-2 text-[12px]">
          <button type="button" onClick={() => onIndex((index - 1 + charts.length) % charts.length)} aria-label="Previous V-plot" className="rounded px-2 py-0.5 text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/10">←</button>
          <span className="font-semibold" style={{ color: c.color }} data-testid="nfr-vplot-viewer-name">{c.title}</span>
          <span className="text-ink-secondary">{index + 1} / {charts.length} · {kind === 'centre' ? 'centre' : 'coverage'} × size</span>
          <button type="button" onClick={() => onIndex((index + 1) % charts.length)} aria-label="Next V-plot" className="rounded px-2 py-0.5 text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/10">→</button>
          <button type="button" onClick={onClose} aria-label="Close" className="ml-auto rounded px-2 py-0.5 text-gray-500 hover:bg-gray-100 dark:hover:bg-white/10">×</button>
        </div>
        <ChartMaximizeContext.Provider value={true}>
          <VPlotChart matrix={c.matrix} sizeMin={c.sizeMin} sizeMax={c.sizeMax} windowBp={c.windowBp} sizeBin={c.sizeBin} posBin={c.posBin}
            width={w} height={h} title={c.title} xLabels={c.xLabels} guides={c.guides} filename={filename(c.key)} positionOrigin={positionOrigin}
            readable exportNotes={notes(c.key)} />
        </ChartMaximizeContext.Provider>
      </div>
    </div>,
    document.body,
  );
}

function PhasingView({ entry, names, width }: { entry: SavedNfr; names: string[]; width: number }) {
  const { data, error, loading } = useView<NfrPhasing>(() => getNfrPhasing(entry.jobId, entry.nfrId), `${entry.jobId}|${entry.nfrId}|phasing`);
  // Only positions enough reads of every series cover (no coverage is not "no nucleosome").
  const trimmed = useMemo(() => {
    if (!data) return null;
    const shown = names.filter(n => data.variants[n]);
    const series = [data.all, ...shown.map(n => data.variants[n].members)];
    const need = (s: { reads: number }) => Math.max(10, Math.round(s.reads * 0.1));
    const ok = data.all.x.map((_, i) => series.every(s => s.n[i] >= need(s) && s.occupancy[i] != null));
    const first = ok.indexOf(true), last = ok.lastIndexOf(true);
    if (first < 0) return null;
    const cut = <T,>(a: T[]) => a.slice(first, last + 1);
    const step = data.all.x.length > 1 ? data.all.x[1] - data.all.x[0] : 10;
    return {
      lo: data.all.x[first] - step / 2, hi: data.all.x[last] + step / 2, shown,
      series: [
        ...shown.map(n => ({ data: cut(data.variants[n].members.occupancy) as number[], color: variantColor(n), label: `${n} reads (${data.variants[n].members.reads.toLocaleString()})`, n: data.variants[n].members.reads })),
        { data: cut(data.all.occupancy) as number[], color: '#6b7280', label: `all callable reads (${data.all.reads.toLocaleString()})`, n: data.all.reads },
      ],
    };
  }, [data, names.join('|')]);
  return (
    <div className="space-y-1.5" data-testid="nfr-phasing-view">
      {loading && <Loading what="Nucleosome occupancy around the NFR…" />}
      {error && <AnalysisStatus kind="error">{error}</AnalysisStatus>}
      {data && !trimmed && <AnalysisStatus kind="info">Too few reads cover the flanks of this NFR for a phasing profile.</AnalysisStatus>}
      {data && trimmed && (
        <>
          <OverlayProfileChart width={width} height={190} windowBp={trimmed.hi - trimmed.lo} yLabel="nucleosome" filename={`nfr-phasing-${stem(entry)}`}
            caption={`${bp(trimmed.lo)}–${bp(trimmed.hi)}; ${trimmed.shown.map(n => `${n} ${bp(data.variants[n].span[0])}–${bp(data.variants[n].span[1])}`).join(', ')}`}
            series={trimmed.series} />
          <ul className="space-y-0.5 text-[11px] text-gray-600 dark:text-gray-300" data-testid="nfr-phasing-boundary">
            {trimmed.shown.map(n => {
              const b = data.variants[n].boundary;
              if (!b?.minus1 || !b?.plus1) return null;
              return (
                <li key={n}><span className="font-semibold" style={{ color: variantColor(n) }}>{n}</span>: −1 dyad at {bp(b.minus1.median)} (IQR {bp(b.minus1.q1)}–{bp(b.minus1.q3)}), +1 at {bp(b.plus1.median)} (IQR {bp(b.plus1.q1)}–{bp(b.plus1.q3)}): {bp(b.plus1.median - b.minus1.median)} bp apart.</li>
              );
            })}
          </ul>
          <p className="text-[10px] text-ink-secondary">Occupancy: of the reads covering a position, the share inside a ≥ 90-bp nucleosome call; one line per variant's member reads (a read can be a member of more than one variant), grey for every callable read.</p>
        </>
      )}
    </div>
  );
}

function PrevalenceView({ entry, names, width, stateKeyMap }: { entry: SavedNfr; names: string[]; width: number; stateKeyMap: Record<string, string[]> }) {
  const { clusterAssignments, clusterGroupLabels, datasets } = useBrowserStore(useShallow(s => ({
    clusterAssignments: s.clusterAssignments, clusterGroupLabels: s.clusterGroupLabels, datasets: s.datasets })));
  // Groups this panel put into the read panels (a pair split, combination patterns, configurations) keep their names,
  // per panel: the newest grouping that panel holds now (two datasets can hold two different groupings, and a grouping
  // on two panels still names the one not split since). Another panel's groups with the same ids are its own.
  const applied = useAccessibilityStore(s => s.applied);
  const groupNames = useMemo(() => {
    const byKey: Record<string, Map<number, string>> = {};
    for (const a of [...applied].reverse()) {
      for (const key of Object.keys(a.grouping?.written ?? {})) {
        if (byKey[key] || !groupingIsCurrentOn(a.grouping, key)) continue;
        const groups = a.split?.groups ?? a.configurations?.groups.map(g => ({ id: g.id, label: g.display_label })) ?? [];
        byKey[key] = new Map(groups.map(g => [g.id, g.label]));
      }
    }
    return byKey;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applied, clusterAssignments]);
  const dsLabel = (id: string) => { const d = datasets.find(x => x.id === id); return d ? getDatasetDisplayLabel(d) : id; };
  // The read groups the panels show now (clusters, a split, haplotype views: whatever is in the cluster store), per
  // panel of a dataset in the run.
  const groups = useMemo(() => {
    const out: Record<string, Record<string, string[]>> = {};
    const swatch: Record<string, string> = {};
    const keys = Object.entries(stateKeyMap).filter(([ds]) => entry.datasetIds.includes(ds));
    const multi = keys.reduce((n, [, ks]) => n + ks.length, 0) > 1;
    for (const [ds, ks] of keys) {
      ks.forEach((key, i) => {
        const a = clusterAssignments[key];
        if (!a) return;
        for (const [read, cid] of Object.entries(a)) {
          if (cid < 0) continue;
          // Per panel: an SV split's own names first (Carriers / Reference ...: the store drops them whenever that
          // panel's groups are replaced, so they are always its current ones; an NFR grouping with the same
          // membership, e.g. one just cleared back to the split, must not rename them), then the NFR group names.
          const name = clusterGroupLabels?.[key]?.[cid] ?? groupNames[key]?.get(cid) ?? getClusterLabel(cid, true);
          const label = `${multi ? `${dsLabel(ds)}${ks.length > 1 ? ` #${i + 1}` : ''} ` : ''}${name}`;
          ((out[label] ??= {})[ds] ??= []).push(read);
          swatch[label] = getClusterColor(cid);
        }
      });
    }
    return { groups: out, swatch };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterAssignments, clusterGroupLabels, stateKeyMap, entry.datasetIds.join('|'), datasets, groupNames]);
  // The request follows the groups' membership, not only their sizes.
  const signature = useMemo(() => membershipKey(groups.groups), [groups]);
  const { data, error, loading } = useView<NfrPrevalence>(() => getNfrPrevalence(entry.jobId, entry.nfrId, groups.groups, PREVALENCE_BOOTSTRAP), `${entry.jobId}|${entry.nfrId}|prev|${signature}`);
  const others = datasets.filter(d => !entry.datasetIds.includes(d.id) && (d.data_type ?? 'bam') === 'bam');
  const owner = useContext(NfrJobOwnerContext);
  // Quantify in another dataset: a server job followed by the panel (utils/nfrJobs), so it keeps going and its result
  // stays when this view closes; Cancel stops it on the server.
  const transferKey = (dsId: string) => `transfer|${entry.jobId}|${entry.nfrId}|${dsId}`;
  const quantify = (dsId: string) => {
    let id = '';
    startJob<TransferJob>(transferKey(dsId), async ctx => {
      let t = await startVariantTransfer(entry.jobId, entry.nfrId, [dsId]);
      id = t.transfer_id;
      // cancelled while the start request was in flight: the cancel had no id yet, so stop it on the server now
      if (ctx.signal.cancelled) { await cancelVariantTransfer(id).catch(() => undefined); return t; }
      ctx.progress(t);
      while ((t.status === 'queued' || t.status === 'running') && !ctx.signal.cancelled) {
        await sleep(1000);
        if (ctx.signal.cancelled) break;
        t = await getVariantTransfer(t.transfer_id);
        ctx.progress(t);
      }
      if (t.status === 'error') throw new Error(t.message);
      return t;
    }, { ...(owner ?? {}), label: `Quantify ${entry.nfrId} in ${dsLabel(dsId)}` }, () => (id ? cancelVariantTransfer(id) : undefined));
  };
  useJobBadges();     // re-render when a transfer moves
  const transferResults: Record<string, TransferJob | null> = Object.fromEntries(others.map(d => {
    const j = getJob<TransferJob>(transferKey(d.id));
    return [d.id, j?.status === 'done' ? j.data : null];
  }));
  const rows: PrevalenceGroupRow[] = [];
  if (data) {
    const all = data.groups.find(g => g.group === 'all');
    if (all) rows.push({ label: `all (${dsLabel(entry.datasetIds[0])}${entry.datasetIds.length > 1 ? ' +' : ''})`, callable: all.callable, variants: all.variants });
    for (const g of data.datasets) rows.push({ label: dsLabel(g.group), callable: g.callable, variants: g.variants });
    for (const g of data.groups) if (g.group !== 'all') rows.push({ label: g.group, swatch: groups.swatch[g.group], callable: g.callable, variants: g.variants });
  }
  for (const d of others) {
    const v = transferResults[d.id]?.result?.datasets[d.id];
    if (v) rows.push({ label: `${dsLabel(d.id)} (frozen)`, callable: v.callable, variants: Object.fromEntries(names.map(n => [n, v.variants[n] ?? { prevalence: null, strict: null, ci: null }])) });
  }
  return (
    <div className="space-y-2" data-testid="nfr-prevalence-view">
      {loading && <Loading what="Prevalence of every variant per group (EM with the run's variants fixed)…" />}
      {error && <AnalysisStatus kind="error">{error}</AnalysisStatus>}
      {data && (
        <>
          <PrevalencePlot rows={rows} names={names} width={width} title={`${entry.name}: prevalence by group`} filename={`nfr-prevalence-${stem(entry)}`} />
          <div className="overflow-x-auto">
            <table className="w-full text-[11px] tabular-nums" data-testid="nfr-prevalence-table">
              <thead className="text-left text-gray-500">
                <tr><th className="font-medium">Group</th><th className="font-medium">callable</th>
                  {names.map(n => <th key={n} className="font-medium" style={{ color: variantColor(n) }}>{n}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.label} className="border-t border-gray-100 dark:border-white/5">
                    <td className="pr-2">{r.swatch && <span className="mr-1 inline-block h-2 w-2 rounded-sm align-middle" style={{ background: r.swatch }} />}{r.label}</td>
                    <td className="pr-2">{r.callable.toLocaleString()}</td>
                    {names.map(n => {
                      const v = r.variants[n];
                      return <td key={n} className="pr-2">{pct(v?.prevalence)}{v?.ci ? <span className="ml-0.5 text-[10px] text-ink-secondary">[{Math.round(v.ci[0] * 100)}–{Math.round(v.ci[1] * 100)}]</span> : null}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {data?.tests && (['groups', 'datasets'] as const).map(k => {
        const t = data.tests![k];
        if (!t || t.p == null) return null;
        return (
          <p key={k} className="text-[11px] text-gray-600 dark:text-gray-300" data-testid={`nfr-usage-test-${k}`}
            title={`How likely differences this large between the ${k === 'groups' ? 'read groups' : 'datasets'} are by chance. G = ${t.g?.toFixed(1)}, df ${t.df}; `
              + `${t.groups.length} ${k}, ${Object.values(t.reads).reduce((a, b) => a + b, 0).toLocaleString()} reads. Per variant: `
              + `${names.map(n => { const v = t.variants[n]; return v ? `${n} q ${v.q == null ? '–' : v.q < 0.001 ? v.q.toExponential(0) : v.q.toFixed(3)}` : null; }).filter(Boolean).join(', ')}. ${t.definition}`}>
            Variant usage {t.p <= 0.05 ? 'differs' : 'does not detectably differ'} between {k === 'groups' ? 'read groups' : 'datasets'} (p {t.p.toExponential(1)})
          </p>
        );
      })}
      {data && !Object.keys(groups.groups).length && (
        <p className="text-[11px] text-gray-500">Cluster the reads (or split them from NFR pairs, or by haplotype views) to compare the variants' prevalence across groups.</p>
      )}
      {others.length > 0 && (
        <div className="space-y-1">
          <p className="text-[11px] text-gray-500" title={`Quantify ${entry.nfrId}'s variants in another open dataset with this run's variants fixed (no rediscovery), at ${entry.chrom}:${bp(entry.nfrStart)}–${bp(entry.nfrEnd)}`}>Other datasets:</p>
          <div className="flex flex-wrap gap-1.5">
            {others.map(d => <TransferButton key={d.id} jobKey={transferKey(d.id)} label={getDatasetDisplayLabel(d)} onStart={() => quantify(d.id)} />)}
          </div>
        </div>
      )}
      {data && <p className="text-[10px] text-ink-secondary">{data.note}</p>}
    </div>
  );
}

function TransferButton({ jobKey, label, onStart }: { jobKey: string; label: string; onStart: () => void }) {
  const j = useJob<TransferJob>(jobKey);
  const t = (j?.progress ?? null) as TransferJob | null;
  if (j?.status === 'loading') {
    // The shared job-status line (compact, as Identify and the alt-allele build show theirs): what, stage, elapsed, Cancel.
    return (
      <JobStatus compact title={`Quantify in ${label}`} testId="nfr-transfer-running" state={t?.status === 'running' ? 'running' : 'queued'}
        stage={t?.message || (t?.status === 'running' ? 'Quantifying' : 'Starting')} startedAt={j.started} onCancel={() => void cancelJob(jobKey)} />
    );
  }
  return (
    <AnalysisButton theme="fuchsia" variant="quiet" onClick={onStart} data-testid="nfr-transfer"
      title={j?.status === 'error' ? j.error : 'Load this dataset at the run\'s window and quantify the frozen variants'}>
      {j?.status === 'error' ? `${label}: failed (retry)` : j?.status === 'cancelled' ? `${label}: cancelled (again)` : j?.status === 'done' ? `${label}: quantified` : `Quantify in ${label}`}
    </AnalysisButton>
  );
}

function ExportView({ entry }: { entry: SavedNfr }) {
  const file = entry.name.replace(/\W+/g, '_');
  return (
    <div className="space-y-1.5 text-[12px]" data-testid="nfr-export-view">
      <div className="flex flex-wrap gap-1.5">
        <AnalysisButton theme="fuchsia" variant="soft" onClick={() => downloadTextFile(savedVariantsBed([entry]), `${file}.bed`)} data-testid="nfr-export-bed">BED of this NFR's variants</AnalysisButton>
        <a href={nfrMembersUrl(entry.jobId, entry.nfrId)} download data-testid="nfr-export-members"
          className="rounded-fb bg-fuchsia-50 px-2 py-1 text-[11px] font-medium text-fuchsia-700 hover:bg-fuchsia-100 dark:bg-fuchsia-900/20 dark:text-fuchsia-300">Per-read membership, every variant (TSV)</a>
        <AnalysisButton variant="neutral" onClick={() => downloadTextFile(JSON.stringify(entry, null, 1), `${file}.json`, 'application/json')}>Saved entry (JSON)</AnalysisButton>
      </div>
      <p className="text-[11px] text-gray-500">Figures: hover any chart in these views for PNG, SVG or PDF and its data as TSV. The sequence: Copy sequence / Download FASTA above. The run's own files (variants, configurations, pairs, per-read membership, manifest) are under Export at the end of the list.</p>
    </div>
  );
}
