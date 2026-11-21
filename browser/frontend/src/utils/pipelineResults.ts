/**
 * Open a finished fiberhmm-pipeline run in the current workspace, as its
 * outputs.json "open" says: the reference (catalog genome, FASTA, or the
 * plasmid map linked to its BAMs), the called BAM(s), and the region.
 * Reuses the normal loaders (genome selector, Load File, Open plasmid dataset).
 *
 * A genome already open is never replaced: a result on another reference opens
 * in its own panel with that reference (as "Open with … in its own panel" in the
 * genome-mismatch banner does), and the open genome stays.
 */
import { markJobOpened, type PipelineJob } from '../api/pipeline';
import { addDataset } from '../api/datasets';
import { getGenomeCheck } from '../api/genomeCheck';
import { withSample } from './datasetLabels';
import { getStatus } from '../api/status';
import { loadFasta, loadGenome } from '../api/reference';
import { useBrowserStore } from '../stores/browserStore';
import { usePanelGenomeStore } from '../stores/panelGenomeStore';
import { isOwnRun } from './labServer';
import { genomeLoadHasFasta } from './genomeAutoload';
import { loadPlasmidFiles, openPlasmidDatasetFiles } from './plasmidLoader';
import { showLoadedReference } from './referenceNavigation';

export { pageOpenerId } from './pageOpener';

/**
 * The finished run this page should open by itself now, if any: it asked to be opened, this page
 * started it (its opener token), it has not been opened anywhere (the server's ``opened_at``), and this
 * page has not already asked to open it (``asked``). The server grants the claim once (POST .../opened).
 */
export function autoOpenCandidate(jobs: PipelineJob[], opener: string, asked: ReadonlySet<string>): PipelineJob | null {
  return jobs.find(j => j.status === 'done' && j.auto_open && !!j.outputs && !j.opened_at && !!j.opener
    && j.opener === opener && !asked.has(j.id) && isOwnRun(j)) ?? null;
}

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

function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

type OpenResult = { success: boolean; error?: string; message?: string; ownPanel?: boolean };

// One open per job at a time: the automatic open and an "Open in browser"
// click must not both add the BAM.
const inFlight = new Map<string, Promise<OpenResult>>();

/**
 * Open a run's result. ``claimed``: the automatic opening already recorded it on the server; otherwise
 * (Open in browser) it is recorded here, so no page opens it automatically afterwards.
 */
export function openJobResult(job: PipelineJob, options: { claimed?: boolean } = {}): Promise<OpenResult> {
  const running = inFlight.get(job.id);
  if (running) return running;
  if (!options.claimed) void markJobOpened(job.id).catch(() => { /* the opening matters, not the record */ });
  const promise = openJobResultOnce(job).finally(() => inFlight.delete(job.id));
  inFlight.set(job.id, promise);
  return promise;
}

/** A reference is open in the main view (a catalog genome or a FASTA; plasmid maps alone are not one). */
function mainReferenceOpen(): boolean {
  const s = useBrowserStore.getState();
  return Boolean(s.fastaPath || (s.currentGenome && s.currentGenome !== 'plasmids') || s.hasFasta);
}

async function addRunDatasets(job: PipelineJob, datasets: string[]): Promise<{ added: string[]; errors: string[] }> {
  const loaded = new Set(useBrowserStore.getState().datasets.flatMap(d => [d.path, ...(d.paths ?? [])]));
  const errors: string[] = [];
  const added: string[] = [];
  for (const path of datasets) {
    if (loaded.has(path)) continue;
    // The file stem names it, as every other way of opening a BAM; the run's sample goes second (N9).
    const res = await addDataset(path);
    if (res.success && res.dataset) {
      useBrowserStore.getState().addDataset(withSample(res.dataset, datasets.length === 1 ? job.sample : undefined));
      added.push(res.dataset.id);
    } else errors.push(`${basename(path)}: ${res.error || 'could not load'}`);
  }
  return { added, errors };
}

