/**
 * Open Library entries in the current workspace with their reference:
 * a BAM linked to a plasmid map opens through Open plasmid dataset (map and
 * BAMs in one step, linked by sequence); a genome BAM loads its catalog
 * genome (or the FASTA its run used) first; plasmid maps load beside the
 * view. Reuses the normal loaders, as a finished DAF-seq run does.
 */
import { addDataset, getDatasets } from '../api/datasets';
import { withSample } from './datasetLabels';
import type { Dataset } from '../types';
import { useOpeningStore } from '../stores/openingStore';
import { datasetPanelShown, revealDatasetPanel } from './panelReveal';
import type { LibraryEntry } from '../api/library';
import { getStatus } from '../api/status';
import { loadFasta, loadGenome } from '../api/reference';
import { useBrowserStore } from '../stores/browserStore';
import { genomeLoadHasFasta } from './genomeAutoload';
import { basename, linkedMaps, openBlocker } from './library';
import { parseRegion } from './pipelineResults';
import { loadPlasmidFiles, openPlasmidDatasetFiles } from './plasmidLoader';
import { showLoadedReference } from './referenceNavigation';
import { ensureClusterRefsConnected } from './connectCluster';

export interface OpenResult {
  success: boolean;
  message?: string;
  error?: string;
}

export interface OpenPlan {
  plasmid: { map: LibraryEntry; bams: LibraryEntry[]; fasta?: string }[];
  maps: LibraryEntry[];
  genome: string | null;
  /** The entries' genome when it is not downloaded here (not loaded automatically). */
  genomeNotDownloaded: string | null;
  fasta: string | null;
  datasets: LibraryEntry[];
  region: string | null;
  skipped: { entry: LibraryEntry; reason: string }[];
}

const BLOCKED: Record<string, string> = {
  unavailable: 'not at its saved location',
  cloud: 'only in the cloud (make it available offline first)',
  kind: 'cannot be opened as a dataset',
};

/** What opening these entries does (pure: the order below is what runs). */
export function planOpen(selected: LibraryEntry[], all: LibraryEntry[], downloadedGenomes?: string[]): OpenPlan {
  const byId = new Map(all.map(e => [e.id, e]));
  const downloaded = downloadedGenomes ? new Set(downloadedGenomes) : null;
  const plan: OpenPlan = { plasmid: [], maps: [], genome: null, genomeNotDownloaded: null, fasta: null, datasets: [], region: null, skipped: [] };
  const plasmidByMap = new Map<string, { map: LibraryEntry; bams: LibraryEntry[]; fasta?: string }>();
  for (const entry of selected) {
    const blocker = openBlocker(entry);
    if (blocker) {
      plan.skipped.push({ entry, reason: BLOCKED[blocker] });
      continue;
    }
    if (entry.kind === 'plasmid_map') {
      if (!plasmidByMap.has(entry.id)) plan.maps.push(entry);
      continue;
    }
    const maps = entry.kind === 'bam' ? linkedMaps(entry, byId) : [];
    if (maps.length) {
      const map = maps[0];
      const slot = plasmidByMap.get(map.id) ?? { map, bams: [], fasta: entry.pipeline?.reference_fasta ?? undefined };
      slot.bams.push(entry);
      plasmidByMap.set(map.id, slot);
      plan.maps = plan.maps.filter(m => m.id !== map.id);
      continue;
    }
    plan.datasets.push(entry);
    const runGenome = entry.job?.reference?.genome_id || null;  // the genome the user ran against
    const genome = runGenome || entry.reference?.genome || null;
    if (genome && !plan.genome && !plan.genomeNotDownloaded) {
      // A genome recognised from chromosome lengths is loaded only when it is on
      // this computer: opening a file must not start a multi-GB download.
      if (runGenome || !downloaded || downloaded.has(genome)) plan.genome = genome;
      else plan.genomeNotDownloaded = genome;
    }
    const fasta = entry.pipeline?.open_fasta || null;
    if (!genome && fasta && !plan.fasta) plan.fasta = fasta;
    if (!plan.region && entry.pipeline?.region) plan.region = entry.pipeline.region;
  }
  plan.plasmid = [...plasmidByMap.values()];
  if (plan.genome) plan.fasta = null;
  return plan;
}

export function describeSkipped(plan: OpenPlan): string | null {
  if (!plan.skipped.length) return null;
  return plan.skipped.map(s => `${s.entry.label}: ${s.reason}`).join('\n');
}

const sameFile = (d: Dataset, path: string) => d.path === path || (d.paths ?? []).includes(path);

export interface OpenOptions {
  /** Called once placeholder panels are up (before anything is awaited; not when there are none): the Library window can close. */
  onStarted?: () => void;
}

