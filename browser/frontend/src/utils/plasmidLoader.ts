import {
  getChromosomes,
  loadPlasmid,
  loadPlasmids,
  openPlasmidDataset,
  type PlasmidLink,
  type PlasmidLoadResult,
  type PlasmidProblem,
} from '../api/reference';
import { getDatasetsWithContig } from '../api/datasets';
import { pickAnyFile } from '../api/files';
import { useBrowserStore } from '../stores/browserStore';
import { findChromInfo } from './chromAliases';
import { formatBp } from './coordinates';
import type { ChromInfo, Dataset } from '../types';

// Plasmid-map formats that are unambiguous (no other handler in the file-load
// dispatch claims them). FASTA/GFF/BED are intentionally excluded — those load
// as reference sequence / annotation tracks, not as supplemental plasmids.
export const PLASMID_MAP_EXTS = ['dna', 'gb', 'gbk', 'genbank', 'embl', 'emb', 'sbol', 'rdf', 'ttl'];

export function isPlasmidMapPath(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  return PLASMID_MAP_EXTS.includes(ext);
}

export function isPlasmidChrom(chrom: ChromInfo | undefined): boolean {
  return Boolean(chrom?.plasmid) || chrom?.circular_source === 'plasmid_map';
}

/**
 * Where a newly loaded plasmid opens:
 * - 'beside': a copy of the selected (or first) dataset panel, at the plasmid,
 *   next to it; the main view stays where it is.
 * - 'main': the main view moves to the plasmid.
 * - 'auto': beside when the main view is showing datasets on the genome,
 *   otherwise main (nothing to keep, or already on a plasmid).
 */
export type PlasmidPlacement = 'auto' | 'beside' | 'main';

export async function showContig(name: string, length: number, placement: PlasmidPlacement = 'auto'): Promise<'beside' | 'main'> {
  const store = useBrowserStore.getState();
  const end = Math.min(20_000, Math.max(1, length));
  const mainPanels = store.panels.filter(p => p.contentType === 'dataset' && p.datasetId && !p.viewportOverride && !p.collapsed);
  const onPlasmid = isPlasmidChrom(findChromInfo(store.chroms, store.chrom));
  const mode = placement === 'auto'
    ? (mainPanels.length > 0 && !onPlasmid && store.chrom !== name ? 'beside' : 'main')
    : placement;
  if (mode === 'beside' && mainPanels.length > 0) {
    // Copies of the panels whose datasets have reads on this contig; else of
    // the selected (or first) panel.
    let withReads: Set<string> = new Set();
    try {
      withReads = new Set((await getDatasetsWithContig(name)).dataset_ids);
    } catch {
      // older server: fall back to the selected/first panel
    }
    const sources: typeof mainPanels = [];
    for (const p of mainPanels) {
      if (withReads.has(p.datasetId!) && !sources.some(s => s.datasetId === p.datasetId)) sources.push(p);
    }
    if (sources.length === 0) sources.push(mainPanels.find(p => store.selectedDatasets.has(p.id)) ?? mainPanels[0]);
    // A maximized panel would hide the copies.
    if (useBrowserStore.getState().fullViewPanelId) useBrowserStore.getState().setFullViewPanel(null);
    let opened = 0;
    for (const source of sources) {
      const copy = useBrowserStore.getState().openPanelAtSite(source.id);
      if (!copy) continue;
      useBrowserStore.getState().navigatePanel(copy, name, 0, end);
      opened += 1;
    }
    if (opened > 0) return 'beside';
  }
  store.setViewport(name, 0, end);
  return 'main';
}

export interface PlasmidLoadSummary {
  success: boolean;
  error?: string;
  count: number;
  loaded: PlasmidLoadResult[];
  failed: number;
  /** Each map that could not be loaded, with why. */
  failures?: Array<{ path: string; error: string }>;
  shownAs?: 'beside' | 'main';
  /** Loaded BAMs whose contigs are these maps' sequences (renamed or rotated). */
  links?: PlasmidLink[];
  /** Loaded plasmid BAMs whose contigs are not (what differs). */
  problems?: PlasmidProblem[];
}

/**
 * Load one or more plasmid maps as supplemental chromosomes, refresh the
 * chromosome list, and show the first one (see showContig).
 */
