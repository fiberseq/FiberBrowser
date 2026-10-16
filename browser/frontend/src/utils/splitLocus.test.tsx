import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../stores/browserStore';
import { splitAway, splitLocusText, splitPinnedAway, splitShowsAll } from './splitLocus';
import { registerPanelTraits } from './panelExtensions';
import { SplitAwayBanner } from '../components/tracks/read-track/SplitAwayBanner';
import { openSplitPanels, type SplitGrouping, type SplitRow } from './splitPanels';
import type { PanelConfig, ReadSubset } from '../types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const locus = { chrom: 'chr2L', start: 9_440_000, end: 9_500_000, label: 'INS 9.2 kb @ chr2L:9,467,038' };
const subset: ReadSubset = {
  groupId: 'split-1', label: 'Carriers', colour: '#e11d48', count: 3267, sourcePanelId: 'src', locus,
  rule: { kind: 'frozen', datasetId: 'numb', groupKeys: ['0'], readIds: ['a'] },
};
const panel = (over: Partial<PanelConfig> = {}): PanelConfig => ({
  id: 'p1', contentType: 'dataset', datasetId: 'numb', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0,
  stateKey: 'numb:split-1:0', readSubset: subset, ...over,
});

describe('a split panel away from its locus', () => {
  it('is away only without overlap, or on another chromosome', () => {
    expect(splitAway(subset, { chrom: 'chr2L', start: 9_450_000, end: 9_470_000 })).toBe(false);
    expect(splitAway(subset, { chrom: 'chr2L', start: 9_499_000, end: 9_510_000 })).toBe(false);
    expect(splitAway(subset, { chrom: 'chr2L', start: 6_300_000, end: 6_320_000 })).toBe(true);
    expect(splitAway(subset, { chrom: 'chr3R', start: 9_450_000, end: 9_470_000 })).toBe(true);
    expect(splitAway(subset, { chrom: '2L', start: 9_450_000, end: 9_470_000 })).toBe(false);  // an alias of chr2L
    expect(splitAway({ ...subset, locus: undefined }, { chrom: 'chr3R', start: 0, end: 10 })).toBe(false);
    expect(splitShowsAll({ ...subset, showAllAway: true }, { chrom: 'chr3R', start: 0, end: 10 })).toBe(true);
    expect(splitShowsAll({ ...subset, showAllAway: true }, { chrom: 'chr2L', start: 9_450_000, end: 9_460_000 })).toBe(false);
    expect(splitLocusText(subset)).toBe('INS 9.2 kb at chr2L:9,467,038');
    expect(splitLocusText({ ...subset, locus: { ...locus, label: 'N5' } })).toBe('N5 at chr2L:9,440,000-9,500,000');
  });

  describe('banner', () => {
    let container: HTMLDivElement;
    let root: Root;
    beforeEach(() => {
      container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
      useBrowserStore.setState({ chrom: 'chr2L', start: 6_300_000, end: 6_320_000, panels: [panel(), panel({ id: 'p2', stateKey: 'numb:split-1:1', readSubset: { ...subset, label: 'Reference' } })] } as never);
    });
    afterEach(() => { act(() => root.unmount()); container.remove(); });
    const click = (id: string) => act(() => (container.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement).click());

    it('says why the panel is empty, and goes back, shows all reads or closes the split', async () => {
      act(() => root.render(<SplitAwayBanner panel={useBrowserStore.getState().panels[0]} />));
      expect(container.querySelector('[data-testid="split-away-text"]')!.textContent)
        .toBe('This split is for INS 9.2 kb at chr2L:9,467,038; the reads here aren’t classified.'.replace('’', "'"));
      click('split-away-show-all');
      expect(useBrowserStore.getState().panels.every(p => p.readSubset!.showAllAway)).toBe(true);
      click('split-away-go-back');
      const s = useBrowserStore.getState();
      expect([s.chrom, s.start, s.end]).toEqual(['chr2L', 9_440_000, 9_500_000]);
      click('split-away-close');
      await vi.waitFor(() => expect(useBrowserStore.getState().panels.filter(p => p.readSubset)).toHaveLength(0));
    });
  });
});

