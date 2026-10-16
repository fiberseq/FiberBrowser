import { scrollIntoViewWithin } from '../../../utils/scrollWithin';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { ConsensusCatalog, RecallerStrand } from '../../../api/consensusWorkflow';
import type { SavedClassInfo } from '../../../types';
import { useBrowserStore } from '../../../stores/browserStore';
import { useConsensusViewStore } from '../../../stores/consensusViewStore';
import { consensusFamilyColor } from '../../../utils/consensusVisual';
import {
  discrepancyFlags, discrepancyScore, formatRecallerTableTsv, pooledPrevalence, recallerChannels, recallerClassRows,
  robustnessDetail, robustnessSummary,
  tierEdge, tierLoose, tierSum, type DiscrepancyFlag, type RecallerChannel, type RecallerClassRow, type RecallerTier, type Weighting,
} from '../../../utils/recallerTable';
import { ClassPrevalenceChart } from '../../charts/ClassPrevalenceChart';
import { downloadTextFile, exportTimestamp } from '../../../utils/analysisExport';
import { nextSavedClassId, restoreRemovedGroups, savedClassGroups } from '../../../utils/savedClasses';

const CHANNEL_COLOR: Record<string, string> = { CT: '#0d9488', GA: '#d97706', pooled: '#7c3aed' };
import { consensusStateGroup } from './StateList';
import { Check } from '../../ui/Icons';
import { classFeature, hoverFeature, toggleClassFeatures } from '../../../utils/classFeatures';
import { featureKey } from '../../../stores/featureStore';
import { HowItWorks } from '../../ui/HowItWorks';
import { classRegionLine } from '../../../utils/classRegion';
import { useClassRegionOutlineStore } from '../../../stores/classRegionOutlineStore';
import { cssValue, FOCUS_FOOTPRINT_CLASS_EVENT, takePendingClassFocus, type FocusClassDetail } from '../../../utils/panelLinks';
import { useClassRowLinks } from './classLinks';
import { classLabel } from '../../../utils/classIdentity';
import { useRunName } from '../../../utils/runNames';
import { useUndoToastStore } from '../../../stores/undoToastStore';
import { useContainerWidth } from '../../../hooks/useContainerWidth';
import { DisclosureChevron } from '../../ui/Disclosure';
import { CartEntryInspect } from './CartEntryInspect';
import type { FootprintGroup } from '../../../types';
import { useFillHeight } from '../../../hooks/useFillHeight';

const pct = (v: number | null | undefined) => (v == null ? '—' : `${(100 * v).toFixed(1)}%`);
const cssId = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');
/** Below this list width a class row puts its numbers on a second line (the fixed parts of a row take ~420 px). */
export const NARROW_LIST_PX = 600;
const FLAG_LABEL: Record<DiscrepancyFlag['kind'], string> = { one_strand: 'one strand', strand_gap: 'CT ≠ GA', assay_gap: 'assay gap', unresolved: 'unresolved' };
const control = 'rounded border border-gray-300 bg-white px-1 py-0.5 dark:border-gray-600 dark:bg-gray-900';

/** One phrase wherever a channel does not support a class (the class list, its tooltips, Inspect, Saved, the legend):
 * "Not supported on CT (exact matches only)". */
export const unsupportedText = (channel: string) => `Not supported on ${channel} (exact matches only)`;
/** "amp_DddB.full CT" → "CT": the strand a channel label ends with (the label itself for a pooled channel). */
const strandOf = (label: string) => /\b(CT|GA)$/.exec(label)?.[1] ?? label;

function tip(c: RecallerChannel, r: RecallerStrand) {
  return [`${c.label}: ${pct(r.prevalence)} (lower bound ${pct(r.prevalence_lower_bound)}) of ${r.molecules.toLocaleString()} molecules`,
    ...(tiersWide(r) ? [`tiers: ${tierLine(r)}`, `cumulative: ${tierCumulativeLine(r)}`] : []),
    `${r.supported ? 'supported' : unsupportedText(strandOf(c.label))} (held-out gain ${r.support_gain_nats == null ? 'n/a' : `${r.support_gain_nats.toFixed(1)} nats`})`,
    `${r.resolved ? 'resolved' : 'unresolved'} (${r.resolution_nats.toFixed(1)} nats)`,
    `broader ${pct(r.broader)} · other shape ${pct(r.other_shape)} · accessible ${pct(r.accessible)}`,
    r.spots ? `learned spots ${r.spots}` : '', r.edge_contraction ? `edge ${r.edge_contraction}` : ''].filter(Boolean).join('\n');
}

function Cell({ value, edge, loose, parts = ['core'], color, faded, italic, picked, onClick, title }: {
  value: number | null; edge?: number | null; loose?: number | null; parts?: RecallerTier[]; color: string; faded: boolean; italic: boolean; picked: boolean; onClick?: () => void; title: string;
}) {
  const e = edge ?? value, l = loose ?? e;
  const wide = value != null && l != null && l - value >= .005;
  const main = value == null ? null : tierSum(value, e ?? value, l ?? value, parts);
  const w = (v: number | null | undefined) => `${Math.min(100, 100 * (v ?? 0))}%`;
  return (
    <td className="px-1 py-0.5 align-middle">
      <button type="button" onClick={onClick} title={title} aria-pressed={picked} data-testid="recaller-cell"
        className={`block w-full rounded px-1 text-right tabular-nums ${picked ? '' : 'opacity-30'} ${onClick ? 'hover:bg-gray-100 dark:hover:bg-gray-800' : 'cursor-default'}`}>
        <span className={`${faded ? 'text-ink-secondary' : 'text-gray-800 dark:text-gray-100'} ${italic ? 'italic' : ''}`}>{pct(main)}</span>
        {wide && (() => { const t = tierWords(value!, e!, l!); return (
          <span className="block text-[11px] leading-3 text-ink-secondary" data-testid="recaller-tiers">
            {(['core', 'edge', 'loose'] as const).map((k, i) => <span key={k} className={`whitespace-nowrap ${parts.includes(k) ? 'font-semibold text-gray-700 dark:text-gray-200' : ''}`}>
              {i ? ' · ' : ''}{k === 'core' ? `exact ${t.exact}` : k === 'edge' ? `edge ${t.edge}` : `other ${t.other}`}</span>)}
          </span>); })()}
        <span className="relative mt-0.5 block h-1 w-full rounded bg-gray-100 dark:bg-gray-800">
          <span className="absolute left-0 top-0 block h-1 rounded" style={{ width: w(l), backgroundColor: color, opacity: faded ? .12 : .2 }} />
          <span className="absolute left-0 top-0 block h-1 rounded" style={{ width: w(e), backgroundColor: color, opacity: faded ? .2 : .45 }} />
          <span className="absolute left-0 top-0 block h-1 rounded" style={{ width: w(value), backgroundColor: color, opacity: faded ? .35 : .9 }} />
        </span>
      </button>
    </td>
  );
}

