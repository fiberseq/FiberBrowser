import { describe, expect, it } from 'vitest';
import { onTurnOf, alternativesFor, comparability, drawnBlocks, explain, frameBedRows, frameWindows, insideRibbon, refine, ribbonPoints, rotatedWindow, selectProposal, splitAtOrigin, splitForBars, visibleProposals, type ComparisonFrame, type SyncResult, type Proposal } from './model';
export const match: Proposal = {
  id: 'reverse', panelId: 'b', partnerId: 'a', rank: 0, template: [100, 900], window: [2100, 2900], strand: '-', sources: ['sequence'],
  metrics: { sequence: { verdict: 'supports', score: 1 } }, status: 'single-metric', confidence: 1, supports: 1, assessed: 1
};
export const result: SyncResult = {
  metrics: ['sequence'], windows: [{ panelId: 'a', datasetId: 'a', genome: null, chrom: 'chr1', start: 0, end: 1000, label: 'A' },
  { panelId: 'b', datasetId: 'b', genome: 'other', chrom: 'chr1', start: 2000, end: 3000, label: 'B' }], proposals: [match], coverage: { a: [[[0, 1000]], [[0, 200], [300, 1000]]], b: [[[0, 1000]]] }, notes: []
};
/** A chain across a 400-bp insertion in B: template [0, 300) ↔ B [0, 300), then [300, 600) ↔ [700, 1000). */
const chain: Proposal = {
  ...match, id: 'chain', strand: '+', template: [0, 600], window: [2000, 3000],
  blocks: [{ template: [0, 300], window: [2000, 2300] }, { template: [300, 600], window: [2700, 3000] }],
  gaps: [{ template: 300, window: 2300, inserted: 400, deleted: 0 }], indels: { inserted: 400, deleted: 0, count: 1 }
};
describe('comparison geometry', () => {
  it('crosses reverse ribbons, preserving endpoint correspondence', () => {
    expect(ribbonPoints([10, 30], [50, 70], 0, 100, '+')).toBe('10,0 30,0 70,100 50,100');
    expect(ribbonPoints([10, 30], [50, 70], 0, 100, '-')).toBe('10,0 30,0 50,100 70,100');
  });
  it('hit-tests trapezoid and hourglass ribbons', () => {
    expect(insideRibbon([10, 30], [50, 70], 0, 100, '+', 40, 50)).toBe(true);
    expect(insideRibbon([10, 30], [50, 70], 0, 100, '+', 10, 50)).toBe(false);
    expect(insideRibbon([0, 100], [0, 100], 0, 100, '-', 50, 50)).toBe(true);
    expect(insideRibbon([0, 100], [0, 100], 0, 100, '-', 10, 50)).toBe(false);
  });
  it('refines forward and reverse windows with equal frame lengths and clamps edges', () => {
    const chosen = selectProposal(result, match)!;
    const windows = frameWindows(result, refine(chosen, 200, 400));
    expect(windows.map(w => [w.start, w.end])).toEqual([[200, 400], [2600, 2800]]);
    expect(windows[1].blocks).toEqual([{ frame: [0, 200], genomic: [2600, 2800] }]);
    expect(refine(chosen, -100, 2000)).toMatchObject({ start: 100, end: 900 });
    expect(frameWindows(result, refine(chosen, 899, 200)).map(w => w.end - w.start)).toEqual([1, 1]);
    expect(windows[1].provenance).toMatchObject({ metric: 'sequence', score: 1, flags: ['single-metric'], scores: { sequence: 1 } });
  });
  it('maps a chain across an insertion block by block into one equal-length frame', () => {
    const r = { ...result, proposals: [chain] };
    const frame = frameWindows(r, refine(selectProposal(r, chain)!, 100, 500));
    expect(frame[0].blocks).toEqual([{ frame: [0, 400], genomic: [100, 500] }]);
    // The 400 inserted bases of B have no frame position; both sides of the insertion do.
    expect(frame[1].blocks).toEqual([{ frame: [0, 200], genomic: [2100, 2300] }, { frame: [200, 400], genomic: [2700, 2900] }]);
    expect([frame[1].start, frame[1].end]).toEqual([2100, 2900]);
    // Flipping reverses B along the frame without changing its bases.
    const flipped = frameWindows(r, refine(selectProposal(r, chain)!, 100, 500), { b: true });
    expect(flipped[1]).toMatchObject({ strand: '-', blocks: [{ frame: [0, 200], genomic: [2700, 2900] }, { frame: [200, 400], genomic: [2100, 2300] }] });
    const check = comparability(frame, { ...r, coverage: { a: [[[0, 1000]]], b: [[[0, 320]], [[0, 1000]]] } }, 400, 1);
    expect(check).toMatchObject({ equal: true, inside: true });
    expect(check.counts[1]).toMatchObject({ mapped: 400, count: 1, spanning: 1 });
  });
  it('draws a chain as blocks, joining only small indels', () => {
    expect(drawnBlocks(chain, 10)).toHaveLength(2);
    expect(drawnBlocks(chain, 500)).toEqual([{ template: [0, 600], window: [2000, 3000] }]);
  });
  it('requires shared support in every window, crops to their intersection and offers repeated copies', () => {
    const third: Proposal = { ...match, id: 'third', panelId: 'c', template: [400, 700], window: [2200, 2500] };
    const copy: Proposal = { ...third, id: 'copy', window: [2600, 2900], confidence: .9 };
    const more = { ...result, windows: [...result.windows, { ...result.windows[1], panelId: 'c' }], proposals: [match, third, copy] };
    expect(selectProposal(more, match)).toMatchObject({ start: 400, end: 700 });
    expect(selectProposal({ ...more, proposals: [match] }, match)).toBeNull();
    const chosen = selectProposal(more, match)!;
    expect(alternativesFor(more, chosen, 'c').map(p => p.id)).toEqual(['third', 'copy']);
    expect(selectProposal(more, { ...third, partnerId: 'b' })).toBeNull();
  });
  it('pools several copies of one window as separate frame windows (W3a, W3b)', () => {
    const third: Proposal = { ...match, id: 'third', panelId: 'c', strand: '+', template: [400, 700], window: [2200, 2500] };
    const copy: Proposal = { ...third, id: 'copy', template: [350, 680], window: [2650, 2980], confidence: .9 };
    const more = { ...result, windows: [...result.windows, { ...result.windows[1], panelId: 'c' }], proposals: [match, third, copy] };
    const both = selectProposal(more, match, { c: ['third', 'copy'] })!;
    expect(both).toMatchObject({ start: 400, end: 680 });
    const frame = frameWindows(more, both);
    expect(frame.map(w => [w.panelId, w.copy])).toEqual([['a', undefined], ['b', undefined], ['c', 'a'], ['c', 'b']]);
    expect(frame.slice(2).map(w => w.blocks)).toEqual([[{ frame: [0, 280], genomic: [2200, 2480] }], [{ frame: [0, 280], genomic: [2700, 2980] }]]);
    // A chosen copy that cannot cover a common stretch is not silently dropped.
    expect(selectProposal(more, match, { c: ['third', 'missing'] })).toBeNull();
  });
  it('counts reads covering a share of each window and those covering all of it', () => {
    const windows = frameWindows(result, selectProposal(result, match)!);
    const check = comparability(windows, result, 800, 1);
    expect(check).toMatchObject({ equal: true, inside: true, strands: true, reads: true });
    expect(check.counts.map(c => [c.panelId, c.count, c.spanning])).toEqual([['a', 2, 1], ['b', 1, 1]]);
    expect(comparability(windows, result, 800, 1, .9).counts[0].count).toBe(1);
    expect(comparability(windows, result, 800, 20).reads).toBe(false);
  });
  it('keeps the top proposals per window pair and the selected ones', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ ...match, id: `p${i}`, confidence: 1 - i / 10 }));
    expect(visibleProposals(many, 3).map(p => p.id)).toEqual(['p0', 'p1', 'p2']);
    expect(visibleProposals(many, 3, ['p4']).map(p => p.id)).toEqual(['p0', 'p1', 'p2', 'p4']);
    expect(visibleProposals(many, null)).toHaveLength(5);
  });
  it('rotates a circular window so a match across its origin sits inside', () => {
    const rotated = rotatedWindow({ start: 0, end: 12150 }, [11000, 12400], 12150);
    expect(rotated.end - rotated.start).toBe(12150);
    expect(rotated.start).toBeLessThanOrEqual(11000);
    expect(rotated.end).toBeGreaterThanOrEqual(12400);
  });
  it('explains each metric verdict in words, and whether the mapping is rigid or chained', () => {
    const p: Proposal = { ...match, metrics: { sequence: { verdict: 'supports', score: .98 }, nfr: { verdict: 'disagrees', score: .1, why: 'peaks +200 bp away (r 0.70)' }, accessibility: { verdict: 'abstains', score: null, why: 'flat or uncovered profile' } } };
    const labels = { sequence: 'Sequence', nfr: 'NFR', accessibility: 'Accessibility', anchor: 'Anchor' };
    expect(explain(p, labels).slice(0, 3)).toEqual([
      'Sequence supports (98% identity)', 'NFR disagrees (r 0.10): peaks +200 bp away (r 0.70)', 'Accessibility could not assess: flat or uncovered profile']);
    expect(explain({ ...p, rigid: true }, labels).at(-1)).toContain('Rigid: one offset');
    expect(explain(chain, labels).at(-1)).toContain('2 blocks; +400/−0 bp');
  });
});
describe('circular origins', () => {
  const plasmid: SyncResult = {
    metrics: ['sequence'], circular: { a: 1000, b: 800 },
    windows: [{ panelId: 'a', datasetId: 'a', genome: null, chrom: 'p1', start: 0, end: 1000, label: 'A' }, { panelId: 'b', datasetId: 'b', genome: null, chrom: 'p2', start: 0, end: 800, label: 'B' }],
    proposals: [], coverage: {}, notes: []
  };
  it('splits a window across its origin into blocks, on the template side too', () => {
    // Template [900, 1100) wraps A's origin; B [700, 900) wraps B's.
    const p: Proposal = { ...match, id: 'wrap', strand: '+', template: [900, 1100], window: [700, 900] };
    const r = { ...plasmid, proposals: [p] };
    const frame = frameWindows(r, selectProposal(r, p)!);
    expect(frame[0]).toMatchObject({ start: 900, end: 1100, contigLength: 1000, blocks: [{ frame: [0, 100], genomic: [900, 1000] }, { frame: [100, 200], genomic: [1000, 1100] }] });
    expect(frame[1]).toMatchObject({ start: 700, end: 900, contigLength: 800, blocks: [{ frame: [0, 100], genomic: [700, 800] }, { frame: [100, 200], genomic: [800, 900] }] });
    expect(splitAtOrigin([{ frame: [0, 200], genomic: [700, 900] }], '-', 800)).toEqual([{ genomic: [700, 800], frame: [100, 200] }, { genomic: [800, 900], frame: [0, 100] }]);
    // Drawn against one turn of each bar: the parts past an end come back at its start.
    const drawn = splitForBars({ template: [900, 1100], window: [700, 900] }, '+', plasmid.windows[0], 1000, plasmid.windows[1], 800);
    expect(drawn).toEqual([{ template: [900, 1000], window: [700, 800] }, { template: [0, 100], window: [0, 100] }]);
    // BED: one row per block in reference coordinates, frame coordinates in extra columns.
    const saved: ComparisonFrame = { id: 'f', name: 'A ↔ B', version: 2, status: 'accepted', templatePanelId: 'a', alignedOn: ['sequence'], length: 200, windows: frame };
    const rows = frameBedRows(saved, w => w.panelId.toUpperCase()).slice(1).map(r => r.split('\t'));
    expect(rows.map(r => r.slice(0, 3).concat(r.slice(5, 8)))).toEqual([
      ['p1', '900', '1000', '+', '0', '100'], ['p1', '0', '100', '+', '100', '200'], ['p2', '700', '800', '+', '0', '100'], ['p2', '0', '100', '+', '100', '200']]);
    expect(rows[0].slice(8)).toEqual(['A_↔_B', '2', 'A', 'main']);
    // A window across its origin is inside a whole-turn loaded window; its reads count on both sides.
    const check = comparability(frame, { ...r, coverage: { a: [[[0, 1000]]], b: [[[0, 800]]] } }, 200, 1);
    expect(check.inside).toBe(true);
    expect(check.counts[1]).toMatchObject({ count: 1, spanning: 1 });
    // A rotated loaded window [200, 1200) still holds a block across the reference origin.
    const rotated = { ...r, windows: [{ ...plasmid.windows[0], start: 200, end: 1200 }, plasmid.windows[1]], coverage: { a: [[[0, 1000]]], b: [[[0, 800]]] } };
    const wrapped = [{ ...frame[0], start: 1100, end: 1300, blocks: [{ frame: [0, 200], genomic: [1100, 1300] } as const].map(b => ({ frame: [...b.frame] as [number, number], genomic: [...b.genomic] as [number, number] })) }, frame[1]];
    const rotatedCheck = comparability(wrapped, rotated, 200, 1);
    expect(rotatedCheck.inside).toBe(true);
    expect(rotatedCheck.counts[0]).toMatchObject({ count: 1, spanning: 1 });
  });
  it('finds the common stretch of proposals on different turns of a circular template', () => {
    const a: Proposal = { ...match, id: 'one', strand: '+', template: [900, 1100], window: [0, 200] };
    const b: Proposal = { ...match, id: 'two', panelId: 'c', strand: '+', template: [0, 200], window: [300, 500] };
    const r = { ...plasmid, windows: [...plasmid.windows, { ...plasmid.windows[1], panelId: 'c' }], proposals: [a, b] };
    expect(selectProposal(r, a)).toMatchObject({ start: 1000, end: 1100 });
    expect(onTurnOf(b, a, 1000).template).toEqual([1000, 1200]);
    // The turn is chosen by the all-window intersection, not each proposal's own overlap.
    const first: Proposal = { ...match, id: 'f', strand: '+', template: [0, 900], window: [0, 900] };
    const second: Proposal = { ...match, id: 's', panelId: 'c', strand: '+', template: [700, 1300], window: [0, 600] };
    const third: Proposal = { ...match, id: 't', panelId: 'd', strand: '+', template: [750, 850], window: [0, 100] };
    const three = { ...plasmid, windows: [...plasmid.windows, { ...plasmid.windows[1], panelId: 'c' }, { ...plasmid.windows[1], panelId: 'd' }], proposals: [first, second, third] };
    expect(selectProposal(three, first)).toMatchObject({ start: 750, end: 850 });
  });
});
it('keeps the template gene strand when anchoring on reverse TSSs', () => {
  const anchored: SyncResult = {
    ...result, metrics: ['anchor'],
    windows: result.windows.map(w => ({ ...w, anchor: { position: w.start + 500, strand: '-', label: 'Gene TSS' } })),
    proposals: [{ ...match, strand: '+', sources: ['anchor'] }],
  };
  const selected = selectProposal(anchored, anchored.proposals[0])!;
  expect(frameWindows(anchored, selected).map(w => w.strand)).toEqual(['-', '-']);
});
