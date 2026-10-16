import { describe, expect, it } from 'vitest';
import { fitToolbar, nextGroupToFold, readsMinHeight } from './toolbarFit';

const base = { gap: 4, moreWidth: 60, overflowOrder: [4, 3, 2, 0, 1] };

describe('fitToolbar', () => {
  it('everything folded fits: nothing in More', () => {
    expect(fitToolbar({ ...base, available: 600, widths: [60, 70, 90, 100, 80] })).toEqual({ overflow: [] });
  });

  it('too narrow even folded: the least-used groups go to More, the rest keep their order', () => {
    const widths = [60, 70, 90, 100, 80];
    // 416 > 300; room = 300 - 60 - 4 = 236: drop 4 (80), 3 (100) -> 60+70+90+8 = 228.
    expect(fitToolbar({ ...base, available: 300, widths })).toEqual({ overflow: [3, 4] });
  });

  it('groups not in the overflow order never leave the row', () => {
    expect(fitToolbar({ ...base, overflowOrder: [2], available: 100, widths: [60, 70, 90] }).overflow).toEqual([2]);
  });

  it('no layout (jsdom): nothing overflows', () => {
    expect(fitToolbar({ ...base, available: 0, widths: [60, 70] })).toEqual({ overflow: [] });
  });
});

// Audit H5: at UI size 150% the toolbar left the reads no height at all.
describe('the reads keep their height', () => {
  it('half the window, never less than 300 px', () => {
    expect(readsMinHeight(700)).toBe(350);
    expect(readsMinHeight(800)).toBe(400);
    expect(readsMinHeight(500)).toBe(300);
  });

  const groups = [
    { id: 'reads', overflowRank: 3 }, { id: 'layers', overflowRank: 4 }, { id: 'cluster', overflowRank: 5 },
    { id: 'sort', overflowRank: 2 }, { id: 'quality', overflowRank: 0 },
  ];
  const none = new Set<string>();

  it('folds the least used open group first', () => {
    const open = new Set(['reads', 'cluster', 'sort']);
    expect(nextGroupToFold({ groups, open: id => open.has(id), folded: none, inMore: none, keep: null })).toBe('sort');
    expect(nextGroupToFold({ groups, open: id => open.has(id), folded: new Set(['sort']), inMore: none, keep: null })).toBe('reads');
  });

  it('never folds the group just opened, or one in More; none left: null', () => {
    const open = new Set(['reads', 'cluster', 'sort']);
    expect(nextGroupToFold({ groups, open: id => open.has(id), folded: none, inMore: new Set(['sort']), keep: 'reads' })).toBe('cluster');
    expect(nextGroupToFold({ groups, open: id => open.has(id), folded: new Set(['sort', 'reads']), inMore: none, keep: 'cluster' })).toBeNull();
  });
});
