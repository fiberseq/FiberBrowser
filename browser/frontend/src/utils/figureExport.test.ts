import { describe, expect, it } from 'vitest';
import type { PanelConfig } from '../types';
import { assertExportSize, figureCitationOffset, figureCropBox, figureDrawables, figureFileStem, figureFooterHeight } from './figureExport';
import { citationText, figureCitationLine, FIBERBROWSER_VERSION, loadFigureCitation, saveFigureCitation } from './citation';
import type { PanelScopeState } from './panelScope';

/** fb-n3-figure (audit P7: M11, M12, M1 file name). */

const panel = (over: Partial<PanelConfig>): PanelConfig => ({
  id: over.id ?? 'p', contentType: 'dataset', datasetId: 'ds', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0, ...over,
}) as PanelConfig;
const MAIN = { chrom: 'chr19', start: 47_514_037, end: 47_519_435 };
const state = (panels: PanelConfig[], over: Partial<PanelScopeState> = {}): PanelScopeState => ({
  ...MAIN, panels, navigationMode: 'perPanel', selectedDatasets: new Set(), lastMovedPanels: {},
  collapsedRows: new Set(), fullViewPanelId: null, currentGenome: 'hg38', fastaPath: null, ...over,
}) as PanelScopeState;
const label = (key: string | null) => (key === null ? 'hg38' : key);

it('refuses a backing store too large to save instead of exporting blank read tracks', () => {
  expect(() => assertExportSize(4000, 3000)).not.toThrow();
  expect(() => assertExportSize(4000, 40_000)).toThrow('lower resolution');
  expect(() => assertExportSize(20_000, 20_000)).toThrow('fewer reads');
});

describe('figure file name', () => {
  it('names the region the panel shows, not the stale main locus (Per panel mode)', () => {
    const s = state([panel({ id: 'a', viewportOverride: { chrom: 'chr19', start: 47_514_262, end: 47_519_210 } })]);
    expect(figureFileStem(s, label)).toBe('chr19_47514262-47519210');
  });

  it('names each region, with its reference when panels are on two references', () => {
    const s = state([
      panel({ id: 'a', viewportOverride: { chrom: 'chr19', start: 47_514_262, end: 47_519_210 } }),
      panel({ id: 'b', datasetId: 'fly', genome: 'dm6', viewportOverride: { chrom: 'chr2L', start: 6_356_793, end: 6_357_648 } }),
      // The same view twice is one region; a minimized panel is not in the figure.
      panel({ id: 'c', datasetId: 'fly2', genome: 'dm6', viewportOverride: { chrom: 'chr2L', start: 6_356_793, end: 6_357_648 } }),
      panel({ id: 'd', datasetId: 'fly3', genome: 'dm6', collapsed: true, viewportOverride: { chrom: 'chrX', start: 1, end: 2 } }),
    ]);
    expect(figureFileStem(s, label)).toBe('hg38_chr19_47514262-47519210_dm6_chr2L_6356793-6357648');
    // The figure shows every panel, whichever are selected.
    expect(figureFileStem({ ...s, selectedDatasets: new Set(['b']) }, label)).toBe('hg38_chr19_47514262-47519210_dm6_chr2L_6356793-6357648');
  });

  it('many regions: the first and a count; no dataset panel: the main locus', () => {
    const at = (i: number) => panel({ id: `p${i}`, datasetId: `d${i}`, viewportOverride: { chrom: `chr${i}`, start: i, end: i + 10 } });
    expect(figureFileStem(state([at(1), at(2), at(3), at(4)]), label)).toBe('chr1_1-11_plus3');
    expect(figureFileStem(state([]), label)).toBe('chr19_47514037-47519435');
  });
});

describe('figure crop (audit M11: a blank strip where the drawer was)', () => {
  const area = { width: 1000, height: 600 };
  it('keeps the dataset panels and the gap around them; drops the side column and the strip above', () => {
    const panels = [
      { left: 8, top: 40, right: 400, bottom: 590 },
      { left: 408, top: 40, right: 800, bottom: 590 },
    ];
    expect(figureCropBox(panels, area, 8)).toEqual({ left: 0, top: 32, right: 808, bottom: 598 });
  });
  it('one panel filling the row: the whole width, as before', () => {
    expect(figureCropBox([{ left: 8, top: 8, right: 992, bottom: 600 }], area, 8)).toEqual({ left: 0, top: 0, right: 1000, bottom: 600 });
  });
  it('no dataset panel: the whole area', () => {
    expect(figureCropBox([], area, 8)).toEqual({ left: 0, top: 0, right: 1000, bottom: 600 });
  });
});

describe('figure footer (audit M12: the datasets line was cut off)', () => {
  it('has room for the second line', () => {
    expect(figureFooterHeight(false, true)).toBe(0);
    const one = figureFooterHeight(true, false);
    const two = figureFooterHeight(true, true);
    // The datasets line's baseline is 34 px into the footer (10 px text): it must end inside.
    expect(two).toBeGreaterThanOrEqual(34 + 4);
    expect(two).toBeGreaterThan(one);
  });

  it('has room for the citation line below them, or a band of its own', () => {
    for (const [coords, datasets] of [[true, false], [true, true], [false, false]] as const) {
      const height = figureFooterHeight(coords, datasets, true);
      expect(height).toBeGreaterThan(figureFooterHeight(coords, datasets));
      // 9 px text: its baseline inside the footer, with room for descenders.
      expect(figureCitationOffset(coords, datasets)).toBeLessThanOrEqual(height - 3);
      expect(figureCitationOffset(coords, datasets)).toBeGreaterThan(figureFooterHeight(coords, datasets) - (coords ? 10 : 0));
    }
  });
});

describe('citation (How to cite, the figure line)', () => {
  it('names the version, FiberBrowser and FiberHMM', () => {
    expect(FIBERBROWSER_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(citationText()).toBe(`How to cite: FiberBrowser ${FIBERBROWSER_VERSION} (github.com/fiberseq/FiberBrowser; CITATION.cff) and FiberHMM (github.com/fiberseq/FiberHMM).`);
    expect(figureCitationLine('3.0.0')).toBe('Made with FiberBrowser 3.0.0 (github.com/fiberseq/FiberBrowser) · please cite FiberBrowser and FiberHMM');
  });

  it('the figure line is on by default and remembered when turned off', () => {
    localStorage.removeItem('fiberbrowser_figure_citation');
    expect(loadFigureCitation()).toBe(true);
    saveFigureCitation(false);
    expect(loadFigureCitation()).toBe(false);
    saveFigureCitation(true);
    expect(loadFigureCitation()).toBe(true);
  });
});

describe('what the figure draws (Codex review: a side panel\'s chart fell over the title)', () => {
  it('only what is in the dataset panels; everything in a layout without them', () => {
    const area = document.createElement('div');
    area.innerHTML = `
      <div data-panel-content-type="read-stats"><canvas id="chart"></canvas><span data-figure-text="x" id="chart-label"></span></div>
      <div data-panel-id="a"><canvas id="reads"></canvas><span data-figure-text="y" id="track-label"></span></div>`;
    expect(figureDrawables(area, 'canvas').map(e => e.id)).toEqual(['reads']);
    expect(figureDrawables(area, '[data-figure-text]').map(e => e.id)).toEqual(['track-label']);
    area.querySelector('[data-panel-id]')!.removeAttribute('data-panel-id');
    expect(figureDrawables(area, 'canvas').map(e => e.id)).toEqual(['chart', 'reads']);
  });
});
