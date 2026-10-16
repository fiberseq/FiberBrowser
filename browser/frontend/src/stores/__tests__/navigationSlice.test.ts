import { describe, it, expect, beforeEach } from 'vitest';
import { createTestStore, ensureBuiltinPanelsRegistered } from './helpers';
import {
  inComparisonGroup,
  isMainViewPanel,
  panelsForGenomes,
  panelsForLinkedMode,
  panelsForPerPanelMode,
} from '../../utils/panelNavigation';
import type { PanelConfig } from '../../types';

/**
 * fb-r2-genomes: datasets on different assemblies side by side, each panel
 * keeping its own reference and locus; "Each panel navigates" gives every
 * panel of the main genome its own locus box without copying views.
 */

let store: ReturnType<typeof createTestStore>;
const panel = (id: string) => store.getState().panels.find(p => p.id === id)!;
const DM6_LOCUS = { chrom: 'chr2R', start: 9_900_000, end: 9_910_000 };

beforeEach(() => {
  localStorage.clear();
  ensureBuiltinPanelsRegistered();
  store = createTestStore();
  store.getState().setViewport('chr19', 47_514_000, 47_518_000);
});

describe('a dataset on another assembly', () => {
  it('gets its own reference and locus; the main view and the other panels stay', () => {
    const human = store.getState().addPanel('demo');
    const fly = store.getState().addPanel('fly');
    store.getState().applyPanelGenomes({ fly: 'dm6' }, { loci: { fly: DM6_LOCUS }, undoLabel: 'Open with dm6 in its own panel' });
    expect(panel(fly).genome).toBe('dm6');
    expect(panel(fly).viewportOverride).toEqual(DM6_LOCUS);
    expect(panel(fly).siteLocked).toBe(false);
    expect(panel(human).genome).toBeUndefined();
    expect(panel(human).viewportOverride).toBeUndefined();
    const s = store.getState();
    expect([s.chrom, s.start, s.end]).toEqual(['chr19', 47_514_000, 47_518_000]);
  });

  it('navigates on its own: the main view never moves it, and it never moves the main view', () => {
    const fly = store.getState().addPanel('fly');
    store.getState().applyPanelGenomes({ fly: 'dm6' }, { loci: { fly: DM6_LOCUS } });
    store.getState().setViewport('chr19', 47_515_000, 47_519_000);  // a pan of the main view
    store.getState().setViewport('chr1', 1_000, 5_000);  // a jump
    expect(panel(fly).viewportOverride).toEqual(DM6_LOCUS);
    store.getState().navigatePanel(fly, 'chr3L', 100, 2_100);
    store.getState().setPanelViewport(fly, 200, 2_200);
    expect(panel(fly).viewportOverride).toEqual({ chrom: 'chr3L', start: 200, end: 2_200 });
    expect(store.getState().chrom).toBe('chr1');
  });

  it('is never linked to the main view (linking is within one assembly)', () => {
    const fly = store.getState().addPanel('fly');
    store.getState().applyPanelGenomes({ fly: 'dm6' }, { loci: { fly: DM6_LOCUS } });
    store.getState().setPanelSiteLocked(fly, true);
    expect(panel(fly).siteLocked).toBe(false);
    store.getState().setPanelIndependent(fly, false);  // "follow the main view"
    expect(panel(fly).viewportOverride).toEqual(DM6_LOCUS);
    store.getState().setViewport('chr19', 47_515_000, 47_519_000);
    expect(panel(fly).viewportOverride).toEqual(DM6_LOCUS);
  });

  it('a copy of its panel stays on its reference', () => {
    const fly = store.getState().addPanel('fly');
    store.getState().applyPanelGenomes({ fly: 'dm6' }, { loci: { fly: DM6_LOCUS } });
    const copy = store.getState().openPanelAtSite(fly);
    expect(panel(copy).genome).toBe('dm6');
    expect(panel(copy).viewportOverride).toEqual(DM6_LOCUS);
  });

  it('a later sync keeps where it is; a panel with no locus on that reference opens at the fallback', () => {
    const fly = store.getState().addPanel('fly');
    store.getState().applyPanelGenomes({ fly: 'dm6' }, { loci: { fly: DM6_LOCUS } });
    store.getState().navigatePanel(fly, 'chrX', 1_000, 3_000);
    store.getState().applyPanelGenomes({ fly: 'dm6' }, { hasChrom: () => true });
    expect(panel(fly).viewportOverride).toEqual({ chrom: 'chrX', start: 1_000, end: 3_000 });
    // fb-r3-nav: in Linked navigation a second dm6 dataset joins dm6's link group (where fly is)...
    const fly2 = store.getState().addPanel('fly2');
    const sync = {
      fallback: () => ({ chrom: 'chr2L', start: 0, end: 10_000 }),
      hasChrom: (_g: string, chrom: string) => chrom.startsWith('chr2') || chrom === 'chrX',
    };
    store.getState().applyPanelGenomes({ fly: 'dm6', fly2: 'dm6' }, sync);
    expect(panel(fly2).viewportOverride).toEqual({ chrom: 'chrX', start: 1_000, end: 3_000 });
    // ...and with each panel navigating on its own, one with no locus there opens at the fallback.
    store.getState().setNavigationMode('perPanel');
    const fly3 = store.getState().addPanel('fly3');
    store.getState().applyPanelGenomes({ fly: 'dm6', fly2: 'dm6', fly3: 'dm6' }, sync);
    expect(panel(fly3).viewportOverride).toEqual({ chrom: 'chr2L', start: 0, end: 10_000 });  // chr19 isn't dm6's
  });

  it('back on the main genome it follows the main view again', () => {
    const fly = store.getState().addPanel('fly');
    store.getState().applyPanelGenomes({ fly: 'dm6' }, { loci: { fly: DM6_LOCUS } });
    store.getState().applyPanelGenomes({});
    expect(panel(fly).genome).toBeUndefined();
    expect(panel(fly).viewportOverride).toBeUndefined();
  });

  it('undo puts the panel back where it was', () => {
    const fly = store.getState().addPanel('fly');
    store.getState().applyPanelGenomes({ fly: 'dm6' }, { loci: { fly: DM6_LOCUS }, undoLabel: 'Open with dm6 in its own panel' });
    store.getState().undo();
    expect(panel(fly).genome).toBeUndefined();
    store.getState().redo();
    expect(panel(fly).genome).toBe('dm6');
  });
});

