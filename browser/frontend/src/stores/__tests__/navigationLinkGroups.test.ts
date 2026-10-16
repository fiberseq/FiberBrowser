import { describe, it, expect, beforeEach } from 'vitest';
import { createTestStore, ensureBuiltinPanelsRegistered } from './helpers';
import { analysisLoci } from '../../utils/analysisLocus';
import { figureRegions } from '../../utils/figureRegions';
import { panelsForGenomes } from '../../utils/panelNavigation';
import { serializeState } from '../historySlice';
import type { PanelConfig } from '../../types';

/**
 * fb-r3-nav: linking is per reference. In "Linked navigation" the panels on
 * one genome share one locus (the main genome's follow the main nav bar; those
 * on another assembly move together from any of their locus boxes); going back
 * from "Each panel navigates" takes each genome's panels to where the one the
 * user moved last is; "Match other panels to this location" moves the others.
 */

let store: ReturnType<typeof createTestStore>;
const panel = (id: string) => store.getState().panels.find(p => p.id === id)!;
const MAIN = { chrom: 'chr19', start: 47_514_000, end: 47_518_000 };
const DM6_A = { chrom: 'chr2R', start: 9_900_000, end: 9_910_000 };
const DM6_B = { chrom: 'chr3L', start: 5_000_000, end: 5_010_000 };
const mainView = () => {
  const s = store.getState();
  return { chrom: s.chrom, start: s.start, end: s.end };
};
const undoSteps = () => store.getState()._historyStack.length;

beforeEach(() => {
  localStorage.clear();
  ensureBuiltinPanelsRegistered();
  store = createTestStore();
  store.getState().setViewport(MAIN.chrom, MAIN.start, MAIN.end);
});

/** The hg38 demo and two dm6 datasets opened together with dm6 (one link group in Linked navigation). */
function twoFlies() {
  const human = store.getState().addPanel('human');
  const fly1 = store.getState().addPanel('fly1');
  const fly2 = store.getState().addPanel('fly2');
  store.getState().applyPanelGenomes({ fly1: 'dm6', fly2: 'dm6' }, { loci: { fly1: DM6_A, fly2: DM6_B } });
  return { human, fly1, fly2 };
}