export async function loadPlasmidFiles(paths: string[], placement: PlasmidPlacement = 'auto'): Promise<PlasmidLoadSummary> {
  if (paths.length === 0) return { success: false, error: 'No plasmid files', count: 0, loaded: [], failed: 0 };

  const loaded: PlasmidLoadResult[] = [];
  const errors: string[] = [];
  const failures: Array<{ path: string; error: string }> = [];
  let links: PlasmidLink[] = [];
  let problems: PlasmidProblem[] = [];

  if (paths.length === 1) {
    const r = await loadPlasmid(paths[0]);
    if (r.success && r.name && r.length) loaded.push(r);
    else {
      errors.push(r.error || 'Failed to load plasmid map');
      failures.push({ path: paths[0], error: r.error || 'Failed to load plasmid map' });
    }
    links = r.links ?? [];
    problems = r.problems ?? [];
  } else {
    const r = await loadPlasmids(paths);
    for (const item of r.loaded || []) {
      if (item.success && item.name && item.length) loaded.push(item);
    }
    for (const item of r.errors || []) {
      errors.push(item?.error || 'Failed to load plasmid map');
      failures.push({ path: item?.path ?? '', error: item?.error || 'Failed to load plasmid map' });
    }
    links = r.links ?? [];
    problems = r.problems ?? [];
  }

  if (loaded.length === 0) {
    return { success: false, error: errors[0] || 'Failed to load plasmid map', count: 0, loaded, failed: errors.length, failures };
  }

  const store = useBrowserStore.getState();
  const chromResult = await getChromosomes();
  store.setChroms(chromResult.chroms);
  store.setHasFasta(true);
  const currentGenome = loaded.find(item => item.current_genome)?.current_genome;
  if (currentGenome) store.setCurrentGenome(currentGenome);
  if (links.length > 0) store.triggerRefresh();
  // Show where the reads are: a map linked to a BAM (else the first map).
  const first = loaded.find(item => links.some(link => link.chrom === item.name)) ?? loaded[0];
  const shownAs = await showContig(first.name!, first.length!, placement);
  const problemText = plasmidProblemsMessage(problems);
  if (problemText) useBrowserStore.getState().setError(problemText);

  return { success: true, error: errors[0], count: loaded.length, loaded, failed: errors.length, failures, shownAs, links, problems };
}

// ---------------------------------------------------------------------------
// Map <-> BAM links (the server matches contigs to maps by sequence)
// ---------------------------------------------------------------------------

const BAM_EXTS = ['bam'];
const FASTA_EXTS = ['fa', 'fasta', 'fna', 'fas'];

function extensionOf(path: string): string {
  const base = path.split(/[\\/]/).pop()?.toLowerCase() || '';
  const stripped = base.endsWith('.gz') ? base.slice(0, -3) : base;
  return stripped.split('.').pop() || '';
}

export interface PlasmidDatasetFiles {
  maps: string[];
  bams: string[];
  fastas: string[];
  other: string[];
}

/** Sort a multi-file pick into plasmid maps, BAMs and reference FASTAs. */
export function classifyPlasmidDatasetPaths(paths: string[]): PlasmidDatasetFiles {
  const out: PlasmidDatasetFiles = { maps: [], bams: [], fastas: [], other: [] };
  for (const path of paths) {
    const ext = extensionOf(path);
    if (isPlasmidMapPath(path)) out.maps.push(path);
    else if (BAM_EXTS.includes(ext)) out.bams.push(path);
    else if (FASTA_EXTS.includes(ext)) out.fastas.push(path);
    else out.other.push(path);
  }
  return out;
}

const METHOD_TEXT: Record<string, string> = {
  m5: 'same M5 checksum',
  reference: 'checked against its reference FASTA',
  reads: 'checked with its reads',
  header: 'declared in the BAM header',
  name: 'same name (sequence not checked)',
  confirmed: 'linked by you (sequence not checked)',
  session: 'from the session',
};

/** One line per link: "EF34GH: D_orirot → D (origin shifted 295 bp; checked against its reference FASTA)". */
export function plasmidLinkSummary(link: PlasmidLink): string {
  const who = link.dataset_label || link.dataset_id;
  const shown = link.contig === link.chrom ? link.chrom : `${link.contig} → ${link.chrom}`;
  const notes = [
    link.offset ? `origin shifted ${formatBp(link.offset)}` : '',
    METHOD_TEXT[link.method] || link.method,
  ].filter(Boolean);
  return `${who}: ${shown} (${notes.join('; ')})`;
}

