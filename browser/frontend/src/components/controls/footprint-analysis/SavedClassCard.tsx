import { useEffect, useRef, useState } from 'react';
import type { FootprintGroup, SavedClassInfo } from '../../../types';
import { useBrowserStore } from '../../../stores/browserStore';
import { useConsensusViewStore } from '../../../stores/consensusViewStore';
import { AnalysisButton } from '../shared';
import {
  discrepancyFlags, formatRecallerTableTsv, parseTiers, tierEdge, tierLoose, tierSpec, tierSum, TIERS, TIER_LABEL,
  type RecallerChannel, type RecallerTier,
} from '../../../utils/recallerTable';
import type { RecallerStrand } from '../../../api/consensusWorkflow';
import { nextSavedClassId, replaceSavedClass, restoreRemovedGroups, savedClassEntries, savedClassGroups, savedClassName, savedClassRow, savedDisplayName, savedRunTiers } from '../../../utils/savedClasses';
import { ClassPrevalenceChart } from '../../charts/ClassPrevalenceChart';
import { downloadTextFile, exportTimestamp } from '../../../utils/analysisExport';
import { CartEntryInspect } from './CartEntryInspect';
import { useSavedClassLinks } from './classLinks';
import { filterConsensus, getConsensusJob } from '../../../api/consensusWorkflow';
import { channelColor, PrevalenceBar } from './RecallerClassTable';
import { DisclosureChevron } from '../../ui/Disclosure';
import { Copy, Trash } from '../../ui/Icons';
import { classLabel } from '../../../utils/classIdentity';
import { useRunName } from '../../../utils/runNames';
import { copyText } from '../../../utils/clipboard';
import { ESTIMATORS, formatPct } from '../../../utils/denominators';
import { useUndoToastStore } from '../../../stores/undoToastStore';
import { tierLine, tierTitle, tiersWide, unsupportedText } from './RecallerClassTable';
import { CheckboxRow } from '../shared/CheckboxRow';

/** What the Saved card's number is, and why Co-occupancy's with/without can differ from it (M8). */
export const RUN_ESTIMATE_HELP = `${ESTIMATORS.moleculePrevalence}: the run's estimate on the picked strands: of the molecules that span the class, the share that carry it. `
  + 'Each molecule counts by how likely it is to carry the class, so uncertain ones count in part, and duplicate reads of one molecule count once. '
  + `Co-occupancy shows the ${ESTIMATORS.confidentReadFraction.toLowerCase()} instead: every read in view with a confident call of the class, over the reads scored, so its % can differ.`;

/** The tiers in words, as the class list says them (what a saved class counts: each ticked tier adds to exact). */
export const TIER_WORDS: Record<string, { label: string; help: string }> = {
  core: { label: 'exact', help: 'Exact: the molecule has this footprint, both edges fitting the class.' },
  edge: { label: '+ edge', help: '+ edge: also a wider protection that lines up with one of the class edges.' },
  loose: { label: '+ other', help: '+ other: also any other protection over the class site (up to 100 bp larger).' },
};

/** What one channel counts for a saved class: the ticked tiers where the channel supports the class, exact matches
 * only where it does not (its wider tiers are chance edge alignments). The channel rows, the card's estimate and the
 * unsupported-channel warning all use it. */
export function channelValue(r: RecallerStrand, parts: RecallerTier[]): number {
  // Unsupported: its wider tiers add nothing, and exact counts only while exact is ticked.
  return r.supported ? tierSum(r.prevalence, tierEdge(r), tierLoose(r), parts) : tierSum(r.prevalence, r.prevalence, r.prevalence, parts);
}

/** The estimate over some channels: each channel's value (channelValue), weighted by its molecules. */
export function savedEstimate(info: SavedClassInfo, keys: string[], parts: RecallerTier[]): { value: number | null; molecules: number } {
  const used = keys.map(k => info.stats[k]).filter((r): r is RecallerStrand => !!r && r.molecules > 0);
  const molecules = used.reduce((n, r) => n + r.molecules, 0);
  return { value: molecules ? used.reduce((v, r) => v + channelValue(r, parts) * r.molecules, 0) / molecules : null, molecules };
}