describe('split panels remember where they were made', () => {
  it('the source panel\'s view and the SV split\'s label', () => {
    const source: PanelConfig = { id: 'src', contentType: 'dataset', datasetId: 'numb', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0 };
    useBrowserStore.setState({
      chrom: 'chr2L', start: 9_450_000, end: 9_480_000, panels: [source],
      svSplits: { numb: { datasetId: 'numb', chrom: 'chr2L', t: 'I', ref: 9_467_038, len: 9211, end: 9_467_038, margin: 50,
        label: 'INS 9.2 kb @ chr2L:9,467,038', counts: [1, 1, 1], viewStart: 9_450_000, viewEnd: 9_480_000 } },
    } as never);
    const grouping: SplitGrouping = { title: 'INS 9.2 kb @ chr2L:9,467,038', rule: { kind: 'frozen' }, groups: [
      { key: '0', label: 'Carriers', count: 1, colour: '#f00', kind: 'group', ids: { numb: ['a'] } },
      { key: '1', label: 'Reference', count: 1, colour: '#00f', kind: 'group', ids: { numb: ['b'] } },
    ] };
    const rows: SplitRow[] = grouping.groups.map(g => ({ key: g.key, label: g.label, colour: g.colour, kind: 'group', groupKeys: [g.key], count: 1, checked: true }));
    const out = openSplitPanels(grouping, rows, [source]);
    expect('groupId' in out).toBe(true);
    const made = useBrowserStore.getState().panels.filter(p => p.readSubset);
    expect(made.map(p => p.readSubset!.locus)).toEqual([
      { chrom: 'chr2L', start: 9_450_000, end: 9_480_000, label: 'INS 9.2 kb @ chr2L:9,467,038' },
      { chrom: 'chr2L', start: 9_450_000, end: 9_480_000, label: 'INS 9.2 kb @ chr2L:9,467,038' },
    ]);
  });
});

describe('an insert-expanded Carriers panel of a split (on its own contig: audit bug 4 / SV-2)', () => {
  const traitsOn = { on: false };
  registerPanelTraits(p => (traitsOn.on && p.id === 'alt' ? { ownContig: true, backToReference: { label: 'Show on reference', run: () => { traitsOn.on = false; } } } : null));
  const alt = () => panel({ id: 'alt', datasetId: 'alt-1', viewportOverride: { chrom: 'chr2L_9467038_INS9185', start: 0, end: 30_000 } });
  const ref = () => panel({ id: 'p2', stateKey: 'numb:split-1:1', readSubset: { ...subset, label: 'Reference' } });
  afterEach(() => { traitsOn.on = false; });

  it('is "pinned away" when its split\'s other panels (the main view) left the locus, never by its own contig', () => {
    traitsOn.on = true;
    const panels = [alt(), ref()];
    expect(splitAway(subset, alt().viewportOverride!, alt())).toBe(false);
    expect(splitPinnedAway(subset, alt(), panels, { chrom: 'chr2L', start: 9_450_000, end: 9_470_000 })).toBe(false);
    expect(splitPinnedAway(subset, alt(), panels, { chrom: 'chr2L', start: 9_600_000, end: 9_630_000 })).toBe(true);
    // A peer with a view of its own: that view counts.
    const own = [alt(), { ...ref(), viewportOverride: { chrom: 'chr2L', start: 9_450_000, end: 9_470_000 } }];
    expect(splitPinnedAway(subset, alt(), own, { chrom: 'chr2L', start: 9_600_000, end: 9_630_000 })).toBe(false);
    // A plain split panel is never "pinned".
    expect(splitPinnedAway(subset, ref(), panels, { chrom: 'chr2L', start: 9_600_000, end: 9_630_000 })).toBe(false);
  });

  it('its banner: Go back moves the main view (the pinned panel stays), Show on reference, no Show all reads', () => {
    traitsOn.on = true;
    const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
    useBrowserStore.setState({ chrom: 'chr2L', start: 9_600_000, end: 9_630_000, panels: [alt(), ref()] } as never);
    act(() => root.render(<SplitAwayBanner panel={useBrowserStore.getState().panels[0]} pinned />));
    expect(container.querySelector('[data-testid="split-away-text"]')!.textContent).toContain('Pinned to the insertion');
    expect(container.querySelector('[data-testid="split-away-show-all"]')).toBeNull();
    act(() => (container.querySelector('[data-testid="split-away-go-back"]') as HTMLButtonElement).click());
    const s = useBrowserStore.getState();
    expect([s.chrom, s.start, s.end]).toEqual(['chr2L', 9_440_000, 9_500_000]);
    expect(s.panels[0].viewportOverride!.chrom).toBe('chr2L_9467038_INS9185');
    act(() => (container.querySelector('[data-testid="split-away-reference"]') as HTMLButtonElement).click());
    expect(traitsOn.on).toBe(false);
    act(() => root.unmount()); container.remove();
  });
});
