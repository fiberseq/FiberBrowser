import { resetAnnotation } from '../api/reference';
import { useBrowserStore } from '../stores/browserStore';
import { useGenomeCheckStore } from '../stores/genomeCheckStore';

/**
 * "Reset to dm6 genes": the reference's registry annotation in place of the loaded one (from the cache, else the
 * online catalog, as the genome list loads it); the FASTA stays. The gene track and the checks follow.
 */
export async function resetRegistryAnnotation(genomeId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await resetAnnotation(genomeId);
    if (!res.success) return { success: false, error: res.gtf_error || `Could not load ${genomeId}'s annotation` };
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : `Could not load ${genomeId}'s annotation` };
  } finally {
    useBrowserStore.getState().triggerRefresh();
    void useGenomeCheckStore.getState().refresh();
  }
}
