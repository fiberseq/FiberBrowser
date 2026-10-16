import { describe, expect, it } from 'vitest';
import { actionableIndices, buildReadMenu, clampMenuPosition, type ReadMenuContext, type ReadMenuItem } from './readMenuModel';

const base: ReadMenuContext = {
  readId: 'm1/1/ccs', footprint: { label: '147 bp, nuc' }, readSelected: false, selectedCount: 0,
  hasReadFilter: false, excludedCount: 0, readHighlighted: false, anyHighlight: false, isMac: true,
};
const items = (ctx: Partial<ReadMenuContext> = {}) =>
  buildReadMenu({ ...base, ...ctx }).filter((e): e is ReadMenuItem => e.kind === 'item');
const byAction = (ctx: Partial<ReadMenuContext>, action: string) => items(ctx).find(i => i.action === action);

/** fb-r4-clicks: the right-click menu on reads. */
describe('read context menu', () => {
  it('offers every read action, with the clicks that do the same', () => {
    const actions = items().map(i => i.action);
    expect(actions).toEqual(expect.arrayContaining([
      'select-read', 'select-footprint', 'open-read-stats', 'copy-read-name', 'copy-read-locus',
      'highlight-read', 'zoom-to-read', 'copy-selected-names', 'keep-selected', 'exclude-selected',
    ]));
    expect(byAction({}, 'select-read')!.shortcut).toBe('⇧-click');
    expect(byAction({}, 'select-footprint')!.shortcut).toBe('⌘-click');
    expect(byAction({ isMac: false }, 'select-footprint')!.shortcut).toBe('Ctrl-click');
    expect(byAction({}, 'select-footprint')!.label).toContain('147 bp');
  });

  it('greys out what does not apply', () => {
    expect(byAction({ footprint: null }, 'select-footprint')!.disabled).toBe(true);
    for (const a of ['copy-selected-names', 'keep-selected', 'exclude-selected']) {
      expect(byAction({}, a)!.disabled).toBe(true);
      expect(byAction({ selectedCount: 3 }, a)!.disabled).toBeFalsy();
    }
    expect(byAction({ selectedCount: 3 }, 'keep-selected')!.label).toBe('Keep only selected reads (3)');
    expect(byAction({ readSelected: true }, 'select-read')!.label).toBe('Deselect read');
    expect(byAction({ readHighlighted: true }, 'clear-highlight')).toBeTruthy();
    expect(byAction({ readHighlighted: true }, 'highlight-read')).toBeUndefined();
    expect(byAction({ hasReadFilter: true }, 'clear-read-filter')).toBeTruthy();
    expect(byAction({ excludedCount: 4 }, 'show-excluded')!.label).toContain('4');
  });

  it('a linked pair panel cannot keep only or exclude (its reads are the pair\'s)', () => {
    const keep = byAction({ selectedCount: 2, filtersUnavailable: 'Not in a linked pair panel' }, 'keep-selected')!;
    expect(keep.disabled).toBe(true);
    expect(keep.title).toContain('linked');
    expect(byAction({ selectedCount: 2, filtersUnavailable: 'x' }, 'exclude-selected')!.disabled).toBe(true);
  });

  it('on empty track space: go to a read by name, zoom, copy the locus', () => {
    const actions = items({ readId: null, footprint: null }).map(i => i.action);
    expect(actions).toEqual(expect.arrayContaining(['find-read-by-name', 'zoom-in-here', 'zoom-out', 'copy-view-locus', 'copy-position']));
    expect(actions).not.toContain('copy-read-name');
    expect(actions).not.toContain('select-footprint');
  });

  it('keyboard moves over enabled items only; the menu stays inside the window', () => {
    const entries = buildReadMenu({ ...base, footprint: null });
    const idx = actionableIndices(entries);
    expect(idx.every(i => entries[i].kind === 'item' && !(entries[i] as ReadMenuItem).disabled)).toBe(true);
    expect(clampMenuPosition(990, 10, { width: 200, height: 300 }, { width: 1000, height: 800 })).toEqual({ left: 796, top: 10 });
    expect(clampMenuPosition(10, 700, { width: 200, height: 300 }, { width: 1000, height: 800 })).toEqual({ left: 10, top: 400 });
  });
});

describe('plugin packs\' items', () => {
  it('none without a pack (the lab pack adds its own: lab/labPack.test.tsx)', () => {
    expect(buildReadMenu({ ...base, bamReads: true }).some(e => e.kind === 'item' && e.action.startsWith('ext:'))).toBe(false);
  });
});
