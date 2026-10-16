import '../testSetup';
import { describe, expect, it } from 'vitest';
import type { CompactRead } from '../../components/tracks/read-track/types';
import {
  axisTicks, computeLensProfile, consensusFasta, consensusMethod, describeAxisPosition, effectiveAnchor, insertsFasta,
  describeCarrier, interpolateKnots, layoutLens, lensParams, makeReadMapper, mapLensRead, pickCluster, profilesTsv,
  reverseComplement, targetForCluster, wrapFasta,
  type LensAxis, type LensEntry, type LensResponse,
} from './insertionLensModel';

const AXIS: LensAxis = { flank: 50, displayLen: 120, total: 220, reversed: false };

function entry(len: number, read: Partial<CompactRead> & Record<string, unknown>, extra: Partial<LensEntry> = {}): LensEntry {
  return { id: 'r', strand: '+', ref: 1000, ref_end: 1000, len, read: { id: 'r', intervals: [], ...read } as CompactRead, ...extra };
}

function response(over: Partial<LensResponse> = {}): LensResponse {
  return {
    success: true, chrom: 'chrT', flank: 50,
    site: { pos: 1000, tolerance: 50, len_min: 50, len_max: null },
    cluster: { ref: 1000, len: 100, len_lo: 90, len_hi: 110, carriers: 2, reference: 1 },
    carriers: [
      entry(90, { layers: { nuc: { intervals: [[-30, 0, 147], [0, 60, 147]] } } as never, methyl_m6a: [-5, 70] }, { id: 'a', knots: [[0, 0], [90, 120]] }),
      entry(110, { layers: { nuc: { intervals: [[10, 40, 30]] } } as never }, { id: 'b', strand: '-', knots: [[0, 0], [110, 120]] }),
    ],
    reference: [entry(0, { layers: { nuc: { intervals: [[-20, 0, 60], [0, 40, 60]] } } as never }, { id: 'ref' })],
    excluded: { other_insert: 0, not_informative: 0 },
    truncated: { carriers: 0, reference: 0 },
    consensus: { seq: 'ACGT'.repeat(30), length: 120, n_reads: 2, seconds: 0.1 },
    ...over,
  };
}

describe('read mapper', () => {
  it('places flanks and insert on one axis (left anchor)', () => {
    const m = makeReadMapper(100, AXIS, 'left');
    expect(m.interval(-20, 0)).toEqual([[30, 50]]);
    expect(m.interval(10, 30)).toEqual([[60, 80]]);
    expect(m.interval(100, 120)).toEqual([[170, 190]]);
    expect(m.point(-1)).toBe(49);
    expect(m.point(0)).toBe(50);
    expect(m.point(100)).toBe(170);
  });

  it('right-anchors, stretches and follows the consensus', () => {
    expect(makeReadMapper(100, AXIS, 'right').interval(10, 30)).toEqual([[80, 100]]);
    expect(makeReadMapper(100, AXIS, 'stretch').interval(50, 100)).toEqual([[110, 170]]);
    const knots: [number, number][] = [[0, 0], [40, 60], [100, 120]];
    expect(makeReadMapper(100, AXIS, 'consensus', knots).interval(0, 40)).toEqual([[50, 110]]);
    expect(makeReadMapper(100, AXIS, 'consensus', knots).point(70)).toBe(50 + 90);
  });

  it('clips a long insert at the display length in left mode, and a short one at 0 in right mode', () => {
    expect(makeReadMapper(140, AXIS, 'left').interval(110, 130)).toEqual([[160, 170]]);
    expect(makeReadMapper(140, AXIS, 'left').point(125)).toBeNull();
    expect(makeReadMapper(140, AXIS, 'right').interval(0, 30)).toEqual([[50, 60]]);
  });

  it('splits a call that straddles a breakpoint, whatever the anchor', () => {
    expect(makeReadMapper(100, AXIS, 'right').interval(-10, 20)).toEqual([[40, 50], [70, 90]]);
    expect(makeReadMapper(100, AXIS, 'left').interval(90, 110)).toEqual([[140, 150], [170, 180]]);
  });

  it('gives reference reads both flanks and no insert', () => {
    const m = makeReadMapper(0, AXIS, 'left');
    expect(m.interval(-10, 10)).toEqual([[40, 50], [170, 180]]);
    expect(m.point(0)).toBe(170);
    expect(m.point(-1)).toBe(49);
  });

  it('mirrors in the reversed view', () => {
    const m = makeReadMapper(100, { ...AXIS, reversed: true }, 'left');
    expect(m.interval(-20, 0)).toEqual([[170, 190]]);
    expect(m.interval(10, 30)).toEqual([[140, 160]]);
    expect(m.point(0)).toBe(219 - 50);
  });

  it('interpolates knots and extrapolates past the ends', () => {
    const knots: [number, number][] = [[0, 0], [10, 20], [20, 25]];
    expect(interpolateKnots(knots, 5)).toBe(10);
    expect(interpolateKnots(knots, 15)).toBe(22.5);
    expect(interpolateKnots(knots, 22)).toBe(27);
    expect(interpolateKnots(undefined, 7)).toBe(7);
  });
});