/** The problems as one message for the error banner (null when there are none). */
export function plasmidProblemsMessage(problems: PlasmidProblem[] | undefined | null): string | null {
  const lines: string[] = [];
  for (const problem of problems ?? []) {
    const who = problem.dataset_label || problem.dataset_id;
    const line = who ? `${who}: ${problem.message}` : problem.message;
    if (!lines.includes(line)) lines.push(line);
  }
  if (lines.length === 0) return null;
  const confirmable = (problems ?? []).some(p => p.can_confirm);
  const tail = confirmable ? '\nTo link one anyway, open Regions on the plasmid and use Link anyway.' : '';
  return lines.join('\n') + tail;
}

// Datasets whose plasmid report was already acted on (by openPlasmidDatasetFiles
// or the watcher), so a dataset is announced once.
const handledPlasmidDatasets = new Set<string>();

async function refreshChromsAfterLinks(): Promise<ChromInfo[]> {
  const store = useBrowserStore.getState();
  const chromResult = await getChromosomes();
  store.setChroms(chromResult.chroms);
  if (chromResult.chroms.some(c => c.plasmid)) store.setHasFasta(true);
  // Linking can rotate a map into the BAM's frame: its features and sequence change.
  store.triggerRefresh();
  return chromResult.chroms;
}

export interface OpenPlasmidDatasetSummary {
  success: boolean;
  error?: string;
  chrom?: string;
  links: PlasmidLink[];
  problems: PlasmidProblem[];
  datasets: Dataset[];
}

/**
 * The one-step flow: a plasmid map plus the BAM(s) aligned to it (and, if the
 * BAM does not name it, the FASTA they were aligned to). The server loads both
 * and links each BAM contig that is the map's sequence, whatever its name or
 * origin; the reads open on the plasmid in the main view.
 */
export async function openPlasmidDatasetFiles(mapPath: string, bamPaths: string[], referenceFasta?: string): Promise<OpenPlasmidDatasetSummary> {
  const res = await openPlasmidDataset(mapPath, bamPaths, referenceFasta);
  if (!res.success) {
    return { success: false, error: res.error || res.errors?.[0]?.error || 'Could not open the plasmid dataset', links: [], problems: [], datasets: [] };
  }
  const store = useBrowserStore.getState();
  const known = new Set(store.datasets.map(d => d.id));
  for (const dataset of res.datasets ?? []) {
    handledPlasmidDatasets.add(dataset.id);
    if (!known.has(dataset.id)) useBrowserStore.getState().addDataset(dataset);
  }
  const chroms = await refreshChromsAfterLinks();
  if (res.current_genome) useBrowserStore.getState().setCurrentGenome(res.current_genome);
  const chrom = res.chrom || res.plasmid?.name;
  const info = chrom ? findChromInfo(chroms, chrom) : undefined;
  if (chrom && info) await showContig(chrom, info.size, 'main');
  // The circular map, with the links (and Link anyway for the unchecked ones).
  useBrowserStore.getState().openAnalysisPanel('circular-genome');
  const problems = res.problems ?? [];
  const failed = (res.errors ?? []).map(e => `${e.path.split(/[\\/]/).pop()}: ${e.error}`);
  const message = [plasmidProblemsMessage(problems), ...failed].filter(Boolean).join('\n');
  if (message) useBrowserStore.getState().setError(message);
  return { success: true, chrom, links: res.links ?? [], problems, datasets: res.datasets ?? [] };
}