/** The estimate the card shows with the picked channels, and without the ones that don't support the class (N19):
 * counting an unsupported channel changes the number, so the card says so. */
export function unsupportedEffect(info: SavedClassInfo, parts: RecallerTier[]) {
  const unsupported = info.picked.filter(k => info.stats[k] && !info.stats[k].supported);
  if (!unsupported.length) return null;
  const supported = info.picked.filter(k => info.stats[k]?.supported);
  return { unsupported, with: savedEstimate(info, info.picked, parts), without: supported.length ? savedEstimate(info, supported, parts) : null };
}

/** The name a saved class shows (the same in the card, the export and the filters). */
export { savedDisplayName } from '../../../utils/savedClasses';

const pct = (v: number | null | undefined) => (v == null ? '—' : `${(100 * v).toFixed(1)}%`);
const FLAG_LABEL = { one_strand: 'one strand', strand_gap: 'CT ≠ GA', assay_gap: 'assay gap', unresolved: 'unresolved' } as const;
const short = (c: { label: string; strand: string }, all: { datasetId: string }[]) =>
  c.strand === 'CT' || c.strand === 'GA' ? (new Set(all.map(x => x.datasetId)).size > 1 ? c.label : c.strand) : c.label;

/** The run's reads draw each class as its saved definitions count it: push that to the run after a change here (the
 * Classes panel, which does the same while open, is not mounted beside Saved). */
export async function pushRunTiers(jobId: string | null | undefined) {
  if (!jobId) return;
  try {
    const job = await getConsensusJob(jobId);
    if (job.status !== 'complete' || job.cr_mode !== 'lattice_recaller') return;
    const tiers = savedRunTiers(useBrowserStore.getState().footprintGroups, jobId), current = job.filters.recaller_class_tiers ?? {};
    if (Object.keys({ ...current, ...tiers }).every(k => (current[k] ?? 'core') === (tiers[k] ?? 'core'))) return;
    await filterConsensus(jobId, { ...job.filters, recaller_class_tiers: tiers });
    useBrowserStore.getState().triggerRefresh();
  } catch { /* the run is gone (session reset): nothing is drawn for it */ }
}

/** Whether a saved class's run is still in this session (it is gone after a restart, or an import that didn't bring
 * it back). Rechecked when the shown run changes. null while unknown. */
export function useRunAvailable(jobId: string | null | undefined): boolean | null {
  const shown = useConsensusViewStore(s => `${s.jobId ?? ''}:${s.catalogRevision}`);
  const [available, setAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    if (!jobId) { setAvailable(false); return; }
    let live = true;
    getConsensusJob(jobId).then(job => { if (live) setAvailable(job.status === 'complete'); }, () => { if (live) setAvailable(false); });
    return () => { live = false; };
  }, [jobId, shown]);
  return available;
}

interface Props {
  info: SavedClassInfo;
  groups: FootprintGroup[];
  filtering: boolean;
  onFilter: (groups: FootprintGroup[]) => void;
  targetDatasetIds: string[];
  chartWidth: number;
}

/**
 * A saved lattice-recaller class: its own definition (S1, S2, ...) from one run. What it counts (strict, + edge,
 * + overlap), which channels it covers, and its numbers from that run; Filter shows the reads it counts.
 */