interface Props {
  jobId: string;
  catalog: ConsensusCatalog;
  datasetLabels: Record<string, string>;
  /** 'classes': one line per class with a Save button (details are in Saved); 'compare': the full table with CT−GA and
   * between-assay difference columns, sorted by the largest difference. */
  variant?: 'classes' | 'compare';
  /** Names the run on classes saved from it ('run 2 · stringency 0.90'). */
  runLabel?: string;
  /** The region the run analysed, in words (ConsensusTools' analysedLine); else the catalog's coordinates. */
  analysedRegion?: string;
}

/** The run's region for saved classes and exported tables. */
const analysedOf = (catalog: ConsensusCatalog, analysedRegion?: string) =>
  analysedRegion || (catalog.region ? classRegionLine(catalog.region) : '');

export function RecallerClassTable(props: Props) {
  return props.variant === 'compare' ? <RecallerCompareTable {...props} /> : <RecallerClassList {...props} />;
}

/**
 * Lattice-recaller classes compared: one row per class, one column per channel (DAF strands separate, Hia5 pooled), EM
 * prevalence in each (with the + edge / + overlap range), the CT−GA and between-assay differences, and strong strand or
 * assay discrepancies flagged. Channels can be hidden or pooled.
 */
export function RecallerCompareTable({ jobId, catalog, datasetLabels, analysedRegion }: Props) {
  const channels = useMemo(() => recallerChannels(catalog, datasetLabels), [catalog, datasetLabels]);
  // Exported tables say which region the run analysed (a `# analysed: …` line first).
  const runRegion = useClassRegionOutlineStore(s => s.runRegions[jobId]);
  const analysed = analysedOf(catalog, analysedRegion ?? runRegion);
  const tsvNotes = analysed ? [`analysed: ${analysed}`] : [];
  const rows = useMemo(() => recallerClassRows(catalog), [catalog]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<'separate' | 'pooled'>('separate');
  const [weighting, setWeighting] = useState<Weighting>('molecules');
  const [sort, setSort] = useState<'position' | 'discrepancy'>('discrepancy');
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [plot, setPlot] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const [boxWidth, setBoxWidth] = useState(460);
  useEffect(() => {
    const el = boxRef.current; if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(entries => setBoxWidth(Math.max(260, Math.floor(entries[0].contentRect.width))));
    ro.observe(el); return () => ro.disconnect();
  }, [plot]);
  const selections = useConsensusViewStore(s => s.selections);

  const shown = channels.filter(c => !hidden.has(c.key));
  const shownKeys = shown.map(c => c.key);
  // One label per class in every panel (utils/classIdentity): "Class 025", from its own id.
  const name = (row: RecallerClassRow) => classLabel(row.family);
  const flagsOf = useMemo(() => new Map(rows.map(r => [r.family, discrepancyFlags(r, shown)])), [rows, shown]);
  const view = rows
    .filter(r => shownKeys.some(k => r.channels[k]))
    .filter(r => !flaggedOnly || (flagsOf.get(r.family) ?? []).some(f => f.strong))
    .sort((a, b) => sort === 'discrepancy' ? discrepancyScore(b, shown) - discrepancyScore(a, shown) || a.start - b.start : a.start - b.start || a.end - b.end);
  const datasets = [...new Set(shown.map(c => c.datasetId))];
  const dafDatasets = datasets.filter(d => shown.filter(c => c.datasetId === d && c.daf).length === 2);

  const selectClass = (row: RecallerClassRow, additive: boolean) => {
    const store = useConsensusViewStore.getState();
    row.datasets.forEach((datasetId, i) => store.select({ jobId, datasetId, family: row.family }, additive || i > 0));
  };
  const strongCount = rows.filter(r => (flagsOf.get(r.family) ?? []).some(f => f.strong)).length;

  return (
    <div data-testid="recaller-compare" className="space-y-1.5 text-[11px]">
      <div className="flex flex-wrap items-center gap-1">
        {channels.map(c => (
          <button key={c.key} type="button" aria-pressed={!hidden.has(c.key)} data-testid="recaller-channel-chip"
            onClick={() => setHidden(h => { const n = new Set(h); if (n.has(c.key)) n.delete(c.key); else if (channels.length - n.size > 1) n.add(c.key); return n; })}
            className={`rounded-full border px-2 py-0.5 ${hidden.has(c.key) ? 'border-gray-300 text-gray-400 line-through dark:border-gray-600' : 'border-cyan-600 bg-cyan-50 text-cyan-900 dark:bg-cyan-950/40 dark:text-cyan-100'}`}>
            {c.label}
          </button>
        ))}
        <span className="ml-auto inline-flex overflow-hidden rounded border border-gray-300 dark:border-gray-600">
          {(['separate', 'pooled'] as const).map(m => (
            <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}
              className={`px-2 py-0.5 ${mode === m ? 'bg-gray-800 text-white dark:bg-gray-200 dark:text-gray-900' : ''}`}>{m === 'separate' ? 'Separate' : 'Pooled'}</button>
          ))}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-gray-600 dark:text-gray-300">
        {mode === 'pooled' && <label className="flex items-center gap-1">Weight
          <select className={control} value={weighting} onChange={e => setWeighting(e.target.value as Weighting)} aria-label="Pooling weight">
            <option value="molecules">by molecules</option><option value="equal">channels equally</option></select></label>}
        <label className="flex items-center gap-1">Sort
          <select className={control} value={sort} onChange={e => setSort(e.target.value as 'position' | 'discrepancy')} aria-label="Class sort">
            <option value="position">genomic order</option><option value="discrepancy">largest discrepancy</option></select></label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={flaggedOnly} onChange={e => setFlaggedOnly(e.target.checked)} />
          flagged only ({strongCount})</label>
        <span className="ml-auto flex gap-1">
          <button type="button" className={control} data-testid="recaller-export-tsv" title="Every class and channel: three prevalence tiers, support, resolution and flags"
            onClick={() => downloadTextFile(formatRecallerTableTsv(view, shown, name, tsvNotes), `footprint_classes_${exportTimestamp()}.tsv`, 'text/tab-separated-values')}>Export TSV</button>
          <button type="button" className={control} aria-pressed={plot} data-testid="recaller-plot" onClick={() => setPlot(v => !v)}>{plot ? 'Hide plot' : 'Plot'}</button>
        </span>
      </div>
      {plot && <div ref={boxRef} className="w-full">
        <ClassPrevalenceChart width={boxWidth} filename="footprint_class_prevalence"
          channels={(mode === 'pooled' ? [{ label: `Pooled (${shown.length})`, color: '#475569' }] : shown.map(c => ({ label: c.label, color: CHANNEL_COLOR[c.strand] ?? '#475569' })))}
          groups={view.map(row => ({ label: name(row), color: consensusFamilyColor(row.family),
            bars: mode === 'pooled'
              ? [(() => { const q = pooledPrevalence(row, shownKeys, weighting); return { channel: 'pooled', color: '#475569', core: q.value, edge: q.edge, loose: q.loose, supported: q.supported }; })()]
              : shown.map(c => { const r = row.channels[c.key]; return { channel: c.label, color: CHANNEL_COLOR[c.strand] ?? '#475569',
                  core: r ? r.prevalence : null, edge: r?.supported ? tierEdge(r) : null, loose: r?.supported ? tierLoose(r) : null, supported: !!r?.supported }; }) }))}
          dataTsv={() => formatRecallerTableTsv(view, shown, name, tsvNotes)} />
      </div>}
      <div className="max-h-96 overflow-auto rounded border border-gray-200 dark:border-gray-700">
        <table className="w-full border-collapse">
          <thead className="sticky top-0 bg-gray-50 text-[11px] text-gray-500 dark:bg-gray-900 dark:text-gray-400">
            {mode === 'separate' && datasets.length > 1 && <tr>
              <th colSpan={2} />
              {datasets.map(d => <th key={d} colSpan={shown.filter(c => c.datasetId === d).length} className="border-l border-gray-200 px-1 text-center font-medium dark:border-gray-700">{datasetLabels[d] ?? d}</th>)}
              <th colSpan={dafDatasets.length + 2} />
            </tr>}
            <tr>
              <th className="px-1 py-0.5 text-left font-medium">Class</th>
              <th className="px-1 text-right font-medium">bp</th>
              {mode === 'separate'
                ? shown.map(c => <th key={c.key} title={c.label} className="px-1 text-right font-medium">{c.strand === 'pooled' ? (datasets.length > 1 ? 'pooled' : c.label) : c.strand}</th>)
                : <th className="px-1 text-right font-medium" title={shown.map(c => c.label).join(' + ')}>Pooled ({shown.length})</th>}
              {dafDatasets.map(d => <th key={d} className="px-1 text-right font-medium" title={`${datasetLabels[d] ?? d}: CT minus GA`}>CT−GA</th>)}
              {<th className="px-1 text-right font-medium" title="Largest difference between datasets (each pooled over its strands)">Δ assay</th>}
              <th className="px-1 text-left font-medium">Flags</th>
            </tr>
          </thead>
          <tbody>
            {view.map(row => {
              const color = consensusFamilyColor(row.family);
              const flags = flagsOf.get(row.family) ?? [];
              const selected = selections.some(s => s.jobId === jobId && s.family === row.family);
              const pooled = pooledPrevalence(row, shownKeys, weighting);
              const levels = datasets.map(d => pooledPrevalence(row, shown.filter(c => c.datasetId === d).map(c => c.key), 'molecules').value).filter((v): v is number => v != null);
              return (
                <tr key={row.family} data-testid="recaller-row" className={`border-t border-gray-100 dark:border-gray-800 ${selected ? 'bg-cyan-50 dark:bg-cyan-950/30' : ''}`}>
                  <td className="px-1 py-0.5">
                    <button type="button" className="flex items-center gap-1 whitespace-nowrap text-left" title="Highlight this class on the reads (Cmd/Ctrl-click adds)"
                      onClick={e => selectClass(row, e.metaKey || e.ctrlKey)}>
                      <span className="h-2.5 w-2.5 flex-shrink-0 rounded-sm" style={{ backgroundColor: color }} />
                      <span className="font-medium text-gray-800 dark:text-gray-100">{name(row)}</span>
                    </button>
                  </td>
                  <td className="px-1 text-right tabular-nums text-gray-500">{Math.round(row.end - row.start)}</td>
                  {mode === 'separate'
                    ? shown.map(c => {
                      const r = row.channels[c.key];
                      if (!r) return <td key={c.key} className="px-1 text-right text-gray-300">—</td>;
                      // Upper tiers only where the channel supports the class: otherwise they are chance edge alignments.
                      return <Cell key={c.key} value={r.prevalence} edge={r.supported ? tierEdge(r) : null} loose={r.supported ? tierLoose(r) : null} color={color} faded={!r.supported} italic={!r.resolved}
                        picked title={tip(c, r)} />;
                    })
                    : <Cell value={pooled.value} edge={pooled.edge} loose={pooled.loose} color={color} faded={!pooled.supported} italic={!pooled.resolved} picked
                        title={`${shownKeys.map(k => channels.find(c => c.key === k)?.label).join(' + ')}: ${pct(pooled.value)}${pooled.lower != null ? ` (lower bound ${pct(pooled.lower)})` : ''} of ${pooled.molecules.toLocaleString()} molecules`} />}
                  {dafDatasets.map(d => {
                    const ct = row.channels[`${d}::CT`], ga = row.channels[`${d}::GA`];
                    const diff = ct && ga ? ct.prevalence - ga.prevalence : null;
                    return <td key={d} className={`px-1 text-right tabular-nums ${diff != null && Math.abs(diff) >= .1 ? 'font-medium text-amber-700 dark:text-amber-300' : 'text-gray-500'}`}>
                      {diff == null ? '—' : `${diff > 0 ? '+' : ''}${(100 * diff).toFixed(1)}`}</td>;
                  })}
                  {<td className={`px-1 text-right tabular-nums ${levels.length > 1 && Math.max(...levels) - Math.min(...levels) >= .2 ? 'font-medium text-amber-700 dark:text-amber-300' : 'text-gray-500'}`}>
                    {levels.length > 1 ? (100 * (Math.max(...levels) - Math.min(...levels))).toFixed(1) : '—'}</td>}
                  <td className="px-1">
                    <span className="flex flex-wrap gap-0.5">
                      {flags.map((f, i) => <span key={i} title={f.text} data-testid="recaller-flag"
                        className={`whitespace-nowrap rounded px-1 text-[11px] ${f.strong ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200' : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'}`}>{FLAG_LABEL[f.kind]}</span>)}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-gray-500">
        EM prevalence: the share of molecules spanning the class window that carry it; below it (when wider) exact, then the
        percentage points “edge” adds (wider protection with one edge lined up with the class edge) and “other” adds (other
        protection up to 100 bp over the class).
         Grey: not supported on that channel (exact matches only; held-out gain);
        italic: unresolved (too little lattice evidence).
        {' '}Flags: one strand = supported on CT or GA only; CT ≠ GA = both supported but more than 2-fold and 10 points apart; assay gap = datasets 20 or more points apart.
      </p>
    </div>
  );
}

/**
 * A labelled sample of the prevalence bar (How to read this): the solid part counts
 * molecules with exactly this footprint, the lighter part adds wider footprints that
 * share one of its edges, the faint part adds other footprints over the site (tiers
 * core, + one edge, + other shapes in utils/recallerTable).
 */
export function PrevalenceLegend({ color = CHANNEL_COLOR.CT }: { color?: string }) {
  const seg = (width: string, opacity: number) => (
    <span className="absolute left-0 top-0 block h-full rounded-sm" style={{ width, backgroundColor: color, opacity }} />
  );
  return (
    <div className="space-y-1.5 py-1" data-testid="recaller-legend">
      <span className="relative block h-2 w-full max-w-[16rem] rounded-sm bg-gray-100 dark:bg-gray-800" aria-hidden="true">
        {seg('78%', 0.2)}{seg('55%', 0.45)}{seg('35%', 0.95)}
      </span>
      <div className="grid max-w-[16rem] grid-cols-3 gap-1 text-[10px] leading-3">
        <span><span className="mr-1 inline-block h-2 w-2 rounded-sm align-[-1px]" style={{ backgroundColor: color, opacity: .95 }} />exact match</span>
        <span><span className="mr-1 inline-block h-2 w-2 rounded-sm align-[-1px]" style={{ backgroundColor: color, opacity: .45 }} />+ sharing one edge</span>
        <span><span className="mr-1 inline-block h-2 w-2 rounded-sm align-[-1px]" style={{ backgroundColor: color, opacity: .2 }} />+ other footprints here</span>
      </div>
      <ul className="space-y-0.5 text-[11px]">
        <li><strong>Exact match</strong>: the molecule has this footprint, edges and all.</li>
        <li><strong>+ sharing one edge</strong>: also counts a wider footprint that lines up with one of its edges.</li>
        <li><strong>+ other footprints here</strong>: also counts any other footprint over the site (up to 100 bp larger).</li>
        <li className="flex items-center gap-1.5">
          <span className="relative inline-block h-1.5 w-10 rounded-sm bg-gray-100 dark:bg-gray-800"><span className="absolute left-0 top-0 block h-full w-1/2 rounded-sm" style={{ backgroundColor: '#94a3b8', opacity: .5 }} /></span>
          grey: that strand's data alone don't support the class.
        </li>
        <li className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-amber-400" />
          the strands or datasets disagree about it (point at the dot to see how).
        </li>
      </ul>
    </div>
  );
}

/** One channel's prevalence as a thin bar: solid exact matches, lighter + sharing one edge, faint + other
 * footprints over the site; grey where the channel does not support the class (see PrevalenceLegend). */
export function PrevalenceBar({ r, color, title }: { r: RecallerStrand | undefined; color: string; title: string }) {
  const w = (v: number | null | undefined) => `${Math.min(100, 100 * (v ?? 0))}%`;
  const faded = !r?.supported;
  return (
    <span className="relative block h-1.5 w-full rounded-sm bg-gray-100 dark:bg-gray-800" title={title} data-testid="recaller-bar">
      {r && <>
        {r.supported && <span className="absolute left-0 top-0 block h-full rounded-sm" style={{ width: w(tierLoose(r)), backgroundColor: color, opacity: .2 }} />}
        {r.supported && <span className="absolute left-0 top-0 block h-full rounded-sm" style={{ width: w(tierEdge(r)), backgroundColor: color, opacity: .45 }} />}
        <span className="absolute left-0 top-0 block h-full rounded-sm" style={{ width: w(r.prevalence), backgroundColor: faded ? '#94a3b8' : color, opacity: faded ? .5 : .95 }} />
      </>}
    </span>
  );
}

export const channelColor = (c: { strand: string }) => CHANNEL_COLOR[c.strand] ?? '#475569';

/** The three tiers as labelled values: exact as a percent, the wider tiers as what each adds, in percentage points
 * ("exact 5.2%", "+28 pp", "+21 pp"). One formatter for every place that shows them (the class list, its tooltips,
 * Inspect, Saved), so the row and its tooltip always say the same thing. */
export function tierText(r: RecallerStrand): { exact: string; edge: string; other: string } {
  return tierWords(r.prevalence, tierEdge(r), tierLoose(r));
}

/** tierText from the three cumulative values (a pooled cell has no strand of its own). */
export function tierWords(exact: number, edge: number, loose: number): { exact: string; edge: string; other: string } {
  const pp = (v: number) => `+${Math.round(100 * Math.max(0, v))} pp`;
  return { exact: pct(exact), edge: pp(edge - exact), other: pp(loose - edge) };
}

/** Whether a channel's wider tiers add anything worth showing (supported, and at least half a point wider). */
export const tiersWide = (r: RecallerStrand) => r.supported && tierLoose(r) - r.prevalence >= .005;

/** "exact 5.2% · edge +28 pp · other +21 pp": the increments each wider tier adds (percentage points). An unsupported
 * channel has no upper tiers (chance edge alignments): only "exact 5.2%". */
export function tierLine(r: RecallerStrand): string {
  const t = tierText(r);
  return tiersWide(r) ? `exact ${t.exact} · edge ${t.edge} · other ${t.other}` : `exact ${t.exact}`;
}

/** "exact 5.2% · ≤ edge 33.2% · ≤ other 54.0%": cumulative, each tier counting everything up to it (what a saved
 * class counts when it includes that tier). */
export function tierCumulativeLine(r: RecallerStrand): string {
  return tiersWide(r) ? `exact ${pct(r.prevalence)} · ≤ edge ${pct(tierEdge(r))} · ≤ other ${pct(tierLoose(r))}` : `exact ${pct(r.prevalence)}`;
}

/** A channel's tiers for a tooltip: the increments shown on the row, then the cumulative values, with the denominator. */
export function tierTitle(label: string, r: RecallerStrand): string {
  return [`${label}: ${tierLine(r)} of ${r.molecules.toLocaleString()} molecules`,
    ...(tiersWide(r) ? [`cumulative: ${tierCumulativeLine(r)}`] : []),
    ...(r.supported ? [] : [unsupportedText(strandOf(label))])].join('\n');
}

/** "5.2% · +28 · +21 pp": a channel's tiers as one compact line (R4), the words (exact / edge / other) left to the
 * legend, the tooltip and Inspect. An unsupported channel: its exact % only. */
export function tierCompact(r: RecallerStrand): string {
  const t = tierText(r);
  return tiersWide(r) ? `${t.exact} · ${t.edge.replace(/ pp$/, '')} · ${t.other}` : t.exact;
}

/** tierCompact in three right-aligned columns, so the numbers line up from row to row (exact; + edge; + other pp).
 * Exact is bold, or italic where the channel does not support the class. */
function TierCells({ r }: { r: RecallerStrand }) {
  const t = tierText(r);
  const wide = tiersWide(r);
  return <>
    <span className={`inline-block w-[2.6rem] ${r.supported ? 'font-medium text-gray-800 dark:text-gray-100' : 'italic'}`}>{t.exact}</span>
    <span className="inline-block w-[2.5rem]">{wide ? ` · ${t.edge.replace(/ pp$/, '')}` : ''}</span>
    <span className="inline-block w-[3.5rem]">{wide ? ` · ${t.other}` : ''}</span>
  </>;
}

/** One line above the class list: what a channel's line says (exact % · + edge · + other pp, as on the rows), the grey
 * of an unsupported channel and the dot (How to read this has the details). */
export function CompactPrevalenceLegend({ flagged }: { flagged: boolean }) {
  const sw = (opacity: number, color = CHANNEL_COLOR.CT) => <span className="mr-0.5 inline-block h-2 w-2 rounded-sm align-[-1px]" style={{ backgroundColor: color, opacity }} />;
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-gray-600 dark:text-gray-300" data-testid="recaller-compact-legend">
      <span className="whitespace-nowrap" data-testid="recaller-legend-tiers"
        title={'Each channel\'s line: the exact %, then the percentage points each wider tier adds.\nexact: molecules with exactly this footprint\n+ edge: also a wider footprint sharing one edge with it\n+ other: also any other footprint over the site (up to 100 bp larger)'}>
        {sw(.95)}exact % · {sw(.45)}+ edge · {sw(.2)}+ other pp</span>
      <span className="whitespace-nowrap">{sw(.5, '#94a3b8')}grey: not supported (exact matches only)</span>
      {flagged && <span className="whitespace-nowrap" title="Point at a dot on a row to see which strands or datasets disagree, and by how much">
        <span className="mr-0.5 inline-block h-2 w-2 rounded-full bg-amber-400 align-[-1px]" /><span data-testid="recaller-flag-legend">strands or datasets disagree</span></span>}
    </p>
  );
}

/**
 * The run's classes, one line each: a prevalence bar per channel and Save. A saved class becomes its own definition
 * (S1, S2, ...) tied to this run; what it counts, its channels, filtering, numbers, plot and export are in Saved.
 */
function RecallerClassList({ jobId, catalog, datasetLabels, runLabel = '', analysedRegion }: Props) {
  const channels = useMemo(() => recallerChannels(catalog, datasetLabels), [catalog, datasetLabels]);
  const rows = useMemo(() => recallerClassRows(catalog).sort((a, b) => a.start - b.start || a.end - b.end), [catalog]);
  const selections = useConsensusViewStore(s => s.selections);
  // One short run name ("Footprint run 2 · 6 Oct 14:02"; the id in the tooltip); the run's settings after it.
  const run = useRunName('footprint', jobId);
  const runSettings = runLabel.replace(/^run \d+( · )?/, '');
  const { footprintGroups, setFootprintGroups } = useBrowserStore(useShallow(s => ({ footprintGroups: s.footprintGroups, setFootprintGroups: s.setFootprintGroups })));
  // One label per class in every panel (utils/classIdentity): "Class 025", from its own id, not a per-view rank.
  const name = (row: RecallerClassRow) => classLabel(row.family);
  // Inspect a class here without saving it: its numbers per channel, sequence, motifs and V-plot.
  const [inspecting, setInspecting] = useState<string | null>(null);
  const isSaved = (family: string) => footprintGroups.some(g => g.savedClass && g.consensusJobId === jobId && g.consensusStateId === family);
  const savedCount = new Set(footprintGroups.filter(g => g.savedClass && g.consensusJobId === jobId).map(g => g.consensusStateId)).size;
  // Only for a run that had the read-order check (Check robustness to read order); otherwise nothing is shown.
  const robustness = useMemo(() => robustnessSummary(rows), [rows]);
  const orderings = catalog.robustness?.orderings;
  // Links plugin packs add to a class row (classLinks.ts): their panel at what the class sits in.
  const rowLinks = useClassRowLinks();
  // Narrow (the side column, 420 px): the numbers go on their own line under the class, so they never run under
  // "Add to Saved" (N1); wide: one line per class.
  const [listWidth, listRef] = useContainerWidth(420);
  const narrow = listWidth < NARROW_LIST_PX;
  // The list fills the panel's height (R4: ten or more classes in view at 1440x900), not a fixed 384 px.
  const fillHeight = useFillHeight(listRef, { min: 240, reserve: 64 });
  // Inspect is as wide as the list (its charts fit the panel).
  const inspectWidth = Math.max(260, listWidth - 20);
  const inspectRow = inspecting ? rows.find(r => r.family === inspecting) ?? null : null;
  // Inspect opens under the list: focus moves there (and it comes into view), and closing it returns focus to the
  // row's arrow, so keyboard users don't have to walk the rest of the list to reach it.
  const inspectId = `recaller-inspect-${cssId(jobId)}`;
  const inspectRef = useRef<HTMLDivElement>(null);
  // Keyboard (Enter/Space on the arrow: a click with detail 0) moves focus into the panel; a mouse click leaves focus
  // and the list where they are, and only brings the panel into view when it is below the visible part.
  const openedByKeyboard = useRef(false);
  useEffect(() => {
    if (!inspecting) return;
    const el = inspectRef.current;
    if (!el) return;
    if (openedByKeyboard.current) {
      scrollIntoViewWithin(el, { block: 'nearest', behavior: 'smooth' });
      el.focus({ preventScroll: true });
    } else if (el.getBoundingClientRect().top > window.innerHeight - 40) scrollIntoViewWithin(el, { block: 'nearest', behavior: 'smooth' });
  }, [inspecting]);
  const closeInspect = () => {
    const family = inspecting;
    setInspecting(null);
    if (family) requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-testid="recaller-row"][data-family="${cssValue(family)}"] [data-testid="recaller-inspect"]`)?.focus());
  };
  // Opened from another panel: bring the class's row into view (now, or once this run's list has mounted), marked.
  const [linked, setLinked] = useState<string | null>(null);
  useEffect(() => {
    const focus = (d: FocusClassDetail | null) => {
      if (!d || d.jobId !== jobId) return;
      setLinked(d.classId);
      const el = listRef.current?.querySelector<HTMLElement>(`[data-family="${cssValue(d.classId)}"]`);
      scrollIntoViewWithin(el, { block: 'center', behavior: 'smooth' });
    };
    focus(takePendingClassFocus(jobId));
    const handler = (event: Event) => {
      const d = (event as CustomEvent<FocusClassDetail>).detail;
      if (d?.jobId === jobId) takePendingClassFocus(jobId);
      focus(d ?? null);
    };
    window.addEventListener(FOCUS_FOOTPRINT_CLASS_EVENT, handler);
    return () => window.removeEventListener(FOCUS_FOOTPRINT_CLASS_EVENT, handler);
  }, [jobId]);

  const save = (row: RecallerClassRow) => {
    const all = useBrowserStore.getState().footprintGroups;
    const present = channels.filter(c => row.channels[c.key]);
    const supported = present.filter(c => row.channels[c.key].supported);
    const info: SavedClassInfo = {
      id: nextSavedClassId(all), family: row.family, className: name(row), runLabel, start: row.start, end: row.end,
      ...(analysedOf(catalog, analysedRegion) ? { analysedRegion: analysedOf(catalog, analysedRegion) } : {}),
      channels: present.map(({ key, datasetId, strand, label, daf, source }) => ({ key, datasetId, strand, label, daf, source })),
      stats: Object.fromEntries(present.map(c => [c.key, row.channels[c.key]])),
      picked: (supported.length ? supported : present).map(c => c.key),
    };
    const dataset = catalog.datasets[row.datasets[0]];
    const family = dataset.catalog.find(f => f.family === row.family)!;
    const template = { ...consensusStateGroup(jobId, row.datasets[0], dataset, family, catalog.region?.chrom ?? useBrowserStore.getState().chrom,
      catalog.view_stage ?? catalog.final_stage), color: consensusFamilyColor(row.family) };
    setFootprintGroups([...all, ...savedClassGroups(info, template, 'core')]);
  };
  const unsave = (family: string) => {
    const before = useBrowserStore.getState().footprintGroups;
    const removed = before.filter(g => g.savedClass && g.consensusJobId === jobId && g.consensusStateId === family);
    setFootprintGroups(before.filter(g => !removed.includes(g)));
    const ids = [...new Set(removed.map(g => g.savedClass!.id))].join(', ');
    useUndoToastStore.getState().show('footprints', `Removed ${ids} · ${classLabel(family)} from Saved`,
      () => useBrowserStore.getState().setFootprintGroups(restoreRemovedGroups(removed, useBrowserStore.getState().footprintGroups)));
  };
  /** The class as a definition to inspect (not saved): the same template Save uses. */
  const inspectGroup = (row: RecallerClassRow): FootprintGroup => {
    const dataset = catalog.datasets[row.datasets[0]];
    const family = dataset.catalog.find(f => f.family === row.family)!;
    return { ...consensusStateGroup(jobId, row.datasets[0], dataset, family, catalog.region?.chrom ?? useBrowserStore.getState().chrom,
      catalog.view_stage ?? catalog.final_stage), id: `inspect-${jobId}-${row.family}`, name: name(row) };
  };
  const selectClass = (row: RecallerClassRow, additive: boolean) => {
    const store = useConsensusViewStore.getState();
    row.datasets.forEach((datasetId, i) => store.select({ jobId, datasetId, family: row.family }, additive || i > 0));
  };
  // Features: shift-click a class to select it (in each of its datasets) for the main toolbar's Cluster / Sort / Filter.
  const selectedFeatureKeys = useBrowserStore(useShallow(s => s.selectedFeatures.map(featureKey)));
  const featuresOf = (row: RecallerClassRow) => row.datasets.map(ds => classFeature(jobId, ds, row.family, row.start, row.end, catalog.region?.chrom, name(row)));

  return (
    <div data-testid="recaller-class-table" className="space-y-1.5 text-[11px]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-gray-600 dark:text-gray-300">
        <span className="font-medium" data-testid="recaller-class-count">{rows.length} class{rows.length === 1 ? '' : 'es'} in this window{savedCount ? ` · ${savedCount} saved` : ''}</span>
        <span className="text-gray-600 dark:text-gray-300" data-testid="recaller-run-label" title={`${run.title}${runLabel ? ` (${runLabel})` : ''}`}>{run.name}{runSettings ? ` · ${runSettings}` : ''}</span>
        {robustness && <span data-testid="recaller-robust-summary" className="text-gray-500 dark:text-gray-400"
          title={`Classes were found again with the reads in ${orderings ? `${orderings - 1} other order${orderings === 2 ? '' : 's'}` : 'other orders'}. A robust class was found${catalog.robustness?.robust_fraction != null && catalog.robustness.robust_fraction < 1 ? ` in at least ${Math.round(100 * catalog.robustness.robust_fraction)}% of them` : ' every time'}; the others are close to the detection threshold and may come and go when the reads are processed in another order. The classes and numbers shown are those of the normal order.`}>
          {robustness.text}</span>}
        <span className="ml-auto flex flex-wrap items-center gap-2 text-[11px]">
          {channels.map(c => <span key={c.key} className="flex items-center gap-1">
            <span className="h-1.5 w-3 rounded-sm" style={{ backgroundColor: channelColor(c) }} />{c.label}</span>)}
        </span>
      </div>
      {/* The dot on a row has a key wherever it appears (L10): in this legend, once. */}
      <CompactPrevalenceLegend flagged={rows.some(row => discrepancyFlags(row, channels).some(f => f.strong))} />
      <div className={`${fillHeight == null ? 'max-h-96' : ''} overflow-auto rounded border border-gray-200 dark:border-gray-700`} ref={listRef}
        style={fillHeight == null ? undefined : { maxHeight: fillHeight }} data-testid="recaller-class-list" data-layout={narrow ? 'narrow' : 'wide'}>
        {rows.map(row => {
          const color = consensusFamilyColor(row.family);
          const saved = isSaved(row.family);
          const strong = discrepancyFlags(row, channels).filter(f => f.strong);
          const selected = selections.some(s => s.jobId === jobId && s.family === row.family);
          const featureSelected = featuresOf(row).some(f => selectedFeatureKeys.includes(featureKey(f)));
          const open = inspecting === row.family;
          const marked = selected || linked === row.family;
          // The numbers per channel, one compact line each (R4): a bar and "5.2% · +28 · +21 pp" in aligned columns;
          // the words are in the legend, the tooltip and Inspect (and read out to screen readers).
          const stats = (
            <span className={`flex min-w-0 flex-col ${narrow ? 'w-full pl-7' : 'min-w-[12.5rem] flex-1'}`} data-testid="recaller-row-stats">
              {channels.map(c => { const r = row.channels[c.key];
                return (
                  <span key={c.key} className="flex min-w-0 items-center gap-1.5 leading-[13px]" data-testid="recaller-channel-line">
                    <span className="min-w-[3rem] flex-1"><PrevalenceBar r={r} color={channelColor(c)} title={r ? tip(c, r) : `${c.label}: not quantified`} /></span>
                    <span className="min-w-0 shrink-0 whitespace-nowrap text-right text-[10px] tabular-nums text-gray-600 dark:text-gray-300" data-testid="recaller-tier-text"
                      aria-hidden="true" title={r ? tierTitle(c.label, r) : undefined}>
                      {r ? <TierCells r={r} /> : '—'}
                    </span>
                    <span className="sr-only">{r ? `${c.label}: ${tierLine(r)}${r.supported ? '' : `. ${unsupportedText(strandOf(c.label))}`}` : `${c.label}: not quantified`}</span>
                  </span>
                ); })}
            </span>
          );
          return (
            <div key={row.family} data-testid="recaller-row-wrap" data-family={row.family} className="border-b border-gray-100 last:border-b-0 dark:border-gray-800">
            <div data-testid="recaller-row" data-family={row.family} data-feature-selected={featureSelected || undefined} data-selected={marked || undefined}
              onMouseEnter={() => hoverFeature(featuresOf(row)[0] ?? null)} onMouseLeave={() => hoverFeature(null)}
              className={`flex flex-wrap items-center gap-x-2 gap-y-0.5 border-l-4 px-2 py-0.5 ${marked ? 'border-l-cyan-600 bg-cyan-50 dark:border-l-cyan-400 dark:bg-cyan-950/40' : 'border-l-transparent'} ${featureSelected ? 'ring-2 ring-inset ring-gray-900 dark:ring-gray-100' : ''}`}>
              <button type="button" onClick={e => { if (open) { closeInspect(); return; } openedByKeyboard.current = e.detail === 0; selectClass(row, false); setInspecting(row.family); }} aria-expanded={open}
                aria-controls={open ? inspectId : undefined}
                aria-label={`${open ? 'Close' : 'Inspect'} ${name(row)}`} data-testid="recaller-inspect" title="Inspect: this class's numbers per strand, sequence, motifs and V-plot (no need to save it)"
                className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800">
                <DisclosureChevron open={open} />
              </button>
              <button type="button" className="flex w-[5.5rem] flex-shrink-0 items-center gap-1 whitespace-nowrap text-left" title="Highlight this class on the reads (Cmd/Ctrl-click adds); shift-click selects it for Cluster, Sort and Filter (main toolbar)"
                aria-pressed={selected} data-testid="recaller-class-name"
                onClick={e => { if (e.shiftKey) toggleClassFeatures(featuresOf(row)); selectClass(row, e.metaKey || e.ctrlKey || e.shiftKey); }}>
                <span className="h-2.5 w-2.5 flex-shrink-0 rounded-sm" style={{ backgroundColor: color }} />
                <span className="font-medium text-gray-800 dark:text-gray-100">{name(row)}</span>
              </button>
              <span className="w-10 flex-shrink-0 text-right tabular-nums text-gray-600 dark:text-gray-300">{Math.round(row.end - row.start)} bp</span>
              {robustness && <span className="w-11 flex-shrink-0" title={robustnessDetail(row, orderings)}>
                {row.robust
                  ? <span data-testid="recaller-robust-badge" className="inline-block rounded border border-gray-300 px-1 text-[10px] leading-4 text-gray-600 dark:border-gray-600 dark:text-gray-300">robust</span>
                  : <span data-testid="recaller-not-robust" className="text-[10px] italic text-gray-500 dark:text-gray-400">varies</span>}
              </span>}
              {narrow ? <span className="flex-1" /> : stats}
              {rowLinks({ chrom: catalog.region?.chrom, start: row.start, end: row.end, classId: row.family, jobId }).map(link => (
                <button key={link.key} type="button" data-testid={link.testId} onClick={link.onClick}
                  className={`flex-shrink-0 whitespace-nowrap rounded px-1 text-[10px] ${link.className}`} title={link.title}>
                  {link.label}
                </button>
              ))}
              <span className="w-2 flex-shrink-0">
                {strong.length > 0 && <span className="block h-2 w-2 rounded-full bg-amber-400" data-testid="recaller-flag" title={strong.map(f => f.text).join('\n')} />}
              </span>
              <button type="button" aria-pressed={saved} aria-label={`${saved ? 'Remove' : 'Add'} ${name(row)} ${saved ? 'from' : 'to'} Saved`} data-testid="recaller-save"
                onClick={() => saved ? unsave(row.family) : save(row)}
                title={saved ? 'In Saved: remove it (Undo is offered)' : 'Add to Saved: keep this class as its own definition (counting rules, channels, filter, plot, export; Co-occupancy; clustering)'}
                className={`inline-flex h-5 w-[5.5rem] flex-shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-fb border px-1.5 font-medium leading-none transition-colors ${saved
                  ? 'border-emerald-700 bg-emerald-700 text-white hover:bg-emerald-800'
                  : 'border-emerald-600 text-emerald-700 hover:bg-emerald-50 dark:text-emerald-300 dark:hover:bg-emerald-950/40'}`}>
                {saved ? <><Check size={11} strokeWidth={2.5} aria-hidden="true" />Remove</> : 'Add to Saved'}
              </button>
              {narrow && stats}
            </div>
            </div>
          );
        })}
      </div>
      {/* Inspect opens under the list, at the panel's width, not inside the list's scroll box (FP-3). */}
      {inspectRow && (
        <div className="min-w-0 space-y-1 rounded border border-cyan-200 bg-gray-50/70 px-2 py-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 dark:border-cyan-900 dark:bg-white/[0.03]"
          data-testid="recaller-inspect-panel" data-family={inspectRow.family} id={inspectId} ref={inspectRef} tabIndex={-1} role="region" aria-label={`Inspect ${name(inspectRow)}`}
          onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); closeInspect(); } }}>
          <div className="flex items-center gap-2 text-[11px]">
            <span className="h-2.5 w-2.5 flex-shrink-0 rounded-sm" style={{ backgroundColor: consensusFamilyColor(inspectRow.family) }} />
            <span className="font-medium text-gray-800 dark:text-gray-100">{name(inspectRow)}</span>
            <span className="text-ink-muted">inspected</span>
            <button type="button" className="ml-auto rounded px-1 text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800" data-testid="recaller-inspect-close"
              onClick={closeInspect} aria-label={`Close ${name(inspectRow)}`}>Close</button>
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] tabular-nums text-gray-700 dark:text-gray-200">
            {channels.filter(c => inspectRow.channels[c.key]).map(c => {
              const r = inspectRow.channels[c.key];
              return <span key={c.key} data-testid="recaller-inspect-channel" title={tierTitle(c.label, r)}>{c.label}: {tierLine(r)} of {r.molecules.toLocaleString()} molecules{r.supported ? '' : ` · ${unsupportedText(strandOf(c.label))}`}</span>;
            })}
          </div>
          {/* Keyed by run and class: another class gets a fresh inspector (no V-plot or motifs of the last one). */}
          <CartEntryInspect key={`${jobId}:${inspectRow.family}`} group={inspectGroup(inspectRow)} targetDatasetIds={inspectRow.datasets} width={inspectWidth} />
        </div>
      )}
      <HowItWorks summary="How to read this" testId="recaller-how-to-read">
        <p>Each bar shows how often the class is found among the molecules that cover its position, one bar per
        strand (CT, GA) or dataset.</p>
        <PrevalenceLegend />
        {robustness && <p><strong>robust</strong> means the class was found again when the reads were processed in other
        orders{(catalog.robustness?.robust_fraction ?? 1) < 1 ? ` (in at least ${Math.round(100 * catalog.robustness!.robust_fraction!)}% of them)` : ''};
        {' '}<strong>varies</strong> marks a class close to the detection threshold that only some orders find. The
        classes and numbers are always those of the normal order.</p>}
        <p>The arrow at the start of a row <strong>inspects</strong> the class here (its numbers per strand, sequence, motifs and
        V-plot) without saving it.</p>
        <p><strong>Add to Saved</strong> keeps a class with the settings of this run{runLabel ? ` (${runLabel})` : ''}, so its numbers
        stay the same if you find classes again. Under <strong>Saved</strong> you choose whether it counts exact matches only
        or near matches too, and which strands; there you can also show only the reads that carry it, plot it, or export it.
        Saved is not the toolbar’s <strong>Save</strong>, which downloads the whole session as a file.</p>
      </HowItWorks>
    </div>
  );
}
