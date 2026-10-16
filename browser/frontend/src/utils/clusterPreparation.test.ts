import { expect, it } from 'vitest';
import { sampledFitCount } from './clusterPreparation';
import type { ClusterPreparationSample } from '../types';

it('counts the target panels once per fitted population', () => {
  const sample: ClusterPreparationSample = { dataset_id: 'ds', result_key: 'ds', chrom: 'chr1', start: 10, end: 20,
    fingerprint: 'abc', used: 6000, selected_names: 10000, prepared_reads: 9000, total_alignments: 100000,
    target_names: 10000, sample_seed: 'seed', method: 'bottom_k_qname_v1' };
  const samples = { left: sample, right: sample, other: { ...sample, dataset_id: 'other', result_key: 'other', used: 1500 } };
  expect(sampledFitCount(samples, ['left', 'right'])).toBe(6000);
  expect(sampledFitCount(samples, ['left', 'right', 'other'])).toBe(7500);
  expect(sampledFitCount(samples, ['unclustered'])).toBe(0);
});