describe('navigation mode', () => {
  it('"Each panel navigates" gives every main-genome panel its own locus at the main view, keeping its state key', () => {
    const a = store.getState().addPanel('a');
    const b = store.getState().addPanel('b');
    const fly = store.getState().addPanel('fly');
    store.getState().applyPanelGenomes({ fly: 'dm6' }, { loci: { fly: DM6_LOCUS } });
    store.getState().setNavigationMode('perPanel');
    const main = { chrom: 'chr19', start: 47_514_000, end: 47_518_000 };
    expect(panel(a).viewportOverride).toEqual(main);
    expect(panel(b).viewportOverride).toEqual(main);
    expect(panel(a).navOwn && panel(b).navOwn).toBe(true);
    expect(panel(a).stateKey).toBeUndefined();  // peak scans and clusters stay under the dataset's key
    // fb-r3-nav: the dm6 panel leaves dm6's link group too (it was in one), staying where it is.
    expect(panel(fly).navOwn).toBe(true);
    expect(panel(fly).viewportOverride).toEqual(DM6_LOCUS);
    // Each moves alone.
    store.getState().navigatePanel(a, 'chr1', 10_000, 20_000);
    expect(panel(b).viewportOverride).toEqual(main);
    expect(isMainViewPanel(panel(a))).toBe(true);  // still a main-genome panel (comparisons start from it)
  });

  it('"Linked navigation" puts back exactly the panels it converted; the main view goes where the first was', () => {
    const a = store.getState().addPanel('a');
    const b = store.getState().addPanel('b');
    const elsewhere = store.getState().openPanelAtSite(a);
    store.getState().navigatePanel(elsewhere, 'chr2', 5_000, 9_000);
    store.getState().setNavigationMode('perPanel');
    store.getState().navigatePanel(a, 'chr1', 10_000, 20_000);
    store.getState().setNavigationMode('linked');
    expect(panel(a).viewportOverride).toBeUndefined();
    expect(panel(b).viewportOverride).toBeUndefined();
    expect(panel(a).navOwn).toBeUndefined();
    expect(panel(elsewhere).viewportOverride).toEqual({ chrom: 'chr2', start: 5_000, end: 9_000 });
    const s = store.getState();
    expect([s.chrom, s.start, s.end]).toEqual(['chr1', 10_000, 20_000]);
  });

  it('is undoable and saved with the panels', async () => {
    store.getState().addPanel('a');
    store.getState().setNavigationMode('perPanel');
    const { serializeState } = await import('../historySlice');
    expect(serializeState(store.getState()).navigationMode).toBe('perPanel');
    store.getState().undo();
    expect(store.getState().navigationMode).toBe('linked');
    expect(store.getState().panels[0].viewportOverride).toBeUndefined();
    store.getState().redo();
    expect(store.getState().navigationMode).toBe('perPanel');
    expect(store.getState().panels[0].navOwn).toBe(true);
  });

  it('a haplotype comparison in per-panel mode starts from the panels (and closes back to them)', () => {
    const a = store.getState().addPanel('a');
    store.getState().setNavigationMode('perPanel');
    store.getState().openHaplotypeComparison({ chrom1: 'chr1_mat', chrom2: 'chr1_pat', start: 1_000, end: 5_000 } as any);
    expect(panel(a).collapsed).toBe(true);
    expect(store.getState().panels.filter(p => p.haplotypeGroup).length).toBe(2);
    store.getState().closeHaplotypeComparison();
    expect(panel(a).collapsed).toBe(false);
    expect(panel(a).navOwn).toBe(true);
  });
});

