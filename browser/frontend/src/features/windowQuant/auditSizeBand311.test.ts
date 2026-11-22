/** Window quantification, size band (audit 3.1.1 #5): a footprint clipped to the view keeps its whole size and centre. */
import { describe, expect, it, vi } from 'vitest';

// One read over the view 1000–1300: a 147 bp nucleosome cut at the view's start (whole: 940–1087, sent as 0–87 with
// size 147), a 500 bp call wider than the view (sent as 0–300, centre unknown) and a whole 40 bp TF footprint at 1020–1060.
const reads = [{ id: 'r0', aligned_blocks: [[900, 1300]], intervals: [[0, 87, 147]], layers: { nuc: { intervals: [[0, 87, 147], [0, 300, 500]] }, tf: { intervals: [[20, 60, 40]] } } }];
vi.mock('../../api/sharedFetch', () => ({ fetchJson: vi.fn(async () => ({ reads, total_reads: 1 })) }));

import { bandCounts, cutBothEnds, loadSizeBand, sizeBandMeasures, SIZE_BAND_MEASURE } from './sources';
import { unitKey, type LoadContext } from './measures';

const ctx = { view: { chrom: 'chr1', start: 1000, end: 1300, genome: null }, bounds: { from: 1000, to: 1100 }, flankFraction: 0.1, sizeBand: [0, 90],
  readCap: 10, seed: 1, allReads: { panels: [{ key: 'p1', datasetId: 'ds', label: 'DS' }] } } as unknown as LoadContext;

describe('size band', () => {
  it('a clipped nucleosome is not a short footprint: its whole size picks the band', async () => {
    const m = sizeBandMeasures({ ...ctx, state: { datasets: [{ id: 'ds', available_layers: { nuc: true } }] } } as never);
    const d = await loadSizeBand(m, ctx);
    const u = d[SIZE_BAND_MEASURE].units!.get(unitKey('ds', 'r0'))!;
    // In the window: the nucleosome (whole centre 1013.5) and the TF; the wide call is left out; only the TF is in 0–90 bp.
    expect(u.slice(0, 2)).toEqual([1, 2]);
  });
  it('bandCounts takes a whole size when given, else the length', () => {
    expect(bandCounts([[940, 1087, 147]], [[1000, 1100]], [0, 90])).toEqual([0, 1]);
    expect(bandCounts([[1000, 1087]], [[1000, 1100]], [0, 90])).toEqual([1, 1]);
  });
});

describe('size band: a footprint wider than the view (audit 3.1.1 re-check #7)', () => {
  it('has no known centre and is not counted (it is cut at both ends)', () => {
    expect(cutBothEnds([1000, 1300, 500], { start: 1000, end: 1300 })).toBe(true);
    expect(cutBothEnds([1000, 1087, 147], { start: 1000, end: 1300 })).toBe(false);
    expect(cutBothEnds([1000, 1300], { start: 1000, end: 1300 })).toBe(false);
  });
});
