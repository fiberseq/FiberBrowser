import { describe, expect, it } from 'vitest';
import { multiwayBlocks, orderWindows, pairProposals, selectBlock, selectProposal, frameWindows, type Proposal, type SyncResult } from './model';
const base: Omit<Proposal, 'id' | 'panelId' | 'partnerId' | 'template' | 'window'> = {
  rank: 0, strand: '+', sources: ['sequence'], metrics: { sequence: { verdict: 'supports', score: 1 } }, status: 'single-metric', confidence: .9, supports: 1, assessed: 1
};
const p = (id: string, partnerId: string, panelId: string, template: [number, number], window: [number, number], extra: Partial<Proposal> = {}): Proposal => ({ ...base, id, partnerId, panelId, template, window, ...extra });
const win = (panelId: string) => ({ panelId, datasetId: panelId, genome: null, chrom: panelId, start: 0, end: 10000, label: panelId.toUpperCase() });
const result = (proposals: Proposal[], ids = ['a', 'b', 'c']): SyncResult => ({ metrics: ['sequence'], windows: ids.map(win), proposals, coverage: {}, notes: [] });
describe('multi-way blocks', () => {
  it('ties pairwise matches into one block across three windows, transitively', () => {
    // a 1000–2000 ↔ b 3000–4000, a ↔ c 5000–6000, b ↔ c (consistent: b 3000 ↔ c 5000).
    const r = result([p('ab', 'a', 'b', [1000, 2000], [3000, 4000]), p('ac', 'a', 'c', [1000, 2000], [5000, 6000]), p('bc', 'b', 'c', [3000, 4000], [5000, 6000])]);
    const blocks = multiwayBlocks(r);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ coverage: 3, total: 3, inconsistent: [] });
    expect(blocks[0].members.map(m => [m.panelId, m.intervals])).toEqual([['a', [[1000, 2000]]], ['b', [[3000, 4000]]], ['c', [[5000, 6000]]]]);
    // b ↔ c alone (no a ↔ c) still joins c through b.
    const chain = multiwayBlocks(result([p('ab', 'a', 'b', [1000, 2000], [3000, 4000]), p('bc', 'b', 'c', [3000, 4000], [5000, 6000])]));
    expect(chain[0].coverage).toBe(3);
  });
  it('flags a triangle whose direct mapping disagrees with the one through the third window', () => {
    const r = result([p('ab', 'a', 'b', [1000, 2000], [3000, 4000]), p('ac', 'a', 'c', [1000, 2000], [5000, 6000]), p('bc', 'b', 'c', [3000, 4000], [5600, 6600])]);
    const [blk] = multiwayBlocks(r);
    expect(blk.inconsistent.length).toBeGreaterThan(0);
    expect(blk.inconsistent[0].offBy).toBeGreaterThanOrEqual(500);
  });
  it('ranks by coverage, keeps copies of one window apart and orients pairs both ways', () => {
    const r = result([p('ab', 'a', 'b', [1000, 2000], [3000, 4000]), p('ab2', 'a', 'b', [1000, 2000], [7000, 8000], { confidence: .8 }), p('ac', 'a', 'c', [8000, 8500], [100, 600], { confidence: 1 })]);
    const blocks = multiwayBlocks(r);
    expect(blocks.find(b => b.members.some(m => m.panelId === 'b'))!.members.find(m => m.panelId === 'b')!.intervals).toEqual([[3000, 4000], [7000, 8000]]);
    expect(blocks.map(b => b.coverage)).toEqual([2, 2]);
    expect(pairProposals(r.proposals, 'b', 'a')[0]).toMatchObject({ partnerId: 'b', panelId: 'a', template: [3000, 4000], window: [1000, 2000] });
    expect(orderWindows(r).map(w => w.panelId)).toEqual(['a', 'b', 'c']);
  });
  it('builds a frame from a block, one window per copy, leaving out windows outside it', () => {
    const r = result([p('ab', 'a', 'b', [1000, 2000], [3000, 4000]), p('ab2', 'a', 'b', [1000, 2000], [7000, 8000]), p('ac', 'a', 'c', [8000, 8500], [100, 600])]);
    const [blk] = multiwayBlocks(r);
    const sel = selectBlock(r, blk)!;
    expect(sel.excluded).toEqual(['c']);
    const frame = frameWindows(r, sel);
    expect(frame.map(w => [w.panelId, w.copy ?? ''])).toEqual([['a', ''], ['b', 'a'], ['b', 'b']]);
    // A proposal whose stretch one window lacks: partial frames leave it out instead of failing.
    expect(selectProposal(r, r.proposals[0])).toBeNull();
    expect(selectProposal(r, r.proposals[0], {}, true)).toMatchObject({ start: 1000, end: 2000, excluded: ['c'] });
    // A block without the template cannot start a frame.
    expect(selectBlock(r, { ...blk, members: blk.members.filter(m => m.panelId !== 'a') })).toBeNull();
  });
});
it('leaves disputed and sequence-contradicted proposals out of blocks', () => {
  const r = result([p('ab', 'a', 'b', [1000, 2000], [3000, 4000]), p('bad', 'a', 'c', [1000, 2000], [5000, 6000], { status: 'disagreement', flags: ['contradicted-by-sequence', 'chromatin-only'] })]);
  expect(multiwayBlocks(r).map(b => b.coverage)).toEqual([2]);
});

