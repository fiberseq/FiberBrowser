import { describe, expect, it } from 'vitest';
import { buildReadMenu, svClusterMenu, type ReadMenuContext, type ReadMenuItem } from './readMenuModel';
import { allSettings, findSetting } from '../../../utils/settingsRegistry';

const base: ReadMenuContext = {
  readId: 'r1', footprint: null, readSelected: false, selectedCount: 0, hasReadFilter: false,
  excludedCount: 0, readHighlighted: false, anyHighlight: false, isMac: true,
};
const items = (ctx: ReadMenuContext) => buildReadMenu(ctx).filter((e): e is ReadMenuItem => e.kind === 'item');

describe('SV items in the read menu', () => {
  it('offers "Group in this panel" and "Split into panels" for the read\'s own event, and the inserted bases for an insertion', () => {
    const list = items({ ...base, sv: { thisEvent: 'INS 400 bp', thisInsertion: true, atCursor: 'DEL 1.5 kb, 13/21' } });
    expect(list.map(i => i.label)).toEqual(expect.arrayContaining([
      'Group in this panel by this SV (INS 400 bp)', 'Split into panels by this SV (INS 400 bp)', 'Copy inserted sequence',
      'Group in this panel by SV at cursor (DEL 1.5 kb, 13/21)', 'Split into panels by SV at cursor (DEL 1.5 kb, 13/21)',
    ]));
    // Straight to panels: no in-panel split needed first.
    expect(list.map(i => i.action)).toEqual(expect.arrayContaining(['sv-split-this-panels', 'sv-split-at-cursor-panels']));
    expect(list.map(i => i.action)).not.toContain('sv-split-panels');
  });

  it('offers "Split by SV at cursor" on empty space, and Clear when a split is on', () => {
    const list = items({ ...base, readId: null, sv: { atCursor: 'DEL 1.5 kb, 13/21', splitActive: true } });
    expect(list.map(i => i.action)).toEqual(expect.arrayContaining(['sv-split-at-cursor', 'sv-clear-split']));
    expect(list.map(i => i.action)).not.toContain('sv-split-this');
  });

  it('says nothing about SVs where there are none', () => {
    expect(items({ ...base, sv: {} }).some(i => i.action.startsWith('sv-'))).toBe(false);
    expect(items(base).some(i => i.action.startsWith('sv-'))).toBe(false);
  });

  it('the SV track has its own items on a cluster (faint ones too); no collapse toggle any more', () => {
    const entries = svClusterMenu({ cluster: 'DEL 1.5 kb, 13/21', insertion: false, splitActive: false, splitAllowed: true });
    expect(entries[0]).toEqual({ kind: 'heading', label: 'DEL 1.5 kb, 13/21' });
    expect(entries.filter((e): e is ReadMenuItem => e.kind === 'item').map(i => i.action))
      .toEqual(['sv-split-this', 'sv-split-this-panels', 'sv-highlight-supporting', 'sv-highlight-confirmed', 'sv-highlight-putative', 'sv-highlight-conflicting', 'sv-highlight-ambiguous']);
    // An insertion's cluster: the same items (plugin packs add their own: readMenuModel.registerReadMenuContribution).
    const ins = svClusterMenu({ cluster: 'INS 9.2 kb, 3267/3600', insertion: true, splitActive: true, splitAllowed: true, bamReads: true });
    expect(ins.filter((e): e is ReadMenuItem => e.kind === 'item' && !e.action.startsWith('ext:')).map(i => i.action))
      .toEqual(['sv-split-this', 'sv-split-this-panels', 'sv-highlight-supporting', 'sv-highlight-confirmed', 'sv-highlight-putative', 'sv-highlight-conflicting', 'sv-highlight-ambiguous', 'sv-split-panels', 'sv-clear-split']);
    expect(ins.find((e): e is ReadMenuItem => e.kind === 'item' && e.action === 'sv-split-this-panels')!.label).toBe('Split into panels by this SV');
    // Between clusters: nothing of its own (the track menu's common items follow).
    expect(svClusterMenu({ cluster: null, insertion: false, splitActive: false, splitAllowed: true, bamReads: true })).toEqual([]);
    // A linked pair panel can't split.
    const linked = svClusterMenu({ cluster: 'DEL 1 kb, 2/3', insertion: false, splitActive: false, splitAllowed: false });
    expect(linked.some(e => e.kind === 'item' && (e.action === 'sv-split-this' || e.action === 'sv-split-this-panels'))).toBe(false);
  });
});

describe('SV settings', () => {
  it('are searchable in the settings catalog', () => {
    for (const id of ['view.sv-display', 'view.sv-min-size']) expect(findSetting(id)).toBeTruthy();
    // The SV summary track switch is retired (fb-n11-tracks): "sv track" finds SV display.
    expect(findSetting('view.sv-summary-track')).toBeUndefined();
    const words = (id: string) => [findSetting(id)!.label, ...(findSetting(id)!.keywords ?? [])].join(' ').toLowerCase();
    expect(words('view.sv-display')).toContain('structural variants');
    expect(words('view.cigar-deletions')).toContain('show small indels');
    expect(words('view.sv-display')).toContain('sv track');
    expect(allSettings().filter(s => s.id.startsWith('view.sv-')).map(s => s.id).sort()).toEqual([
      'view.sv-conflicts', 'view.sv-display', 'view.sv-min-size', 'view.sv-min-support',
    ]);
    expect(words('view.sv-min-support')).toContain('minimum carriers');
  });
});
