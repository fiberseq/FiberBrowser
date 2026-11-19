import { describe, expect, it } from 'vitest';
import type { CompactRead } from '../../components/tracks/read-track/types';
import type { Dataset } from '../../types/dataset';
import { variantDatasets } from '../variants/useSnpScan';
import { drawReadVariantMarks } from './drawing';
import {
  ALLELE_AMBIGUOUS, DEFAULT_LAYER_SETTINGS, alleleAt, alleleColor, alleleName, baseReadId, datasetVariantLayers, mergeOverlay,
  overlayQuery, splitLinks, supplementaryRowId, type FiberhmmOverlay, type FiberhmmRead,
} from './model';
import { restoreLayerSettings } from './state';

const bigbed = (companions: Record<string, string[]>, layer_type = 'footprint') =>
  ({ id: 'ds', data_type: 'bigbed', layer_type, companion_layers: companions }) as unknown as Dataset;

const reads: CompactRead[] = [
  { id: 'r1', intervals: [[0, 1000, 0]] },
  { id: 'r2', intervals: [[0, 1000, 0]], sv: [{ t: 'D', ref: 1500, len: 80, q: 10 }] },
  { id: 'r3', intervals: [[0, 1000, 0]] },
];

const overlay: FiberhmmOverlay = {
  dataset_id: 'ds', region: { chrom: 'chr1', start: 1000, end: 2000 },
  reads: {
    r1: { sv: [{ t: 'D', ref: 1200, len: 300, q: -1 }, { t: 'S', side: 'R', ref: 1990, len: 900, q: -1 },
      { t: 'SA', chrom: 'chr1', pos: 5000, strand: '+', mapq: 60, nm: 0, cigar_ref_len: 900, supp: false, same_strand: true }],
    var: [[1400, 1, 1], [1600, 1, ALLELE_AMBIGUOUS]], mapq: 60 },
    r2: { sv: [{ t: 'I', ref: 1300, len: 50, q: -1 }], mapq: 60 },
  },
  pieces: [
    { id: 'r3', start: 1700, end: 2500, strand: '+', mapq: 50, flag: 2048, sv: [{ t: 'S', side: 'L', ref: 1700, len: 600, q: -1 }] },
    { id: 'r9', start: 1100, end: 1300, strand: '-', mapq: 3, flag: 2048, sv: [] },
  ],
  sv_summary: null,
};

describe('dataset layers', () => {
  it('finds var / sv companions on bigBed datasets only', () => {
    expect(datasetVariantLayers(bigbed({ var: ['a.bb'], sv: ['b.bb'] }))).toEqual({ var: true, sv: true });
    expect(datasetVariantLayers(bigbed({ msp: ['m.bb'] }))).toEqual({ var: false, sv: false });
    expect(datasetVariantLayers(bigbed({}, 'sv'))).toEqual({ var: false, sv: true });
    expect(datasetVariantLayers({ data_type: 'bam', companion_layers: { var: ['x'] } } as unknown as Dataset)).toEqual({ var: false, sv: false });
  });

  it('offers a bigBed dataset with variant layers to the Variants panel', () => {
    const ds = [bigbed({ var: ['a.bb'] }), { id: 'plain', data_type: 'bigbed', companion_layers: {} } as unknown as Dataset];
    expect(variantDatasets([], ds).map(d => d.id)).toEqual(['ds']);
  });
});

describe('overlay request', () => {
  it('asks for nothing until a layer is on', () => {
    expect(overlayQuery('ds', 'chr1', 0, 100, DEFAULT_LAYER_SETTINGS, 50)).toBeNull();
  });
  it('names the layers and filters', () => {
    const url = overlayQuery('ds', 'chr1', 10.4, 99.2, { ...DEFAULT_LAYER_SETTINGS, sv: true, minMapq: 20, hideSupplementary: true }, 30)!;
    const q = new URL(url, 'http://x').searchParams;
    expect(q.get('layers')).toBe('sv');
    expect(q.get('start')).toBe('10');
    expect(q.get('end')).toBe('100');
    expect(q.get('min_mapq')).toBe('20');
    expect(q.get('hide_supplementary')).toBe('true');
    expect(q.get('min_sv_len')).toBe('30');
  });
});

describe('merging the overlay onto reads', () => {
  const on = { ...DEFAULT_LAYER_SETTINGS, sv: true, var: true };

  it('returns the reads untouched while nothing is on', () => {
    expect(mergeOverlay(reads, overlay, DEFAULT_LAYER_SETTINGS, 1000, 2000)).toBe(reads);
  });

  it('adds sv and var, keeps a read\'s own sv', () => {
    const merged = mergeOverlay(reads, overlay, on, 1000, 2000);
    const r1 = merged.find(r => r.id === 'r1')!;
    expect(r1.sv?.[0]).toEqual({ t: 'D', ref: 1200, len: 300, q: -1 });
    expect(r1.var).toEqual([[1400, 1, 1], [1600, 1, ALLELE_AMBIGUOUS]]);
    expect(merged.find(r => r.id === 'r2')!.sv).toEqual(reads[1].sv);
  });

  it('places a supplementary row after its primary when linked, and filters by MAPQ', () => {
    const merged = mergeOverlay(reads, overlay, { ...on, minMapq: 10 }, 1000, 2000);
    expect(merged.map(r => r.id)).toEqual(['r1', 'r2', 'r3', supplementaryRowId(overlay.pieces[0])]);
    const piece = merged[3];
    expect(piece.supplementaryOf).toBe('r3');
    expect(baseReadId(piece)).toBe('r3');
    expect(piece.intervals).toEqual([[700, 1000, 0]]);
  });

  it('puts unlinked pieces at the end and hides them on request', () => {
    const unlinked = mergeOverlay(reads, overlay, { ...on, linkSplit: false }, 1000, 2000);
    // At the end; only the panel's reads have pieces (r9 is not in this panel).
    expect(unlinked.slice(-1).map(r => r.supplementaryOf)).toEqual(['r3']);
    expect(unlinked.some(r => r.supplementaryOf === 'r9')).toBe(false);
    const hidden = mergeOverlay(reads, overlay, { ...on, hideSupplementary: true }, 1000, 2000);
    expect(hidden.some(r => r.supplementary)).toBe(false);
  });
});

