import type { Difference, DifferencesResponse } from './differenceTypes';

/** Reuse the strip's loaded map evidence for read actions. Keep only a few
 * responses, scoped by lift_key as well as dataset/chromosome: a settings
 * change must never resolve a badge against geometry from the previous map. */
const loaded: DifferencesResponse[] = [];
export function rememberDifferences(response: DifferencesResponse) {
  loaded.unshift(response);
  loaded.splice(16);
}
export function clearDifferenceCache() { loaded.length = 0; }
export function findLoadedDifference(datasetId: string, liftKey: string, chrom: string,
  event: { id?: string; hap: string; pos: number; kind: 'insertion' | 'snv' }): Difference | undefined {
  for (const response of loaded) {
    if (response.dataset_id !== datasetId || response.lift_key !== liftKey || response.chrom !== chrom) continue;
    const item = response.items.find(d => event.id ? d.id === event.id || d.aliases?.includes(event.id)
      : d.hap_label === event.hap && (event.kind === 'insertion' ? d.kind === 'insertion' && d.t_start === event.pos
        : (d.kind === 'snv' || d.kind === 'mnv') && d.t_start <= event.pos && d.t_end > event.pos));
    if (item) return item;
  }
}
