import { readAlignmentBounds, readBinaryBytes, readRegionProjectionSafe, readTerminalGaps } from './readBinary';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ReadsResponse } from '../components/tracks/read-track/types';
import { clearLoadedReadRegions, lookupReadRegion, projectLoadedReads, readRegionGeneration, rememberReadRegion, lookupExactReadResponse, rememberExactReadResponse, setReadRegionBudget, readRegionDiagnostics, releaseReadRegions } from './loadedReadRegion';

const params = (start = 0, end = 100) => new URLSearchParams({
  chrom: 'chr1', dataset_id: 'a', start: String(start), end: String(end),
  full_working_set: 'true', spanning: 'false', hide_terminal_gaps: 'false',
  terminal_gap_threshold: '0', include_sv_summary: 'false',
});
const data = (): ReadsResponse => ({ count: 1, total: 1, width: 100,
  total_overlapping: 1, working_count: 1, reads: [{ id: 'a', intervals: [[0, 100, 120]],
    methyl: [10, 30, 80], deam: [[10, 0], [30, 1]], layers: { tf: { intervals: [[20, 40, 20]] } } }] });

describe('loaded read regions', () => {
  beforeEach(clearLoadedReadRegions);
  it('reuses complete regions and lazily shifts marks without changing the source', () => {
    const original = data();
    readAlignmentBounds.set(original.reads[0], [0, 100]);
    readRegionProjectionSafe.add(original);
    rememberReadRegion(params(), original, 100, readRegionGeneration());
    const projected = lookupReadRegion(params(20, 70))!;
    expect(projected.reads[0].methyl).toEqual([10]);
    expect(projected.reads[0].deam).toEqual([[10, 1]]);
    expect(projected.reads[0].layers?.tf.intervals).toEqual([[0, 20, 20]]);
    expect(projected.total_spanning).toBe(1);
    expect(projected.has_methylation).toBe(true);
    expect(projectLoadedReads(original, 40, 20, 0)?.has_methylation).toBe(false);
    expect(original).toEqual(data());
  });
  it('misses on source, option, refresh and interval changes', () => {
    rememberReadRegion(params(), data(), 100, readRegionGeneration());
    for (const [key, value] of [['dataset_id', 'b'], ['layer_names', 'tf'], ['refresh_generation', '1'], ['include_metaprofile', 'true']]) {
      const p = params(); p.set(key, value);
      expect(lookupReadRegion(p)).toBeUndefined();
    }
    expect(lookupReadRegion(params(50, 150))).toBeUndefined();
    clearLoadedReadRegions();
    expect(lookupReadRegion(params())).toBeUndefined();
  });
  it('rejects sampled, partial, oversized and obsolete responses', () => {
    const generation = readRegionGeneration();
    clearLoadedReadRegions();
    rememberReadRegion(params(), data(), 100, generation);
    rememberReadRegion(params(), { ...data(), total_overlapping: 2 }, 100, readRegionGeneration());
    rememberReadRegion(params(), data(), 4 * 1024 * 1024 * 1024, readRegionGeneration());
    expect(lookupReadRegion(params())).toBeUndefined();
  });
  it('does not guess terminal gap clipping or circular and structural evidence', () => {
    const original = data();
    readAlignmentBounds.set(original.reads[0], [0, 100]);
    readRegionProjectionSafe.add(original);
    original.reads[0].intervals = [[0, 30, -30], [30, 100, 70]];
    expect(projectLoadedReads(original, 10, 60, 0)).toBeUndefined();
    original.reads[0].intervals = [[0, 100, 100]];
    original.reads[0].sv = [{ t: 'D', ref: 20, len: 50, q: 20 }];
    expect(projectLoadedReads(original, 10, 60, 0)).toBeUndefined();
  });
});

it('retains sampled revisits without projecting them, and invalidates on source changes', () => {
  clearLoadedReadRegions();
  const key = '/api/reads/compact?dataset_id=a&start=0&end=100';
  const sample = { ...data(), total_overlapping: 100, working_count: 100 };
  rememberExactReadResponse(key, sample, readRegionGeneration());
  expect(lookupExactReadResponse(key)).toMatchObject({ reads: sample.reads, working_count: 100 });
  expect(lookupExactReadResponse(key.replace('end=100', 'end=99'))).toBeUndefined();
  expect(lookupReadRegion(params(10, 50))).toBeUndefined();
  releaseReadRegions('a');
  expect(lookupExactReadResponse(key)).toBeUndefined();
  const generation = readRegionGeneration();
  clearLoadedReadRegions();
  rememberExactReadResponse(key, sample, generation);
  expect(lookupExactReadResponse(key)).toBeUndefined();
  rememberExactReadResponse(key, { ...sample, warning: 'incomplete' }, readRegionGeneration());
  expect(lookupExactReadResponse(key)).toBeUndefined();
});

