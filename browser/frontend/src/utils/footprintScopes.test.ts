import { describe, expect, it } from 'vitest';
import { footprintAnalysisScopes, mergeFootprintScopeResults } from './footprintScopes';
import type { FootprintAnalysisResult } from '../api/footprints';

const main = { chrom: 'chr1', start: 0, end: 1000 };
const panels = [
  { contentType: 'dataset' },
  { contentType: 'dataset', viewportOverride: { chrom: 'chr2', start: 0, end: 1000 } },
];

describe('footprintAnalysisScopes', () => {
  it('analyses a footprint picked on another chromosome in that panel\'s region', () => {
    const scopes = footprintAnalysisScopes([
      { chrom: 'chr1', absStart: 100, absEnd: 150 },
      { chrom: 'chr2', absStart: 100, absEnd: 150 },
      { chrom: '1', absStart: 300, absEnd: 350 },
    ], main, panels);
    expect(scopes).toEqual([
      { chrom: 'chr1', start: 0, end: 1000, indices: [0, 2] },
      { chrom: 'chr2', start: 0, end: 1000, indices: [1] },
    ]);
  });

  it('analyses a footprint picked at another locus on the same chromosome in that panel\'s region', () => {
    const far = [{ contentType: 'dataset' }, { contentType: 'dataset', viewportOverride: { chrom: 'chr1', start: 1_000_000, end: 1_001_000 } }];
    expect(footprintAnalysisScopes([{ chrom: 'chr1', absStart: 1_000_100, absEnd: 1_000_150 }], main, far)).toEqual([
      { chrom: 'chr1', start: 1_000_000, end: 1_001_000, indices: [0] },
    ]);
  });
});

describe('mergeFootprintScopeResults', () => {
  it('puts each region\'s results back at the selection positions', () => {
    const entry = (n: number) => ({ overlap_count: n, overlap_fraction: 0, size_mean: 0, size_median: 0, size_histogram: { bins: [], counts: [], bin_width: 1 } });
    const res = (counts: number[]) => ({
      success: true,
      footprints: counts.map(c => ({ absStart: c, absEnd: c + 1, size: 1, sequence: null, seq_start: c, motif_hits: [] })),
      overlap_stats: { ds: { total_reads: 10, per_footprint: counts.map(entry) } },
    }) as unknown as FootprintAnalysisResult;
    const merged = mergeFootprintScopeResults([
      { scope: { chrom: 'chr1', start: 0, end: 1000, indices: [0, 2] }, res: res([5, 7]) },
      { scope: { chrom: 'chr2', start: 0, end: 1000, indices: [1] }, res: res([6]) },
    ])!;
    expect(merged.overlap_stats.ds.per_footprint.map(e => e.overlap_count)).toEqual([5, 6, 7]);
    expect(merged.footprints.map(f => f.absStart)).toEqual([5, 6, 7]);
  });
});

describe('footprintAnalysisScopes with panels navigating on their own (fb-r2-integ)', () => {
  it('a footprint picked in a panel at its own locus is analysed there, even inside the (stale) main view', () => {
    // "Each panel navigates": the panel moved to chr1:500-1500; the main view stayed at chr1:0-1000.
    const perPanel = [{ contentType: 'dataset', datasetId: 'a', navOwn: true, viewportOverride: { chrom: 'chr1', start: 500, end: 1500 } }];
    expect(footprintAnalysisScopes([{ chrom: 'chr1', absStart: 600, absEnd: 650, datasetId: 'a' }], main, perPanel as never)).toEqual([
      { chrom: 'chr1', start: 500, end: 1500, indices: [0] },
    ]);
  });

  it('a dataset shown at the main view keeps the main view (as before)', () => {
    const linked = [{ contentType: 'dataset', datasetId: 'a' }, { contentType: 'dataset', datasetId: 'a', viewportOverride: { chrom: 'chr1', start: 500, end: 1500 } }];
    expect(footprintAnalysisScopes([{ chrom: 'chr1', absStart: 600, absEnd: 650, datasetId: 'a' }], main, linked as never)).toEqual([
      { chrom: 'chr1', start: 0, end: 1000, indices: [0] },
    ]);
  });
});

describe('footprintAnalysisScopes: the panel a footprint was picked in (fb-r2-integ review)', () => {
  it('a footprint picked in a copy overlapping the main view is analysed in the copy\'s window', () => {
    const copies = [
      { contentType: 'dataset', datasetId: 'a' },
      { contentType: 'dataset', datasetId: 'a', stateKey: 'copy', viewportOverride: { chrom: 'chr1', start: 500, end: 1500 } },
    ];
    expect(footprintAnalysisScopes([{ chrom: 'chr1', absStart: 600, absEnd: 650, datasetId: 'a', stateKey: 'copy' }], main, copies as never)).toEqual([
      { chrom: 'chr1', start: 500, end: 1500, indices: [0] },
    ]);
    expect(footprintAnalysisScopes([{ chrom: 'chr1', absStart: 600, absEnd: 650, datasetId: 'a', stateKey: 'a' }], main, copies as never)).toEqual([
      { chrom: 'chr1', start: 0, end: 1000, indices: [0] },
    ]);
  });
});
