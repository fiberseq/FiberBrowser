import type { ClusterPreparationSample } from '../types';

/** Duplicate panels may display one fitted result; count that population once. */
export function sampledFitCount(samples: Record<string, ClusterPreparationSample>, keys: string[]): number {
  const seen = new Set<string>();
  let total = 0;
  for (const key of keys) {
    const sample = samples[key];
    if (!sample) continue;
    const identity = JSON.stringify([sample.dataset_id ?? key, sample.result_key ?? key,
      sample.chrom, sample.start, sample.end, sample.fingerprint]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    total += sample.used;
  }
  return total;
}