it('evicts by a shared byte budget rather than a tiny window-count limit', () => {
  setReadRegionBudget(200000);
  try {
    for (let i = 0; i < 25; i++) rememberExactReadResponse(`/api/reads/compact?dataset_id=a&start=${i}`, data(), readRegionGeneration());
    expect(readRegionDiagnostics().entries).toBeGreaterThan(16);
    expect(lookupExactReadResponse('/api/reads/compact?dataset_id=a&start=0')).toBeDefined();
    for (let i = 25; i < 60; i++) rememberExactReadResponse(`/api/reads/compact?dataset_id=a&start=${i}`, data(), readRegionGeneration());
    expect(readRegionDiagnostics().retained).toBeLessThanOrEqual(200000);
    expect(lookupExactReadResponse('/api/reads/compact?dataset_id=a&start=1')).toBeUndefined();
    releaseReadRegions('a');
    expect(readRegionDiagnostics().retained).toBe(0);
  } finally { setReadRegionBudget(3 * 1024 ** 3); }
});

it('retains binary batches without expanding dense evidence to estimate memory', () => {
  clearLoadedReadRegions();
  const payload = { datasets: { a: data() } };
  Object.defineProperty(payload.datasets.a.reads[0], 'methyl', { enumerable: true, get: () => { throw new Error('eager expansion'); } });
  readBinaryBytes.set(payload, 1000);
  const key = '/api/reads/compact_all?dataset_ids=a,b&start=0&end=100';
  rememberExactReadResponse(key, payload, readRegionGeneration());
  expect(lookupExactReadResponse(key)).toHaveProperty('datasets');
  releaseReadRegions('b');
  expect(lookupExactReadResponse(key)).toBeUndefined();
});

it('clips aligned layer metadata and uses alignment bounds for spanning counts', () => {
  const original = data();
  original.reads[0].intervals = [[0, 25, 25], [25, 75, -50], [75, 100, 25]];
  Object.defineProperty(original.reads[0], 'qualities', { configurable: true, enumerable: true, get: () => [10, 20] });
  original.reads[0].layers = { tf: { intervals: [[0, 10, 10], [80, 95, 15]], qualities: [[40, 90]],
    annotation_names: ['left', 'right'], source_intervals: [[0, 10, 10], [80, 95, 15]] } };
  readAlignmentBounds.set(original.reads[0], [10, 95]);
  const projected = projectLoadedReads(original, 20, 70, 0)!;
  expect(projected.total_spanning).toBe(1);
  expect(projected.reads[0].intervals).toEqual([[0, 5, 25], [5, 55, -50], [55, 70, 25]]);
  expect(projected.reads[0].qualities).toEqual([10, 20]);
  expect(projected.reads[0].layers?.tf).toEqual({ intervals: [[60, 70, 15]], qualities: [[90]],
    annotation_names: ['right'], source_intervals: [[60, 75, 15]] });
});

it('retains a deep compact cohort and replaces a contained cohort in stable row order', () => {
  clearLoadedReadRegions();
  const first = data();
  first.reads = [{ id: 'b', intervals: [[0, 100, 100]] }, { id: 'a', intervals: [[0, 100, 100]] }];
  first.total_overlapping = first.working_count = 2;
  rememberReadRegion(params(), first, 100, readRegionGeneration());
  const larger = { ...first, width: 200, reads: [first.reads[1], { id: 'c', intervals: [[0, 200, 200]] as [number, number, number][] }, first.reads[0]], total_overlapping: 3, working_count: 3 };
  rememberReadRegion(params(0, 200), larger, 200, readRegionGeneration());
  expect(lookupReadRegion(params(0, 200))?.reads.map(read => read.id)).toEqual(['b', 'a', 'c']);
  const deep = { ...data(), reads: Array(200000).fill(data().reads[0]), total_overlapping: 200000, working_count: 200000 };
  rememberReadRegion(params(), deep, 500 * 1024 * 1024, readRegionGeneration());
  expect(lookupReadRegion(params())?.reads.length).toBe(200000);
  clearLoadedReadRegions();
});

it('preserves the visible terminal-gap size across deletion-split pieces', () => {
  const original = data();
  original.width = 1000;
  original.reads[0].intervals = [[0, 200, -800], [400, 800, -800], [800, 1000, 200]];
  original.reads[0].sv = [{ t: 'D', ref: 300, len: 200, q: 200 }];
  readAlignmentBounds.set(original.reads[0], [100, 1100]);
  expect(projectLoadedReads(original, 10, 980, 100)).toBeUndefined();
  readTerminalGaps.set(original.reads[0], [[100, 900]]);
  expect(projectLoadedReads(original, 10, 980, 100)?.reads[0].intervals)
    .toEqual([[0, 190, -790], [390, 790, -790], [790, 980, 200]]);
});

it('keeps allele evidence when client projection crops a clip outside the new view', () => {
  const original = data();
  const r = original.reads[0];
  readAlignmentBounds.set(r, [0, 100]);
  r.sv = [{ t: 'S', side: 'R', ref: 10, len: 60, q: 50 }];
  const cropped = projectLoadedReads(original, 20, 50, 0)!;
  expect(cropped.reads[0].sv).toBeUndefined();
  expect(cropped.reads[0].sv_evidence).toEqual(r.sv);
  expect(r.sv).toHaveLength(1);
});