/**
 * The result's datasets on a reference other than the one open: added, then each that does not fit the
 * open genome (the server's genome check) gets the run's reference in its own panel. The open genome stays.
 */
async function openBesideOpenGenome(job: PipelineJob, datasets: string[], reference: { genome_id: string } | { fasta_path: string }): Promise<OpenResult> {
  const { added, errors } = await addRunDatasets(job, datasets);
  let ownPanel = false;
  if (added.length) {
    let fits = new Set<string>();
    try {
      const check = await getGenomeCheck();
      fits = new Set((check.datasets ?? []).filter(d => d.status === 'match').map(d => d.dataset_id));
    } catch { /* unknown: give them their own reference */ }
    const others = added.filter(id => !fits.has(id));
    if (others.length) {
      const res = await usePanelGenomeStore.getState().attach({ dataset_ids: others, ...reference }, { perPanel: others.length === 1 });
      if (!res.success) errors.push(res.error || 'Could not load the run\'s reference in its own panel');
      else ownPanel = true;
    }
  }
  // All on the open genome after all (e.g. a copy of the same FASTA): the main view goes to the region.
  const region = parseRegion(job.outputs?.open?.region);
  if (!ownPanel && region) useBrowserStore.getState().setViewport(region.chrom, region.start, region.end);
  useBrowserStore.getState().triggerRefresh();
  if (errors.length) return { success: false, error: errors.join('\n') };
  return { success: true, ownPanel, message: ownPanel ? `Opened ${job.sample} with its own reference in its own panel.` : `Opened ${job.sample}.` };
}

async function openJobResultOnce(job: PipelineJob): Promise<OpenResult> {
  const outputs = job.outputs;
  if (!outputs) return { success: false, error: 'This run has no results to open.' };
  const open = outputs.open ?? { fasta: null, datasets: [], plasmid_maps: [], region: null };
  const datasets = open.datasets?.length ? open.datasets : (outputs.called_bam ? [outputs.called_bam] : []);

  // A plasmid run: the map and its BAM(s) in one step, linked by sequence (added beside the open genome).
  if (open.plasmid_maps?.length) {
    const [first, ...rest] = open.plasmid_maps;
    const result = await openPlasmidDatasetFiles(first, datasets, outputs.reference_fasta ?? undefined);
    if (!result.success) return { success: false, error: result.error };
    if (rest.length) await loadPlasmidFiles(rest, 'beside');
    return { success: true, message: `Opened ${job.sample} on ${basename(first)}.` };
  }

  const store = useBrowserStore.getState();
  const genomeId = job.reference?.genome_id;
  const sameReference = genomeId ? store.currentGenome === genomeId : !open.fasta || store.fastaPath === open.fasta;
  if (!sameReference && mainReferenceOpen()) {
    // Never replace the genome that is open.
    return openBesideOpenGenome(job, datasets, genomeId ? { genome_id: genomeId } : { fasta_path: open.fasta as string });
  }
  if (genomeId && !sameReference) {
    // Nothing open yet: as the genome selector does, sequence and annotations of the catalog genome.
    const res = await loadGenome(genomeId);
    if (!res.success) return { success: false, error: res.fasta_error || res.gtf_error || `Could not load ${genomeId}` };
    store.setHasFasta(genomeLoadHasFasta(res));
    store.setFastaPath(null);
    store.setCurrentGenome(genomeId);
    await showLoadedReference();
  } else if (!genomeId && open.fasta && !sameReference) {
    const res = await loadFasta(open.fasta);
    if (!res.success) return { success: false, error: res.error || 'Could not load the reference FASTA' };
    store.setHasFasta(true);
    store.setFastaPath(res.path || open.fasta);
    store.setCurrentGenome(res.inferred_genome ?? null);
    await showLoadedReference();
  }

  const { errors } = await addRunDatasets(job, datasets);
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
