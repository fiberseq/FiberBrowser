import { describe, expect, it } from 'vitest';
import type { PanelConfig } from '../../../types';
import type { PanelScopeState } from '../../../utils/panelScope';
import { chartRoundStillCurrent, clusterChartPeaks, clusterChartRunPeaks, clusterChartScope, clusterChartScopeNote, currentChartView, scopedClusters } from './clusterChartScope';
import { roundStillCurrent } from './clusterOperationRounds';

const panel = (id: string, datasetId: string, over: Partial<PanelConfig> = {}) =>
  ({ id, contentType: 'dataset', datasetId, subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0, ...over }) as PanelConfig;

const state = (over: Partial<PanelScopeState> = {}): PanelScopeState => ({
  // The main locus is stale (Per panel mode): the hg38 panel has moved on its own.
  chrom: 'chr19', start: 47_514_037, end: 47_518_985,
  navigationMode: 'perPanel', selectedDatasets: new Set(), lastMovedPanels: {}, collapsedRows: new Set(),
  fullViewPanelId: null, currentGenome: 'hg38', fastaPath: null,
  panels: [
    panel('ph', 'napa', { navOwn: true, viewportOverride: { chrom: 'chr19', start: 47_514_262, end: 47_519_210 } }),
    panel('pf', 'flyamp', { genome: 'dm6', viewportOverride: { chrom: 'chr2L', start: 6_356_793, end: 6_357_648 } }),
  ],
  ...over,
}) as PanelScopeState;

/**
 * fb-n3-clusters (audit H2): in Per panel mode the Projection, V-Plot and
 * Enrichment charts read the stale main locus, so the clustered hg38 panel
 * itself was "left out" and the charts were empty.
 */
