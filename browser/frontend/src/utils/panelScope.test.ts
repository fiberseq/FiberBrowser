import { beforeEach, describe, expect, it } from 'vitest';
import { useBrowserStore } from '../stores/browserStore';
import { highlightView } from './highlightActions';
import {
  activePanelId,
  activePanelView,
  shownPanelViews,
  targetPanelView,
  viewFileStem,
  viewLocusLabel,
} from './panelScope';

/**
 * fb-n2-scope (audit M1): in "Each panel navigates" the main locus goes
 * stale; what a panel shows is its own locus and reference.
 */

const MAIN = { chrom: 'chr19', start: 47_514_037, end: 47_519_435 };
const HUMAN_AT = { chrom: 'chr19', start: 47_514_262, end: 47_519_210 };
const FLY_AT = { chrom: 'chr2L', start: 6_356_793, end: 6_357_648 };
const s = () => useBrowserStore.getState();
const panel = (id: string) => s().panels.find(p => p.id === id)!;

let human: string;
let fly: string;

beforeEach(() => {
  localStorage.clear();
  useBrowserStore.setState({
    panels: [], highlights: [], selectedDatasets: new Set(), lastMovedPanels: {}, collapsedRows: new Set(),
    fullViewPanelId: null, navigationMode: 'linked', currentGenome: 'hg38', fastaPath: null,
    _historyStack: [], _historyPointer: -1,
  } as never);
  s().setViewport(MAIN.chrom, MAIN.start, MAIN.end);
  human = s().addPanel('napa');
  fly = s().addPanel('flyamp');
  s().applyPanelGenomes({ flyamp: 'dm6' }, { loci: { flyamp: FLY_AT } });
});

/** Per panel, the hg38 panel moved away from the (now stale) main locus. */
function perPanelMoved() {
  s().setNavigationMode('perPanel');
  s().navigatePanel(human, HUMAN_AT.chrom, HUMAN_AT.start, HUMAN_AT.end);
}

describe('panel views', () => {
  it('Linked: the main view is active; a panel on another assembly has its own locus and reference', () => {
    expect(activePanelId(s())).toBe(human);
    const main = activePanelView(s());
    expect(main).toMatchObject({ ...MAIN, genome: null, genomeKey: 'hg38', followsMain: true, panelIds: [human] });
    expect(targetPanelView(s(), fly)).toMatchObject({ ...FLY_AT, panelId: fly, genome: 'dm6', genomeKey: 'dm6', followsMain: false });
    expect(shownPanelViews(s()).map(v => [v.genomeKey, v.chrom, v.start])).toEqual([['hg38', 'chr19', MAIN.start], ['dm6', 'chr2L', FLY_AT.start]]);
  });

  it('Per panel: the active panel is the one moved last (across references), not the stale main locus', () => {
    perPanelMoved();
    expect(activePanelView(s())).toMatchObject({ ...HUMAN_AT, panelId: human, genomeKey: 'hg38' });
    s().navigatePanel(fly, 'chr3R', 1_000, 5_000);
    expect(activePanelId(s())).toBe(fly);
    // An undone move doesn't count (the panel is no longer where it went).
    useBrowserStore.setState({ panels: s().panels.map(p => (p.id === fly ? { ...p, viewportOverride: { ...FLY_AT } } : p)) });
    expect(activePanelId(s())).toBe(human);
  });

  it('the selected panel, then the panel an action was invoked from, win', () => {
    perPanelMoved();
    useBrowserStore.setState({ selectedDatasets: new Set([fly]) });
    expect(activePanelId(s())).toBe(fly);
    expect(activePanelId(s(), human)).toBe(human);
    expect(targetPanelView(s(), 'active').panelId).toBe(fly);
    // Only the selected panels' views when some are selected.
    expect(shownPanelViews(s()).map(v => v.panelId)).toEqual([fly]);
    expect(shownPanelViews(s(), { scope: 'all' }).map(v => v.panelId)).toEqual([human, fly]);
  });

  it('a minimized panel or one in a collapsed row is not on screen; panels at one view are listed together', () => {
    const copy = s().addPanel('napa');
    expect(shownPanelViews(s())[0].panelIds).toEqual([human, copy]);
    useBrowserStore.setState({ panels: s().panels.map(p => (p.id === human ? { ...p, collapsed: true } : p)) });
    expect(shownPanelViews(s()).map(v => v.panelIds)).toEqual([[fly], [copy]]);
    useBrowserStore.setState({ collapsedRows: new Set([panel(copy).layoutRow ?? 0]) });
    expect(shownPanelViews(s()).map(v => v.panelId)).not.toContain(copy);
  });

  it('a maximized analysis panel hides the dataset panels (Codex review)', () => {
    perPanelMoved();
    const analysis = { id: 'an1', contentType: 'cluster-detail', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0 };
    useBrowserStore.setState({ panels: [...s().panels, analysis as never], fullViewPanelId: 'an1' });
    expect(shownPanelViews(s())).toEqual([]);
    expect(highlightView()).toEqual([]);
    useBrowserStore.setState({ fullViewPanelId: fly });
    expect(shownPanelViews(s()).map(v => v.panelId)).toEqual([fly]);
  });

  it('labels and file names', () => {
    expect(viewLocusLabel(FLY_AT)).toBe('chr2L:6,356,793-6,357,648');
    expect(viewFileStem(HUMAN_AT)).toBe('chr19_47514262-47519210');
    expect(viewFileStem([HUMAN_AT, FLY_AT, FLY_AT])).toBe('chr19_47514262-47519210_plus2');
  });
});

describe('Highlight › View (audit M1)', () => {
  it("Per panel: highlights each panel's own view, not the stale main locus, one per reference", () => {
    perPanelMoved();
    highlightView();
    expect(s().highlights.map(h => [h.genome, h.chrom, h.start, h.end])).toEqual([
      ['hg38', HUMAN_AT.chrom, HUMAN_AT.start, HUMAN_AT.end],
      ['dm6', FLY_AT.chrom, FLY_AT.start, FLY_AT.end],
    ]);
    // One undo step for all of them.
    s().undo();
    expect(s().highlights).toEqual([]);
  });

  it("with a panel: that panel's view only; with a selection: the selected panels'", () => {
    perPanelMoved();
    highlightView(fly);
    expect(s().highlights.map(h => [h.genome, h.chrom, h.start])).toEqual([['dm6', 'chr2L', FLY_AT.start]]);
    useBrowserStore.setState({ selectedDatasets: new Set([human]) });
    highlightView();
    expect(s().highlights.map(h => [h.genome, h.chrom, h.start]).slice(1)).toEqual([['hg38', 'chr19', HUMAN_AT.start]]);
  });
});