describe('mapLensRead', () => {
  it('moves intervals, marks and per-interval data together', () => {
    const read = mapLensRead(entry(100, {
      intervals: [[-60, 0, 147], [0, 87, 147]],
      qualities: [200, 210],
      layers: {
        nuc: { intervals: [[-60, 0, 147], [0, 87, 147]], qualities: [[200, 210], [1, 2]], quality_names: ['nq', 'lq'] },
      } as never,
      methyl_m6a: [-5, 3, 99, 500],
      deam: [[-5, 1], [3, 0]],
      straddles: [{ layer: 'nuc', start: -60, end: 87, size: 147, side: 'L' }],
    }), { ...AXIS, reversed: true }, 'left');
    // Reversed: right of the axis is the left flank; intervals stay sorted by start.
    expect(read.intervals).toEqual([[83, 170, 147], [170, 220, 147]]);
    expect(read.qualities).toEqual([210, 200]);
    expect(read.layers?.nuc.qualities).toEqual([[210, 200], [2, 1]]);
    expect(read.layers?.nuc.quality_names).toEqual(['nq', 'lq']);
    expect(read.methyl_m6a).toEqual([70, 166, 174]);
    expect(read.deam).toEqual([[166, 0], [174, 1]]);
    expect('straddles' in read).toBe(false);
  });
});

describe('layoutLens', () => {
  it('uses the consensus length, and falls back to stretch without a consensus', () => {
    const lens = layoutLens(response(), 'consensus', false);
    expect(lens.axis).toEqual({ flank: 50, displayLen: 120, total: 220, reversed: false });
    expect(lens.anchor).toBe('consensus');
    // Read a: 90 bp onto 120 consensus bases, its nucleosome straddling the left breakpoint.
    expect(lens.carriers[0].layers?.nuc.intervals).toEqual([[20, 50, 147], [50, 130, 147]]);
    expect(lens.carrierRows.map(r => r.id)).toEqual(['a', 'b']);
    const noCons = response({ consensus: undefined });
    expect(effectiveAnchor(noCons, 'consensus')).toBe('stretch');
    expect(layoutLens(noCons, 'consensus', false).axis.displayLen).toBe(100);
  });

  it('describes axis positions and draws breakpoint ticks', () => {
    const lens = layoutLens(response(), 'left', false);
    expect(describeAxisPosition(10, lens.axis, response(), 'left')).toBe('left flank chrT:960');
    expect(describeAxisPosition(60, lens.axis, response(), 'left')).toBe('insert base 11 of 120');
    expect(describeAxisPosition(180, lens.axis, response(), 'left')).toBe('right flank chrT:1,010');
    const ticks = axisTicks(lens.axis);
    expect(ticks.filter(t => t.major).map(t => t.X)).toEqual([50, 170]);
    expect(axisTicks({ ...lens.axis, reversed: true }).filter(t => t.major).map(t => t.X)).toEqual([170, 50]);
  });
});

