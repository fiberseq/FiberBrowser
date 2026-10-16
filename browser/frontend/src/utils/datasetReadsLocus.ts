/**
 * Where to show a dataset's reads ("Go to reads", the first view of new data,
 * after loading the genome the data needs).
 *
 * The best-covered loci come from findTopLocus, narrowed to their reads
 * (`fit`) so an amplicon fills the view instead of being a sliver of a wide
 * window. With a read filter the user set (Min footprints), a locus whose reads
 * the filter hides would only show an empty panel again: the next loci are tried
 * first (a cheap one-read request each); when none keeps a read, the best
 * locus is used and the read track says the filter hides its reads.
 */
import { getCompactReads } from '../api/readOperations';
import { useBrowserStore } from '../stores/browserStore';
import { DEFAULT_MIN_FOOTPRINTS } from '../stores/uiSlice';
import { findTopLocus, isTopLocusStep, type TopLocusResult, type TopLocusStep } from './topLoci';

/** Loci probed for reads that pass the read filters before settling on the best one. */
export const FILTER_PROBES = 5;
/** One probe's time limit (ms): a stalled request counts as unknown, not as hidden. */
export const PROBE_TIMEOUT_MS = 15_000;

export interface DatasetReadsLocusOptions {
  signal?: AbortSignal;
  /** Narrow the locus to its reads (default true). */
  fit?: boolean;
}

/** Reads of `datasetId` in the window that the current read filters keep; null when unknown. */
export async function readsKeptByFilters(
  window: { chrom: string; start: number; end: number },
  datasetId: string,
  signal?: AbortSignal,
): Promise<number | null> {
  const s = useBrowserStore.getState();
  const params = new URLSearchParams({
    chrom: window.chrom,
    start: String(window.start),
    end: String(window.end),
    dataset_id: datasetId,
    max_reads: '1',
    spanning: 'false',
    include_methylation: 'false',
    include_layers: 'false',
    include_layer_qualities: 'false',
    include_duplicates: String(Boolean(s.showDuplicateReads)),
    min_footprints: String(Math.max(0, s.minFootprints || 0)),
  });
  // Its own deadline, and the caller's cancel: a stalled request never leaves
  // "Go to reads" (or a genome load) waiting.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await getCompactReads<{ total_overlapping?: number; total_in_scope?: number; total?: number }>(params, { signal: controller.signal });
    const n = res.total_overlapping ?? res.total_in_scope ?? res.total;
    return typeof n === 'number' ? n : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** The locus to show `datasetId`'s reads at (see the module comment). Never rejects. */
export async function findDatasetReadsLocus(
  datasetId: string,
  span: number,
  { signal, fit = true }: DatasetReadsLocusOptions = {},
): Promise<TopLocusResult> {
  const first = await findTopLocus(span, datasetId, { signal, fit });
  if (!isTopLocusStep(first)) return first;
  const { minFootprints, minFootprintsAuto } = useBrowserStore.getState();
  // No filter, or the untouched default: the best locus (the default turns
  // itself off there if it hides every read; see relaxDefaultMinFootprints).
  if ((minFootprints || 0) <= 0 || (minFootprintsAuto && minFootprints === DEFAULT_MIN_FOOTPRINTS)) return first;
  let step: TopLocusStep = first;
  for (let probe = 0; probe < FILTER_PROBES; probe++) {
    const kept = await readsKeptByFilters(step.window, datasetId, signal);
    if (signal?.aborted) return { window: null, reason: 'cancelled', message: 'Search cancelled.' };
    if (kept === null || kept > 0) return step;
    if (probe + 1 >= first.total) break;
    const next = await findTopLocus(span, datasetId, { signal, fit });
    if (!isTopLocusStep(next)) return next.reason === 'cancelled' ? next : first;
    if (next.index === first.index) break;  // wrapped round
    step = next;
  }
  // Every locus tried has reads only the filter hides: the best one, where the
  // read track offers to show them.
  return first;
}