/** Files being opened now: a second Open of one waits for the first (never two datasets of one file). */
const openingPaths = new Set<string>();
/** Tests: forget opens a test left unanswered. */
export function resetLibraryOpening(): void { openingPaths.clear(); }

export async function openLibraryEntries(selected: LibraryEntry[], all: LibraryEntry[], downloadedGenomes?: string[],
  options: OpenOptions = {}): Promise<OpenResult> {
  const busy = selected.filter(e => openingPaths.has(e.path));
  const todo = selected.filter(e => !openingPaths.has(e.path));
  const busyNote = busy.length ? `${busy.map(e => e.label).join(', ')} ${busy.length === 1 ? 'is' : 'are'} being opened already (its panel shows how far it is).` : '';
  if (!todo.length) return { success: false, error: busyNote };
  for (const e of todo) openingPaths.add(e.path);
  try {
    const res = await openEntries(todo, all, downloadedGenomes, options);
    return busyNote ? { ...res, error: [res.error, busyNote].filter(Boolean).join('\n') } : res;
  } catch (err) {
    // Whatever failed (a reference that could not load, the server gone): said, in the placeholders too.
    const error = `Could not open ${todo.map(e => e.label).join(', ')}: ${err instanceof Error ? err.message : String(err)}`;
    for (const e of todo) {
      if (useOpeningStore.getState().opening.some(o => o.key === e.path && !o.error)) useOpeningStore.getState().fail(e.path, error);
    }
    return { success: false, error };
  } finally {
    for (const e of todo) openingPaths.delete(e.path);
  }
}