describe('Linked navigation: one locus per genome', () => {
  it('several dm6 datasets opened with dm6 share one locus (the first one\'s) and move together', () => {
    const { human, fly1, fly2 } = twoFlies();
    expect(panel(fly1).viewportOverride).toEqual(DM6_A);
    expect(panel(fly2).viewportOverride).toEqual(DM6_A);
    // The locus box of either moves both; the hg38 panel and the main view stay.
    store.getState().navigatePanel(fly2, 'chrX', 100_000, 110_000);
    expect(panel(fly1).viewportOverride).toEqual({ chrom: 'chrX', start: 100_000, end: 110_000 });
    expect(panel(fly2).viewportOverride).toEqual({ chrom: 'chrX', start: 100_000, end: 110_000 });
    // Pan/zoom/drag (setPanelViewport) of either moves both by exactly the same locus.
    store.getState().setPanelViewport(fly1, 101_000, 111_000);
    expect(panel(fly2).viewportOverride).toEqual({ chrom: 'chrX', start: 101_000, end: 111_000 });
    expect(panel(human).viewportOverride).toBeUndefined();
    expect(mainView()).toEqual(MAIN);
    // The main view never moves them (another genome).
    store.getState().setViewport('chr19', 47_515_000, 47_519_000);
    expect(panel(fly1).viewportOverride).toEqual({ chrom: 'chrX', start: 101_000, end: 111_000 });
  });

  it('a later dm6 dataset joins the group where it is', () => {
    const { fly1 } = twoFlies();
    const fly3 = store.getState().addPanel('fly3');
    store.getState().applyPanelGenomes({ fly1: 'dm6', fly2: 'dm6', fly3: 'dm6' }, { loci: { fly3: DM6_B } });
    expect(panel(fly3).viewportOverride).toEqual(panel(fly1).viewportOverride);
  });

  it('a copy at another locus stays on its own; a linked copy moves with the group', () => {
    const { fly1, fly2 } = twoFlies();
    const elsewhere = store.getState().openPanelAtSite(fly1);
    const linked = store.getState().openPanelAtSite(fly1, { linked: true });
    store.getState().navigatePanel(fly2, 'chr2L', 1_000, 5_000);
    expect(panel(linked).viewportOverride).toEqual({ chrom: 'chr2L', start: 1_000, end: 5_000 });
    expect(panel(elsewhere).viewportOverride).toEqual(DM6_A);
    store.getState().navigatePanel(elsewhere, 'chr4', 0, 1_000);
    expect(panel(fly1).viewportOverride).toEqual({ chrom: 'chr2L', start: 1_000, end: 5_000 });
  });

  it("moving the group is one undo step for all its panels", () => {
    const { fly1, fly2 } = twoFlies();
    store.getState().navigatePanel(fly1, 'chr4', 0, 1_000);
    const before = undoSteps();
    store.getState().navigatePanel(fly1, 'chrX', 100_000, 110_000);
    expect(undoSteps()).toBe(before + 1);
    store.getState().undo();
    expect(panel(fly1).viewportOverride).toEqual({ chrom: 'chr4', start: 0, end: 1_000 });
    expect(panel(fly2).viewportOverride).toEqual({ chrom: 'chr4', start: 0, end: 1_000 });
    store.getState().undo();
    expect(panel(fly1).viewportOverride).toEqual(DM6_A);
    expect(panel(fly2).viewportOverride).toEqual(DM6_A);
  });

  it('a jump leaves every moved panel\'s clusters and filters behind', () => {
    const { fly1, fly2 } = twoFlies();
    store.setState({ filteredReadIds: { fly1: new Set(['r1']), fly2: new Set(['r2']), human: new Set(['r3']) } } as any);
    store.getState().navigatePanel(fly1, 'chrX', 100_000, 110_000);
    expect(Object.keys(store.getState().filteredReadIds as Record<string, unknown>)).toEqual(['human']);
    void fly2;
  });

  it('an analysis of the dm6 group takes one region, and a figure names one dm6 region', () => {
    const { fly1 } = twoFlies();
    store.getState().setPanelViewport(fly1, DM6_A.start + 2_000, DM6_A.end + 2_000);
    const st = store.getState();
    const loci = analysisLoci(st, ['fly1', 'fly2']);
    expect(loci).toHaveLength(1);
    expect(loci[0]).toMatchObject({ genome: 'dm6', chrom: 'chr2R', start: DM6_A.start + 2_000, datasetIds: ['fly1', 'fly2'] });
    expect(figureRegions(st, key => key)).toEqual(['chr19:47,514,000-47,518,000', 'chr2R:9,902,000-9,912,000']
      .map((r, i) => `${i === 0 ? 'main genome' : 'dm6'} ${r}`));
  });

  it('an older session with dm6 panels at two loci comes back as one group', () => {
    const base = (id: string, v: { chrom: string; start: number; end: number }): PanelConfig => ({
      id, contentType: 'dataset', datasetId: id, subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0, genome: 'dm6', viewportOverride: v,
    });
    const next = panelsForGenomes([base('f1', DM6_A), base('f2', DM6_B)], { f1: 'dm6', f2: 'dm6' }, { main: MAIN, mode: 'linked' });
    expect(next.map(p => p.viewportOverride)).toEqual([DM6_A, DM6_A]);
    // Each panel navigating: they keep theirs.
    const own = panelsForGenomes([{ ...base('f1', DM6_A), navOwn: true }, { ...base('f2', DM6_B), navOwn: true }], { f1: 'dm6', f2: 'dm6' },
      { main: MAIN, mode: 'perPanel' });
    expect(own.map(p => p.viewportOverride)).toEqual([DM6_A, DM6_B]);
  });

  it('a session keeps which panels are copies at their own locus', () => {
    const { fly1 } = twoFlies();
    const copy = store.getState().openPanelAtSite(fly1);
    const saved = serializeState(store.getState()).panels.find(p => p.id === copy)!;
    expect(saved.ownLocus).toBe(true);
    expect(saved.genome).toBe('dm6');
  });
});