describe('review fixes (Codex)', () => {
  it('a copy made in per-panel mode keeps its own locus when going back to Linked', () => {
    const a = store.getState().addPanel('a');
    store.getState().setNavigationMode('perPanel');
    const copy = store.getState().openPanelAtSite(a);
    store.getState().navigatePanel(copy, 'chr2', 5_000, 9_000);
    expect(panel(copy).navOwn).toBeUndefined();
    store.getState().setNavigationMode('linked');
    expect(panel(copy).viewportOverride).toEqual({ chrom: 'chr2', start: 5_000, end: 9_000 });
  });

  it("the header's linked copy of another assembly's panel is not linked to the main view", () => {
    const fly = store.getState().addPanel('fly');
    store.getState().applyPanelGenomes({ fly: 'dm6' }, { loci: { fly: DM6_LOCUS } });
    const copy = store.getState().openPanelAtSite(fly, { linked: true });
    expect(panel(copy).siteLocked).toBe(false);
    store.getState().setViewport('chr19', 47_515_000, 47_519_000);
    expect(panel(copy).viewportOverride).toEqual(DM6_LOCUS);
  });

  it('back to Linked, a panel that was elsewhere leaves its filters behind', () => {
    const a = store.getState().addPanel('a');
    const b = store.getState().addPanel('b');
    store.getState().setNavigationMode('perPanel');
    store.getState().navigatePanel(a, 'chr1', 10_000, 20_000);  // the main view goes here
    store.setState({ filteredReadIds: { a: new Set(['r1']), b: new Set(['r2']) } } as any);
    store.getState().setNavigationMode('linked');
    const filters = store.getState().filteredReadIds as Record<string, unknown>;
    expect('a' in filters).toBe(true);   // stays where it was
    expect('b' in filters).toBe(false);  // was at chr19, now shows chr1
    void b;
  });

  it('a panel given another reference at the same coordinates leaves its clusters and filters behind (Codex audit #6)', () => {
    const a = store.getState().addPanel('a');
    const at = { chrom: 'chr1', start: 1_000, end: 2_000 };
    store.getState().applyPanelGenomes({ a: 'fasta:asmA' }, { loci: { a: at } });
    store.setState({ filteredReadIds: { a: new Set(['r1']) }, clusterAssignments: { a: { r1: 0 } } } as any);
    store.getState().applyPanelGenomes({ a: 'fasta:asmB' }, { loci: { a: at } });
    expect(panel(a).genome).toBe('fasta:asmB');
    expect(panel(a).viewportOverride).toEqual(at);
    expect('a' in (store.getState().filteredReadIds as Record<string, unknown>)).toBe(false);
    expect('a' in (store.getState().clusterAssignments as Record<string, unknown>)).toBe(false);
  });

  it('back to Linked, a reference\'s panels go where the dataset opened last is (audit L2)', () => {
    store.getState().addPanel('human');
    const fly1 = store.getState().addPanel('fly1');
    const fly2 = store.getState().addPanel('fly2');
    const first = { chrom: 'chr3L', start: 5_064_541, end: 5_065_214 };
    const second = { chrom: 'chr2L', start: 6_356_793, end: 6_357_648 };
    // "Open with dm6 in its own panel" for the first: Per panel; then for the second.
    store.getState().applyPanelGenomes({ fly1: 'dm6' }, { loci: { fly1: first } });
    store.getState().switchToPerPanelForOwnReference(['fly1'], { fly1: first }, 'Open fly1 with dm6: each panel navigates');
    store.getState().applyPanelGenomes({ fly1: 'dm6', fly2: 'dm6' }, { loci: { fly2: second } });
    expect(panel(fly2).viewportOverride).toEqual(second);
    store.getState().setNavigationMode('linked');
    expect(panel(fly1).viewportOverride).toEqual(second);
    expect(panel(fly2).viewportOverride).toEqual(second);
  });

  it('peaks scanned in a panel on another assembly stay in it (same chromosome names)', async () => {
    const { otherLocusWindows } = await import('../../utils/locusPeaks');
    const panels = [
      { id: 'h', contentType: 'dataset', datasetId: 'h', viewportOverride: { chrom: 'chrX', start: 0, end: 100 } },
      { id: 'f', contentType: 'dataset', datasetId: 'f', genome: 'dm6', viewportOverride: { chrom: 'chrX', start: 0, end: 100 } },
    ];
    const windows = otherLocusWindows(panels, 'chr19', 0, 100);
    expect(windows.map(w => [w.genome ?? null, w.datasetIds])).toEqual([[null, ['h']], ['dm6', ['f']]]);
    // A dm6 panel at the main view's coordinates is still its own window.
    expect(otherLocusWindows([panels[1]], 'chrX', 0, 100).length).toBe(1);
  });
});