async function openEntries(selected: LibraryEntry[], all: LibraryEntry[], downloadedGenomes: string[] | undefined,
  options: OpenOptions): Promise<OpenResult> {
  const plan = planOpen(selected, all, downloadedGenomes);
  const errors: string[] = [];
  const opened: string[] = [];
  const opening = useOpeningStore.getState();

  // Each file shows at once as a placeholder panel (its name and what the open is doing), before
  // the cluster connect, the reference load and the server's own checks; its real panel replaces it.
  // One already shown on screen needs none (it is pointed at below).
  const placeholders = plan.datasets.filter(entry => {
    const known = useBrowserStore.getState().datasets.find(d => sameFile(d, entry.path));
    return !(known && datasetPanelShown(known.id));
  });
  const keys = placeholders.map(e => e.path);
  if (placeholders.length) {
    opening.begin(placeholders.map(e => ({ key: e.path, label: e.label_override || e.sample || e.label, stage: 'Opening…' })),
      () => { void openLibraryEntries(placeholders, all, downloadedGenomes); });
  }
  if (placeholders.length) options.onStarted?.();
  const failAll = (error: string) => { for (const key of keys) useOpeningStore.getState().fail(key, error); };

  // Files on a cluster (ssh:// references): connect to their host first.
  const refs = [...plan.datasets, ...plan.maps, ...plan.plasmid.flatMap(p => [p.map, ...p.bams])].map(e => e.path);
  if (refs.some(r => r.includes('://'))) useOpeningStore.getState().stage(keys, 'Connecting to the cluster…');
  if (!(await ensureClusterRefsConnected(refs, 'The Library'))) {
    const error = 'Not connected to the cluster, so nothing was opened. Use Connect to cluster… and try again.';
    failAll(error);
    return { success: false, error };
  }

  for (const { map, bams, fasta } of plan.plasmid) {
    const res = await openPlasmidDatasetFiles(map.path, bams.map(b => b.path), fasta);
    if (res.success) opened.push(`${bams.map(b => b.sample || b.label).join(', ')} on ${basename(map.path)}`);
    else errors.push(res.error || `Could not open ${basename(map.path)}`);
  }
  if (plan.maps.length) {
    const res = await loadPlasmidFiles(plan.maps.map(m => m.path), 'beside');
    if (res.loaded.length) opened.push(...res.loaded.map(m => m.name || 'plasmid map'));
    if (!res.success) errors.push(res.error || 'Could not load the plasmid map');
    else if (res.failed) errors.push(`${res.failed} plasmid map(s) could not be loaded`);
  }

  const store = useBrowserStore.getState();
  // Soon after start-up the page may not know yet which genome the server has loaded (its own
  // start-up load is still under way): ask, rather than loading that genome a second time.
  let serverGenome: string | null | undefined;
  if (plan.genome && store.currentGenome !== plan.genome) {
    try { serverGenome = (await getStatus()).current_genome ?? null; } catch { serverGenome = undefined; }
  }
  if (plan.genome && store.currentGenome !== plan.genome && serverGenome === plan.genome) {
    store.setCurrentGenome(plan.genome);
    store.setFastaPath(null);
    await showLoadedReference();
  } else if (plan.genome && store.currentGenome !== plan.genome) {
    useOpeningStore.getState().stage(keys, `Loading the reference ${plan.genome}…`);
    const res = await loadGenome(plan.genome);
    if (!res.success) errors.push(res.fasta_error || res.gtf_error || `Could not load ${plan.genome}`);
    else {
      store.setHasFasta(genomeLoadHasFasta(res));
      store.setFastaPath(null);
      store.setCurrentGenome(plan.genome);
      await showLoadedReference();
    }
  } else if (plan.fasta && store.fastaPath !== plan.fasta) {
    useOpeningStore.getState().stage(keys, 'Loading its reference FASTA…');
    const res = await loadFasta(plan.fasta);
    if (!res.success) errors.push(res.error || 'Could not load the reference FASTA');
    else {
      store.setHasFasta(true);
      store.setFastaPath(res.path || plan.fasta);
      store.setCurrentGenome(res.inferred_genome ?? null);
      await showLoadedReference();
    }
  }

  // What the server has open now (the page's list can be stale: a server restarted under it).
  let serverDatasets: Dataset[] | null = null;
  if (plan.datasets.length) {
    try { serverDatasets = (await getDatasets()).datasets ?? []; } catch { serverDatasets = null; }
  }
  const hadDatasets = useBrowserStore.getState().datasets.length > 0;
  const revealed: string[] = [];
  for (const entry of plan.datasets) {
    const inStore = useBrowserStore.getState().datasets.find(d => sameFile(d, entry.path));
    const onServer = serverDatasets ? serverDatasets.find(d => sameFile(d, entry.path)) : inStore;
    if (onServer) {
      // Open already (perhaps folded away by a split, minimized, behind a full view): show it. The server's
      // dataset is the one (after a restart it may have another id than the page's stale entry).
      if (inStore && serverDatasets && inStore.id !== onServer.id) useBrowserStore.getState().removeDataset(inStore.id);
      revealDatasetPanel(serverDatasets ? onServer : (inStore ?? onServer));
      useOpeningStore.getState().done(entry.path);
      revealed.push(entry.label);
      continue;
    }
    // The page lists it but the server has no such dataset: the page's entry is stale; open it afresh.
    if (inStore) useBrowserStore.getState().removeDataset(inStore.id);
    useOpeningStore.getState().stage([entry.path], 'Checking the file and reading its index…');
    // One name rule however a BAM is opened (N9): the file stem (the server's default, as with -b or Open file), or
    // the name the user gave it in the Library; the sample name (@RG SM) goes second, in tooltips. Ids are unchanged.
    const label = entry.label_override || undefined;
    let res: Awaited<ReturnType<typeof addDataset>>;
    try {
      res = await addDataset(entry.path, label);
    } catch (err) {
      res = { success: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (res.success && res.dataset) {
      useBrowserStore.getState().addDataset(withSample(res.dataset, entry.sample));
      useOpeningStore.getState().done(entry.path);
      opened.push(entry.label);
    } else {
      const error = res.error || 'could not load';
      useOpeningStore.getState().fail(entry.path, error);
      errors.push(`${entry.label}: ${error}`);
    }
  }
  // An open that stopped before reaching a file (a reference that failed to load) says so in its placeholder.
  const reason = errors[0];
  for (const key of keys) {
    if (useOpeningStore.getState().opening.some(o => o.key === key && !o.error)) {
      if (reason) useOpeningStore.getState().fail(key, reason);
      else useOpeningStore.getState().done(key);
    }
  }

  const region = parseRegion(plan.region);
  if (region) useBrowserStore.getState().setViewport(region.chrom, region.start, region.end);
  else if (plan.datasets.length && !hadDatasets && !plan.genome && !plan.fasta) {
    try {
      const status = await getStatus();
      if (status.initial_position) {
        useBrowserStore.getState().setViewport(status.initial_position.chrom, status.initial_position.start, status.initial_position.end);
      }
    } catch { /* keep the current view */ }
  }
  if (plan.datasets.length) useBrowserStore.getState().triggerRefresh();

  const skipped = describeSkipped(plan);
  if (skipped) errors.push(skipped);
  const hint = plan.genomeNotDownloaded && useBrowserStore.getState().currentGenome !== plan.genomeNotDownloaded
    ? ` These reads are on ${plan.genomeNotDownloaded}, which is not downloaded here: load it in Reference & Tracks for sequence and genes.`
    : '';
  const shownNote = revealed.length ? `${revealed.join('; ')} ${revealed.length === 1 ? 'was' : 'were'} already open: shown.` : '';
  const openedNote = opened.length ? `Opened ${opened.join('; ')}.${hint}` : '';
  const message = [openedNote, shownNote].filter(Boolean).join(' ') || undefined;
  if (errors.length) return { success: opened.length + revealed.length > 0, error: errors.join('\n'), message };
  return { success: true, message: message ?? 'Nothing to open.' };
}
