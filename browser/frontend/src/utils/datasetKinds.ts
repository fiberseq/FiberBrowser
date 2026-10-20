/**
 * Dataset kinds (backend: services/lift/capability.py). A live-lift dataset (`bam_livelift`) is BAM records drawn on
 * the main genome through a graphlift map: display code treats it as a BAM (layers, footprints, the read body),
 * analyses do not (the server refuses them until they support lifted rows).
 */
import type { Dataset } from '../types/dataset';

type Kind = Pick<Dataset, 'data_type'> | null | undefined;

/** Reads come from BAM records (native or lifted): for display decisions only. */
export function isBamBacked(dataset: Kind): boolean {
  return dataset?.data_type === 'bam' || dataset?.data_type === 'bam_livelift';
}

/** A live-lift dataset. */
export function isLiveLift(dataset: Kind): boolean {
  return dataset?.data_type === 'bam_livelift';
}

/** The datasets a read panel's combined request (`/api/reads/compact_all`) loads: every dataset except other
 * live-lift datasets. A panel only uses its own dataset from the response, and a lifted dataset's split panels never
 * batch (they ask per haplotype), so including it would compose its lifted rows again on every view for nothing. */
export function batchReadDatasets<T extends Pick<Dataset, 'id' | 'data_type'>>(datasets: readonly T[], ownId: string): T[] {
  return datasets.filter(d => d.id && (!isLiveLift(d) || d.id === ownId));
}
