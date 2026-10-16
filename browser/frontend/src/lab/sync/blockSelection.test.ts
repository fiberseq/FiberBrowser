import { describe, expect, it } from 'vitest';
import { defaultMembers, selectableBlocks, selectionForMembers, mergeBlockFrames } from './blockSelection';
import { frameWindows, type Proposal, type SyncResult, type Interval, type ComparisonFrame } from './model';
import { restoreSync } from './syncState';

const p = (id: string, partnerId: string, panelId: string, template: Interval, window: Interval, extra: Partial<Proposal> = {}): Proposal => ({
  id, partnerId, panelId, template, window, rank: 0, strand: '+', sources: ['sequence'],
  metrics: { sequence: { verdict: 'supports', score: 1 } }, status: 'single-metric', confidence: 1, supports: 1, assessed: 1, ...extra,
});
const result = (proposals: Proposal[], ids = ['a', 'b', 'c', 'd']): SyncResult => ({
  windows: ids.map(panelId => ({ panelId, datasetId: panelId, genome: panelId, chrom: panelId, start: 0, end: 10000, label: panelId })),
  metrics: ['sequence'], proposals, coverage: {}, notes: [],
});
const frame = (r: SyncResult, index = 0): ComparisonFrame => {
  const block = selectableBlocks(r)[index];
  const { selection } = selectionForMembers(r, block, defaultMembers([block]));
  expect(selection).toBeTruthy();
  return { id: `f${index}`, name: 'Group', version: 1, status: 'accepted', templatePanelId: selection!.templateId!,
    length: selection!.end - selection!.start, windows: frameWindows(r, selection!), alignedOn: ['sequence'] };
};

describe('block member selection', () => {
  it.each([2, 3, 4, 6])('accepts a transitive chain of %i windows', count => {
    const ids = Array.from({ length: count }, (_, i) => String(i));
    const r = result(ids.slice(1).map((id, i) => p(id, ids[i], id, [100, 1100], [100, 1100])), ids);
    const f = frame(r);
    expect(f.windows).toHaveLength(count);
    expect(restoreSync({ comparisonFrames: [f] }).comparisonFrames).toHaveLength(1);
  });

  it('combines three copies with two other windows and can omit a connecting member', () => {
    const r = result([p('aa', 'a', 'a', [100, 600], [1000, 1500]), p('aaa', 'a', 'a', [1000, 1500], [2000, 2500]),
      p('ab', 'a', 'b', [2000, 2500], [3000, 3500]), p('bc', 'b', 'c', [3000, 3500], [4000, 4500])]);
    const [block] = selectableBlocks(r);
    expect(block.choices).toHaveLength(5);
    expect(frame(r).windows.map(w => [w.panelId, w.copy])).toEqual([['a', 'a'], ['a', 'b'], ['a', 'c'], ['b', undefined], ['c', undefined]]);
    const selected = block.choices.filter(c => c.panelId !== 'b').map(c => c.key);
    const s = selectionForMembers(r, block, selected).selection!;
    expect(frameWindows(r, s).map(w => w.panelId)).toEqual(['a', 'a', 'a', 'c']);
  });

  it('accepts a block without the first window', () => {
    const f = frame(result([p('bc', 'b', 'c', [100, 600], [2000, 2500])]));
    expect(f.templatePanelId).toBe('b');
    expect(f.windows.map(w => w.panelId)).toEqual(['b', 'c']);
  });

  it('composes reversed members through indels without filling their gaps', () => {
    const r = result([p('ab', 'a', 'b', [100, 400], [1000, 1400], { strand: '-', blocks: [
      { template: [100, 200], window: [1300, 1400] }, { template: [300, 400], window: [1000, 1100] },
    ] }), p('bc', 'b', 'c', [1000, 1400], [5000, 5400])]);
    const f = frame(r);
    expect(f.windows[2].strand).toBe('-');
    expect(f.windows[2].blocks).toEqual([{ frame: [0, 100], genomic: [5300, 5400] }, { frame: [200, 300], genomic: [5000, 5100] }]);
    expect(restoreSync({ comparisonFrames: [f] }).comparisonFrames).toHaveLength(1);
  });

  it('does not precheck an inconsistent triangle, explains it, and allows a consistent subset', () => {
    const r = result([p('ab', 'a', 'b', [0, 1000], [0, 1000]), p('bc', 'b', 'c', [0, 1000], [0, 1000]), p('ac', 'a', 'c', [0, 1000], [0, 1000], { strand: '-' })]);
    const [b] = selectableBlocks(r);
    expect(defaultMembers([b])).toEqual([]);
    expect(selectionForMembers(r, b, b.choices.map(c => c.key)).error).toContain('different positions');
    expect(selectionForMembers(r, b, b.choices.slice(0, 2).map(c => c.key)).selection).toBeTruthy();
  });

  it('merges two disjoint blocks as gapped windows and round-trips them through sessions', () => {
    const r = result([p('ab', 'a', 'b', [100, 200], [1000, 1100]), p('ab2', 'a', 'b', [300, 400], [1300, 1400])]);
    const merged = mergeBlockFrames([frame(r, 0), frame(r, 1)]);
    expect(merged.length).toBe(200);
    expect(merged.windows[0].blocks).toEqual([{ frame: [0, 100], genomic: [100, 200] }, { frame: [100, 200], genomic: [300, 400] }]);
    expect(restoreSync({ comparisonFrames: [merged] }).comparisonFrames).toHaveLength(1);
  });
});
