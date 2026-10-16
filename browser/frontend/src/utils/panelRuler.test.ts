import { describe, expect, it } from 'vitest';
import type { PanelConfig } from '../types';
import { rulerRepeatsAbove } from './panelRuler';

const main = { chrom: 'chr19', start: 1000, end: 6000 };
const panel = (id: string, extra: Partial<PanelConfig> = {}): PanelConfig => ({
  id, contentType: 'dataset', datasetId: id, collapsed: false, linkGroup: null, layoutRow: 0,
  subTracks: [{ type: 'axis', visible: true }, { type: 'reads', visible: true }],
  ...extra,
} as PanelConfig);

describe('one ruler per column of panels showing the same region', () => {
  it('drops the ruler of a panel stacked under one at the same region', () => {
    const col = [panel('a'), panel('b'), panel('c')];
    expect(col.map((_, i) => rulerRepeatsAbove(col, i, main))).toEqual([false, true, true]);
  });

  it('keeps the top panel of every column (side by side columns have their own widths)', () => {
    expect(rulerRepeatsAbove([panel('a')], 0, main)).toBe(false);
  });

  it('keeps the ruler of a panel at another region (haplotype and region views)', () => {
    const col = [
      panel('a'),
      panel('h1', { viewportOverride: { chrom: 'chr19_hap2', start: 1000, end: 6000 }, haplotypeGroup: 'g' }),
      panel('h2', { viewportOverride: { chrom: 'chr19', start: 2000, end: 3000 } }),
    ];
    expect(col.map((_, i) => rulerRepeatsAbove(col, i, main))).toEqual([false, false, false]);
  });

  it('treats a linked copy at the main region (and chr aliases) as the same region', () => {
    const col = [panel('a'), panel('b', { viewportOverride: { chrom: '19', start: 1000, end: 6000 } })];
    expect(rulerRepeatsAbove(col, 1, main)).toBe(true);
  });

  it('keeps the ruler when the panel above shows none or is not a dataset panel', () => {
    const noAxis = panel('a', { subTracks: [{ type: 'axis', visible: false }, { type: 'reads', visible: true }] } as Partial<PanelConfig>);
    expect(rulerRepeatsAbove([noAxis, panel('b')], 1, main)).toBe(false);
    const analysis = { id: 'x', contentType: 'read-stats', subTracks: [] } as unknown as PanelConfig;
    expect(rulerRepeatsAbove([analysis, panel('b')], 1, main)).toBe(false);
  });
});

describe('the container\'s region resolver', () => {
  it('matches a copy sitting on the main view and nothing else, without the main coordinates', async () => {
    const { panelsAtMainKey, regionResolver } = await import('./panelRuler');
    const a = panel('a');
    const onMain = panel('b', { viewportOverride: { ...main } });
    const away = panel('c', { viewportOverride: { chrom: 'chr19', start: 1, end: 2 } });
    const regionOf = regionResolver(panelsAtMainKey([a, onMain, away], main));
    expect(rulerRepeatsAbove([a, onMain], 1, regionOf)).toBe(true);
    expect(rulerRepeatsAbove([a, away], 1, regionOf)).toBe(false);
    expect(rulerRepeatsAbove([onMain, a], 1, regionOf)).toBe(true);
  });
});

it('keeps opposite rulers and compares effective orientation in each navigation mode', async () => {
  const { panelReversed } = await import('../hooks/usePanelDisplayStore');
  const panels = [panel('a'), panel('b', { reversed: false })];
  const state = { panels, navigationMode: 'perPanel' as const, isReversed: true };
  expect(rulerRepeatsAbove(panels, 1, main, p => panelReversed(state, p.id))).toBe(false);
  expect(rulerRepeatsAbove(panels, 1, main, p => panelReversed({ ...state, navigationMode: 'linked' }, p.id))).toBe(true);
  panels[0].reversed = false;
  expect(rulerRepeatsAbove(panels, 1, main, p => panelReversed(state, p.id))).toBe(true);
});
