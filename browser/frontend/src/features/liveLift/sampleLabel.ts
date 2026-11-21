/**
 * Names for a lifted dataset's two assemblies in labels ("Open in HG002 view", "HG002 MAT source", the inspector's
 * columns): the source sample from the map (`live_lift.source_sample`, PanSN `HG002#1#chr3` -> `HG002`) and the target
 * reference (`live_lift.target_reference`, `GRCh38#0` -> `GRCh38`). Older servers and sessions without those fields
 * derive the sample from the map's haplotype keys; a map of several samples, or none, says "source assembly".
 */
import type { Dataset } from '../../types';

type Lifted = Pick<Dataset, 'live_lift'> | null | undefined;

/** The sample of a PanSN name (`HG002#1#chr3`, `HG002#1` -> `HG002`; a `_MAT`/`_PATERNAL` suffix is dropped). */
export function pansnSample(name: string | null | undefined): string | null {
  const sample = String(name ?? '').split('#', 1)[0].trim().replace(/[_.-](MAT|PAT)(ERNAL)?$/i, '');
  return sample || null;
}

/** The one sample a lifted dataset's map lifts from (null: unknown, or several). */
export function sourceSampleName(dataset: Lifted): string | null {
  const info = dataset?.live_lift;
  if (!info) return null;
  if (info.source_sample) return info.source_sample;
  // The dataset's own haplotypes first (one sample opened from a multi-sample map is that sample), else the map's.
  const keys = info.haplotypes?.length ? info.haplotypes : Object.keys(info.available_haplotypes ?? {});
  // A haplotype key without a PanSN '#' ("H1") names no sample.
  const samples = new Set(keys.filter(k => k.includes('#')).map(pansnSample).filter((s): s is string => Boolean(s)));
  return samples.size === 1 ? [...samples][0] : null;
}

/** The source sample for a label, else "source assembly". */
export function sourceSampleLabel(dataset: Lifted): string {
  return sourceSampleName(dataset) ?? 'source assembly';
}

/** "HG002 MAT" (or just "MAT" when the sample is unknown; a PanSN haplotype label such as "strainA#0" already names
 * its sample and is not prefixed again). */
export function sourceHapLabel(dataset: Lifted, hap: string | null | undefined): string {
  const sample = sourceSampleName(dataset);
  if (sample && hap && ((pansnSample(hap) === sample && hap.includes('#')) || hap === sample)) return hap;
  return [sample, hap].filter(Boolean).join(' ') || 'source assembly';
}

/** The target reference's name (GRCh38), else `fallback`. */
export function targetReferenceLabel(dataset: Lifted, fallback = 'reference'): string {
  return dataset?.live_lift?.target_reference || fallback;
}
