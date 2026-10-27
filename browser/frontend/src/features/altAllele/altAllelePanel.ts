/**
 * Alt-allele panels: an insertion's carriers shown on its alternate allele, the
 * insert expanded (services/alt_allele.py builds a BAM of the carriers re-aligned
 * onto reference flank + insert consensus + reference flank, opened as a dataset
 * with that contig as its own reference). On it every carrier is an ordinary
 * read, so the read track, Cluster / Sort / Filter, Find classes, the analysis
 * panels, metaprofiles and exports work on the insert like on any region.
 *
 * - showPanelOnAltAllele: a dataset panel switches to the alt allele (and back,
 *   showPanelOnReference, to exactly what it showed: dataset, reference, locus,
 *   state key).
 * - openAltAllelePanel: a new panel on the alt allele (the insertion lens, the SV band).
 * - healAltAllelePanels: a restored panel whose alt dataset could not be reopened
 *   (its built files gone) is rebuilt from the insertion it records.
 */
import { create } from 'zustand';
import { openAltAllele, insertionClustersInView, type AltAlleleResponse } from './api';
import { removeDataset } from '../../api/datasets';
import { useBrowserStore } from '../../stores/browserStore';
import { seedHistoryBaseline, serializeDataset, type SerializedDataset } from '../../stores/historySlice';
import { closedDatasetReference, usePanelGenomeStore } from '../../stores/panelGenomeStore';
import type { PanelConfig } from '../../types';
import type { AltAlleleCluster, AltAllelePanelState } from './types';
import type { Dataset } from '../../types/dataset';
import { createDefaultSubTracks, generatePanelId } from '../../stores/utils';
import { altAlleleName, mapSpanToAlt, mapSpanToRef } from './altAlleleCoords';

/** Insertions shorter than this are not offered by the panel menu's toggle. */
export const ALT_MIN_INSERT = 300;

interface BuildState {
  /** panel id -> what is being built for it ("Building the alt allele of +9,184 bp at ..."). */
  pending: Record<string, string>;
  /** panel id -> when its build started (ms): the panel body's job status shows the time since. */
  started: Record<string, number>;
  /** panel id -> its latest build's number: a build whose number is no longer the latest was cancelled (or replaced). */
  runs: Record<string, number>;
  set: (panelId: string, text: string | null) => void;
  /** A build starts for the panel: its number. */
  begin: (panelId: string, text: string) => number;
  /** Its build `run` is over: its status goes (unless a later build is running). */
  end: (panelId: string, run: number) => void;
  /** Stop waiting for the panel's build (round 2: the status had no Cancel): it stays as it was. */
  cancel: (panelId: string) => void;
}

const clearPending = (s: Pick<BuildState, 'pending' | 'started'>, panelId: string) => {
  const pending = { ...s.pending };
  const started = { ...s.started };
  delete pending[panelId];
  delete started[panelId];
  return { pending, started };
};

export const useAltAlleleBuildStore = create<BuildState>((set, get) => ({
  pending: {},
  started: {},
  runs: {},
  set: (panelId, text) => set(s => {
    if (!text) return clearPending(s, panelId);
    return { pending: { ...s.pending, [panelId]: text }, started: { ...s.started, [panelId]: s.started[panelId] ?? Date.now() } };
  }),
  begin: (panelId, text) => {
    const run = (get().runs[panelId] ?? 0) + 1;
    set(s => ({
      runs: { ...s.runs, [panelId]: run },
      pending: { ...s.pending, [panelId]: text },
      started: { ...s.started, [panelId]: s.started[panelId] ?? Date.now() },
    }));
    return run;
  },
  end: (panelId, run) => {
    if (get().runs[panelId] === run) set(s => clearPending(s, panelId));
  },
  cancel: (panelId) => set(s => ({ runs: { ...s.runs, [panelId]: (s.runs[panelId] ?? 0) + 1 }, ...clearPending(s, panelId) })),
}));

/** Whether the panel's build `run` is still the one wanted (not cancelled). */
const buildWanted = (panelId: string, run: number) => useAltAlleleBuildStore.getState().runs[panelId] === run;

/**
 * Datasets of cancelled builds, closed once no build is running: a retry of the same insertion gets the same dataset
 * back from the server (one per definition), so closing it while another build waits could take the retry's.
 */
const cancelledDatasets = new Set<string>();