describe('profiles', () => {
  it('gives occupancy and mark rate per covered base, and no data where a group has no reads', () => {
    const reads = [
      { id: 'a', intervals: [[0, 100, 0]], layers: { nuc: { intervals: [[0, 50, 50]] }, msp: { intervals: [[50, 100, 50]] } }, methyl_m6a: [60, 70, 80] },
      { id: 'b', intervals: [[0, 50, 0]], layers: { nuc: { intervals: [[0, 50, 50]] } } },
    ] as unknown as CompactRead[];
    const p = computeLensProfile(reads, 200, 4);
    expect(p.bins).toBe(4);
    expect(p.coverage).toEqual([2, 1, 0, 0]);
    expect(p.nuc).toEqual([1, 0, null, null]);
    expect(p.msp).toEqual([0, 1, null, null]);
    expect(p.marks[1]).toBeCloseTo(6);
    expect(p.marks[0]).toBe(0);
    const tsv = profilesTsv({ flank: 50, displayLen: 100, total: 200, reversed: false }, [{ label: 'carriers', profile: p }]);
    expect(tsv.split('\n')[0]).toBe('bin_start\tbin_end\tcarriers_reads\tcarriers_nuc_frac\tcarriers_msp_frac\tcarriers_marks_per_100bp');
    expect(tsv.split('\n')[1].startsWith('-50.0\t0.0\t2.00\t1.0000')).toBe(true);
  });
});

describe('sequences and targets', () => {
  it('writes FASTA, reverse-complementing in the reversed view', () => {
    expect(reverseComplement('AACGTn')).toBe('nACGTT');
    expect(wrapFasta('x', 'ACGTACGT', 3)).toBe('>x\nACG\nTAC\nGT\n');
    const res = response({ consensus: { seq: 'AAAC', length: 4, n_reads: 2, seconds: 0 } });
    expect(consensusFasta(res, false)).toContain('>ins_chrT_1000_len100_n2 consensus of 2 carrier reads');
    expect(consensusFasta(res, true).split('\n')[1]).toBe('GTTT');
    const fasta = insertsFasta([{ ...res.carriers[0], seq: 'ACG' }, res.carriers[1]], res, false);
    expect(fasta).toBe('>a ins_chrT_1000_len100 strand=+ len=90\nACG\n');
  });

  it('says how the consensus was built: DAF-aware (FiberHMM) or majority vote, and why not DAF-aware', () => {
    const daf = response({ consensus: { seq: 'ACGT', length: 4, n_reads: 24, seconds: 0, method: 'daf',
      method_label: 'DAF-aware (FiberHMM)', confident_fraction: 0.97, carriers_ct: 20, carriers_ga: 4 },
      run_consensus: { path: '/x/qc/a.insert_consensus.json', used: true, carriers: 24, confident_fraction: 0.95 } });
    const method = consensusMethod(daf);
    expect(method.label).toBe('DAF-aware (FiberHMM)');
    expect(method.title).toContain('20 C→T and 4 G→A carriers voted');
    expect(method.title).toContain('97% of columns confident');
    expect(method.title).toContain("The run called this insertion against FiberHMM's consensus (24 carriers, 95% confident columns)");
    expect(consensusFasta(daf, false)).toContain('(FiberBrowser insertion lens, DAF-aware (FiberHMM))');
    const old = consensusMethod(response({ consensus: { seq: 'ACGT', length: 4, n_reads: 3, seconds: 0, method: 'majority',
      method_label: 'majority vote', fallback: 'the FiberHMM this Browser runs has no DAF-aware insert consensus' } }));
    expect(old.label).toBe('majority vote');
    expect(old.title).toContain('Not DAF-aware: the FiberHMM this Browser runs has no DAF-aware insert consensus');
    expect(consensusMethod({ consensus: undefined }).label).toBe('');
  });

  it('builds a target from a cluster and the request from a target', () => {
    const cluster = { ref: 15000, len: 2012, carriers: 24 };
    const target = targetForCluster(cluster, 'ds1', 'chrT', { flank: 2000, anchor: 'left' });
    expect(target).toMatchObject({ pos: 15000, ref: 15000, len: 2012, tolerance: 50, lenMin: 1609, lenMax: 2415, flank: 2000, anchor: 'left', reversed: false });
    const params = lensParams(target, { include_sequences: 'true' });
    expect(Object.fromEntries(params)).toEqual({
      chrom: 'chrT', pos: '15000', dataset_id: 'ds1', tolerance: '50', len_min: '1609', flank: '2000',
      include_sequences: 'true', len_max: '2415', ref: '15000', length: '2012',
    });
    expect(lensParams({ ...target, lenMax: null }).has('len_max')).toBe(false);
    // An older session's target (no ref/len) asks the server to find the cluster at pos.
    expect(lensParams({ ...target, ref: undefined, len: undefined }).has('ref')).toBe(false);
  });

  it('picks the cluster with most carriers, the nearest on ties', () => {
    const c = (ref: number, carriers: number) => ({ ref, len: 100, carriers });
    expect(pickCluster([c(100, 2), c(500, 9), c(120, 9)], 130)?.ref).toBe(120);
    expect(pickCluster([], 0)).toBeNull();
  });
});

