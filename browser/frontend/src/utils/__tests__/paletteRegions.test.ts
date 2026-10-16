/**
 * integ-r4: the Regions panel (the real registry, fb-r4-regions) is findable in
 * the command palette by its name and what it holds.
 */
import { describe, expect, it } from 'vitest';
import '../../plugins/builtinPanels';
import { buildPaletteItems, paletteSections } from '../commandPaletteItems';

const rankOf = (query: string, id: string) =>
  paletteSections(query, buildPaletteItems(), []).flatMap(s => s.items).findIndex(item => item.id === id);

describe('the Regions panel in the palette', () => {
  it.each(['regions', 'regions panel', 'saved regions', 'amplicons'])('“%s” finds it near the top', query => {
    const rank = rankOf(query, 'panel:circular-genome');
    expect(rank).toBeGreaterThanOrEqual(0);
    expect(rank).toBeLessThan(6);
  });
});

describe('the t-SNE and Highlight toolbar options in the palette (integ-r4)', () => {
  it.each([
    ['neighbourhoods', 'setting:toolbar.cluster-method'],
    ['t-sne graph', 'setting:toolbar.cluster-method'],
    ['resolution', 'setting:toolbar.cluster-resolution'],
    ['sort by projection', 'setting:toolbar.sort-by'],
    ['highlight colour', 'setting:toolbar.highlight-color'],
  ])('“%s” finds %s', (query, id) => {
    const rank = rankOf(query, id);
    expect(rank).toBeGreaterThanOrEqual(0);
    expect(rank).toBeLessThan(6);
  });
});