describe('Per panel -> Linked: each genome goes where its panel moved last', () => {
  it('the main view goes to the main-genome panel moved last, not the first one', () => {
    const a = store.getState().addPanel('a');
    const b = store.getState().addPanel('b');
    store.getState().setNavigationMode('perPanel');
    store.getState().navigatePanel(a, 'chr1', 10_000, 20_000);
    store.getState().navigatePanel(b, 'chr2', 30_000, 40_000);
    store.getState().setNavigationMode('linked');
    expect(mainView()).toEqual({ chrom: 'chr2', start: 30_000, end: 40_000 });
    expect(panel(a).viewportOverride).toBeUndefined();
    expect(panel(b).viewportOverride).toBeUndefined();
  });

  it('dm6 panels are linked again at the one moved last; each genome separately', () => {
    const { human, fly1, fly2 } = twoFlies();
    store.getState().setNavigationMode('perPanel');
    expect(panel(fly1).navOwn && panel(fly2).navOwn).toBe(true);
    // Each moves alone now.
    store.getState().navigatePanel(fly1, 'chrX', 100_000, 110_000);
    store.getState().navigatePanel(fly2, 'chr3R', 2_000_000, 2_010_000);
    expect(panel(fly1).viewportOverride).toEqual({ chrom: 'chrX', start: 100_000, end: 110_000 });
    store.getState().navigatePanel(human, 'chr1', 1_000, 2_000);
    // A pan of the first dm6 panel makes it the last moved.
    store.getState().setPanelViewport(fly1, 100_500, 110_500);
    store.getState().setNavigationMode('linked');
    expect(panel(fly1).viewportOverride).toEqual({ chrom: 'chrX', start: 100_500, end: 110_500 });
    expect(panel(fly2).viewportOverride).toEqual({ chrom: 'chrX', start: 100_500, end: 110_500 });
    expect(panel(fly1).navOwn).toBeUndefined();
    expect(mainView()).toEqual({ chrom: 'chr1', start: 1_000, end: 2_000 });
    // Linked again: moving one moves the other.
    store.getState().navigatePanel(fly2, 'chr4', 0, 5_000);
    expect(panel(fly1).viewportOverride).toEqual({ chrom: 'chr4', start: 0, end: 5_000 });
  });

  it('none moved: the first panel of the group', () => {
    const { fly1, fly2 } = twoFlies();
    store.getState().setNavigationMode('perPanel');
    store.setState({ panels: store.getState().panels.map(p => (p.id === fly2 ? { ...p, viewportOverride: DM6_B } : p)) });
    store.getState().setNavigationMode('linked');
    expect(panel(fly2).viewportOverride).toEqual(DM6_A);
    void fly1;
  });
});

describe('opening a dataset with its own genome switches to Per panel', () => {
  it('one undo step; undo goes back to Linked with the dataset still on its genome', () => {
    const human = store.getState().addPanel('human');
    const fly = store.getState().addPanel('fly');
    // As panelGenomeStore.attach does: the panels follow the server, then the switch.
    store.getState().applyPanelGenomes({ fly: 'dm6' }, { loci: { fly: DM6_A } });
    store.getState().switchToPerPanelForOwnReference(['fly'], { fly: DM6_A }, 'Open fly with dm6: each panel navigates');
    expect(store.getState().getHistoryLabels().at(-1)?.label).toBe('Open fly with dm6: each panel navigates');
    expect(store.getState().navigationMode).toBe('perPanel');
    expect(store.getState().navigationNotice).toMatch(/Per panel/);
    expect(panel(fly).viewportOverride).toEqual(DM6_A);
    expect(panel(human).viewportOverride).toEqual(MAIN);
    store.getState().undo();
    expect(store.getState().navigationMode).toBe('linked');
    expect(panel(fly).genome).toBe('dm6');
    expect(panel(human).viewportOverride).toBeUndefined();
  });

  it('a dataset joining an existing dm6 group still opens at its own reads', () => {
    const { fly1 } = twoFlies();
    const fly3 = store.getState().addPanel('fly3');
    store.getState().applyPanelGenomes({ fly1: 'dm6', fly2: 'dm6', fly3: 'dm6' }, { loci: { fly3: DM6_B } });
    store.getState().switchToPerPanelForOwnReference(['fly3'], { fly3: DM6_B }, 'Open fly3 with dm6');
    expect(panel(fly3).viewportOverride).toEqual(DM6_B);
    expect(panel(fly1).viewportOverride).toEqual(DM6_A);
  });
});

