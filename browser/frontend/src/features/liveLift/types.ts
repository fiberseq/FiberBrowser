/** What a live-lift dataset carries (Dataset.to_dict's `live_lift`, services/lift/dataset.py). */
import type { LiftSettings } from './api';

export interface LiveLiftDatasetInfo {
  manifest: string;
  map_label: string;
  /** Selected haplotype keys and their labels (MAT/PAT). */
  haplotypes: string[];
  haplotype_labels: Record<string, string>;
  available_haplotypes?: Record<string, string>;
  settings: LiftSettings;
  key: string;
  source_assembly?: string;
}

declare module '../../types/dataset' {
  interface Dataset {
    /** A live-lift dataset's map, haplotypes and settings (data_type 'bam_livelift'). */
    live_lift?: LiveLiftDatasetInfo;
  }
}

/** Haplotype labels of a lifted dataset, in the map's order. */
export function liftHapLabels(info: LiveLiftDatasetInfo | undefined): string[] {
  if (!info) return [];
  return info.haplotypes.map(h => info.haplotype_labels?.[h] ?? h);
}
