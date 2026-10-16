import type { PanelConfig } from '../types';

/** State keys of open dataset panels showing the main view (not a copy at another locus). */
export function mainViewStateKeys(st: { panels: PanelConfig[]; chrom: string; start: number; end: number }): string[] {
  return st.panels
    .filter(p => p.contentType === 'dataset' && p.datasetId)
    .filter(p => {
      const v = p.viewportOverride;
      return !v || (sameChrom(v.chrom, st.chrom) && v.start === st.start && v.end === st.end);
    })
    .map(p => p.stateKey ?? p.datasetId!);
}
import { sameChrom } from './chromAliases';