describe('alleles', () => {
  it('names and colours alleles, ambiguous apart', () => {
    expect(alleleName(0)).toBe('REF');
    expect(alleleName(2)).toBe('ALT 2');
    expect(alleleName(ALLELE_AMBIGUOUS)).toBe('ambiguous (DAF)');
    expect(alleleColor(ALLELE_AMBIGUOUS)).not.toBe(alleleColor(1));
  });
  it('finds a read\'s allele at a position', () => {
    const read = { var: [[1400, 3, 1]] } as FiberhmmRead;
    expect(alleleAt(read, 1402)).toEqual([1400, 3, 1]);
    expect(alleleAt(read, 1403)).toBeNull();
  });
  it('paints one mark per site in view, an outline for ambiguous', () => {
    const calls: string[] = [];
    const ctx = {
      save: () => {}, restore: () => {}, beginPath: () => {}, moveTo: () => {}, lineTo: () => {}, stroke: () => {},
      fillRect: () => calls.push('fill'), strokeRect: () => calls.push('outline'),
      set fillStyle(_v: string) {}, set strokeStyle(_v: string) {}, set lineWidth(_v: number) {},
    } as unknown as CanvasRenderingContext2D;
    drawReadVariantMarks(ctx, [[1400, 1, 1], [1600, 1, ALLELE_AMBIGUOUS], [5000, 1, 0]],
      { y: 0, rowHeight: 6, toX: rel => rel, viewStart: 1000, viewEnd: 2000, scale: 1 });
    expect(calls).toEqual(['fill', 'outline']);
  });
});

describe('split links', () => {
  it('pairs a read\'s rows and points at pieces outside the view', () => {
    const merged = mergeOverlay(reads, overlay, { ...DEFAULT_LAYER_SETTINGS, sv: true }, 1000, 2000);
    const { pairs, away } = splitLinks(merged, 0, merged.length - 1, 'chr1', 1000, 2000);
    expect(pairs).toEqual([[2, 3]]);
    expect(away).toEqual([{ row: 0, side: 'R', ref: 1990, label: 'chr1:5,001 +' }]);
  });
});

describe('settings in sessions', () => {
  it('restores known fields and clamps them', () => {
    expect(restoreLayerSettings({ fiberhmmLayerSettings: { ds: { sv: true, minMapq: 999, junk: 1 } } }).fiberhmmLayerSettings.ds)
      .toEqual({ sv: true, var: false, minMapq: 255, hideSupplementary: false, linkSplit: true, lift: null });
    expect(restoreLayerSettings(undefined).fiberhmmLayerSettings).toEqual({});
  });
});

describe('overlay read set', () => {
  it('asks for the read track\'s read set: QC-fail by choice, uncalled only with All reads', () => {
    const settings = { ...DEFAULT_LAYER_SETTINGS, sv: true, var: true };
    const plain = new URL(overlayQuery('ds', 'chr1', 0, 100, settings, 50)!, 'http://x').searchParams;
    expect(plain.has('include_qcfail')).toBe(false);
    expect(plain.has('hide_uncalled')).toBe(false);
    const both = new URL(overlayQuery('ds', 'chr1', 0, 100, settings, 50, { includeQcfail: true, hideUncalled: false })!,
      'http://x').searchParams;
    expect(both.get('include_qcfail')).toBe('true');
    expect(both.get('hide_uncalled')).toBe('false');
    // Different read sets are different cache entries.
    expect(overlayQuery('ds', 'chr1', 0, 100, settings, 50, { hideUncalled: false }))
      .not.toBe(overlayQuery('ds', 'chr1', 0, 100, settings, 50));
  });
});

describe('overlay pieces and the panel cohort', () => {
  const overlay = (pieces: Array<{ id: string; flag?: number }>) => ({
    dataset_id: 'ds', region: { chrom: 'chr1', start: 0, end: 1000 }, reads: {},
    pieces: pieces.map(p => ({ id: p.id, start: 100, end: 300, strand: '+', mapq: 60, flag: p.flag ?? 2048, sv: [] })),
  });
  const settings = { ...DEFAULT_LAYER_SETTINGS, sv: true, linkSplit: true, hideSupplementary: false };

  it('adds supplementary rows only for reads in the panel, and duplicates only when shown', () => {
    const reads = [{ id: 'ref1', intervals: [[0, 900, 0]] }] as unknown as CompactRead[];
    const rows = mergeOverlay(reads, overlay([{ id: 'ref1' }, { id: 'carrier9' }, { id: 'ref1', flag: 2048 | 0x400 }]) as FiberhmmOverlay,
      settings, 0, 1000);
    // A Reference split panel never gains the Carriers' pieces; the duplicate piece stays hidden.
    expect(rows.map(r => r.id)).toEqual(['ref1', supplementaryRowId({ id: 'ref1', start: 100 })]);
    const withDups = mergeOverlay(reads, overlay([{ id: 'ref1', flag: 2048 | 0x400 }]) as FiberhmmOverlay, settings, 0, 1000,
      { showDuplicates: true });
    expect(withDups).toHaveLength(2);
  });
});
