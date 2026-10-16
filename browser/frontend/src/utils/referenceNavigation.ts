import { getChromosomes } from '../api/reference';
import { findChromInfo } from './chromAliases';
import { useBrowserStore } from '../stores/browserStore';

/**
 * After a new reference loads: refresh (chromosome list, genes, tracks) and,
 * when the current chromosome isn't in it, go to the start of its first one.
 */
export async function showLoadedReference(): Promise<void> {
  useBrowserStore.getState().triggerRefresh();
  try {
    const res = await getChromosomes();
    const store = useBrowserStore.getState();
    store.setChroms(res.chroms);
    if (res.chroms.length > 0 && !res.chroms.some(c => c.name === store.chrom)) {
      // The same contig under the new reference's name keeps the view; else the first contig.
      const alias = findChromInfo(res.chroms, store.chrom);
      if (alias) store.setViewport(alias.name, store.start, Math.min(store.end, alias.size));
      else {
        const first = res.chroms[0];
        store.setViewport(first.name, 0, Math.min(20000, first.size));
      }
    }
  } catch { /* the refresh fetches the chromosome list too */ }
}
