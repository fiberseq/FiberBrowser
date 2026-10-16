import { describe, expect, it } from 'vitest';
import type { ProjectionResponse } from '../api/clustering';
import { currentReadProjection, formatProjectionTsv, indexProjection, projectionFilename, projectionInputSignature, projectionTableColumns } from './projectionExport';
import { formatClusterAssignmentsTsv } from './clusterExport';

const response: ProjectionResponse = {
  coords_x: [1.5, -2],
  coords_y: [0.25, 3],
  read_ids: ['read/1', 'read/2'],
  dataset_ids: ['ds1', 'ds2'],
  labels_before: [0, 2],
  labels_after: null,
  cluster_centroids_before: {},
  cluster_centroids_after: null,
  dissolved: [],
  method: 'tsne',
  variance_explained: null,
  feature_dim: 12,
  n_reads: 2,
  sample_seed: 'fiberbrowser-analysis',
  projection_random_state: 42,
  strands: ['CT', ''],
  alignment_strands: ['+', '-'],
  embedded: [true, false],
  projection_params: {
    method: 'tsne', random_state: 42, n_reads: 2, feature_dim: 12, perplexity: 30, n_neighbors: 91,
    feature_digest: 'abc123', max_reads: 4000, n_embedded: 1, cache_hit: false,
  },
};

