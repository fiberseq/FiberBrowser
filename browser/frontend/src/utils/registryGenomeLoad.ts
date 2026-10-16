import { loadGenome } from '../api/reference';
import { getStatus } from '../api/status';
import { useBrowserStore } from '../stores/browserStore';
import { useGenomeCheckStore } from '../stores/genomeCheckStore';
import { autoSaveNow } from '../hooks/useAutoSave';
import { genomeLoadHasFasta } from './genomeAutoload';
import { showLoadedReference } from './referenceNavigation';
import { findDatasetReadsLocus } from './datasetReadsLocus';
import { isTopLocusStep } from './topLoci';

export interface RegistryGenomeLoadOptions {
  /** Show this dataset's reads once the genome is loaded (it was loaded for it). */
  goToDatasetId?: string;
}

/**
 * Load a registry genome (downloaded once into ~/.fiberhmm/genomes, then
 * from the cache) and update the app as the genome picker does: sequence,
 * genome id, a refresh, and the view (the data's start position, else the
 * same contig under the new names, else the first contig). Loaded for a
 * dataset (`goToDatasetId`, e.g. the genome-mismatch banner's Load dm6), the
 * view goes to that dataset's best-covered reads, fitted to them.
 */
export async function loadRegistryGenome(genomeId: string, options: RegistryGenomeLoadOptions = {}): Promise<{ success: boolean; error?: string }> {
  const checks = useGenomeCheckStore.getState();
  checks.setLoadingGenome(genomeId);
  try {
    const res = await loadGenome(genomeId);
    if (!res.success) return { success: false, error: res.fasta_error || res.gtf_error || `Failed to load ${genomeId}` };
    const store = useBrowserStore.getState();
    store.setHasFasta(genomeLoadHasFasta(res));
    // Registry genomes are identified by id (a local-FASTA path would send reloads down the wrong branch).
    store.setFastaPath(null);
    store.setCurrentGenome(genomeId);
    const status = await getStatus().catch(() => null);
    const datasetId = options.goToDatasetId;
    const atReads = datasetId && store.datasets.some(d => d.id === datasetId)
      ? await findDatasetReadsLocus(datasetId, Math.max(1000, store.end - store.start)).catch(() => null)
      : null;
    if (atReads && isTopLocusStep(atReads)) {
      store.triggerRefresh();
      store.setViewport(atReads.window.chrom, atReads.window.start, atReads.window.end);
    } else if (status?.initial_position) {
      store.triggerRefresh();
      store.setViewport(status.initial_position.chrom, status.initial_position.start, status.initial_position.end);
    } else {
      await showLoadedReference();
    }
    setTimeout(() => { void autoSaveNow(); }, 500);
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : `Failed to load ${genomeId}` };
  } finally {
    checks.setLoadingGenome(null);
    void useGenomeCheckStore.getState().refresh();
  }
}