async function releaseCancelled(): Promise<void> {
  // Checked before each one: a build may start while an earlier one is being closed (then the rest wait for its end).
  for (const id of [...cancelledDatasets]) {
    if (Object.keys(useAltAlleleBuildStore.getState().pending).length > 0) return;
    if (!cancelledDatasets.delete(id)) continue;
    // (Kept when a panel shows it: discardAltDataset checks.)
    await discardAltDataset(id);
  }
}

/**
 * Cancel the alt-allele build of a panel: the panel stays as it was. The server has no cancel for this request, so
 * its build finishes there (built once per definition and cached, so a later Expand is quick); its dataset is closed
 * when it arrives, unless a panel shows it.
 */
export function cancelAltAlleleBuild(panelId: string): void {
  useAltAlleleBuildStore.getState().cancel(panelId);
}

function clusterLabel(cluster: AltAlleleCluster): string {
  return cluster.len != null && cluster.ref != null
    ? `+${cluster.len.toLocaleString()} bp at ${cluster.chrom}:${cluster.ref.toLocaleString()}`
    : `the insertion near ${cluster.chrom}:${(cluster.pos ?? 0).toLocaleString()}`;
}

async function requestAltAllele(cluster: AltAlleleCluster, opts: { includeReference?: boolean; flank?: number }): Promise<AltAlleleResponse> {
  const st = useBrowserStore.getState();
  try {
    return await openAltAllele({
      dataset_id: cluster.datasetId, chrom: cluster.chrom, ref: cluster.ref, length: cluster.len, pos: cluster.pos,
      include_reference: Boolean(opts.includeReference), flank: opts.flank,
      include_duplicates: Boolean(st.showDuplicateReads),
    });
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The alt dataset in the store (added once), and its reference known to the panel-genome store. */
async function registerAltDataset(res: AltAlleleResponse): Promise<Dataset> {
  const dataset = res.dataset!;
  // The reference first, so the panel's genome is never out of step with the assignments.
  await usePanelGenomeStore.getState().refresh();
  const st = useBrowserStore.getState();
  if (!st.datasets.some(d => d.id === dataset.id)) {
    useBrowserStore.setState(s => ({
      datasets: [...s.datasets, dataset],
      slotOrder: s.slotOrder.includes(dataset.id) ? s.slotOrder : [...s.slotOrder, dataset.id],
    }));
    queueMicrotask(() => {
      const after = useBrowserStore.getState();
      after.initModTypeDefaults();
      after.seedDefaultMetaprofile();
    });
  } else {
    useBrowserStore.setState(s => ({ datasets: s.datasets.map(d => (d.id === dataset.id ? { ...d, ...dataset } : d)) }));
  }
  return dataset;
}

/** The source dataset's own reference, when it has one (not the main genome). */
function sourceGenomeOf(datasetId: string, panelGenome?: string): string | undefined {
  return panelGenome ?? usePanelGenomeStore.getState().assignments[datasetId] ?? undefined;
}

function altState(res: AltAlleleResponse, cluster: AltAlleleCluster, opts: { includeReference?: boolean; flank?: number; linked?: boolean; sourceGenome?: string },
  restore: AltAllelePanelState['restore']): AltAllelePanelState {
  return {
    cluster: { ...cluster, ref: res.layout!.ref, len: res.alt_allele?.meta?.sv?.len ?? cluster.len },
    layout: res.layout!,
    altDatasetId: res.dataset!.id,
    genomeKey: res.genome_key!,
    // The main view is another assembly than a source on its own reference: never linked to it then.
    linked: opts.sourceGenome ? false : (opts.linked ?? true),
    ...(opts.sourceGenome ? { sourceGenome: opts.sourceGenome } : {}),
    includeReference: Boolean(opts.includeReference),
    flank: opts.flank ?? res.alt_allele?.definition.flank,
    restore,
  };
}

/** Where the alt panel opens: the main view's locus mapped onto the contig when it shows the insertion, else the insert. */
function startLocus(res: AltAlleleResponse, from?: { chrom: string; start: number; end: number }) {
  const mapped = from ? mapSpanToAlt(res.layout!, from) : null;
  const ins = res.layout!;
  if (mapped && mapped.start <= ins.insert_start && mapped.end >= ins.insert_end && mapped.end - mapped.start <= 4 * ins.length) return mapped;
  return res.locus!;
}

/** The error banner for a failed build; `retry` (the same call again) gives it a Retry button. */
function fail(label: string, error: string | undefined, retry?: () => void) {
  useBrowserStore.getState().setError(`Could not show the insert expanded (${label}): ${error || 'the server did not answer'}`,
    retry ? { label: 'Retry', run: retry } : undefined);
}

/**
 * Switch a dataset panel to the alt allele of `cluster` (carriers only, insert expanded).
 * What it showed before is kept for showPanelOnReference. Returns the alt dataset id, or null.
 * `retry`: what the error banner's Retry runs when the build fails (default: this call again). A caller that does
 * more after this call passes its own.
 */
export async function showPanelOnAltAllele(panelId: string, cluster: AltAlleleCluster,
  opts: { includeReference?: boolean; flank?: number } = {}, retry?: () => void): Promise<string | null> {
  const panel = useBrowserStore.getState().panels.find(p => p.id === panelId);
  if (!panel || panel.contentType !== 'dataset') return null;
  const label = clusterLabel(cluster);
  const run = useAltAlleleBuildStore.getState().begin(panelId, `Building the alternate allele of ${label}…`);
  try {
    const res = await requestAltAllele(cluster, opts);
    if (!buildWanted(panelId, run)) {
      // Cancelled meanwhile: the panel stays as it is; the built dataset is not kept (closed once no build waits).
      if (res.success && res.dataset) cancelledDatasets.add(res.dataset.id);
      return null;
    }
    if (!res.success || !res.dataset || !res.layout || !res.genome_key) {
      fail(label, res.error, retry ?? (() => void showPanelOnAltAllele(panelId, cluster, opts)));
      return null;
    }
    const dataset = await registerAltDataset(res);
    const st = useBrowserStore.getState();
    const current = st.panels.find(p => p.id === panelId);
    if (!current || !buildWanted(panelId, run)) {
      // The panel closed while its alt allele was building (e.g. its split closed), or the build was cancelled: drop
      // the result (once no build waits).
      cancelledDatasets.add(dataset.id);
      return null;
    }
    // Back to the reference later: exactly what it shows now (an alt panel re-switched keeps its first restore).
    const restore: AltAllelePanelState['restore'] = current.altAllele ? current.altAllele.restore : {
      datasetId: current.datasetId, genome: current.genome, viewportOverride: current.viewportOverride,
      stateKey: current.stateKey, ownLocus: current.ownLocus, navOwn: current.navOwn, siteLocked: current.siteLocked,
      linkGroup: current.linkGroup,
    };
    const view = current.viewportOverride ?? { chrom: st.chrom, start: st.start, end: st.end };
    seedHistoryBaseline(st, 'Before showing the insert expanded', 'layout');
    const next: PanelConfig = {
      ...current,
      datasetId: dataset.id,
      genome: res.genome_key,
      viewportOverride: startLocus(res, view),
      // Its own reads: its own clusters, filters and sort.
      stateKey: `${panelId}~alt`,
      ownLocus: true,
      navOwn: undefined,
      siteLocked: false,
      linkGroup: null,
      altAllele: altState(res, cluster, {
        ...opts, linked: current.altAllele?.linked ?? true,
        sourceGenome: current.altAllele ? current.altAllele.sourceGenome : sourceGenomeOf(cluster.datasetId, current.genome),
      }, restore),
    };
    useBrowserStore.setState(s => ({ panels: s.panels.map(p => (p.id === panelId ? next : p)) }));
    useBrowserStore.getState().pushSnapshot?.(`Show insert expanded: ${altAlleleName(res.layout)}`, { kind: 'layout' });
    return dataset.id;
  } finally {
    useAltAlleleBuildStore.getState().end(panelId, run);
    void releaseCancelled();
  }
}

/**
 * Close the alt dataset (server and store) when no panel shows it any more, as one undo step
 * with the panel change: Undo reopens it (its built BAM, and its contig as its reference) and
 * puts the panel back on it, like closing any dataset.
 */
async function closeAltDatasetIfUnused(datasetId: string, label: string): Promise<boolean> {
  const st = useBrowserStore.getState();
  if (st.panels.some(p => p.contentType === 'dataset' && p.datasetId === datasetId)) return false;
  const dataset = st.datasets.find(d => d.id === datasetId);
  const reference = closedDatasetReference(datasetId);
  try {
    const res = await removeDataset(datasetId);
    if (!res.success) return false;
  } catch {
    return false;
  }
  const after = useBrowserStore.getState();
  if (after.panels.some(p => p.contentType === 'dataset' && p.datasetId === datasetId)) return false;
  after.removeDataset(datasetId);
  useBrowserStore.getState().pushSnapshot?.(label, {
    kind: 'layout',
    ...(dataset ? { closedDatasets: [{ ...serializeDataset(dataset), ...(reference ? { reference } : {}) }] } : {}),
  });
  void usePanelGenomeStore.getState().refresh();
  return true;
}

/** An alt dataset registered for a panel that has gone meanwhile: closed without an undo step (it never was one). */
async function discardAltDataset(datasetId: string): Promise<void> {
  if (useBrowserStore.getState().panels.some(p => p.contentType === 'dataset' && p.datasetId === datasetId)) return;
  try {
    if (!(await removeDataset(datasetId)).success) return;
  } catch {
    return;
  }
  const after = useBrowserStore.getState();
  if (after.panels.some(p => p.contentType === 'dataset' && p.datasetId === datasetId)) return;
  after.removeDataset(datasetId);
  void usePanelGenomeStore.getState().refresh();
}

/**
 * Closing panels that show alt datasets (a split's Carriers panel): close those datasets on the server when no
 * other panel shows them, and return what the caller's single undo step records (its `closedDatasets`) and the
 * ids it must take out of the store with the panels. Undo then reopens them with the panels, in one step.
 */
export async function releaseAltDatasets(datasetIds: string[], closingPanelIds: string[]): Promise<{ ids: string[]; closed: SerializedDataset[] }> {
  const out: { ids: string[]; closed: SerializedDataset[] } = { ids: [], closed: [] };
  for (const id of new Set(datasetIds)) {
    const st = useBrowserStore.getState();
    if (st.panels.some(p => p.contentType === 'dataset' && p.datasetId === id && !closingPanelIds.includes(p.id))) continue;
    const dataset = st.datasets.find(d => d.id === id);
    const reference = closedDatasetReference(id);
    try {
      if (!(await removeDataset(id)).success) continue;
    } catch {
      continue;
    }
    out.ids.push(id);
    if (dataset) out.closed.push({ ...serializeDataset(dataset), ...(reference ? { reference } : {}) });
  }
  return out;
}

/**
 * "Split into panels" by an insertion's SV allele (fb-n11-features + fb-n11-altallele): the Carriers panels
 * (the split's group 0, SV_GROUP_LABELS) show the insert expanded, carriers on the alternate allele.
 * Their header pill ("Pinned to insertion ⓘ" → Show on reference) and ⋯ menu toggle back to the reference.
 */
/** The SV split a panel shows, when its Carriers open with the insert expanded (an insertion of ALT_MIN_INSERT+ in a BAM). */
function expandingSvSplit(sourcePanelId: string) {
  const st = useBrowserStore.getState();
  const source = st.panels.find(p => p.id === sourcePanelId);
  const key = source ? source.stateKey ?? source.datasetId : undefined;
  const def = key ? st.svSplits[key] : undefined;
  if (!def || def.t !== 'I' || def.len < ALT_MIN_INSERT) return null;
  if (st.datasets.find(d => d.id === def.datasetId)?.data_type !== 'bam') return null;
  return def;
}

/** Whether "Split into panels" by this panel's SV split opens its Carriers with the insert expanded. */
export function svSplitExpands(sourcePanelId: string): boolean {
  return Boolean(expandingSvSplit(sourcePanelId));
}

export async function expandSvSplitCarriers(groupId: string, sourcePanelId: string): Promise<void> {
  const st = useBrowserStore.getState();
  const def = expandingSvSplit(sourcePanelId);
  if (!def) return;
  const carriers = st.panels.filter(p => p.readSubset?.groupId === groupId
    && p.readSubset.rule.groupKeys?.length === 1 && p.readSubset.rule.groupKeys[0] === '0');
  for (const p of carriers) await showPanelOnAltAllele(p.id, { datasetId: def.datasetId, chrom: def.chrom, ref: def.ref, len: def.len });
}

/** Back to what the panel showed before it went to the alt allele (a panel opened on it: its source at the reference). */
export async function showPanelOnReference(panelId: string): Promise<void> {
  const st = useBrowserStore.getState();
  const panel = st.panels.find(p => p.id === panelId);
  const alt = panel?.altAllele;
  if (!panel || !alt) return;
  const altDatasetId = panel.datasetId;
  seedHistoryBaseline(st, 'Before showing the reference', 'layout');
  let next: PanelConfig;
  if (alt.restore) {
    const r = alt.restore;
    const { altAllele: _alt, ...rest } = panel;
    next = {
      ...rest,
      datasetId: r.datasetId,
      genome: r.genome,
      viewportOverride: r.viewportOverride,
      stateKey: r.stateKey,
      ownLocus: r.ownLocus,
      navOwn: r.navOwn,
      siteLocked: r.siteLocked,
      linkGroup: r.linkGroup,
    };
  } else {
    // Opened on the alt allele: the source dataset at the matching reference locus.
    const v = panel.viewportOverride;
    const ref = v ? mapSpanToRef(alt.layout, v) : null;
    const { altAllele: _alt, ...rest } = panel;
    next = {
      ...rest,
      datasetId: alt.cluster.datasetId,
      genome: alt.sourceGenome,
      viewportOverride: ref ?? { chrom: alt.layout.chrom, start: Math.max(0, alt.layout.ref - 10_000), end: alt.layout.ref + 10_000 },
      stateKey: `${panelId}~ref`,
      ownLocus: true,
      siteLocked: false,
      linkGroup: null,
    };
  }
  useBrowserStore.setState(s => ({ panels: s.panels.map(p => (p.id === panelId ? next : p)) }));
  const label = 'Show the reference (insert collapsed)';
  const closed = altDatasetId ? await closeAltDatasetIfUnused(altDatasetId, label) : false;
  if (!closed) useBrowserStore.getState().pushSnapshot?.(label, { kind: 'layout' });
  void usePanelGenomeStore.getState().refresh();
}

/** A new panel on the alt allele of `cluster`. Returns its panel id, or null. */
export async function openAltAllelePanel(cluster: AltAlleleCluster,
  opts: { afterPanelId?: string; includeReference?: boolean; flank?: number } = {}): Promise<string | null> {
  const label = clusterLabel(cluster);
  const pendingKey = `new:${cluster.datasetId}:${cluster.chrom}:${cluster.ref ?? cluster.pos}`;
  const key = opts.afterPanelId ?? pendingKey;
  const run = useAltAlleleBuildStore.getState().begin(key, `Building the alternate allele of ${label}…`);
  try {
    const res = await requestAltAllele(cluster, opts);
    if (!buildWanted(key, run)) {
      if (res.success && res.dataset) cancelledDatasets.add(res.dataset.id);
      return null;
    }
    if (!res.success || !res.dataset || !res.layout || !res.genome_key) {
      fail(label, res.error, () => void openAltAllelePanel(cluster, opts));
      return null;
    }
    const dataset = await registerAltDataset(res);
    if (!buildWanted(key, run)) {
      // Cancelled while it was being registered.
      cancelledDatasets.add(dataset.id);
      return null;
    }
    const st = useBrowserStore.getState();
    const id = generatePanelId();
    const panel: PanelConfig = {
      id,
      contentType: 'dataset',
      datasetId: dataset.id,
      subTracks: createDefaultSubTracks(st.orthogonalTracks, st.compositeTracks),
      collapsed: false,
      linkGroup: null,
      layoutRow: 0,
      genome: res.genome_key,
      viewportOverride: startLocus(res, { chrom: st.chrom, start: st.start, end: st.end }),
      stateKey: `${id}~alt`,
      ownLocus: true,
      siteLocked: false,
      altAllele: altState(res, cluster, { ...opts, sourceGenome: sourceGenomeOf(cluster.datasetId) }, null),
    };
    useBrowserStore.setState(s => {
      const panels = [...s.panels];
      const at = opts.afterPanelId ? panels.findIndex(p => p.id === opts.afterPanelId) : -1;
      if (at >= 0) panels.splice(at + 1, 0, { ...panel, layoutRow: panels[at].layoutRow });
      else panels.push(panel);
      return { panels };
    });
    useBrowserStore.getState().pushSnapshot?.(`Open carriers with the insert expanded: ${altAlleleName(res.layout)}`, { kind: 'layout' });
    return id;
  } finally {
    useAltAlleleBuildStore.getState().end(key, run);
    void releaseCancelled();
  }
}

/** The insertion a panel's view shows (the one with most carriers, at least ALT_MIN_INSERT bp), or why there is none. */
export async function insertionInView(panel: PanelConfig): Promise<{ cluster: AltAlleleCluster } | { error: string }> {
  const st = useBrowserStore.getState();
  if (!panel.datasetId) return { error: 'This panel shows no dataset' };
  const v = panel.viewportOverride ?? { chrom: st.chrom, start: st.start, end: st.end };
  try {
    const res = await insertionClustersInView(panel.datasetId, v.chrom, v.start, v.end, ALT_MIN_INSERT);
    if (!res.success) return { error: res.error || 'Could not list the insertions in view' };
    const centre = (v.start + v.end) / 2;
    const best = [...res.clusters].sort((a, b) => (b.carriers - a.carriers) || (Math.abs(a.ref - centre) - Math.abs(b.ref - centre)))[0];
    if (!best) return { error: `No insertion of ${ALT_MIN_INSERT} bp or more in view` };
    return { cluster: { datasetId: panel.datasetId, chrom: v.chrom, ref: best.ref, len: best.len } };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** The panel menu's toggle: on, the insertion in view expanded (carriers only); off, back to the reference. */
export async function toggleInsertExpanded(panelId: string): Promise<void> {
  const st = useBrowserStore.getState();
  const panel = st.panels.find(p => p.id === panelId);
  if (!panel) return;
  if (panel.altAllele) {
    await showPanelOnReference(panelId);
    return;
  }
  const run = useAltAlleleBuildStore.getState().begin(panelId, 'Finding the insertion in view…');
  const found = await insertionInView(panel);
  const wanted = buildWanted(panelId, run);
  useAltAlleleBuildStore.getState().end(panelId, run);
  if (!wanted) return;
  if ('error' in found) {
    useBrowserStore.getState().setError(`Show insert expanded: ${found.error}`);
    return;
  }
  await showPanelOnAltAllele(panelId, found.cluster);
}

/** Re-open this panel's alt allele with or without reference reads (the insert drawn as a deletion across them). */
export async function setAltIncludeReference(panelId: string, include: boolean): Promise<void> {
  const panel = useBrowserStore.getState().panels.find(p => p.id === panelId);
  const alt = panel?.altAllele;
  if (!panel || !alt || Boolean(alt.includeReference) === include) return;
  const before = panel.datasetId;
  const viewport = panel.viewportOverride;
  const id = await showPanelOnAltAllele(panelId, alt.cluster, { includeReference: include, flank: alt.flank },
    () => void setAltIncludeReference(panelId, include));
  if (!id) return;
  // Same contig: stay where it was.
  if (viewport) {
    useBrowserStore.setState(s => ({ panels: s.panels.map(p => (p.id === panelId ? { ...p, viewportOverride: viewport } : p)) }));
  }
  if (before && before !== id) void closeAltDatasetIfUnused(before, 'Include reference reads');
}

export function setAltLinked(panelId: string, linked: boolean): void {
  useBrowserStore.setState(s => ({
    panels: s.panels.map(p => (p.id === panelId && p.altAllele ? { ...p, altAllele: { ...p.altAllele, linked } } : p)),
  }));
}

const healing = new Set<string>();

/**
 * Restored panels on an alt allele whose dataset is not open (a session whose built files
 * were cleaned up, another computer): rebuilt from the insertion they record, once each.
 */
export async function healAltAllelePanels(): Promise<void> {
  const st = useBrowserStore.getState();
  const open = new Set(st.datasets.map(d => d.id));
  for (const panel of st.panels) {
    const alt = panel.altAllele;
    if (!alt || !panel.datasetId || open.has(panel.datasetId) || healing.has(panel.id)) continue;
    if (!open.has(alt.cluster.datasetId)) continue;  // its source is not open (yet)
    healing.add(panel.id);
    const viewport = panel.viewportOverride;
    void (async () => {
      try {
        const res = await requestAltAllele(alt.cluster, { includeReference: alt.includeReference, flank: alt.flank });
        if (!res.success || !res.dataset || !res.layout || !res.genome_key) {
          // Retry heals every restored panel still missing its alt allele (this one included).
          fail(clusterLabel(alt.cluster), res.error, () => void healAltAllelePanels());
          return;
        }
        const dataset = await registerAltDataset(res);
        const sameContig = viewport?.chrom === res.layout.name;
        useBrowserStore.setState(s => ({
          panels: s.panels.map(p => (p.id === panel.id ? {
            ...p, datasetId: dataset.id, genome: res.genome_key,
            viewportOverride: sameContig ? viewport : res.locus,
            altAllele: { ...alt, layout: res.layout!, altDatasetId: dataset.id, genomeKey: res.genome_key! },
          } : p)),
        }));
      } finally {
        healing.delete(panel.id);
      }
    })();
  }
}
