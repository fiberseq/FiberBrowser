/**
 * A live-lift panel's map correspondence over the view (GET /api/coverage's `live_lift`): per bin, the fraction of
 * bases a primary piece of the panel's haplotype (pooled: of any selected haplotype) covers. The read track's
 * coverage histogram hatches bins without it (§3.8, owner 4: "no correspondence" must not look like "no reads").
 */
import { useEffect, useState } from 'react';
import type { Dataset } from '../../types';
import { isLiveLift } from '../../utils/datasetKinds';
import { liftCoverage } from './api';

export const CORRESPONDENCE_BINS = 200;

export function useLiftCorrespondence(
  dataset: Dataset | undefined, chrom: string, start: number, end: number, liftHap: string | null | undefined,
  enabled: boolean,
): number[] | null {
  const [value, setValue] = useState<{ key: string; corr: number[] } | null>(null);
  const on = enabled && isLiveLift(dataset) && dataset?.live_lift?.settings?.coverage_hatching !== false && end > start;
  const key = on ? [dataset!.id, dataset!.live_lift?.key, chrom, start, end, liftHap ?? ''].join('|') : '';
  useEffect(() => {
    if (!on) return;
    let live = true;
    liftCoverage({ chrom, start, end, bins: CORRESPONDENCE_BINS, datasetId: dataset!.id, liftHap })
      .then(r => {
        if (!live || !r.live_lift) return;
        const corr = liftHap && r.live_lift.haplotypes[liftHap]
          ? r.live_lift.haplotypes[liftHap].correspondence : r.live_lift.pooled.correspondence;
        setValue({ key, corr });
      })
      .catch(() => { /* hatching is a hint: a failed request leaves the histogram plain */ });
    return () => { live = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return on && value?.key === key ? value.corr : null;
}
