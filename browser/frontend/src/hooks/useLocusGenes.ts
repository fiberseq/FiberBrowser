import { useEffect, useState } from 'react';
import { getGenes } from '../api/reference';
import type { Gene } from '../types';

/** Reference annotations for an analysis's own locus; never reuse the main view's genes. */
export function useLocusGenes(chrom: string, start: number, end: number, genome: string | null) {
  const [genes, setGenes] = useState<Gene[]>([]);
  useEffect(() => {
    let live = true;
    setGenes([]);
    if (chrom) getGenes(chrom, start, end, undefined, genome)
      .then(r => { if (live) setGenes(r.genes); }).catch(() => {});
    return () => { live = false; };
  }, [chrom, start, end, genome]);
  return genes;
}
