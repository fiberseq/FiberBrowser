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
