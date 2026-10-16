/**
 * Open a finished fiberhmm-pipeline run in the current workspace, as its
 * outputs.json "open" says: the reference (catalog genome, FASTA, or the
 * plasmid map linked to its BAMs), the called BAM(s), and the region.
 * Reuses the normal loaders (genome selector, Load File, Open plasmid dataset).
 */
import type { PipelineJob } from '../api/pipeline';
import { addDataset } from '../api/datasets';
import { withSample } from './datasetLabels';
import { getStatus } from '../api/status';
import { loadFasta, loadGenome } from '../api/reference';
import { useBrowserStore } from '../stores/browserStore';
import { genomeLoadHasFasta } from './genomeAutoload';
import { loadPlasmidFiles, openPlasmidDatasetFiles } from './plasmidLoader';
import { showLoadedReference } from './referenceNavigation';

const OPENED_KEY = 'fiberbrowser.dafRun.opened';

/**
 * The viewport for a pipeline region. fiberhmm-pipeline writes regions
 * one-based and inclusive (``format_region(chrom, start0, end)`` gives
 * ``chrom:start0+1-end``); the viewport is zero-based, end-exclusive.
 */
export function parseRegion(region: string | null | undefined): { chrom: string; start: number; end: number } | null {
  const m = String(region ?? '').replace(/,/g, '').match(/^([^\s:]+):(\d+)-(\d+)$/);
  if (!m) return null;
  const start = Number(m[2]);
  const end = Number(m[3]);
  return start >= 1 && end >= start ? { chrom: m[1], start: start - 1, end } : null;
}

/** Jobs whose result this browser already opened (auto-open happens once). */
export function openedJobs(): Set<string> {
  try {
    const raw = window.localStorage.getItem(OPENED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

export function markJobOpened(id: string): void {
  try {
    const ids = [...openedJobs(), id].slice(-200);
    window.localStorage.setItem(OPENED_KEY, JSON.stringify(ids));
  } catch { /* storage unavailable: auto-open may repeat */ }
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

type OpenResult = { success: boolean; error?: string; message?: string };

// One open per job at a time: the automatic open and an "Open in browser"
// click must not both add the BAM.
const inFlight = new Map<string, Promise<OpenResult>>();

export function openJobResult(job: PipelineJob): Promise<OpenResult> {
  const running = inFlight.get(job.id);
  if (running) return running;
  const promise = openJobResultOnce(job).finally(() => inFlight.delete(job.id));
  inFlight.set(job.id, promise);
  return promise;
}

async function openJobResultOnce(job: PipelineJob): Promise<OpenResult> {
  const outputs = job.outputs;
  if (!outputs) return { success: false, error: 'This run has no results to open.' };
  const open = outputs.open ?? { fasta: null, datasets: [], plasmid_maps: [], region: null };
  const datasets = open.datasets?.length ? open.datasets : (outputs.called_bam ? [outputs.called_bam] : []);
  markJobOpened(job.id);

  // A plasmid run: the map and its BAM(s) in one step, linked by sequence.
  if (open.plasmid_maps?.length) {
    const [first, ...rest] = open.plasmid_maps;
    const result = await openPlasmidDatasetFiles(first, datasets, outputs.reference_fasta ?? undefined);
    if (!result.success) return { success: false, error: result.error };
    if (rest.length) await loadPlasmidFiles(rest, 'beside');
    return { success: true, message: `Opened ${job.sample} on ${basename(first)}.` };
  }

  const store = useBrowserStore.getState();
  const genomeId = job.reference?.genome_id;
  if (genomeId) {
    if (store.currentGenome !== genomeId) {
      // As the genome selector does: sequence and annotations of the catalog genome.
      const res = await loadGenome(genomeId);
      if (!res.success) return { success: false, error: res.fasta_error || res.gtf_error || `Could not load ${genomeId}` };
      store.setHasFasta(genomeLoadHasFasta(res));
      store.setFastaPath(null);
      store.setCurrentGenome(genomeId);
      await showLoadedReference();
    }
  } else if (open.fasta && store.fastaPath !== open.fasta) {
    const res = await loadFasta(open.fasta);
    if (!res.success) return { success: false, error: res.error || 'Could not load the reference FASTA' };
    store.setHasFasta(true);
    store.setFastaPath(res.path || open.fasta);
    store.setCurrentGenome(res.inferred_genome ?? null);
    await showLoadedReference();
  }

  const loaded = new Set(useBrowserStore.getState().datasets.flatMap(d => [d.path, ...(d.paths ?? [])]));
  const errors: string[] = [];
  for (const path of datasets) {
    if (loaded.has(path)) continue;
    // The file stem names it, as every other way of opening a BAM; the run's sample goes second (N9).
    const res = await addDataset(path);
    if (res.success && res.dataset) useBrowserStore.getState().addDataset(withSample(res.dataset, datasets.length === 1 ? job.sample : undefined));
    else errors.push(`${basename(path)}: ${res.error || 'could not load'}`);
  }

  const region = parseRegion(open.region);
  if (region) useBrowserStore.getState().setViewport(region.chrom, region.start, region.end);
  else if (!genomeId && !open.fasta) {
    // No region given: the start position the server suggests for these reads.
    try {
      const status = await getStatus();
      if (status.initial_position) {
        useBrowserStore.getState().setViewport(status.initial_position.chrom, status.initial_position.start, status.initial_position.end);
      }
    } catch { /* keep the current view */ }
  }
  useBrowserStore.getState().triggerRefresh();
  if (errors.length) return { success: false, error: errors.join('\n') };
  return { success: true, message: `Opened ${job.sample}.` };
}
