import { useEffect } from 'react';
import { useBrowserStore } from '../../../stores/browserStore';
import { refreshSvSplit } from '../../../utils/svAlleleSplit';

/**
 * An SV allele split survives pan/zoom within its locus (fb-n9-sv): when the
 * panel's view changes while the locus stays in it, the new view's reads are
 * classified and merged into the groups, so none of them is left out (a read
 * with no group would not be fetched: its id is outside the cohort filter).
 */
export function useSvSplitRefresh({ stateKey, datasetId, chrom, start, end, enabled }: {
  stateKey: string; datasetId: string; chrom: string; start: number; end: number; enabled: boolean;
}): void {
  const def = useBrowserStore(s => s.svSplits[stateKey]);
  const duplicates = useBrowserStore(s => Boolean(s.showDuplicateReads));
  useEffect(() => {
    if (!enabled || !def || def.datasetId !== datasetId || def.chrom !== chrom) return;
    // Classified for this view (and duplicate setting) already.
    if (def.viewStart === start && def.viewEnd === end && Boolean(def.includeDuplicates) === duplicates) return;
    if (!(def.ref < end && def.end + 1 > start)) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      refreshSvSplit({ stateKey, datasetId, chrom, viewStart: start, viewEnd: end }, def, controller.signal)
        .catch(() => { /* the groups stay as they were */ });
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [enabled, def, stateKey, datasetId, chrom, start, end, duplicates]);
}