describe('multi-way blocks, the details', () => {
  it('joins stretches by aligned bases, not by a chain envelope across a gap', () => {
    const chain = p('ab', 'a', 'b', [0, 3000], [0, 3000], { blocks: [{ template: [0, 500], window: [0, 500] }, { template: [2500, 3000], window: [2500, 3000] }] });
    const r = result([chain, p('ac', 'a', 'c', [1000, 2000], [5000, 6000])]);
    expect(multiwayBlocks(r).map(b => b.coverage)).toEqual([2, 2]);
  });
  it('flags a triangle whose strands do not compose', () => {
    const r = result([p('ab', 'a', 'b', [0, 1000], [0, 1000]), p('ac', 'a', 'c', [0, 1000], [0, 1000]), p('bc', 'b', 'c', [0, 1000], [0, 1000], { strand: '-' })]);
    expect(multiwayBlocks(r)[0].inconsistent.length).toBeGreaterThan(0);
  });
  it('merges the stretches of a window to a fixed point, whatever the order', () => {
    const r = result([p('x1', 'a', 'b', [0, 100], [0, 100]), p('x2', 'a', 'b', [100, 200], [100, 200]), p('x3', 'a', 'b', [50, 150], [50, 150])]);
    expect(multiwayBlocks(r)[0].members.find(m => m.panelId === 'a')!.intervals).toEqual([[0, 200]]);
  });
  it('selects a block with its own proposals only, naming windows reached only through another', () => {
    const r = result([p('ab', 'a', 'b', [1000, 2000], [3000, 4000]), p('bc', 'b', 'c', [3000, 4000], [5000, 6000])]);
    const [blk] = multiwayBlocks(r);
    expect(blk.coverage).toBe(3);
    const sel = selectBlock(r, blk)!;
    expect(sel.excluded).toEqual(['c']);
    expect(sel.transitive).toEqual(['c']);
    // A contradicted a -> c left out of the block does not come back through the selection.
    const r2 = result([p('ab', 'a', 'b', [1000, 2000], [3000, 4000]), p('ac', 'a', 'c', [1000, 2000], [5000, 6000], { status: 'disagreement', flags: ['contradicted-by-sequence'] })]);
    const sel2 = selectBlock(r2, multiwayBlocks(r2)[0])!;
    expect(sel2.matches.map(m => m.id)).toEqual(['ab']);
    expect(sel2.excluded).toEqual(['c']);
  });
  it('re-reads indel gaps when a reverse chain is seen from the other side', () => {
    const rev = p('rev', 'a', 'b', [0, 500], [500, 1250], { strand: '-', blocks: [{ template: [0, 200], window: [1050, 1250] }, { template: [300, 500], window: [500, 700] }], gaps: [{ template: 200, window: 1050, inserted: 350, deleted: 100 }] });
    const swapped = pairProposals([rev], 'b', 'a')[0];
    expect(swapped.gaps).toEqual([{ template: 700, window: 300, inserted: 100, deleted: 350 }]);
  });
});
describe('multi-way blocks, second pass', () => {
  it('needs the chosen proposal itself to align over the selected stretch', () => {
    const ab = p('ab', 'a', 'b', [0, 3000], [0, 3000], { blocks: [{ template: [0, 500], window: [0, 500] }, { template: [2500, 3000], window: [2500, 3000] }] });
    const r = result([ab, p('ac', 'a', 'c', [1000, 2000], [5000, 6000])]);
    const sel = selectProposal(r, ab, {}, true)!;
    expect(sel.matches.map(m => m.id)).toEqual(['ab']);
    expect(sel.excluded).toEqual(['c']);
  });
  it('checks triangle strands at aligned positions even when the envelopes have gaps', () => {
    const gapped = (extra: Partial<Proposal>) => ({ blocks: [{ template: [0, 200] as [number, number], window: [0, 200] as [number, number] }, { template: [800, 1000] as [number, number], window: [800, 1000] as [number, number] }], ...extra });
    const r = result([p('ab', 'a', 'b', [0, 1000], [0, 1000], gapped({})), p('ac', 'a', 'c', [0, 1000], [0, 1000], gapped({})),
      p('bc', 'b', 'c', [0, 1000], [0, 1000], gapped({ strand: '-', blocks: [{ template: [0, 200], window: [800, 1000] }, { template: [800, 1000], window: [0, 200] }] }))]);
    expect(multiwayBlocks(r)[0].inconsistent.length).toBeGreaterThan(0);
  });
  it('groups the stretches of a window the same way in any order', () => {
    const order = (ivs: [number, number][]) => multiwayBlocks(result(ivs.map((iv, i) => p(`x${i}`, 'a', 'b', iv, [1000 + iv[0], 1000 + iv[1]])))).flatMap(b => b.members.find(m => m.panelId === 'a')!.intervals).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    const ivs: [number, number][] = [[80, 160], [30, 90], [70, 160], [20, 50]];
    expect(order(ivs)).toEqual(order([...ivs].reverse()));
  });
});
describe('multi-way blocks, third pass', () => {
  it('still selects a gapped chain on its own aligned stretches', () => {
    const ab = p('ab', 'a', 'b', [0, 3000], [0, 3000], { blocks: [{ template: [0, 500], window: [0, 500] }, { template: [2500, 3000], window: [2500, 3000] }] });
    const r = result([ab], ['a', 'b']);
    const sel = selectProposal(r, ab)!;
    expect(sel).not.toBeNull();
    expect(sel.end - sel.start).toBeGreaterThanOrEqual(500);
    expect(selectBlock(r, multiwayBlocks(r)[0])).not.toBeNull();
  });
  it('finds a strand contradiction only where all three legs align', () => {
    const blocks = (ivs: [number, number][], map: (x: number) => number = x => x) => ivs.map(([a, b]) => ({ template: [a, b] as [number, number], window: (map === undefined ? [a, b] : [Math.min(map(a), map(b - 1)), Math.max(map(a), map(b - 1)) + 1]) as [number, number] }));
    const r = result([
      p('ab', 'a', 'b', [0, 900], [0, 900], { blocks: blocks([[0, 500], [600, 900]]) }),
      p('ac', 'a', 'c', [0, 1000], [0, 1000], { blocks: blocks([[0, 200], [400, 500], [800, 1000]]) }),
      p('cb', 'c', 'b', [0, 1000], [0, 1000], { strand: '-', blocks: blocks([[0, 100], [200, 400], [600, 800], [900, 1000]], x => 999 - x) }),
    ]);
    expect(multiwayBlocks(r)[0].inconsistent.length).toBeGreaterThan(0);
  });
});
describe('multi-way blocks, fourth pass', () => {
  it('prefers the stretch a match aligns over to a gapped envelope', () => {
    const r = result([p('ab', 'a', 'b', [0, 1000], [0, 1000]),
      p('gap', 'a', 'c', [0, 1000], [0, 1000], { confidence: .9, blocks: [{ template: [0, 10], window: [0, 10] }, { template: [990, 1000], window: [990, 1000] }] }),
      p('solid', 'a', 'c', [0, 900], [2000, 2900], { confidence: .8 })]);
    const sel = selectProposal(r, r.proposals[0])!;
    expect(sel.matches.map(m => m.id)).toContain('solid');
  });
  it('finds a contradiction confined to tiny three-leg stretches', () => {
    const r = result([
      p('ab', 'a', 'b', [0, 1000], [0, 1000], { blocks: [{ template: [0, 401], window: [0, 401] }, { template: [599, 1000], window: [599, 1000] }] }),
      p('ac', 'a', 'c', [0, 1000], [0, 1000], { blocks: [{ template: [300, 700], window: [300, 700] }] }),
      p('cb', 'c', 'b', [0, 1000], [0, 1000], { strand: '-', blocks: [{ template: [400, 401], window: [599, 600] }, { template: [599, 600], window: [400, 401] }] }),
    ]);
    expect(multiwayBlocks(r)[0].inconsistent.length).toBeGreaterThan(0);
  });
});
describe('multi-way blocks, triangle checks in every block (Codex on a720581d)', () => {
  it('finds a contradiction confined to a short block', () => {
    const quarters: [number, number][] = [[0, 1000], [1100, 2100], [2200, 3200], [3300, 4290]];
    const same = quarters.map(q => ({ template: q, window: q }));
    const shifted = quarters.map((q, i) => ({ template: q, window: (i === 3 ? [q[0] + 200, q[1] + 200] : q) as [number, number] }));
    const r = result([p('ab', 'a', 'b', [0, 4290], [0, 4290]), p('ac', 'a', 'c', [0, 4290], [0, 4290], { blocks: same }),
      p('cb', 'c', 'b', [0, 4290], [0, 4490], { blocks: shifted })]);
    const blk = multiwayBlocks(r)[0];
    expect(blk.inconsistent.length).toBeGreaterThan(0);
    expect(blk.inconsistent[0].offBy).toBe(200);
  });
});
