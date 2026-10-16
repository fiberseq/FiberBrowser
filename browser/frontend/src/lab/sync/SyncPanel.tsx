import { automaticCorrespondences, includeAutomaticCorrespondences } from './automaticCorrespondence';
import { BlockList } from './BlockList';
import { selectableBlocks, defaultMembers, selectionForMembers, mergeBlockFrames, type SelectableBlock } from './blockSelection';
import { acceptBlocks } from './acceptBlocks';
import { SavedGroups } from './SavedGroups';
import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../stores/browserStore';
import { withSiteLockSuppressed } from '../../stores/siteLock';
import { clusterWindows } from '../../utils/clusterTargets';
import { getChromosomes, getGenes, getSequence } from '../../api/reference';
import { fetchJson } from '../../api/sharedFetch';
import { AnalysisPanelShell, AnalysisButton, CheckboxRow, JobStatus } from '../../components/controls/shared';
import { OpenBamHint } from '../../components/controls/shared/OpenBamHint';
import type { JobState } from '../../components/controls/shared/JobStatus';
import { HowItWorks } from '../../components/ui/HowItWorks';
import { getClusterColor } from '../../components/tracks/read-track/constants';
import { downloadTextFile } from '../../utils/analysisExport';
import { useSyncSettings, setSyncSettings, searchThresholds, SYNC_KNOBS, DEFAULT_SYNC_SETTINGS } from './settings';
import type { Gene } from '../../types';
import { useActiveFrame } from './syncState';
import { usePanelField, useSyncPanelState } from './panelState';
import { useAnchorPick, setAnchor } from './anchors';
import { SyncMap, type MapFeature } from './SyncMap';
import { ProposalList, indelText } from './ProposalList';
import { AnalysisToggleGroup } from '../../components/controls/shared';
import type { MapMode } from './SyncMap';
import { LocatePanel } from './LocatePanel';
import { WindowBadge, windowIdentity, formatNumber, formatInterval } from './presentation';
import {
  alternativesFor, comparability, explain, frameBedRows, frameWindows, otherPairProposals, refine, rotatedWindow, selectProposal, templateProposals, visibleProposals, windowKey,
  chromatinOnly,
  type ComparisonFrame, type FrameWindow, type Interval, type Locus, type Metric, type Proposal, type Selection, type Strand, type SyncResult, type SyncWindow
} from './model';
const labels: Record<Metric, string> = { sequence: 'Sequence', shape: 'Chromatin shape (local)', accessibility: 'Accessibility profile', nfr: 'NFR profile', anchor: 'Feature anchor' };
const shortMetric: Record<Metric, string> = { sequence: 'sequence', shape: 'chromatin shape', accessibility: 'accessibility', nfr: 'NFR', anchor: 'anchor' };
const metricHelp: Record<Metric, string> = {
  sequence: 'Proposes regions with shared sequence (minimap2, both strands), chained across indels.',
  shape: 'Proposes stretches whose local chromatin (accessibility, NFR and nucleosome profiles) matches, without shared sequence: hypotheses, not homology.',
  accessibility: 'Scores each proposal; proposes on its own only when one whole-window shift stands out.',
  nfr: 'Scores each proposal; proposes on its own only when one whole-window shift stands out.',
  anchor: 'Proposes the offset that aligns your chosen positions.'
};
const inputClass = 'min-w-0 max-w-full rounded-fb border border-line bg-white px-1 text-ink dark:bg-gray-900';
interface Job {
  fraction?: number;
  startedAt?: number;
  id: string;
  state: JobState;
  message: string;
  result: SyncResult | null;
}
interface ClusterCheck {
  key?: string;
  windows: { key: string; panelId: string; eligible: number; used: number; total: number; clusters: number[] }[];
  clusters: { cluster: number; reads: number; windows: number; agreement: number | null }[];
  k: number;
  separation: number;
  agreement: number | null;
  fitted: number;
  seconds: number;
}
const endpoint = '/api/lab/region-sync/jobs';
// Module-level, like the panel store: a search keeps reporting into the store across remounts.
const generation = { current: 0 };
// Window identities (W1, W2, …) in first-seen panel order, stable across remounts and template changes.
const identityIds: string[] = [];
function AnchorChoice({ window: w }: {
  window: SyncWindow;
}) {
  const anchor = useAnchorPick(s => s.anchors[w.panelId]);
  const [genes, setGenes] = useState<Gene[]>([]);
  const [error, setError] = useState('');
  const peaks = useBrowserStore(useShallow(s => s.getAllPeaks().filter(p => s.selectedPeaks.has(p.index) && (p.genome ?? null) === w.genome && (p.chrom ?? s.chrom) === w.chrom && p.start >= w.start && p.end <= w.end)));
  useEffect(() => {
    let live = true; getGenes(w.chrom, w.start, w.end, undefined, w.genome).then(r => {
      if (live)
        setGenes(r.genes);
    }).catch(() => {
      if (live)
        setError('Gene annotation unavailable; pick or type an anchor.');
    }); return () => { live = false; };
  }, [w.chrom, w.start, w.end, w.genome]);
  const choose = (position: number, strand: Strand, label: string) => setAnchor(w.panelId, { position, strand, label });
  return <div className="flex flex-wrap items-center gap-1" data-testid={`sync-anchor-${w.panelId}`}>
    <AnalysisButton
      theme="teal"
      data-testid={`sync-pick-${w.panelId}`}
      onClick={() => useAnchorPick.setState({ panelId: w.panelId })}>
      Pick in panel
    </AnalysisButton>
    <label className="flex min-w-0 flex-wrap items-center gap-1">
      Position
      <input
        className={`${inputClass} w-28`}
        data-testid={`sync-anchor-position-${w.panelId}`}
        type="number"
        min={w.start}
        max={w.end - 1}
        value={anchor?.position ?? ''}
        onChange={e => choose(Number(e.target.value), anchor?.strand ?? '+', 'Manual position')} />
    </label>
    <select
      aria-label="Choose a gene TSS or selected peak"
      className={`${inputClass} w-44`}
      data-testid={`sync-anchor-feature-${w.panelId}`}
      value=""
      onChange={e => {
        const [kind, index] = e.target.value.split(':');
        const i = Number(index);
        if (kind === 'gene') {
          const g = genes[i];
          choose(g.strand === '-' ? g.end - 1 : g.start, g.strand === '-' ? '-' : '+', `${g.name ?? g.id} TSS`);
        }
        if (kind === 'peak') {
          const p = peaks[i];
          choose(Math.floor((p.start + p.end) / 2), '+', `Peak ${p.index}`);
        }
      }}>
      <option value="">Gene TSS / selected peak</option>
      {genes.map((g, i) => { const at = g.strand === '-' ? g.end - 1 : g.start; return at >= w.start && at < w.end ? <option key={g.id} value={`gene:${i}`}>{g.name ?? g.id} TSS ({g.strand})</option> : null; })}
      {peaks.map((p, i) => <option key={p.index} value={`peak:${i}`}>Peak {p.index}</option>)}
    </select>
    {anchor && <span>{anchor.label} · {anchor.strand}</span>}
    {error && <span className="text-ink-muted">{error}</span>}
  </div>;
}
/** Plan, inspect and accept a matched group (block maps across indels and copies) without changing downstream analyses. */
export function SyncPanel({ isFullView }: {
  isFullView?: boolean;
}) {
  const { panels, datasets, chrom, start, end, frames } = useBrowserStore(useShallow(s => ({ panels: s.panels, datasets: s.datasets, chrom: s.chrom, start: s.start, end: s.end, frames: s.comparisonFrames ?? [] })));
  const candidates = panels.filter(p => p.contentType === 'dataset' && p.datasetId && !p.collapsed);
  const [checked, setChecked] = usePanelField<Record<string, boolean>>('checked', {});
  const [template, setTemplate] = usePanelField('template', '');
  const [metrics, setMetrics] = usePanelField<Record<Metric, boolean>>('metrics', { sequence: true, shape: true, accessibility: true, nfr: true, anchor: false });
  const [sequenceAvailable, setSequenceAvailable] = useState<Record<string, boolean>>({});
  const settings = useSyncSettings();
  const [chromInfo, setChromInfo] = useState<Record<string, { size: number; circular: boolean }>>({});
  const [origins, setOrigins] = useState<Record<string, string>>({});
  const [minimumReads, setMinimumReads] = usePanelField('minimumReads', 20);
  const [cover, setCover] = usePanelField('cover', 80);
  const [job, setJob] = usePanelField<Job | null>('job', null);
  const [result, setResult] = usePanelField<SyncResult | null>('result', null);
  const [memberState, setMemberState] = usePanelField<{ result: SyncResult; keys: string[] } | null>('memberState', null);
  const [mergeBlocks, setMergeBlocks] = usePanelField('mergeBlocks', false);
  const [selection, setSelection] = usePanelField<Selection | null>('selection', null);
  const [focusedId, setFocusedId] = usePanelField<string | null>('focusedId', null);
  const [copies, setCopies] = usePanelField<Record<string, string[]>>('copies', {});
  const [showAll, setShowAll] = usePanelField('showAll', false);
  const [showOthers, setShowOthers] = usePanelField('showOthers', true);
  const [features, setFeatures] = usePanelField<Record<string, MapFeature[]>>('features', {});
  const [flips, setFlips] = usePanelField<Record<string, boolean>>('flips', {});
  const [notice, setNotice] = usePanelField('notice', '');
  const [name, setName] = usePanelField('name', '');
  const [editingId, setEditingId] = usePanelField<string | null>('editingId', null);
  const [clusterK, setClusterK] = usePanelField('clusterK', 3);
  const [setupOpen, setSetupOpen] = usePanelField('setupOpen', false);
  const [mapMode, setMapMode] = usePanelField<MapMode>('mapMode', 'all');
  const [checklistOpen, setChecklistOpen] = usePanelField('checklistOpen', false);
  // A selection made from a multi-way block keeps to that block's proposals.
  const [blockOnly, setBlockOnly] = usePanelField<string[] | null>('blockOnly', null);
  const [clusterCheck, setClusterCheck] = usePanelField<ClusterCheck | null>('clusterCheck', null);
  const [clusterState, setClusterState] = usePanelField<{ busy: boolean; error: string; key?: string }>('clusterState', { busy: false, error: '' });
  const epoch = useAnchorPick(s => s.epoch);
  const active = useActiveFrame();
  const anchors = useAnchorPick(s => s.anchors);
  const windows: SyncWindow[] = candidates.map(p => ({
    panelId: p.id, datasetId: p.datasetId!, genome: p.genome ?? null,
    ...(p.viewportOverride ?? { chrom, start, end }), label: p.title ?? datasets.find(d => d.id === p.datasetId)?.label ?? p.datasetId!, anchor: anchors[p.id]
  }));
  windows.forEach(w => { if (!identityIds.includes(w.panelId)) identityIds.push(w.panelId); });
  const identities = Object.fromEntries(identityIds.map((id, i) => [id, windowIdentity(i)]));
  const chosen = windows.filter(w => checked[w.panelId] ?? !!(candidates.find(p => p.id === w.panelId)?.viewportOverride || w.genome));
  const ordered = [...chosen].sort((a, b) => a.panelId === template ? -1 : b.panelId === template ? 1 : 0);
  const signature = JSON.stringify(windows.map(w => [w.panelId, w.genome, w.chrom, w.start, w.end]));
  useEffect(() => {
    let live = true; Promise.all(windows.map(async (w) => {
      try {
        const r = await getSequence(w.chrom, w.start, Math.min(w.end, w.start + 1), w.genome);
        return [w.panelId, !!r.sequence] as const;
      }
      catch {
        return [w.panelId, false] as const;
      }
    })).then(pairs => {
      if (live)
        setSequenceAvailable(Object.fromEntries(pairs));
    });
    // Contig lengths and topology: any circular window can be rotated.
    Promise.all(windows.map(async w => {
      try {
        const { chroms } = await getChromosomes(w.genome);
        const c = chroms.find(c => c.name === w.chrom);
        return [w.panelId, { size: c?.size ?? 0, circular: !!c?.circular }] as const;
      }
      catch {
        return [w.panelId, { size: 0, circular: false }] as const;
      }
    })).then(pairs => { if (live) setChromInfo(Object.fromEntries(pairs)); });
    return () => { live = false; };
  }, [signature]);
  useEffect(() => () => { useAnchorPick.setState({ panelId: null }); }, []);
  useEffect(() => {
    if (!job?.id || !['queued', 'running'].includes(job.state))
      return;
    const token = generation.current;
    let live = true;
    const timer = setTimeout(() => {
      fetchJson<Job>(`${endpoint}/${job.id}`).then(next => {
        // Only the live poll of the current job may move it on, and never backwards.
        const current = useSyncPanelState.getState().job as Job | null;
        if (!live || token !== generation.current || current?.id !== next.id || !['queued', 'running'].includes(current.state))
          return; setJob(next); if (next.state === 'complete' && next.result) {
            setResult(includeAutomaticCorrespondences(useBrowserStore.getState(), next.result));
            setSelection(null);
            setFocusedId(null);
            setCopies({});
            setFlips({});
            setEditingId(null);
            setClusterCheck(null);
            setName(`Group ${(useBrowserStore.getState().comparisonFrames?.length ?? 0) + 1}`);
          }
      }).catch(e => {
        if (live && token === generation.current)
          setJob({ ...job, state: 'error', message: String(e) });
      });
    }, 500);
    return () => { live = false; clearTimeout(timer); };
  }, [job]);
  // Annotation ticks on the map bars make shared parts (e.g. vector elements) recognisable.
  const resultSignature = result ? JSON.stringify(result.windows.map(w => [w.panelId, w.genome, w.chrom, w.start, w.end])) : '';
  useEffect(() => {
    if (!result)
      return;
    let live = true;
    Promise.all(result.windows.map(async w => {
      try {
        const r = await getGenes(w.chrom, w.start, w.end, undefined, w.genome);
        // One tick per feature: genes with several transcripts repeat the same interval.
        const seen = new Set<string>();
        return [w.panelId, r.genes.map(g => ({ name: g.name ?? g.id, start: g.start, end: g.end })).filter(f => {
          const key = `${f.name}:${f.start}:${f.end}`;
          return !seen.has(key) && !!seen.add(key);
        })] as const;
      }
      catch {
        return [w.panelId, []] as const;
      }
    })).then(pairs => { if (live) setFeatures(Object.fromEntries(pairs)); });
    return () => { live = false; };
  }, [resultSignature]);
  // A session import (epoch) clears the search; a remount (full view, dock) keeps it.
  useEffect(() => {
    const seen = useSyncPanelState.getState().epoch;
    if (seen === epoch)
      return;
    if (seen !== undefined) {
      generation.current++;
      useSyncPanelState.setState({ job: null, result: null, selection: null, focusedId: null, editingId: null, checked: {}, notice: '', clusterCheck: null, clusterState: { busy: false, error: '' }, copies: {}, flips: {} });
    }
    useSyncPanelState.setState({ epoch });
  }, [epoch]);
  const locateBusy = useSyncPanelState(s => Object.keys((s.locating as Record<string, boolean> | undefined) ?? {}).length > 0);
  const busy = job?.state === 'queued' || job?.state === 'running' || locateBusy;
  const stale = !!result && result.windows.some(w => !windows.some(v => v.panelId === w.panelId && v.genome === w.genome && v.chrom === w.chrom && v.start === w.start && v.end === w.end));
  const selected: FrameWindow[] = result && selection ? frameWindows(result, selection, flips).map(w => flips[windowKey(w)]
    ? { ...w, provenance: { ...w.provenance, flags: [...w.provenance.flags, 'manual-strand'], metric: `${w.provenance.metric} + manual strand` } } : w) : [];
  const frameLength = selection ? selection.end - selection.start : 0;
  const checks = result ? comparability(selected, result, frameLength, minimumReads, cover / 100) : null;
  const windowLabel = (w: { panelId: string; copy?: string }) => `${identities[w.panelId]?.label ?? '?'}${w.copy ?? ''}`;
  // What a clustering check was run on; a result for anything else is not shown.
  const clusterKey = JSON.stringify([epoch, job?.id, selected.map(w => [windowKey(w), w.datasetId, w.genome, w.chrom, w.strand, w.blocks, w.readStrand, w.readIds?.length]), cover, clusterK]);
  useEffect(() => { useSyncPanelState.setState({ clusterFor: clusterKey }); }, [clusterKey]);
  const shownCluster = clusterCheck?.key === clusterKey ? clusterCheck : null;
  const clusterBusy = clusterState.busy && clusterState.key === clusterKey;
  const canAccept = selected.length >= 2 && checks?.equal && checks.reads && checks.strands && checks.inside && !stale && !busy;
  const keep = [...(selection?.matches.map(p => p.id) ?? []), ...(focusedId ? [focusedId] : [])];
  const allTemplate = result ? templateProposals(result) : [];
  const allOthers = result ? otherPairProposals(result) : [];
  const shownTemplate = visibleProposals(allTemplate, showAll ? null : settings.perPair, keep);
  const shownOthers = visibleProposals(allOthers.filter(p => showOthers || p.panelId === p.partnerId), showAll ? null : settings.perPair, keep);
  const listed = [...shownTemplate, ...shownOthers];
  const hidden = allTemplate.length + allOthers.filter(p => showOthers || p.panelId === p.partnerId).length - listed.length;
  const focused = result?.proposals.find(p => p.id === focusedId) ?? null;
  async function widen(ids: string[]) {
    const session = useAnchorPick.getState().epoch;
    try {
      const changes = await Promise.all(windows.filter(w => ids.includes(w.panelId)).map(async w => {
        const { chroms } = await getChromosomes(w.genome);
        const size = chroms.find(c => c.name === w.chrom)?.size;
        if (!size) throw new Error(`Cannot find the length of ${w.chrom}; refresh its reference first.`);
        const span = Math.min(15000, size);
        const start = Math.min(size - span, Math.max(0, Math.round((w.start + w.end - span) / 2)));
        return { ...w, start, end: start + span };
      }));
      if (session !== useAnchorPick.getState().epoch) return;
      const state = useBrowserStore.getState();
      state.setNavigationMode('perPanel');
      withSiteLockSuppressed(() => changes.forEach(w => state.navigatePanel(w.panelId, w.chrom, w.start, w.end)));
      setNotice(`Re-centred in Per panel mode, bounded by each chromosome: ${changes.map(w => `${identities[w.panelId].label}: ${formatNumber(w.end - w.start)} bp`).join('; ')}.`);
    } catch (error) { setNotice(String(error)); }
  }
  async function run(known = false) {
    generation.current++;
    const token = generation.current;
    setNotice('');
    setResult(null);
    setSelection(null);
    setFocusedId(null);
    setEditingId(null);
    setCopies({});
    setClusterCheck(null);
    const s = useBrowserStore.getState();
    const captured = ordered.map(w => { const scope = clusterWindows({ ...s, panels: s.panels.filter(p => p.id === w.panelId), selectedDatasets: new Set() }, [w.datasetId])[0]; return { ...w, readIds: scope?.read_ids, readStrand: scope?.strand }; });
    setJob({ id: '', state: 'running', message: known ? 'Checking reads in the known correspondence' : 'Starting search', result: null });
    setSetupOpen(false);
    try {
      const next = await fetchJson<Job>(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ windows: captured,
        metrics: known ? ['sequence'] : (Object.keys(metrics) as Metric[]).filter(m => metrics[m] && (m !== 'sequence' || captured.every(w => sequenceAvailable[w.panelId]))),
        coverageOnly: known, ...searchThresholds(settings) }) });
      if (token === generation.current)
        setJob(next);
    }
    catch (e) {
      if (token === generation.current)
        setJob({ id: '', state: 'error', message: String(e), result: null });
    }
  }
  function focus(p: Proposal, chosenCopies = copies) {
    if (!result)
      return;
    if (p.panelId === p.partnerId) { chosenCopies = {}; setCopies({}); }
    setFocusedId(p.id);
    setClusterCheck(null);
    if (p.partnerId !== p.panelId && p.partnerId !== result.windows[0].panelId) {
      const block = blocks.find(b => b.proposalIds.includes(p.id));
      if (block) {
        const keys = block.choices.map(c => c.key);
        setMemberKeys([...new Set([...memberKeys, ...keys])]);
        const next = selectionForMembers(result, block, keys);
        setSelection(next.selection ?? null); setNotice(next.error ?? '');
      }
      return;
    }
    // Windows without this stretch are left out of the frame (said so) rather than shrinking the rest.
    setBlockOnly(null);
    const next = selectProposal(result, p, chosenCopies) ?? selectProposal(result, p, chosenCopies, true);
    setSelection(next);
    setFlips({});
    setNotice(next ? '' : 'No common stretch for this proposal and the chosen copies. Untick a copy or choose another proposal.');
  }
  function chooseBlock(block: SelectableBlock) {
    if (!result) return;
    const next = selectionForMembers(result, block, memberKeys);
    setNotice(next.error ?? '');
    setSelection(next.selection ?? null);
    setFocusedId(next.selection?.matches[0]?.id ?? null);
    setBlockOnly(block.proposalIds);
    setFlips({}); setClusterCheck(null);
  }
  function acceptSelected() {
    if (!result) return;
    try {
      const frames: ComparisonFrame[] = selectedBlocks.map((block, i) => {
        const { selection, error } = selectionForMembers(result, block, memberKeys);
        if (!selection) throw new Error(error);
        return { id: crypto.randomUUID(), name: `${name.trim() || 'Group'}${selectedBlocks.length > 1 ? ` · ${i + 1}` : ''}`,
          version: 1, status: 'accepted', templatePanelId: selection.templateId!, length: selection.end - selection.start,
          alignedOn: result.metrics, windows: frameWindows(result, selection).map(w => ({ ...w, tag: windowLabel(w) })) };
      });
      acceptBlocks(mergeBlocks ? [mergeBlockFrames(frames)] : frames);
      setNotice(`Saved ${mergeBlocks ? 1 : frames.length} matched group${!mergeBlocks && frames.length > 1 ? 's' : ''}. Their regions are on the peak row. Undo restores the previous groups.`);
      setMemberState({ result, keys: [] });
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  }
  /** Use these copies of one window together (one frame window each). */
  function chooseCopies(panelId: string, ids: string[]) {
    if (!result || !selection || !ids.length)
      return;
    const next = { ...copies, [panelId]: ids };
    // The proposal the selection started from must stay one of its window's copies.
    const initiating = selection.matches[0].panelId === panelId && !ids.includes(selection.matches[0].id)
      ? result.proposals.find(p => p.id === ids[0])! : selection.matches[0];
    setCopies(next);
    setFocusedId(initiating.id);
    // A partial selection (windows left out) stays partial; a block's selection keeps to the block.
    const chosen = blockOnly ? selectProposal(result, initiating, next, true, blockOnly) : selectProposal(result, initiating, next) ?? selectProposal(result, initiating, next, true);
    setSelection(chosen);
    setClusterCheck(null);
    setNotice(chosen ? '' : 'These copies share no common stretch with the other windows. Untick one.');
  }
  /** Show a circular window as one turn starting at `start` (a logical window across its origin). */
  function rotateTo(w: SyncWindow, start: number, size: number) {
    const width = Math.min(size, w.end - w.start);
    start = ((Math.round(start) % size) + size) % size;
    const s = useBrowserStore.getState();
    s.setNavigationMode('perPanel');
    withSiteLockSuppressed(() => s.navigatePanel(w.panelId, w.chrom, start, start + width));
    setNotice(`Rotated ${identities[w.panelId].label} to ${formatNumber(start)}–${formatNumber(start + width)}${start + width > size ? `, across its origin (positions past ${formatNumber(size)} continue from 0)` : ''}. Find again to score it.`);
  }
  function rotate(p: Proposal, side: 'template' | 'window') {
    const id = side === 'template' ? p.partnerId : p.panelId;
    const w = result?.windows.find(v => v.panelId === id);
    const size = result?.circular?.[id];
    if (!w || !size)
      return;
    rotateTo(w, rotatedWindow(w, (side === 'template' ? p.template : p.window) as Interval, size).start, size);
  }
  async function checkClusters() {
    const key = clusterKey;
    setClusterState({ busy: true, error: '', key });
    setClusterCheck(null);
    try {
      const out = await fetchJson<ClusterCheck>('/api/lab/region-sync/cluster', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ length: frameLength, k: clusterK, minCover: cover / 100, windows: selected.map(w => ({ key: windowKey(w), panelId: w.panelId, datasetId: w.datasetId, genome: w.genome, chrom: w.chrom, start: w.start, end: w.end, strand: w.strand, blocks: w.blocks, readIds: w.readIds, readStrand: w.readStrand })) })
      });
      // Only the latest check reports, and only for the selection, coverage, k and session it ran on.
      if ((useSyncPanelState.getState().clusterState as { key?: string } | undefined)?.key !== key)
        return;
      setClusterState({ busy: false, error: '', key });
      if (useSyncPanelState.getState().clusterFor === key)
        setClusterCheck({ ...out, key });
    } catch (e) {
      if ((useSyncPanelState.getState().clusterState as { key?: string } | undefined)?.key === key)
        setClusterState({ busy: false, error: String(e instanceof Error ? e.message : e), key });
    }
  }
  function showFrame(frame = active) {
    if (!frame)
      return;
    const s = useBrowserStore.getState();
    const missing = frame.windows.filter(w => !s.panels.some(p => p.id === w.panelId && p.datasetId === w.datasetId && (p.genome ?? null) === w.genome));
    if (missing.length) {
      setNotice('Some group panels or references are missing. Reopen them before showing this group.');
      return;
    }
    s.setNavigationMode('perPanel');
    // A panel with several copies shows all of them.
    const extents = new Map<string, FrameWindow>();
    for (const w of frame.windows) {
      const e = extents.get(w.panelId);
      extents.set(w.panelId, e ? { ...e, start: Math.min(e.start, w.start), end: Math.max(e.end, w.end) } : w);
    }
    withSiteLockSuppressed(() => [...extents.values()].forEach(w => s.navigatePanel(w.panelId, w.chrom, w.start, w.end)));
    setNotice(`Shown in ${extents.size} panels. ${frame.windows.some(w => w.strand === '-') ? 'Reversed windows retain their native display direction; reversal is recorded in the group.' : ''}`);
  }
  /** Move the template window to 15 kb around a located match (Per panel), then search again. */
  async function moveTemplate(locus: Locus) {
    const w = result?.windows[0];
    const session = useAnchorPick.getState().epoch;
    // Only for the panel and reference the search ran on.
    // Every searched window still at its locus on its reference (the store now, not this render).
    const unchanged = () => {
      if (!result || session !== useAnchorPick.getState().epoch)
        return false;
      const st = useBrowserStore.getState();
      return result.windows.every(v => st.panels.some(p => {
        const at = p.viewportOverride ?? { chrom: st.chrom, start: st.start, end: st.end };
        return p.id === v.panelId && (p.genome ?? null) === v.genome && at.chrom === v.chrom && at.start === v.start && at.end === v.end;
      }));
    };
    if (!w || stale || !unchanged())
      return setNotice('The panels changed since this search. Find again before moving.');
    try {
      const { chroms } = await getChromosomes(w.genome);
      if (!unchanged())
        return setNotice('The panels changed since this search. Find again before moving.');
      const size = chroms.find(c => c.name === locus.chrom)?.size ?? locus.end;
      const span = Math.min(15000, size);
      const start = Math.min(size - span, Math.max(0, Math.round((locus.start + locus.end - span) / 2)));
      const s = useBrowserStore.getState();
      s.setNavigationMode('perPanel');
      withSiteLockSuppressed(() => s.navigatePanel(w.panelId, locus.chrom, start, start + span));
      setNotice(`Moved ${identities[w.panelId].label} to ${locus.chrom}:${formatNumber(start)}–${formatNumber(start + span)}. Find comparable regions again.`);
    } catch (error) { setNotice(String(error)); }
  }
  function exportFrame() {
    if (!active)
      return;
    downloadTextFile(frameBedRows(active, windowLabel).join('\n') + '\n', `${active.name.replace(/[^A-Za-z0-9_.-]+/g, '_') || 'comparison_frame'}.bed`, 'text/plain');
  }
  const crossing = allTemplate.filter(p => p.flags?.includes('crosses-origin'));
  // Linked panels on one reference search for copies within their shared view.
  const locusGroups = new Map<string, SyncWindow[]>();
  for (const w of chosen) {
    const key = JSON.stringify([w.genome, w.chrom, w.start, w.end]);
    locusGroups.set(key, [...(locusGroups.get(key) ?? []), w]);
  }
  const sameLocus = [...locusGroups.values()].filter(g => g.length > 1);
  const listLabels = (ws: SyncWindow[]) => { const l = ws.map(w => identities[w.panelId].label); return l.length > 1 ? `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}` : l[0]; };
  const usedMetrics = (Object.keys(metrics) as Metric[]).filter(m => metrics[m]);
  const blocks = result ? selectableBlocks(result) : [];
  const memberKeys = result && memberState?.result === result ? memberState.keys : defaultMembers(blocks);
  const setMemberKeys = (keys: string[]) => { if (result) setMemberState({ result, keys }); };
  const selectedBlocks = blocks.filter(b => b.choices.filter(c => memberKeys.includes(c.key)).length >= 2);
  const batchError = result ? selectedBlocks.map(b => selectionForMembers(result, b, memberKeys).error).find(Boolean) : null;
  const chromatinCount = allTemplate.filter(chromatinOnly).length;
  const issues = checks ? [!checks.equal, !checks.reads, !checks.strands, !checks.inside].filter(Boolean).length : 0;
  const circularAligned = result?.metrics.some(m => m === 'shape' || m === 'accessibility' || m === 'nfr');
  const runningJob = job && (job.state === 'running' || job.state === 'queued' || job.state === 'error' || job.state === 'cancelled');
  const knob = ([key, label, min, max, step, help]: typeof SYNC_KNOBS[number]) => <div key={key} className="flex min-w-0 flex-wrap items-center gap-2" title={help}>
    {max === 1 && step === 1
      ? <CheckboxRow className="min-w-0 flex-1" testId={`sync-knob-${key}`} checked={settings[key] === 1} onChange={v => setSyncSettings({ [key]: v ? 1 : 0 })} label={label} description={<span id={`sync-knob-help-${key}`} className="sr-only">{help}</span>} />
      : <label className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-2">
        <span>{label}</span>
        <input data-testid={`sync-knob-${key}`} aria-describedby={`sync-knob-help-${key}`} className={`${inputClass} w-20 tabular-nums`} type="number" min={min} max={max} step={step} value={settings[key]}
          onChange={e => { const v = Number(e.target.value); if (e.target.value !== '' && Number.isFinite(v)) setSyncSettings({ [key]: v }); }} />
      </label>}
    <button type="button" data-testid={`sync-knob-reset-${key}`} aria-label={`Reset ${label} to ${DEFAULT_SYNC_SETTINGS[key]}`}
      disabled={settings[key] === DEFAULT_SYNC_SETTINGS[key]} onClick={() => setSyncSettings({ [key]: DEFAULT_SYNC_SETTINGS[key] })}
      className="text-[11px] text-teal-700 hover:underline disabled:text-ink-muted disabled:no-underline dark:text-teal-300">Reset</button>
    {!(max === 1 && step === 1) && <span id={`sync-knob-help-${key}`} className="sr-only">{help}</span>}
  </div>;
  const setup = <>
    <section data-testid="sync-windows" className="space-y-1">
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <strong>1 · Windows</strong>
        <div className="flex flex-wrap items-center gap-1">
          <label className="flex min-w-0 items-center gap-1">
            Template
            <select data-testid="sync-template" className={`${inputClass} max-w-[12rem]`} disabled={busy} value={ordered[0]?.panelId ?? ''} onChange={e => setTemplate(e.target.value)}>
              {chosen.map(w => <option key={w.panelId} value={w.panelId}>{identities[w.panelId].label} · {w.label}</option>)}
            </select>
          </label>
          <AnalysisButton data-testid="sync-widen-all" disabled={busy} title="Widen every window to 15 kb around its centre (Per panel), bounded by its chromosome." onClick={() => widen(windows.map(w => w.panelId))}>All to 15 kb</AnalysisButton>
        </div>
      </div>
      {windows.map(w => <div key={w.panelId} className="min-w-0">
        <div className="flex min-w-0 items-start gap-1">
          <CheckboxRow className="min-w-0 flex-1" testId={`sync-window-${w.panelId}`} checked={chosen.some(v => v.panelId === w.panelId)} disabled={busy}
            title="Coordinates are zero-based, end-exclusive." onChange={v => setChecked({ ...checked, [w.panelId]: v })}
            label={<><WindowBadge identity={identities[w.panelId]} /> · {w.label}</>}
            description={`${formatInterval(w)} · ${formatNumber(w.end - w.start)} bp · ${w.genome ? w.genome.replace(/^fasta:/, '') : 'main reference'}${chromInfo[w.panelId]?.circular ? ' · circular' : ''}${sequenceAvailable[w.panelId] === false ? ' · no sequence' : ''}`} />
          <AnalysisButton className="mt-0.5 shrink-0" data-testid={`sync-widen-${w.panelId}`} disabled={busy} title="Widen to 15 kb around its centre" onClick={() => widen([w.panelId])}>15 kb</AnalysisButton>
        </div>
        {chromInfo[w.panelId]?.circular && <div className="ml-7 flex flex-wrap items-center gap-1 text-ink-secondary">
          <label className="flex items-center gap-1" title="Circular contig: show one turn starting here; positions past its end continue from 0.">
            Origin at
            <input data-testid={`sync-origin-${w.panelId}`} className={`${inputClass} w-20`} type="number" min={0} max={chromInfo[w.panelId].size - 1}
              value={origins[w.panelId] ?? String(w.start)} onChange={e => setOrigins({ ...origins, [w.panelId]: e.target.value })} />
          </label>
          <AnalysisButton data-testid={`sync-rotate-${w.panelId}`} disabled={busy} onClick={() => rotateTo(w, Number(origins[w.panelId] ?? w.start), chromInfo[w.panelId].size)}>Rotate</AnalysisButton>
        </div>}
        {metrics.anchor && <div className="ml-7"><AnchorChoice window={w} /></div>}
      </div>)}
      {chosen.length < 1 && <p className="text-ink-secondary">Tick at least one panel.</p>}
      {automaticCorrespondences(useBrowserStore.getState(), chosen).length > 0 && <AnalysisButton data-testid="sync-use-correspondence" disabled={busy} onClick={() => void run(true)}>Use known correspondence</AnalysisButton>}
      {sameLocus.length > 0 && <p data-testid="sync-same-locus" className="text-amber-700 dark:text-amber-300">
        {sameLocus.map(listLabels).join('; ')}: same sequence in both windows — use the shared positions as a correspondence.
      </p>}
    </section>
    <section data-testid="sync-metrics" className="space-y-1">
      <strong>2 · Metrics</strong>
      <div className="flex flex-wrap gap-x-3">
        {(Object.keys(labels) as Metric[]).map(m => <CheckboxRow key={m} testId={`sync-metric-${m}`} label={labels[m]} title={metricHelp[m]}
          description={<span className="sr-only">{metricHelp[m]}</span>}
          checked={metrics[m] && (m !== 'sequence' || (chosen.length > 0 && chosen.every(w => sequenceAvailable[w.panelId])))}
          disabled={busy || (m === 'sequence' && (!chosen.length || !chosen.every(w => sequenceAvailable[w.panelId])))}
          onChange={v => setMetrics({ ...metrics, [m]: v })} />)}
      </div>
      {metrics.sequence && chosen.some(w => sequenceAvailable[w.panelId] === false) && <p data-testid="sync-no-sequence" className="text-amber-700 dark:text-amber-300">
        Sequence is off: {chosen.filter(w => sequenceAvailable[w.panelId] === false).map(w => identities[w.panelId].label).join(', ')} {chosen.filter(w => sequenceAvailable[w.panelId] === false).length === 1 ? 'has' : 'have'} no reference sequence. Load a FASTA for {chosen.filter(w => sequenceAvailable[w.panelId] === false).length === 1 ? 'its' : 'their'} reference to use it.
      </p>}
    </section>
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <AnalysisButton theme="teal" variant="primary" data-testid="sync-find"
        disabled={busy || chosen.length < 1 || !Object.entries(metrics).some(([m, v]) => v && (m !== 'sequence' || chosen.every(w => sequenceAvailable[w.panelId]))) || (metrics.anchor && chosen.some(w => !w.anchor))}
        onClick={() => void run()}>
        {chosen.length === 1 ? 'Find repeats in this window' : 'Find comparable regions'}
      </AnalysisButton>
      <details data-testid="sync-advanced" className="min-w-0">
        <summary data-testid="sync-advanced-toggle" className="cursor-pointer text-ink-secondary">Advanced</summary>
        <div className="mt-1 grid gap-1 rounded-fb border border-line p-2">
          {SYNC_KNOBS.map(knob)}
          <button type="button" data-testid="sync-knob-defaults" className="justify-self-start text-[11px] text-teal-700 hover:underline dark:text-teal-300" onClick={() => setSyncSettings(DEFAULT_SYNC_SETTINGS)}>All defaults</button>
          <p className="text-[11px] text-ink-muted">Saved for you in this browser; used by the next search. Coming later as metrics: motifs, frozen footprint classes, SV anchors.</p>
        </div>
      </details>
    </div>
  </>;
  return <AnalysisPanelShell
    tabs={[]}
    activeTab="plan"
    onTabChange={() => { }}
    theme="teal"
    layout="standard"
    bodyMode="none"
    isFullView={isFullView}
    bodyClassName="min-w-0 break-words">
    <div data-testid="sync-header" className="space-y-1">
      {!result && <p className="text-ink-secondary">Find repeats within one window or comparable subregions across panels, then keep them as a matched group.</p>}
      {!!frames.length && <div className="flex flex-wrap items-center gap-1">
        <span data-testid="sync-active-frame" title={active?.alignedOn.some(m => m === 'shape' || m === 'accessibility' || m === 'nfr') ? 'Aligned partly on chromatin: comparisons of accessibility or NFRs in this frame agree partly by construction.' : undefined}
          className="inline-block rounded-fb bg-teal-50 px-2 text-teal-800 dark:bg-teal-950 dark:text-teal-200">
          {active ? `${active.name} · v${active.version} · ${active.windows.length} windows · ${formatNumber(active.length)} bp` : 'No active matched group'}
        </span>
        <select data-testid="sync-frame-select" aria-label="Active matched group" className={inputClass} value={active?.id ?? ''} onChange={e => useBrowserStore.getState().activateComparisonFrame(e.target.value || null)}>
          <option value="">No active group</option>
          {frames.filter(f => f.status === 'accepted').map(f => <option key={f.id} value={f.id}>{f.name} · v{f.version}</option>)}
        </select>
        <AnalysisButton data-testid="sync-show-panels" disabled={!active} onClick={() => showFrame()}>Show in panels</AnalysisButton>
        <AnalysisButton data-testid="sync-export-bed" disabled={!active} title="One BED6 row per block (a window across a circular origin is two rows), with frame coordinates in extra columns." onClick={exportFrame}>Export BED</AnalysisButton>
      </div>}
    </div>
    <SavedGroups showFrame={showFrame} />
    {!candidates.length ? <OpenBamHint testId="sync-open-bam" /> : <>
      {result && !setupOpen && !busy
        ? <button type="button" data-testid="sync-setup-summary" onClick={() => setSetupOpen(true)} title="Edit the windows, metrics and settings"
          className="flex w-full min-w-0 items-center justify-between gap-2 rounded-fb border border-line px-2 py-1 text-left hover:bg-gray-50 dark:hover:bg-white/5">
          <span className="min-w-0 truncate">{result.windows.length} window{result.windows.length === 1 ? '' : 's'} · template <WindowBadge identity={identities[result.windows[0].panelId]} /> · {result.metrics.map(m => shortMetric[m]).join(', ')}</span>
          <span className="shrink-0 text-teal-700 dark:text-teal-300">Edit</span>
        </button>
        : setup}
      {runningJob && <JobStatus testId="sync-job" title="Find comparable regions" state={job!.state} message={job!.message} runKey={job!.id} progress={{ fraction: job!.fraction }} startedAt={job!.startedAt}
        onCancel={job!.id && (job!.state === 'running' || job!.state === 'queued') ? () => { void fetchJson<Job>(`${endpoint}/${job!.id}`, { method: 'DELETE' }).then(setJob).catch(e => setNotice(String(e))); } : undefined} />}
      {notice && <p role="status" data-testid="sync-notice">{notice}</p>}
      {result && <>
        <section data-testid="sync-results" className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
            <strong data-testid="sync-job">3 · Matches <span className="font-normal text-ink-secondary">· {formatNumber(allTemplate.length)} {result.windows.length === 1 ? 'repeat matches' : 'with the template'}{chromatinCount ? ` (${chromatinCount} chromatin only)` : ''}{result.timings?.total != null ? ` · ${result.timings.total.toFixed(1)} s` : ''}</span></strong>
            <div className="flex flex-wrap items-center gap-2">
              {result.windows.length >= 3 && <AnalysisToggleGroup theme="teal" value={mapMode} onChange={v => v && setMapMode(v as MapMode)}
                options={[{ value: 'lanes', label: 'Each vs template' }, { value: 'all', label: 'All windows' }]} />}
              <CheckboxRow testId="sync-show-all" checked={showAll} onChange={setShowAll} label={`All (${formatNumber(allTemplate.length + allOthers.length)})`} title="Show every proposal, not only the best per pair" />
              {allOthers.length > 0 && mapMode === 'lanes' && <CheckboxRow testId="sync-show-others" checked={showOthers} onChange={setShowOthers} label="Other pairs" title="Pairs between non-template windows" />}
            </div>
          </div>
          <div className="space-y-1" data-testid="sync-results-notes">
            {!allTemplate.length && <p data-testid="sync-nothing" className="font-medium text-amber-700 dark:text-amber-300">No comparable regions found with the template.</p>}
            {result.notes.map((n, i) => {
              const note = typeof n === 'string' ? { panelId: null, kind: 'note', text: n } : n;
              const w = note.panelId ? result.windows.find(v => v.panelId === note.panelId) : null;
              // A direct pair can miss a region that is connected through another window.
              if (note.kind === 'nothing' && blocks.some(b => !b.inconsistent.length && b.choices.some(c => c.panelId === note.panelId))) return null;
              return <div key={i} data-testid={`sync-note-${note.kind}`} className={['nothing', 'no-minimap2', 'no-sequence', 'identical'].includes(note.kind) ? 'text-amber-700 dark:text-amber-300' : 'text-ink-secondary'}>
                {note.panelId && identities[note.panelId] ? <><WindowBadge identity={identities[note.panelId]} />: </> : null}{note.text}
                {note.kind === 'nothing' && w && <div className="mt-1"><LocatePanel result={result} window={w} identities={identities} stale={stale} busy={busy && !(useSyncPanelState.getState().locating as Record<string, boolean> | undefined)?.[`${result.windows[0].panelId}~${w.panelId}`]} onMove={locus => void moveTemplate(locus)} /></div>}
              </div>;
            })}
            {crossing.length > 0 && <p data-testid="sync-circular-note" className="text-ink-secondary" title="Frames keep such a window across its origin (two blocks; BED export gives two rows); Rotate centres the match instead.">
              {crossing.length === 1 ? 'A match crosses' : `${crossing.length} matches cross`} a circular origin ({[...new Set(crossing.flatMap(p => (p.crosses ?? ['window']).map(side => identities[side === 'template' ? p.partnerId : p.panelId].label)))].join(', ')}).
            </p>}
            {stale && <p className="text-amber-700 dark:text-amber-300">Panels moved or references changed. Search again before saving.</p>}
          </div>
          {(allTemplate.length > 0 || allOthers.length > 0) && <>
            <SyncMap result={result} identities={identities} selection={selection} frame={selected} proposals={shownTemplate} otherPairs={mapMode === 'all' ? visibleProposals(allOthers, showAll ? null : settings.perPair, keep) : shownOthers}
              mode={result.windows.length < 3 ? 'lanes' : mapMode} blocks={blocks} onSelectBlock={b => { const block = blocks.find(x => x.id === b.id); if (block) chooseBlock(block); }}
              members={blocks.flatMap(b => b.choices)} selectedMembers={memberKeys}
              onMembersChange={setMemberKeys} focusedId={focusedId} features={features}
              onRefine={(a, b) => { if (selection) { setSelection(refine(selection, a, b)); setClusterCheck(null); } }}
              onSelect={p => focus(p)} />
            <BlockList result={result} blocks={blocks} selected={memberKeys} identities={identities} onChange={setMemberKeys} onRefine={chooseBlock} />
            {!!blocks.length && <div className="space-y-1" data-testid="sync-block-actions" onKeyDown={e => { if (e.key === 'Escape') setMemberKeys([]); }}>
              <CheckboxRow testId="sync-merge-blocks" checked={mergeBlocks} onChange={setMergeBlocks} label="Merge selected blocks into one group" />
              <div className="flex flex-wrap gap-1">
                <AnalysisButton theme="teal" variant="primary" data-testid="sync-accept-blocks" disabled={!selectedBlocks.length || !!batchError || stale || busy} onClick={acceptSelected}>Accept selected blocks ({selectedBlocks.length})</AnalysisButton>
                <AnalysisButton data-testid="sync-clear-members" disabled={!memberKeys.length} onClick={() => setMemberKeys([])}>Clear selection</AnalysisButton>
                <AnalysisButton data-testid="sync-select-members" onClick={() => setMemberKeys(defaultMembers(blocks))}>Select consistent blocks</AnalysisButton>
              </div>
              {batchError && <p role="status" className="text-amber-700 dark:text-amber-300">{batchError}</p>}
              <p className="text-ink-secondary">Tick members here or click their bars. Drag across lanes to select several; Shift or ⌘ adds to the selection. Escape clears.</p>
            </div>}
            <ProposalList result={result} proposals={listed} identities={identities} focusedId={focusedId} hidden={hidden} onFocus={p => focus(p)} onRotate={rotate}
              onUseTemplate={id => { setTemplate(id); setNotice(`${identities[id].label} is now the template. Find comparable regions again.`); }} />
          </>}
          {result.windows.length > 2 && <div className="flex flex-wrap items-center gap-1 text-ink-secondary">
            Leave out:
            {result.windows.slice(1).map(w => <AnalysisButton key={w.panelId} data-testid={`sync-drop-${w.panelId}`}
              onClick={() => {
                const windowsLeft = result.windows.filter(v => v.panelId !== w.panelId);
                setResult({ ...result, windows: windowsLeft, proposals: result.proposals.filter(p => p.panelId !== w.panelId && p.partnerId !== w.panelId) });
                setSelection(null); setFocusedId(null); setClusterCheck(null);
              }}>
              <WindowBadge identity={identities[w.panelId]} />
            </AnalysisButton>)}
          </div>}
          {focused && <details data-testid="sync-why" className="rounded-fb border border-line px-2 py-1">
            <summary className="cursor-pointer">Why confidence {focused.confidence.toFixed(2)} · {focused.supports} of {focused.assessed} metrics support{chromatinOnly(focused) ? ' · chromatin only (no shared sequence)' : ''}</summary>
            <ul className="mt-1 list-disc pl-4">{explain(focused, labels).map((line, i) => <li key={i}>{line}</li>)}</ul>
            {chromatinOnly(focused) && <p className="text-ink-secondary">Matched: the local accessibility, NFR and nucleosome profiles of {identities[focused.panelId].label} {formatNumber(focused.window[0])}–{formatNumber(focused.window[1])} against {identities[focused.partnerId].label} {formatNumber(focused.template[0])}–{formatNumber(focused.template[1])}{focused.r != null ? ` (mean r ${focused.r.toFixed(2)}${focused.z != null ? `, z ${focused.z.toFixed(1)} against scrambled profiles` : ''})` : ''}{focused.nfr ? `, centred on NFRs at ${formatNumber(focused.nfr[0] + result.windows[0].start)} and ${formatNumber(focused.nfr[1] + (result.windows.find(w => w.panelId === focused.panelId)?.start ?? 0))}` : ''}{focused.landmark ? ' (an NFR landmark pair)' : ''}. No shared sequence: a hypothesis about corresponding elements, not evidence of homology.</p>}
            {indelText(focused, identities[focused.panelId].label) && <p className="text-ink-secondary">Indels: {indelText(focused, identities[focused.panelId].label)}.</p>}
            <p className="text-ink-secondary">Confidence: the weighted mean support of the metrics that could assess this mapping (sequence by identity times share; anchors 1/0; chromatin profiles by correlation, r 0.1 → 0 to 0.6 → 1, sharing weight). Accessibility, NFR and chromatin shape count as one line of evidence for “Metrics agree”.</p>
          </details>}
        </section>
        {selection && checks && <section data-testid="sync-refine" className="space-y-2">
          <strong>4 · Refine and save</strong>
          <div className="flex flex-wrap gap-2">
            {(['start', 'end'] as const).map(edge => <label key={edge} className="flex min-w-0 flex-wrap items-center gap-1">
              {`Template ${edge}`}
              <input data-testid={`sync-refine-${edge}`} className={`${inputClass} w-28`} type="number" value={selection[edge]}
                onChange={e => { setSelection(refine(selection, edge === 'start' ? Number(e.target.value) : selection.start, edge === 'end' ? Number(e.target.value) : selection.end)); setClusterCheck(null); }} />
            </label>)}
          </div>
          {selection.excluded?.length ? <p data-testid="sync-excluded" className="text-ink-secondary">
            Left out: {selection.excluded.map(id => `${identities[id]?.label ?? id}${selection.transitive?.includes(id) ? ' (linked only through another window: make it or that window the template to include it)' : ' (no match for this stretch)'}`).join(', ')}.
          </p> : null}
          {result.windows.filter(rw => !selection.excluded?.includes(rw.panelId)).map((rw, i) => {
            const rows = selected.filter(w => w.panelId === rw.panelId);
            const alternatives = i || selection.templateId === rw.panelId ? alternativesFor(result, selection, rw.panelId) : [];
            const chosenIds = selection.matches.filter(p => p.panelId === rw.panelId).map(p => p.id);
            return <div key={rw.panelId} data-testid={`sync-refine-window-${rw.panelId}`} className="space-y-1">
              {rows.map(w => {
                const mapped = w.blocks.reduce((sum, b) => sum + b.frame[1] - b.frame[0], 0);
                return <div key={windowKey(w)} data-testid={`sync-refine-row-${windowKey(w)}`} className="flex items-start gap-2">
                  <div className="min-w-0 flex-1" title={`${w.blocks.length} block${w.blocks.length === 1 ? '' : 's'} · maps ${formatNumber(mapped)} of ${formatNumber(frameLength)} frame bp${w.contigLength && w.end > w.contigLength ? ` · across the origin (${formatNumber(w.contigLength)} bp contig)` : ''}`}>
                    <WindowBadge identity={{ ...identities[w.panelId], label: windowLabel(w) }} /> · {formatInterval(w)} ({w.strand})
                    <span className="text-ink-secondary"> · {w.blocks.length} block{w.blocks.length === 1 ? '' : 's'} · maps {formatNumber(mapped)} of {formatNumber(frameLength)} frame bp</span>
                  </div>
                  <AnalysisButton className="shrink-0" data-testid={`sync-flip-${windowKey(w)}`} title="Read this window the other way along the frame (a manual override)."
                    onClick={() => setFlips({ ...flips, [windowKey(w)]: !flips[windowKey(w)] })}>Flip</AnalysisButton>
                </div>;
              })}
              {alternatives.length > 1 && <fieldset data-testid={`sync-copies-${rw.panelId}`} className="ml-4 text-ink-secondary">
                <legend>Use copies (one frame window each):</legend>
                {alternatives.map((p, k) => <CheckboxRow key={p.id} testId={`sync-copy-${p.id}`} checked={chosenIds.includes(p.id)} disabled={chosenIds.length === 1 && chosenIds.includes(p.id)}
                  onChange={v => chooseCopies(rw.panelId, v ? [...chosenIds, p.id] : chosenIds.filter(id => id !== p.id))}
                  label={`${k + 1}: ${formatNumber(p.window[0])}–${formatNumber(p.window[1])} (${p.confidence.toFixed(2)})`} />)}
              </fieldset>}
            </div>;
          })}
          <details data-testid="sync-comparable" open={checklistOpen || issues > 0} onToggle={e => setChecklistOpen((e.currentTarget as HTMLDetailsElement).open)}>
            <summary data-testid="sync-comparable-summary" className={`cursor-pointer ${issues ? 'text-amber-700 dark:text-amber-300' : 'text-teal-700 dark:text-teal-300'}`}>{issues ? `${issues} issue${issues === 1 ? '' : 's'}` : 'Comparable ✓'}</summary>
            <div className="mt-1 space-y-1">
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                <label className="flex min-w-0 flex-wrap items-center gap-1">
                  Reads must cover
                  <input data-testid="sync-min-cover" aria-label="Percent of the sub-window each read must cover" className={`${inputClass} w-14`} type="number" min={10} max={100} value={cover}
                    onChange={e => setCover(Math.max(10, Math.min(100, Number(e.target.value) || 80)))} />
                  %
                </label>
                <label className="flex min-w-0 flex-wrap items-center gap-1">
                  Minimum reads
                  <input data-testid="sync-min-reads" className={`${inputClass} w-16`} type="number" min={1} value={minimumReads} onChange={e => setMinimumReads(Math.max(1, Number(e.target.value)))} />
                </label>
              </div>
              <ul data-testid="sync-checklist">
                <li>{checks.equal ? '✓' : '✗'} Equal length: {formatNumber(frameLength)} frame bp each</li>
                {checks.counts.map(c => <li key={c.key}>
                  {c.count >= minimumReads ? '✓' : '✗'} <WindowBadge identity={{ ...identities[c.panelId], label: windowLabel(c) }} />: {formatNumber(c.count)} reads cover ≥{cover}% (need {formatNumber(minimumReads)}) · {formatNumber(c.spanning)} span all of it
                  {c.count < minimumReads && <p className="text-ink-secondary">Too few reads cover {cover}% of {formatNumber(c.mapped)} bp: shorten the sub-window or lower the coverage.</p>}
                </li>)}
                <li>{checks.strands ? '✓' : '✗'} Strands set</li>
                <li>{checks.inside ? '✓' : '✗'} Inside each loaded range</li>
              </ul>
            </div>
          </details>
          <details data-testid="sync-cluster" className="rounded-fb border border-line px-2 py-1">
            <summary className="cursor-pointer">Check with clustering</summary>
            <div className="mt-1 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <AnalysisButton theme="teal" data-testid="sync-cluster-run" disabled={clusterBusy || !checks.equal || stale} onClick={() => void checkClusters()}
                  title="Pools the reads of every frame window (mapped block by block), clusters them once on accessibility (k-means fitted on an equal number of reads per window) and shows each window’s share per cluster.">
                  {clusterBusy ? 'Clustering…' : 'Run'}
                </AnalysisButton>
                <label className="flex items-center gap-1">
                  Clusters
                  <select data-testid="sync-cluster-k" className={inputClass} value={clusterK} onChange={e => { setClusterK(Number(e.target.value)); setClusterCheck(null); }}>
                    {[2, 3, 4, 5, 6].map(k => <option key={k} value={k}>{k}</option>)}
                  </select>
                </label>
              </div>
              {clusterState.error && clusterState.key === clusterKey && <p className="text-amber-700 dark:text-amber-300">{clusterState.error}</p>}
              {shownCluster && <div data-testid="sync-cluster-result" className="space-y-1">
                {shownCluster.windows.map(w => {
                  const total = w.clusters.reduce((a, b) => a + b, 0) || 1;
                  const label = windowLabel({ panelId: w.panelId, copy: w.key.includes('#') ? w.key.split('#')[1] : undefined });
                  return <div key={w.key} className="flex items-center gap-2">
                    <span className="w-10 shrink-0"><WindowBadge identity={{ ...identities[w.panelId], label }} /></span>
                    <div className="flex h-3 min-w-0 flex-1 overflow-hidden rounded-sm" role="img" aria-label={`${label}: ${w.clusters.map((c, i) => `cluster ${i + 1} ${Math.round(100 * c / total)}%`).join(', ')}`}>
                      {w.clusters.map((c, i) => <div key={i} style={{ width: `${100 * c / total}%`, backgroundColor: getClusterColor(i) }} title={`Cluster ${i + 1}: ${formatNumber(c)} reads`} />)}
                    </div>
                    <span className="shrink-0 text-ink-secondary">{formatNumber(w.used)} of {formatNumber(w.eligible)}</span>
                  </div>;
                })}
                <ul className="text-ink-secondary">
                  {shownCluster.clusters.map(c => <li key={c.cluster}>
                    <span aria-hidden="true" className="mr-1 inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: getClusterColor(c.cluster) }} />
                    Cluster {c.cluster + 1}: {formatNumber(c.reads)} reads · {c.agreement == null ? 'in one window only' : `window profiles agree r ${c.agreement.toFixed(2)}`}
                  </li>)}
                </ul>
                <p className={shownCluster.separation > 0.3 ? 'text-amber-700 dark:text-amber-300' : 'text-ink-secondary'}>
                  Mean profiles agree r {shownCluster.agreement?.toFixed(2) ?? '–'}. Clusters {shownCluster.separation > 0.3 ? 'largely separate the windows' : 'mix the windows'} (NMI {shownCluster.separation.toFixed(2)}){shownCluster.separation > 0.3 ? ': they may reflect the window, chemistry or depth rather than shared states.' : '.'} {shownCluster.seconds.toFixed(1)} s.
                </p>
              </div>}
            </div>
          </details>
          <label className="block space-y-1">Group name <input data-testid="sync-frame-name" className={`${inputClass} block w-full`} value={name} onChange={e => setName(e.target.value)} /></label>
          {circularAligned && <p data-testid="sync-circularity" className="text-[11px] text-ink-secondary">Aligned partly on chromatin ({result.metrics.filter(m => m === 'shape' || m === 'accessibility' || m === 'nfr').map(m => shortMetric[m]).join(', ')}): comparing accessibility or NFRs in this frame agrees partly by construction.</p>}
          <div className="flex flex-wrap gap-1">
            <AnalysisButton theme="teal" variant="primary" data-testid="sync-accept" disabled={!canAccept}
              onClick={() => {
                const id = editingId ?? crypto.randomUUID();
                try {
                  acceptBlocks([{ id, name: name.trim() || 'Comparison', version: 1, status: 'accepted', windows: selected.map(w => ({ ...w, tag: windowLabel(w) })), templatePanelId: selection.templateId ?? result.windows[0].panelId, length: selection.end - selection.start, alignedOn: result.metrics }]);
                  setEditingId(id);
                  setNotice('Matched group saved and active: its regions are on the peak row.');
                } catch (error) {
                  setNotice(`This group could not be saved: ${error instanceof Error ? error.message : String(error)}. Refine it and try again.`);
                }
              }}>
              Use as matched group
            </AnalysisButton>
            {editingId && <AnalysisButton data-testid="sync-save-copy" onClick={() => { setEditingId(null); setNotice('The next save will create another group.'); }}>Save next as a new group</AnalysisButton>}
          </div>
        </section>}</>}
    </>}
    <HowItWorks testId="sync-how">
      <p>Steps: choose the windows and metrics, then Find. Consistent blocks start with all members ticked. Toggle any window or copy on the map or in the list, then Accept selected blocks. Each becomes a matched group; tick Merge to combine them. Refine adjusts a single block. Undo reverses acceptance. Saved groups create matched regions on the peak row, saved with the session.</p>
      <p>The map has two views. Each vs template: one lane per window under its own copy of the template bar. All windows: every window once, ordered by similarity, ribbons between neighbours, and the common blocks bracketed (“in 3 of 4”). Ribbons cross when reversed; an indel is a gap on one bar and a notch on the other; hatched ribbons are chromatin only. To pick among overlapping ribbons, click a stretch of a bar: its matches light up on the other bars; click one of those (again to step through several). Bars are keyboard stops: arrows move between stretches, Enter chooses, Escape clears.</p>
      <p>Tick one window to find repeats within it. Overlapping windows on the same reference exclude the match to the same bases. Repeat searches exclude self-hits before alignment, mask short low-complexity repeats and use the Minimum aligned length and Minimum identity settings. Copy groups save as W1a, W1b, W1c for the existing matched-region actions.</p>
      <p>Sequence aligns each window’s reference to the template with minimap2 (asm20, both strands) and chains aligned blocks across indels up to the Advanced limit (2 kb by default). A stretch matching several places (copies) is marked as repeated; copies can be used together (W3a, W3b…). Shared sequence is a candidate for corresponding stretches, not proof of orthology.</p>
      <p>Chromatin shape (local) compares accessibility, ≥175-bp gap (NFR) and nucleosome occupancy profiles, each z-scored within its window (thinly covered bins left out), in seeds of 300, 600 and 1,200 bp of each window against every position of the template, both strands. A match counts when its mean correlation reaches r 0.6 and it beats the best match in phase-randomised template profiles (same autocorrelation) by z 4 when centred on an NFR on both sides, or by z 6 otherwise, and every seed’s best match in those null profiles. Matches with the same offset chain into blocks. NFR ↔ NFR landmark pairs can be proposed too (Advanced); since NFRs resemble one another, they are hypotheses. Chromatin-only matches are hypotheses about corresponding elements, not evidence of homology; aligning on chromatin and then comparing chromatin is circular, and frames aligned on it say so. A chromatin match that sequence places elsewhere is flagged.</p>
      <p>The accessibility and NFR profiles score each proposal along its block map (±300 bp search) and propose a rigid whole-window shift only when one stands out. Feature anchors align chosen positions (a gene TSS gives its strand). Status: metrics agree (sequence or an anchor plus another line of evidence; accessibility, NFR and chromatin shape count as one), one metric, metrics disagree, weak.</p>
      <p>Refine crops the template stretch; every window maps onto the same frame length through its block map. Windows that lack the chosen stretch are left out (and listed) rather than shrinking the others. Circular windows may run across their origin; BED export writes one row per block. Reads count when they cover at least the chosen share of a window’s mapped bases. Check with clustering pools the frame windows’ reads in frame coordinates and shows each window’s share per cluster.</p>
    </HowItWorks>
  </AnalysisPanelShell>;
}