describe('projection export (per-read table)', () => {
  it('names the columns as the Python client does', () => {
    expect(projectionTableColumns('tsne')).toEqual(
      ['read_name', 'dataset', 'strand', 'alignment_strand', 'cluster', 'tsne_x', 'tsne_y', 'embedded']);
  });

  it('writes one row per read with the map parameters and seed in the header', () => {
    const lines = formatProjectionTsv(response).trimEnd().split('\n');
    expect(lines[0]).toBe('# fiberbrowser_export: read_projection');
    const header = lines.filter(l => l.startsWith('#'));
    expect(header).toContain('# random_state: 42');
    expect(header).toContain('# perplexity: 30');
    expect(header).toContain('# n_neighbors: 91');
    expect(header).toContain('# feature_digest: abc123');
    expect(header).toContain('# sample_seed: fiberbrowser-analysis');
    // fb-n3-export (audit L15): how the request went (cache_hit, seconds) is not part of the map.
    expect(header.some(l => /^# (cache_hit|seconds):/.test(l))).toBe(false);
    // Header keys sorted (as the Python writer sorts them).
    const keys = header.slice(1).map(l => l.slice(2).split(':')[0]);
    expect(keys).toEqual([...keys].sort());
    const body = lines.filter(l => !l.startsWith('#'));
    expect(body[0].split('\t')).toEqual(projectionTableColumns('tsne'));
    expect(body[1].split('\t')).toEqual(['read/1', 'ds1', 'CT', '+', '0', '1.5', '0.25', 'True']);
    expect(body[2].split('\t')).toEqual(['read/2', 'ds2', '', '-', '2', '-2', '3', 'False']);
  });

  it('a refetched map names its reference, not the request time or cache hit (fb-n3-export, audit L15)', () => {
    const refetched = { ...response, projection_params: { ...response.projection_params!, seconds: 0.002, cache_hit: true } };
    const header = formatProjectionTsv(refetched, { reference: 'dm6' }).split('\n').filter(l => l.startsWith('#'));
    expect(header).toContain('# reference: dm6');
    expect(header.join('\n')).not.toMatch(/seconds|cache_hit/);
  });

  it('the After view exports the simulated grouping, with both columns (fb-n3-export, Codex audit #22)', () => {
    const shown = { ...response, labels_after: [5, 2] };
    // The export's refetch carries no simulation: the shown map's After labels, by dataset and read.
    const refetched = { ...response, read_ids: ['read/2', 'read/1'], dataset_ids: ['ds2', 'ds1'], labels_before: [2, 0],
      coords_x: [-2, 1.5], coords_y: [3, 0.25], strands: ['', 'CT'], alignment_strands: ['-', '+'], embedded: [false, true] };
    const after = formatProjectionTsv(refetched, {}, { view: 'after', shown }).trimEnd().split('\n');
    expect(after).toContain('# cluster_column: after_autocull');
    const body = after.filter(l => !l.startsWith('#'));
    expect(body[0].split('\t')).toEqual([...projectionTableColumns('tsne'), 'cluster_before', 'cluster_after']);
    expect(body[1].split('\t')).toEqual(['read/2', 'ds2', '', '-', '2', '-2', '3', 'False', '2', '2']);
    expect(body[2].split('\t')).toEqual(['read/1', 'ds1', 'CT', '+', '5', '1.5', '0.25', 'True', '0', '5']);
    // Side by side: cluster is Before's, both columns given.
    const side = formatProjectionTsv(refetched, {}, { view: 'side-by-side', shown }).trimEnd().split('\n').filter(l => !l.startsWith('#'));
    expect(side[2].split('\t').slice(4)).toEqual(['0', '1.5', '0.25', 'True', '0', '5']);
    // Before: the table as it was.
    expect(formatProjectionTsv(refetched, {}, { view: 'before', shown })).toBe(formatProjectionTsv(refetched));
  });

  it('names the file after the method and region', () => {
    expect(projectionFilename('tsne', 'chr2L', 10, 20)).toBe('tsne_reads_chr2L_10-20.tsv');
  });

  it('adds the map columns to the cluster-assignment export', () => {
    const projection = indexProjection(response, { chrom: 'chr1', start: 0, end: 100 });
    expect(projection.coords.ds1['read/1']).toEqual([1.5, 0.25]);
    const tsv = formatClusterAssignmentsTsv({
      clusterAssignments: { ds1: { 'read/1': 0, other: 1 } },
      datasets: [{ id: 'ds1', label: 'Dataset 1' }],
      provenance: { chrom: 'chr1' },
      projection,
    });
    const lines = tsv.split('\n').filter(Boolean);
    expect(lines).toContain('# projection_random_state: 42');
    expect(lines).toContain('# projection_region: chr1:0-100');
    const body = lines.filter(l => !l.startsWith('#'));
    expect(body[0].split('\t')).toEqual(['read_id', 'dataset', 'cluster', 'viewer_order', 'tsne_x', 'tsne_y']);
    expect(body).toContain(['read/1', 'Dataset 1', '0', '1', '1.5', '0.25'].join('\t'));
    expect(body).toContain(['other', 'Dataset 1', '1', '2', '', ''].join('\t'));
  });

  it('leaves the cluster export as before without a map', () => {
    const tsv = formatClusterAssignmentsTsv({ clusterAssignments: { ds1: { a: 0 } }, projection: null });
    expect(tsv.split('\n')[0]).toBe('read_id\tdataset\tcluster\tviewer_order');
  });

  it('drops a kept map once the inputs that shaped it change', () => {
    const inputs = {
      chrom: 'chr1', start: 0, end: 100, analysisSampleSeed: 'a', subnucleosomalThreshold: 90, spanningOnly: false,
      clusterFeatureRules: [], clusterPeakRegions: [{ start: 10, end: 20, mode: 'nuc' }], selectedPeaks: new Set([1]),
      activeColormap: { qualityFilters: [] },
    };
    const kept = indexProjection(response, { chrom: 'chr1', start: 0, end: 100 }, projectionInputSignature(inputs));
    expect(currentReadProjection(kept, inputs)).toBe(kept);
    // Selected peaks don't matter while the clustering's own peaks set the map.
    expect(currentReadProjection(kept, { ...inputs, selectedPeaks: new Set([2]) })).toBe(kept);
    expect(currentReadProjection(kept, { ...inputs, subnucleosomalThreshold: 80 })).toBeNull();
    expect(currentReadProjection(kept, { ...inputs, analysisSampleSeed: 'b' })).toBeNull();
    expect(currentReadProjection(kept, { ...inputs, clusterFeatureRules: [{ id: 'x' }] })).toBeNull();
    expect(currentReadProjection(kept, { ...inputs, activeColormap: { qualityFilters: [{ layer: 'fire', qualityName: 'aq', minValue: 200, enabled: true }] as any } })).toBeNull();
    expect(currentReadProjection(kept, { ...inputs, end: 101 })).toBeNull();
    expect(currentReadProjection(kept, { ...inputs, legacyLayerInference: true })).toBeNull();
    // Another cohort is another map; relabelling the same reads is not.
    const withReads = { ...inputs, clusterAssignments: { ds1: { r1: 0, r2: 1 } } };
    const keptReads = indexProjection(response, { chrom: 'chr1', start: 0, end: 100 }, projectionInputSignature(withReads));
    expect(currentReadProjection(keptReads, { ...withReads, clusterAssignments: { ds1: { r2: 0, r1: 0 } } })).toBe(keptReads);
    expect(currentReadProjection(keptReads, { ...withReads, clusterAssignments: { ds1: { r1: 0 } } })).toBeNull();
    // Without the clustering's peaks, a selected peak's mode is part of the map.
    const bySelection = { ...inputs, clusterPeakRegions: [], selectedPeaks: new Set([1]), peakModes: { 1: 'nuc' },
      getAllPeaks: () => [{ index: 1, start: 5, end: 9 }] };
    const keptSel = indexProjection(response, { chrom: 'chr1', start: 0, end: 100 }, projectionInputSignature(bySelection));
    expect(currentReadProjection(keptSel, { ...bySelection, peakModes: { 1: 'tf' } })).toBeNull();
    expect(currentReadProjection(null, inputs)).toBeNull();
  });
});