export function SavedClassCard({ info, groups, filtering, onFilter, targetDatasetIds, chartWidth }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const parts = parseTiers(groups[0]?.consensusTier);
  // One short run name everywhere ("Footprint run 2 · 6 Oct 14:02"); the ids in the tooltip and behind Copy ids.
  const runJob = groups[0]?.consensusJobId ?? null;
  const run = useRunName('footprint', runJob);
  const runSettings = (info.runLabel ?? '').replace(/^run \d+( · )?/, '');
  const row = savedClassRow(info);
  const channels = info.channels as RecallerChannel[];
  // The card's estimate: each picked channel as its row counts it (channelValue), pooled by molecules.
  const counted = savedEstimate(info, info.picked, parts);
  const countedValue = counted.value;
  const flags = discrepancyFlags(row, channels);
  const effect = unsupportedEffect(info, parts);
  const enabled = groups.some(g => g.enabled);
  const stale = useRunAvailable(groups[0]?.consensusJobId) === false;
  // Links plugin packs add to a saved class (classLinks.ts): what of theirs covers it (linked, not copied).
  const savedLinks = useSavedClassLinks()({ chrom: groups[0]?.referenceChrom, start: info.start, end: info.end });
  const rebuild = (next: SavedClassInfo, tier: string) => {
    const all = useBrowserStore.getState().footprintGroups;
    const current = all.filter(g => g.savedClass?.id === info.id);
    useBrowserStore.getState().setFootprintGroups(replaceSavedClass(all, info.id, savedClassGroups(next, current[0] ?? groups[0], tier, current)));
    void pushRunTiers(groups[0]?.consensusJobId);
  };
  const setTier = (next: typeof parts) => { if (next.length) rebuild(info, tierSpec(next)); };
  const togglePick = (key: string) => {
    const picked = info.picked.includes(key) ? info.picked.filter(k => k !== key) : channels.filter(c => c.key === key || info.picked.includes(c.key)).map(c => c.key);
    if (picked.length) rebuild({ ...info, picked }, tierSpec(parts));
  };
  const patchAll = (patch: Partial<FootprintGroup>) => {
    const ids = new Set(groups.map(g => g.id));
    const all = useBrowserStore.getState().footprintGroups;
    useBrowserStore.getState().setFootprintGroups(all.map(g => ids.has(g.id) ? { ...g, ...patch } : g));
  };
  const remove = () => {
    const before = useBrowserStore.getState().footprintGroups;
    const removed = before.filter(g => g.savedClass?.id === info.id);
    useBrowserStore.getState().setFootprintGroups(before.filter(g => g.savedClass?.id !== info.id));
    void pushRunTiers(groups[0]?.consensusJobId);
    useUndoToastStore.getState().show('footprints', `Removed ${info.id} · ${savedDisplayName(info)}`, () => {
      useBrowserStore.getState().setFootprintGroups(restoreRemovedGroups(removed, useBrowserStore.getState().footprintGroups));
      void pushRunTiers(groups[0]?.consensusJobId);
    });
  };
  const copy = () => {
    const all = useBrowserStore.getState().footprintGroups;
    const next = { ...info, id: nextSavedClassId(all) };
    useBrowserStore.getState().setFootprintGroups([...all, ...savedClassGroups(next, { ...groups[0], id: crypto.randomUUID() }, tierSpec(parts))]);
    void pushRunTiers(groups[0]?.consensusJobId);
  };

  return (
    <div data-testid="saved-class" data-saved-class-id={info.id}
      className={`rounded border ${filtering ? 'border-emerald-400 bg-emerald-50/50 dark:bg-emerald-900/20' : 'border-gray-200 dark:border-gray-700'}`}>
      <div className="flex items-center gap-1.5 px-2 py-1 text-[11px]">
        <input type="checkbox" checked={enabled} onChange={e => patchAll({ enabled: e.target.checked })} className="h-4 w-4 flex-shrink-0"
          aria-label={`Show and compare ${info.id}`} title="Color matching reads and include in Co-occupancy" />
        <input type="color" value={groups[0]?.color ?? '#888888'} onChange={e => patchAll({ color: e.target.value })}
          className="h-4 w-4 flex-shrink-0 cursor-pointer rounded-sm border-0 bg-transparent p-0" title="Color" />
        <button type="button" onClick={() => {
          // Opening highlights the class on the reads (while its run is the one shown).
          if (!expanded) groups.forEach((g, i) => g.consensusJobId && g.sourceDatasetId && g.consensusStateId
            && useConsensusViewStore.getState().select({ jobId: g.consensusJobId, datasetId: g.consensusDatasetId ?? g.sourceDatasetId, family: g.consensusStateId }, i > 0));
          setExpanded(v => !v);
        }} className="flex min-w-0 flex-1 items-baseline gap-1 text-left" aria-expanded={expanded} title="Details">
          <span className="inline-flex w-3 self-center text-gray-500"><DisclosureChevron open={expanded} /></span>
          <span className="flex-shrink-0 whitespace-nowrap font-medium text-gray-800 dark:text-gray-200" data-testid="saved-class-label">{info.id} · {savedDisplayName(info)}</span>
          <span className="min-w-0 truncate text-[11px] text-gray-600 dark:text-gray-300" data-testid="saved-class-run"
            title={`${run.title}${info.runLabel ? ` (${info.runLabel})` : ''}`}>
            {Math.round(info.end - info.start)} bp · {runJob ? run.name : info.runLabel || 'earlier run'}</span>
        </button>
        {savedLinks.map(link => (
          <button key={link.key} type="button" data-testid={link.testId} onClick={link.onClick}
            className={`whitespace-nowrap rounded px-1 text-[10px] ${link.className}`} title={link.title}>{link.label}</button>
        ))}
        {stale && <span data-testid="saved-class-stale" className="whitespace-nowrap rounded bg-amber-100 px-1 text-[11px] text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
          title="The run this class was saved from is not in this session (for example after a restart). Its numbers are from that run; filtering and co-occupancy need the run: reopen the session it was saved in, import the run's result, or find classes again.">run unavailable</span>}
        <AnalysisButton onClick={() => onFilter(groups)} theme="emerald" variant={filtering ? 'primary' : 'soft'} className="whitespace-nowrap"
          disabled={stale && !filtering}
          title={stale ? 'Filtering needs the run this class was saved from' : filtering ? 'Show all reads again' : 'Show only reads this class counts, on its channels'}>
          {filtering ? 'Filtering' : 'Filter reads'}
        </AnalysisButton>
        <AnalysisButton onClick={copy} variant="outline" className="inline-flex items-center" title="Copy as a new saved class (e.g. to count it differently)"
          aria-label={`Copy ${info.id}`} data-testid="saved-class-copy"><Copy size={12} aria-hidden="true" /></AnalysisButton>
        <AnalysisButton onClick={remove} variant="dangerOutline" className="inline-flex items-center" title="Remove from Saved"
          aria-label={`Remove ${info.id}`} data-testid="saved-class-remove"><Trash size={12} aria-hidden="true" /></AnalysisButton>
      </div>
      <div className="space-y-1 border-t border-gray-100 px-2 py-1 text-[11px] dark:border-gray-800">
        <div className="space-y-px" data-testid="saved-class-channels" aria-label={`Channels ${info.id} counts`} role="group">
          {channels.map(c => {
            const r = info.stats[c.key]; const on = info.picked.includes(c.key);
            const value = r ? channelValue(r, parts) : null;
            // The last counted channel stays: a saved class counts on at least one.
            const last = on && info.picked.length === 1;
            return (
              <CheckboxRow key={c.key} checked={on} onChange={() => togglePick(c.key)} disabled={last} testId="saved-class-channel"
                title={`${last ? `Counted: ${c.label} is the last counted channel` : on ? `Counted: untick to leave out ${c.label}` : `Not counted: tick to include ${c.label}`}${r ? `\n${tierTitle(c.label, r)}` : ''}`}
                label={<span className="flex min-w-0 items-center gap-1.5">
                  <span className="w-24 flex-shrink-0 truncate text-gray-700 dark:text-gray-200">{short(c, channels)}</span>
                  <span className="min-w-[3rem] flex-1"><PrevalenceBar r={r} color={channelColor(c)} title="" /></span>
                  <span className={`w-12 flex-shrink-0 text-right tabular-nums ${r?.supported ? 'text-gray-800 dark:text-gray-100' : 'italic text-ink-secondary'}`}>{pct(value)}</span>
                </span>}
                description={r ? <span className="tabular-nums" data-testid="saved-class-tiers-text">
                  {tierLine(r)} · of {r.molecules.toLocaleString()} molecules
                  {!r.supported && <span className="font-medium text-amber-800 dark:text-amber-300" data-testid="saved-class-unsupported"> · {unsupportedText(short(c, channels))}</span>}
                </span> : <span>not quantified on this channel</span>} />
            );
          })}
        </div>
        {effect && (
          <p role="status" data-testid="saved-class-unsupported-warning"
            className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
            {effect.without
              ? <>Counting {effect.unsupported.map(k => short(channels.find(c => c.key === k) ?? { label: k, strand: '' }, channels)).join(', ')}, where the class is not supported,
                  changes the estimate: {formatPct(effect.with.value, { digits: 1 })} of {effect.with.molecules.toLocaleString()} molecules
                  {' '}(without: {formatPct(effect.without.value, { digits: 1 })} of {effect.without.molecules.toLocaleString()}).</>
              : <>No counted channel supports this class: its estimate counts chance matches.</>}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="flex items-center gap-2" data-testid="saved-class-tiers"
            title="What counts as this class: exact (both edges fit), + edge (a clean core under protection with an edge lined up with the class edge), + other (a clean core under other protection). Sets what is drawn, filtered and counted in co-occupancy.">
            <span className="text-gray-600 dark:text-gray-300">Counts</span>
            {TIERS.map(t => <CheckboxRow key={t} className="inline-flex" testId={`saved-class-tier-${t}`} title={TIER_WORDS[t].help}
              checked={parts.includes(t)} disabled={parts.includes(t) && parts.length === 1}
              onChange={on => setTier(on ? [...parts, t] : parts.filter(x => x !== t))}
              label={<span aria-label={`${info.id} counts ${TIER_LABEL[t]} (${TIER_WORDS[t].label})`}>{TIER_WORDS[t].label}</span>} />)}
          </span>
          <span className="tabular-nums text-gray-600 dark:text-gray-300" data-testid="saved-class-estimate" title={RUN_ESTIMATE_HELP}>
            {ESTIMATORS.moleculePrevalence} <span className="font-medium text-gray-800 dark:text-gray-100">{formatPct(countedValue, { digits: 1 })}</span>
            {counted.molecules ? <span className="text-gray-600 dark:text-gray-300"> of {counted.molecules.toLocaleString()} molecules</span> : null}
          </span>
          {flags.map((f, i) => <span key={i} title={f.text} data-testid="saved-class-flag"
            className={`whitespace-nowrap rounded px-1 text-[11px] ${f.strong ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200' : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'}`}>{FLAG_LABEL[f.kind]}</span>)}
        </div>
      </div>
      {expanded && (
        <div className="space-y-2 border-t border-gray-200 p-2 text-[11px] dark:border-gray-700">
          <label className="flex items-center gap-1.5">
            <span className="w-12 text-gray-500">Name</span>
            <input type="text" value={info.className} onChange={e => rebuild({ ...info, className: e.target.value }, tierSpec(parts))}
              className="flex-1 rounded border border-gray-300 bg-white px-1 py-0.5 dark:border-gray-600 dark:bg-gray-800" />
          </label>
          <div className="text-[11px] text-gray-600 dark:text-gray-300" data-testid="saved-class-provenance">
            {classLabel(info.family)} of <span title={run.title}>{runJob ? run.name : 'an earlier run'}</span>{runSettings ? ` (${runSettings})` : ''}; its reads are drawn while that run is the one shown.
            {runJob && <button type="button" data-testid="saved-class-copy-run" className="ml-1 rounded px-1 text-[10px] text-gray-500 underline-offset-2 hover:underline dark:text-gray-400"
              title={`Copy the run's id (${runJob}) and the class id (${info.family})`}
              onClick={() => void copyText(`${runJob}\t${info.family}`).then(ok => setCopied(ok))}>{copied ? 'Copied ids' : 'Copy ids'}</button>}
          </div>
          {info.analysedRegion && <div data-testid="saved-class-analysed" className="text-[11px] text-gray-500 dark:text-gray-400">Analysed: <span className="tabular-nums">{info.analysedRegion}</span></div>}
          <div className="min-w-0 max-w-full">{groups.map(g => <CartEntryInspect key={g.id} group={g} targetDatasetIds={targetDatasetIds} width={chartWidth} />)}</div>
        </div>
      )}
    </div>
  );
}

/** Plot and export every saved class: its run's prevalence per channel, strict to + overlap. */
export function SavedClassesSummary({ groups }: { groups: FootprintGroup[] }) {
  const entries = savedClassEntries(groups);
  const [plot, setPlot] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(420);
  useEffect(() => {
    const el = boxRef.current; if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(e => setWidth(Math.max(260, Math.floor(e[0].contentRect.width)))); ro.observe(el); return () => ro.disconnect();
  }, [plot]);
  if (!entries.length) return null;
  const channels = [...new Map(entries.flatMap(e => e.info.channels).map(c => [c.key, c as RecallerChannel])).values()];
  const rows = entries.map(e => savedClassRow(e.info));
  const nameOf = new Map(entries.map(e => [e.info.id, `${savedClassName(e.info, e.groups[0]?.consensusTier)} (${e.info.runLabel || 'earlier run'})`]));
  // The region each saved class's run analysed, as `# analysed (S1, S2): …` lines first.
  const byRegion = new Map<string, string[]>();
  for (const e of entries) if (e.info.analysedRegion) byRegion.set(e.info.analysedRegion, [...(byRegion.get(e.info.analysedRegion) ?? []), e.info.id]);
  const notes = [...byRegion].map(([region, ids]) => `analysed (${ids.join(', ')}): ${region}`);
  const tsv = () => formatRecallerTableTsv(rows, channels, r => nameOf.get(r.family) ?? r.family, notes);
  return (
    <div className="space-y-1" data-testid="saved-classes-summary">
      <div className="flex items-center gap-1 text-[11px] text-gray-600 dark:text-gray-300">
        {/* The count is in the Saved header; this row only holds what applies to every saved class. */}
        <span className="text-ink-muted">Every saved class:</span>
        <span className="ml-auto flex gap-1">
          <AnalysisButton variant="outline" onClick={() => downloadTextFile(tsv(), `saved_footprint_classes_${exportTimestamp()}.tsv`, 'text/tab-separated-values')}
            title="Every saved class and channel: the three prevalence tiers, support, resolution and flags">Export TSV</AnalysisButton>
          <AnalysisButton variant={plot ? 'primary' : 'outline'} onClick={() => setPlot(v => !v)} data-testid="saved-classes-plot">{plot ? 'Hide plot' : 'Plot'}</AnalysisButton>
        </span>
      </div>
      {plot && <div ref={boxRef} className="w-full">
        <ClassPrevalenceChart width={width} filename="saved_class_prevalence" title="Saved class prevalence"
          channels={channels.map(c => ({ label: c.label, color: channelColor(c) }))}
          groups={entries.map(e => ({ label: e.info.id, color: e.groups[0]?.color ?? '#475569',
            bars: channels.map(c => { const r = e.info.stats[c.key]; return { channel: c.label, color: channelColor(c),
              core: r ? r.prevalence : null, edge: r?.supported ? tierEdge(r) : null, loose: r?.supported ? tierLoose(r) : null, supported: !!r?.supported }; }) }))}
          dataTsv={tsv} />
      </div>}
    </div>
  );
}