describe('Codex review regressions', () => {
  it('swaps paired edge qualities when the lens is mirrored', () => {
    const layers = {
      tf: { intervals: [[10, 30, 20]], qualities: [[200], [11], [22]], quality_names: ['tq', 'el', 'er'] },
      nuc: { intervals: [[40, 60, 20]], qualities: [[1], [2], [3], [4]], quality_names: ['nq', 'mq', 'lq', 'rq'] },
    };
    const forward = mapLensRead(entry(100, { layers } as never), AXIS, 'left');
    expect(forward.layers?.tf.qualities).toEqual([[200], [11], [22]]);
    const mirrored = mapLensRead(entry(100, { layers } as never), { ...AXIS, reversed: true }, 'left');
    expect(mirrored.layers?.tf.qualities).toEqual([[200], [22], [11]]);
    expect(mirrored.layers?.nuc.qualities).toEqual([[1], [2], [4], [3]]);
  });

  it('projects each piece\'s whole-call extent within its own segment', () => {
    const read = mapLensRead(entry(100, {
      layers: { tf: { intervals: [[-60, 0, 147], [0, 87, 147]], source_intervals: [[-60, 87, 147], [-60, 87, 147]] } },
    } as never), AXIS, 'right');
    // Left piece: [-60, 0) in the left flank; right piece: [0, 87) moved with the right-anchored insert.
    expect(read.layers?.tf.intervals).toEqual([[0, 50, 147], [70, 157, 147]]);
    expect(read.layers?.tf.source_intervals).toEqual([[-10, 50, 147], [70, 157, 147]]);
  });
});

describe('clipped carriers', () => {
  it('draws the start of the insert from the left breakpoint in every anchor mode', () => {
    for (const anchor of ['left', 'right', 'stretch'] as const) {
      const m = makeReadMapper(40, AXIS, anchor, undefined, 'start');
      expect(m.interval(0, 40)).toEqual([[50, 90]]);
      expect(m.interval(-20, 0)).toEqual([[30, 50]]);
    }
  });

  it('draws the end of the insert up to the right breakpoint, then the right flank', () => {
    for (const anchor of ['left', 'right', 'stretch'] as const) {
      const m = makeReadMapper(30, AXIS, anchor, undefined, 'end');
      expect(m.interval(0, 30)).toEqual([[140, 170]]);
      expect(m.interval(30, 50)).toEqual([[170, 190]]);
    }
    // Consensus mode: the knots already carry the offset into the consensus.
    const c = makeReadMapper(30, AXIS, 'consensus', [[0, 90], [30, 120]], 'end');
    expect(c.interval(0, 30)).toEqual([[140, 170]]);
  });

  it('places a hard-clipped carrier\'s flank only', () => {
    const left = makeReadMapper(0, AXIS, 'left', undefined, 'start');
    expect(left.interval(-30, 0)).toEqual([[20, 50]]);
    const right = makeReadMapper(0, AXIS, 'left', undefined, 'end');
    expect(right.interval(0, 20)).toEqual([[170, 190]]);
  });

  it('says what each carrier row is', () => {
    expect(describeCarrier({ id: 'a', strand: '+', len: 900, carrier: true, identity: 0.98 }))
      .toBe('insert 900 bp · 98.0% identity to consensus');
    expect(describeCarrier({ id: 'b', strand: '+', len: 600, carrier: true, partial: 'start', clipLen: 600, sa: true }))
      .toBe("clipped (600 bp, rest in a supplementary alignment): the insert's first 600 bp from the soft clip");
    expect(describeCarrier({ id: 'c', strand: '-', len: 0, carrier: true, partial: 'start', clipLen: 900, hard: true }))
      .toContain('the inserted bases are not in this record');
  });

  it('labels a clipped carrier\'s inserted bases in the FASTA', () => {
    const res = response();
    const fasta = insertsFasta([{ ...res.carriers[0], seq: 'ACG', partial: 'end', kind: 'clip' }], res, false);
    expect(fasta.split('\n')[0]).toBe('>a ins_chrT_1000_len100 strand=+ len=90 partial=end (clipped read)');
  });
});