describe('panelNavigation helpers', () => {
  const base = (over: Partial<PanelConfig>): PanelConfig => ({
    id: 'p', contentType: 'dataset', datasetId: 'd', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0, ...over,
  });
  const main = { chrom: 'chr1', start: 0, end: 100 };

  // fb-r3-nav: a panel on another assembly is in its reference's link group, so it gets its own locus
  // box too (where it is); a copy at its own locus is left alone, as on the main genome.
  it('per-panel mode leaves comparison panels, analysis panels and copies at their own locus alone', () => {
    const panels = [
      base({ id: 'plain' }),
      base({ id: 'hap', haplotypeGroup: 'g', viewportOverride: { chrom: 'chr1_mat', start: 0, end: 10 } }),
      base({ id: 'fly', genome: 'dm6', viewportOverride: DM6_LOCUS }),
      base({ id: 'flyCopy', genome: 'dm6', ownLocus: true, viewportOverride: DM6_LOCUS }),
      base({ id: 'analysis', contentType: 'footprint-analysis' as any, datasetId: null }),
    ];
    const next = panelsForPerPanelMode(panels, main);
    expect(next.map(p => [p.id, Boolean(p.navOwn)])).toEqual([['plain', true], ['hap', false], ['fly', true], ['flyCopy', false], ['analysis', false]]);
    expect(next[2].viewportOverride).toEqual(DM6_LOCUS);
    expect(panelsForPerPanelMode(next, main)).toBe(next);  // nothing left to convert
    expect(inComparisonGroup(panels[1])).toBe(true);
    expect(panelsForLinkedMode(next).mainLocus).toEqual(main);
  });

  it('comparison panels of a dataset given a reference keep their own locus when it is on it', () => {
    const panels = [base({ id: 'hap', haplotypeGroup: 'g', viewportOverride: { chrom: 'chr2L_mat', start: 0, end: 10 } })];
    const next = panelsForGenomes(panels, { d: 'dm6' }, {
      main, mode: 'linked', loci: { d: DM6_LOCUS }, hasChrom: (_g, c) => c === 'chr2L_mat',
    });
    expect(next[0].viewportOverride).toEqual({ chrom: 'chr2L_mat', start: 0, end: 10 });
    expect(next[0].genome).toBe('dm6');
  });

  it('back on the main genome in per-panel mode a panel keeps its own locus box at the main view', () => {
    const panels = [base({ id: 'fly', genome: 'dm6', viewportOverride: DM6_LOCUS })];
    const next = panelsForGenomes(panels, {}, { main, mode: 'perPanel' });
    expect(next[0]).toMatchObject({ viewportOverride: main, navOwn: true });
    expect(next[0].genome).toBeUndefined();
  });
});