describe('Match other panels on a genome to this location', () => {
  it('per panel: moves the other panels on that genome there without linking them; one undo step', () => {
    const { human, fly1, fly2 } = twoFlies();
    const human2 = store.getState().addPanel('human2');
    store.getState().setNavigationMode('perPanel');
    store.getState().navigatePanel(fly1, 'chrX', 100_000, 110_000);
    store.getState().navigatePanel(human, 'chr1', 1_000, 2_000);
    const before = undoSteps();
    store.getState().matchPanelsToPanel(fly1);
    expect(undoSteps()).toBe(before + 1);
    expect(panel(fly2).viewportOverride).toEqual({ chrom: 'chrX', start: 100_000, end: 110_000 });
    // Other genomes stay; still per panel (not linked).
    expect(panel(human).viewportOverride).toEqual({ chrom: 'chr1', start: 1_000, end: 2_000 });
    expect(store.getState().navigationMode).toBe('perPanel');
    store.getState().navigatePanel(fly2, 'chr4', 0, 1_000);
    expect(panel(fly1).viewportOverride).toEqual({ chrom: 'chrX', start: 100_000, end: 110_000 });
    // Main-genome panels match to each other.
    store.getState().matchPanelsToPanel(human);
    expect(panel(human2).viewportOverride).toEqual({ chrom: 'chr1', start: 1_000, end: 2_000 });
    store.getState().undo();
    expect(panel(human2).viewportOverride).toEqual(MAIN);
  });

  it('linked: a dm6 copy brings the dm6 group to it; a main-genome copy brings the main view', () => {
    const { human, fly1, fly2 } = twoFlies();
    const flyCopy = store.getState().openPanelAtSite(fly1);
    store.getState().navigatePanel(flyCopy, 'chr2L', 1_000, 3_000);
    store.getState().matchPanelsToPanel(flyCopy);
    expect(panel(fly1).viewportOverride).toEqual({ chrom: 'chr2L', start: 1_000, end: 3_000 });
    expect(panel(fly2).viewportOverride).toEqual({ chrom: 'chr2L', start: 1_000, end: 3_000 });
    expect(mainView()).toEqual(MAIN);
    const humanCopy = store.getState().openPanelAtSite(human);
    store.getState().navigatePanel(humanCopy, 'chr7', 5_000, 9_000);
    const before = undoSteps();
    store.getState().matchPanelsToPanel(humanCopy);
    expect(mainView()).toEqual({ chrom: 'chr7', start: 5_000, end: 9_000 });
    expect(panel(human).viewportOverride).toBeUndefined();
    expect(undoSteps()).toBe(before + 1);
    store.getState().undo();
    expect(mainView()).toEqual(MAIN);
  });

  it('comparisons keep their own loci', () => {
    const a = store.getState().addPanel('a');
    store.getState().setNavigationMode('perPanel');
    store.getState().openHaplotypeComparison({ chrom1: 'chr1_mat', chrom2: 'chr1_pat', start: 1_000, end: 5_000 } as any);
    const hap = store.getState().panels.filter(p => p.haplotypeGroup);
    const b = store.getState().addPanel('b');
    store.getState().navigatePanel(b, 'chr2', 0, 1_000);
    store.getState().matchPanelsToPanel(b);
    expect(store.getState().panels.filter(p => p.haplotypeGroup).map(p => p.viewportOverride)).toEqual(hap.map(p => p.viewportOverride));
    void a;
  });
});

describe('review fixes (Codex, fb-r3-nav)', () => {
  it('a strand copy of a comparison panel keeps its own locus, outside the dm6 group', () => {
    const { fly1, fly2 } = twoFlies();
    // A region panel of the dm6 dataset elsewhere (a Genome Navigator region view).
    const region = { ...panel(fly1), id: 'region', stateKey: 'region', genomeRegionGroupId: 'g1', viewportOverride: DM6_B };
    store.setState({ panels: [...store.getState().panels, region] });
    const ga = store.getState().splitPanelByStrand('region');
    expect(panel(ga).ownLocus).toBe(true);
    expect(panel(ga).viewportOverride).toEqual(DM6_B);
    store.getState().navigatePanel(fly2, 'chr4', 0, 1_000);
    expect(panel(ga).viewportOverride).toEqual(DM6_B);
    store.getState().navigatePanel(ga, 'chrX', 0, 1_000);
    expect(panel(fly1).viewportOverride).toEqual({ chrom: 'chr4', start: 0, end: 1_000 });
    store.getState().applyPanelGenomes({ fly1: 'dm6', fly2: 'dm6' });
    expect(panel(ga).viewportOverride).toEqual({ chrom: 'chrX', start: 0, end: 1_000 });
  });

  it('an undone move does not count as the last one', () => {
    const { fly1, fly2 } = twoFlies();
    store.getState().setNavigationMode('perPanel');
    store.getState().navigatePanel(fly1, 'chrX', 100_000, 110_000);
    store.getState().navigatePanel(fly2, 'chr3R', 2_000_000, 2_010_000);
    store.getState().undo();
    expect(panel(fly2).viewportOverride).toEqual(DM6_A);
    store.getState().setNavigationMode('linked');
    expect(panel(fly2).viewportOverride).toEqual({ chrom: 'chrX', start: 100_000, end: 110_000 });
  });

  it('moving a copy at its own locus does not replace the group\'s last-moved panel', () => {
    const { fly1, fly2 } = twoFlies();
    const copy = store.getState().openPanelAtSite(fly1);
    store.getState().setNavigationMode('perPanel');
    store.getState().navigatePanel(fly1, 'chrX', 100_000, 110_000);
    store.getState().navigatePanel(fly2, 'chr3R', 2_000_000, 2_010_000);
    store.getState().navigatePanel(copy, 'chr4', 0, 1_000);
    store.getState().setPanelViewport(copy, 100, 1_100);
    store.getState().setNavigationMode('linked');
    expect(panel(fly1).viewportOverride).toEqual({ chrom: 'chr3R', start: 2_000_000, end: 2_010_000 });
  });
});
