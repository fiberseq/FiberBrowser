import { describe, expect, it } from 'vitest';
import {
  buildClusterAssignmentSignature,
  buildClusterEnrichmentRequestKey,
  buildClusterProjectionRequestKey,
  buildClusterVplotRequestKey,
} from './clusterDetailRequestKey';

describe('cluster detail request keys', () => {
  it('tracks V-plot semantic settings', () => {
    const base = {
      chrom: 'chr2R',
      start: 100,
      end: 500,
      sizeBin: 10,
      posBin: 10,
      sizeMin: 10,
      sizeMax: 300,
      logNorm: true,
      smooth: 1,
      layer: null,
      normalize: 'per_cluster' as const,
      sampleSeed: '1729',
      assignmentSignature: 'ds1:2:test',
    };
    const first = buildClusterVplotRequestKey(base);

    expect(buildClusterVplotRequestKey({ ...base })).toBe(first);
    expect(buildClusterVplotRequestKey({ ...base, layer: 'tf' })).not.toBe(first);
    expect(buildClusterVplotRequestKey({ ...base, smooth: 2 })).not.toBe(first);
    // Midpoint is the default; Full footprint and per-size-row are new plots.
    expect(buildClusterVplotRequestKey({ ...base, mode: 'midpoint', rowNormalize: false })).toBe(first);
    expect(buildClusterVplotRequestKey({ ...base, mode: 'span' })).not.toBe(first);
    expect(buildClusterVplotRequestKey({ ...base, rowNormalize: true })).not.toBe(first);
  });

  it('normalizes projection dataset order but tracks projection settings', () => {
    const base = {
      chrom: 'chr2R',
      start: 100,
      end: 500,
      datasetIds: ['ds2', 'ds1'],
      method: 'pca' as const,
      spanning: true,
      simulateAutocull: false,
      minFraction: 0.05,
      maxCosineSimilarity: 0.95,
      subnucleosomalThreshold: 90,
      accessibilityThreshold: 0.5,
      sampleSeed: '1729',
      assignmentSignature: 'ds1:2:test',
    };
    const first = buildClusterProjectionRequestKey(base);

    expect(buildClusterProjectionRequestKey({ ...base, datasetIds: ['ds1', 'ds2'] })).toBe(first);
    expect(buildClusterProjectionRequestKey({ ...base, method: 'umap' })).not.toBe(first);
    expect(buildClusterProjectionRequestKey({ ...base, simulateAutocull: true })).not.toBe(first);
  });

  it('builds assignment signatures independent of dataset order', () => {
    const assignments = {
      ds2: { r2: 1, r1: 0 },
      ds1: { a: 0 },
    };
    const first = buildClusterAssignmentSignature(assignments, ['ds2', 'ds1']);

    expect(buildClusterAssignmentSignature(assignments, ['ds1', 'ds2'])).toBe(first);
    expect(buildClusterAssignmentSignature({
      ...assignments,
      ds2: { r2: 0, r1: 0 },
    }, ['ds1', 'ds2'])).not.toBe(first);
  });

  it('normalizes enrichment dataset order', () => {
    const first = buildClusterEnrichmentRequestKey({
      chrom: 'chr2R',
      start: 100,
      end: 500,
      datasetIds: ['ds2', 'ds1'],
    });

    expect(buildClusterEnrichmentRequestKey({
      chrom: 'chr2R',
      start: 100,
      end: 500,
      datasetIds: ['ds1', 'ds2'],
    })).toBe(first);
  });
});