describe('cluster charts plot a clustered panel\'s own view', () => {
  it('the clustered hg38 panel at its own locus is plotted, not left out', () => {
    const scope = clusterChartScope(state(), ['napa']);
    expect(scope.keys).toEqual(['napa']);
    expect(scope.leftOut).toBe(0);
    expect([scope.view.chrom, scope.view.start, scope.view.end, scope.view.genome]).toEqual(['chr19', 47_514_262, 47_519_210, null]);
    expect(clusterChartScopeNote(scope, k => k)).toBeNull();
  });

  it('a clustered dm6 panel is plotted on dm6, at its locus', () => {
    const scope = clusterChartScope(state(), ['flyamp']);
    expect(scope.keys).toEqual(['flyamp']);
    expect([scope.view.chrom, scope.view.genome]).toEqual(['chr2L', 'dm6']);
  });

  it('both clustered: the panel the user works in; the other is left out, with a note', () => {
    const selectedFly = clusterChartScope(state({ selectedDatasets: new Set(['pf']) }), ['napa', 'flyamp']);
    expect(selectedFly.keys).toEqual(['flyamp']);
    expect(selectedFly.leftOut).toBe(1);
    expect(clusterChartScopeNote(selectedFly, k => k)).toBe(
      '1 clustered panel at another locus or on another reference is left out: these plots use the reads at dm6 chr2L:6,356,793-6,357,648. Select a panel to plot its clusters.');
    // Nothing selected: the first visible panel (the hg38 one).
    expect(clusterChartScope(state(), ['napa', 'flyamp']).keys).toEqual(['napa']);
  });

  it('Linked: panels following the main view are plotted together', () => {
    const linked = state({
      navigationMode: 'linked',
      panels: [panel('pa', 'a'), panel('pb', 'b'), panel('pc', 'c', { viewportOverride: { chrom: 'chr7', start: 1, end: 9 } })],
    });
    const scope = clusterChartScope(linked, ['a', 'b', 'c']);
    expect(scope.keys).toEqual(['a', 'b']);
    expect([scope.view.chrom, scope.view.start]).toEqual(['chr19', 47_514_037]);
  });

  it('the plotted view\'s peaks: its reference and chromosome only', () => {
    const peaks = [
      { start: 47_515_000, end: 47_515_200, mode: 'accessibility' },
      { start: 47_516_000, end: 47_516_200, chrom: 'chr19' },
      { start: 6_356_930, end: 6_357_166, chrom: 'chr2L', genome: 'dm6' },
      { start: 6_357_191, end: 6_357_572, chrom: 'chr2L' },
    ];
    expect(clusterChartPeaks(peaks, { chrom: 'chr19', genome: null }, 'chr19').map(p => p.start)).toEqual([47_515_000, 47_516_000]);
    expect(clusterChartPeaks(peaks, { chrom: 'chr2L', genome: 'dm6' }, 'chr19').map(p => p.start)).toEqual([6_356_930, 6_357_191]);
  });

  it('dissolve/merge results apply only while the plotted panel is still where it was', () => {
    const s0 = { ...state(), clusterAssignments: { napa: { r1: 0 } } };
    const scope = clusterChartScope(s0, ['napa']);
    const round = { keyByDataset: { napa: 'napa' }, assignments: { napa: s0.clusterAssignments.napa } };
    expect(roundStillCurrent(round, scope.view, currentChartView(s0, scope.view))).toBe(true);
    // The main locus moving (stale in Per panel mode) doesn't matter; the panel moving does.
    expect(roundStillCurrent(round, scope.view, currentChartView({ ...s0, start: 1, end: 2 }, scope.view))).toBe(true);
    const moved = { ...s0, panels: s0.panels.map(p => p.id === 'ph' ? { ...p, viewportOverride: { chrom: 'chr19', start: 1, end: 2 } } : p) };
    expect(roundStillCurrent(round, scope.view, currentChartView(moved, scope.view))).toBe(false);
  });

  it('a round applies only while every panel it covered still shows the view (Codex review)', () => {
    const two = {
      ...state({ navigationMode: 'linked', panels: [panel('pa', 'a'), panel('pb', 'b')] }),
      clusterAssignments: { a: { r1: 0 }, b: { r2: 1 } },
    };
    const scope = clusterChartScope(two, ['a', 'b']);
    expect(scope.keys).toEqual(['a', 'b']);
    const round = { keyByDataset: { a: 'a', b: 'b' }, assignments: { a: two.clusterAssignments.a, b: two.clusterAssignments.b } };
    expect(chartRoundStillCurrent(round, scope.view, two)).toBe(true);
    // b moved on its own while the request ran (its assignments object is the same).
    const bMoved = { ...two, panels: two.panels.map(p => p.id === 'pb' ? { ...p, viewportOverride: { chrom: 'chr19', start: 5, end: 9 } } : p) };
    expect(chartRoundStillCurrent(round, scope.view, bMoved)).toBe(false);
  });

  it('copies at other loci on one reference are plotted with their own matched peaks (Codex review)', () => {
    const regions = [{ start: 1_100, end: 1_200, mode: 'accessibility', chrom: 'chr1' }];
    const windowPeaks = { regions, byKey: { a: [{ start: 1_100, end: 1_200, mode: 'accessibility' }], b: [{ start: 5_100, end: 5_200, mode: 'accessibility' }] } };
    const second = { chrom: 'chr1', genome: null, start: 5_000, end: 6_000 };
    expect(clusterChartRunPeaks(regions, windowPeaks, ['b'], second, 'chr1')).toEqual([{ start: 5_100, end: 5_200, mode: 'accessibility' }]);
    // A branch or snapshot restores a copy of the same peaks: still that run's.
    expect(clusterChartRunPeaks(regions.map(r => ({ ...r })), windowPeaks, ['b'], second, 'chr1').map(p => p.start)).toEqual([5_100]);
    // Another clustering's peaks since, or the panel moved off its peaks: the stored per-panel peaks don't apply.
    expect(clusterChartRunPeaks([{ ...regions[0], end: 1_300 }], windowPeaks, ['b'], second, 'chr1').map(p => p.start)).toEqual([1_100]);
    expect(clusterChartRunPeaks(regions, windowPeaks, ['b'], { ...second, start: 9_000, end: 9_500 }, 'chr1').map(p => p.start)).toEqual([1_100]);
  });
});

describe('scopedClusters (fb-n6-integ)', () => {
  it('counts, orders, focuses and picks over the given panels only', () => {
    const s = {
      clusterAssignments: { a: { r1: 0, r2: 1, r3: 1 }, b: { r1: 2, r2: 1 }, other: { x: 7 } },
      clusterOrder: { a: [1, 0], b: [2, 1] },
      clusterFocus: { a: new Set([1]), other: new Set([7]) },
      selectedClusters: { b: new Set([2]), other: new Set([7]) },
    };
    const scoped = scopedClusters(['a', 'b'], s);
    expect(scoped.clusters.map(c => [c.cluster, c.counts])).toEqual([[1, [2, 1]], [0, [1, 0]], [2, [0, 1]]]);
    expect([...scoped.focus!]).toEqual([1]);
    expect(scoped.visible.map(c => c.cluster)).toEqual([1]);
    expect([...scoped.selected]).toEqual([2]);
    const b = scopedClusters(['b'], s);
    expect(b.clusters.map(c => c.cluster)).toEqual([2, 1]);
    expect(b.focus).toBeNull();
    expect(scopedClusters([], s).clusters).toEqual([]);
  });
});