async function pickPaths(): Promise<string[] | null> {
  const picked = await pickAnyFile();
  if (!picked.success) return null;
  return picked.paths?.length ? picked.paths : (picked.path ? [picked.path] : []);
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/**
 * "Open plasmid dataset…": pick the map and its BAM(s) (and optionally the
 * FASTA they were aligned to) in one dialog; a missing piece is asked for
 * next. ``onStatus`` gets progress and the result line.
 */
export async function pickAndOpenPlasmidDataset(onStatus: (message: string | null) => void): Promise<OpenPlasmidDatasetSummary | null> {
  onStatus(null);
  const first = await pickPaths();
  if (!first) return null;
  let files = classifyPlasmidDatasetPaths(first);
  if (files.maps.length === 0 && files.bams.length > 0) {
    onStatus('Now choose the plasmid map (.dna, .gb, .gbk, .embl, SBOL) the reads belong to.');
    const more = await pickPaths();
    if (!more) return null;
    files = classifyPlasmidDatasetPaths([...first, ...more]);
  } else if (files.maps.length > 0 && files.bams.length === 0) {
    onStatus(`Now choose the BAM file(s) aligned to ${basename(files.maps[0])}.`);
    const more = await pickPaths();
    if (!more) return null;
    files = classifyPlasmidDatasetPaths([...first, ...more]);
  }
  if (files.maps.length === 0) {
    onStatus(`Choose a plasmid map (${PLASMID_MAP_EXTS.slice(0, 5).map(e => `.${e}`).join(', ')}, …) and its BAM file(s).`);
    return null;
  }
  if (files.maps.length > 1) {
    onStatus('Choose one plasmid map at a time (with its BAM files).');
    return null;
  }
  if (files.bams.length === 0) {
    onStatus(`Choose the BAM file(s) aligned to ${basename(files.maps[0])} (sorted and indexed).`);
    return null;
  }
  onStatus(`Opening ${basename(files.maps[0])} with ${files.bams.length} BAM${files.bams.length === 1 ? '' : 's'}…`);
  const result = await openPlasmidDatasetFiles(files.maps[0], files.bams, files.fastas[0]);
  if (!result.success) {
    onStatus(result.error || 'Could not open the plasmid dataset');
    return result;
  }
  const linked = new Set(result.links.map(link => link.dataset_id)).size;
  const total = result.datasets.length;
  const parts = [
    `${result.chrom}: ${linked} of ${total} BAM${total === 1 ? '' : 's'} linked`,
    ...result.links.map(plasmidLinkSummary),
  ];
  if (result.problems.length > 0) parts.push(`${result.problems.length} not linked (see message)`);
  onStatus(parts.join(' · '));
  return result;
}

/** What to do for a dataset the server linked to a plasmid map when it loaded. */
export function plasmidReportNeedsRefresh(dataset: Dataset): boolean {
  const report = dataset.plasmid;
  if (!report) return false;
  return (report.links?.length ?? 0) > 0 || (report.maps_loaded ?? []).some(m => m.success);
}

async function handleLoadedDataset(dataset: Dataset): Promise<void> {
  const report = dataset.plasmid;
  if (!report) return;
  const store = useBrowserStore.getState();
  if (plasmidReportNeedsRefresh(dataset)) {
    const chroms = await refreshChromsAfterLinks();
    const target = report.links?.[0]?.chrom
      ?? report.maps_loaded?.find(m => m.success && m.name)?.name;
    const current = useBrowserStore.getState().chrom;
    const currentGone = !findChromInfo(chroms, current);
    const autoLoaded = (report.maps_loaded ?? []).some(m => m.success);
    const info = target ? findChromInfo(chroms, target) : undefined;
    // The BAM's own contig became the map (or the BAM brought its map): show it.
    if (target && info && (currentGone || autoLoaded)) await showContig(target, info.size, currentGone ? 'main' : 'auto');
  }
  const failedMaps = (report.maps_loaded ?? []).filter(m => !m.success).map(m => m.error || `Could not load ${m.path}`);
  const message = [plasmidProblemsMessage(report.problems), ...failedMaps].filter(Boolean).join('\n');
  if (message) store.setError(message);
}

/**
 * Datasets loaded any way (Load File, drag and drop, by path, sessions) carry
 * the server's plasmid report: refresh the chromosomes when a BAM was linked to
 * a map (or brought its map), and say why a plasmid BAM was not. Returns the
 * unsubscribe function.
 */
export function installPlasmidLinkWatcher(): () => void {
  for (const dataset of useBrowserStore.getState().datasets) handledPlasmidDatasets.add(dataset.id);
  return useBrowserStore.subscribe((state, prev) => {
    if (state.datasets === prev.datasets) return;
    // A removed dataset is forgotten: loading the same file again is announced again.
    const present = new Set(state.datasets.map(d => d.id));
    for (const id of Array.from(handledPlasmidDatasets)) if (!present.has(id)) handledPlasmidDatasets.delete(id);
    for (const dataset of state.datasets) {
      if (handledPlasmidDatasets.has(dataset.id)) continue;
      handledPlasmidDatasets.add(dataset.id);
      if (dataset.plasmid) void handleLoadedDataset(dataset);
    }
  });
}

/** For tests: forget which datasets were handled. */
export function resetPlasmidLinkWatcherForTests(): void {
  handledPlasmidDatasets.clear();
}
