import { describe, expect, it } from 'vitest';
import type { PanelConfig } from '../types';
import type { ReadTrackStatus } from '../stores/uiSlice';
import { computeCopilotDiagnostics, computeCopilotRawState, type DiagnosticState } from './copilotDiagnostics';

const panel = (over: Partial<PanelConfig> = {}): PanelConfig => ({
  id: 'p1', contentType: 'dataset', datasetId: 'ds1', subTracks: [], collapsed: false,
  linkGroup: null, layoutRow: 0, ...over,
} as PanelConfig);

const status = (over: Partial<ReadTrackStatus> = {}): ReadTrackStatus => ({
  datasetId: 'ds1', chrom: 'chr2L', start: 1000, end: 2000,
  loading: false, fetchFailed: false, warning: null, zoomedOut: false, stale: false,
  displayed: 40, working: 40, inScope: 40, overlapping: 40, spanning: 40, strand: null,
  ...over,
});

function state(over: Partial<DiagnosticState> = {}): DiagnosticState {
  return {
    chrom: 'chr2L', start: 1000, end: 2000,
    chroms: [{ name: 'chr2L', size: 23_000_000 }] as DiagnosticState['chroms'],
    hasFasta: true, currentGenome: 'dm6',
    datasets: [{ id: 'ds1', label: 'A3 sample', path: '/d/a.bam', color: '#000' }],
    panels: [panel()],
    collapsedRows: new Set<number>(),
    fullViewPanelId: null,
    maxRegionForReads: 100_000,
    readTrackStatus: { ds1: status() },
    filteredReadIds: {},
    clusterAssignments: {},
    clusterFocus: {},
    activeClusterTreeNodeId: null,
    clusterTreeNodes: {},
    spanningOnly: false,
    minFootprints: 0,
    minFpQuality: 0,
    activeColormap: { qualityFilters: [] } as unknown as DiagnosticState['activeColormap'],
    enabledModTypes: { nuc: true, tf: true },
    ...over,
  } as DiagnosticState;
}

const codes = (s: DiagnosticState, extras = {}) => computeCopilotDiagnostics(s, extras).map(d => `${d.severity}:${d.code}`);
const find = (s: DiagnosticState, code: string, extras = {}) => computeCopilotDiagnostics(s, extras).find(d => d.code === code);

describe('computeCopilotDiagnostics', () => {
  it('reports nothing for a healthy view', () => {
    expect(codes(state())).toEqual([]);
  });

  it('no datasets, no reference', () => {
    const s = state({ datasets: [], panels: [], readTrackStatus: {}, hasFasta: false, currentGenome: null, chroms: [] });
    expect(codes(s)).toEqual(['blocking:no_datasets', 'blocking:no_reference']);
    expect(find(s, 'no_datasets')?.fix_anchor).toBe('load-dataset');
    expect(find(state({ hasFasta: false, currentGenome: null }), 'no_reference')?.severity).toBe('info');
  });

  it('no GTF only when known', () => {
    expect(find(state(), 'no_gtf')).toBeUndefined();
    expect(find(state(), 'no_gtf', { gtfLoaded: false })?.fix_anchor).toBe('load-gtf');
  });

  it('zoomed out past the read window', () => {
    const d = find(state({ end: 301_000 }), 'zoomed_out_past_reads');
    expect(d?.severity).toBe('blocking');
    expect(d?.fix_anchor).toBe('read-window-setting');
    expect(d?.message).toContain('A3 sample');
  });

  it('chromosome missing from the dataset (alias-aware)', () => {
    expect(find(state(), 'chrom_missing_in_dataset', { datasetChroms: { ds1: ['chr3R'] } })?.severity).toBe('blocking');
    expect(find(state(), 'chrom_missing_in_dataset', { datasetChroms: { ds1: ['2L'] } })).toBeUndefined();
  });

  it('no reads in the region', () => {
    const s = state({ readTrackStatus: { ds1: status({ displayed: 0, working: 0, inScope: 0, overlapping: 0, spanning: 0 }) } });
    expect(codes(s)).toEqual(['blocking:no_reads_in_region']);
  });

  it('a filter that matched nothing vs. one that hides some', () => {
    const empty = state({ filteredReadIds: { ds1: new Set() }, readTrackStatus: { ds1: status({ displayed: 0 }) } });
    expect(find(empty, 'filter_matches_none')?.fix_anchor).toBe('clear-filter');
    const some = state({ filteredReadIds: { ds1: new Set(['r1']) }, readTrackStatus: { ds1: status({ displayed: 1 }) } });
    expect(find(some, 'filter_active')?.severity).toBe('warning');
  });

  it('a cluster focus that leaves nothing visible', () => {
    const s = state({ clusterAssignments: { ds1: { r1: 0, r2: 1 } }, clusterFocus: { ds1: new Set([5]) } });
    expect(find(s, 'focus_hides_all')?.fix_anchor).toBe('cluster-focus-bar');
    const ok = state({ clusterAssignments: { ds1: { r1: 0 } }, clusterFocus: { ds1: new Set([0]) } });
    expect(find(ok, 'focus_hides_all')).toBeUndefined();
  });

  it('an empty cluster branch', () => {
    const s = state({
      activeClusterTreeNodeId: 'n1',
      clusterTreeNodes: { n1: { id: 'n1', parentId: 'root', assignments: { ds1: {} } } } as unknown as DiagnosticState['clusterTreeNodes'],
      clusterAssignments: { ds1: {} },
    });
    expect(find(s, 'branch_scope_empty')?.severity).toBe('blocking');
  });

  it('collapsed panel, collapsed row, maximized other panel', () => {
    expect(codes(state({ panels: [panel({ collapsed: true })] }))).toEqual(['blocking:panel_collapsed']);
    const two = [panel(), panel({ id: 'p2', datasetId: 'ds1', stateKey: 'p2', layoutRow: 1 })];
    expect(codes(state({ panels: two, collapsedRows: new Set([1]) }))).toContain('info:row_collapsed');
    expect(find(state({ panels: two, fullViewPanelId: 'p1' }), 'panel_collapsed')?.panel_id).toBe('p2');
  });

  it('a copy at another locus', () => {
    const s = state({ panels: [panel({ viewportOverride: { chrom: 'chr2L', start: 5000, end: 6000 } })] });
    expect(find(s, 'panel_at_other_locus')?.severity).toBe('info');
  });

  it('an empty one-strand panel', () => {
    const s = state({ panels: [panel({ strand: 'CT' })], readTrackStatus: { ds1: status({ inScope: 0, displayed: 0, working: 0, strand: 'CT' }) } });
    expect(codes(s)).toEqual(['blocking:strand_panel_empty']);
    expect(find(s, 'strand_panel_empty')?.fix_anchor).toBe('strand-chip');
  });

  it('spanning-only hiding reads', () => {
    const none = state({ spanningOnly: true, readTrackStatus: { ds1: status({ displayed: 0, spanning: 0, overlapping: 30 }) } });
    expect(find(none, 'spanning_only_hides')?.severity).toBe('blocking');
    const few = state({ spanningOnly: true, readTrackStatus: { ds1: status({ spanning: 3, overlapping: 30 }) } });
    expect(find(few, 'spanning_only_hides')?.severity).toBe('warning');
  });

  it('quality settings hiding reads', () => {
    const all = state({ minFootprints: 5, readTrackStatus: { ds1: status({ working: 0, displayed: 0 }) } });
    expect(find(all, 'quality_filter_hides_all')?.severity).toBe('blocking');
    const most = state({
      activeColormap: { qualityFilters: [{ layer: 'nuc', qualityName: 'nq', minValue: 200, enabled: true }] } as unknown as DiagnosticState['activeColormap'],
      readTrackStatus: { ds1: status({ working: 10, displayed: 10, inScope: 40 }) },
    });
    expect(find(most, 'quality_filter_hides_all')?.severity).toBe('warning');
  });

  it('footprint layers switched off', () => {
    expect(find(state({ enabledModTypes: { footprint: false, nuc: false, tf: true } }), 'layers_hidden')?.severity).toBe('warning');
    expect(find(state({ enabledModTypes: { footprint: false, nuc: false, tf: false } }), 'layers_hidden')?.severity).toBe('blocking');
  });

  it('still loading and failed loads', () => {
    expect(codes(state({ readTrackStatus: { ds1: status({ loading: true }) } }))).toEqual(['info:still_loading']);
    const failed = find(state({ readTrackStatus: { ds1: status({ fetchFailed: true, warning: 'Could not load reads for this region.' }) } }), 'fetch_failed');
    expect(failed?.severity).toBe('blocking');
    expect(failed?.message).toContain('Could not load reads');
  });

  it('orders blocking causes first and caps the list', () => {
    const panels = Array.from({ length: 20 }, (_, i) => panel({ id: `p${i}`, stateKey: `k${i}`, collapsed: true }));
    const out = computeCopilotDiagnostics(state({ panels, hasFasta: false, currentGenome: null }));
    expect(out.length).toBe(16);
    expect(out[0].severity).toBe('blocking');
  });
});

describe('computeCopilotRawState', () => {
  it('is compact and bounded', () => {
    const panels = Array.from({ length: 12 }, (_, i) => panel({ id: `p${i}`, stateKey: `k${i}` }));
    const raw = computeCopilotRawState(state({ panels }), { datasetChroms: { ds1: Array.from({ length: 50 }, (_, i) => `chr${i}`) } });
    const text = JSON.stringify(raw);
    expect(text.length).toBeLessThan(2000);
    expect((raw.panels as unknown[]).length).toBe(6);
    expect(((raw.datasets as Array<{ chroms: string[] }>)[0].chroms).length).toBe(8);
    expect(raw.viewport).toEqual({ chrom: 'chr2L', start: 1000, end: 2000 });
  });

  it('includes each panel\'s read counts and filter', () => {
    const raw = computeCopilotRawState(state({ filteredReadIds: { ds1: new Set(['a', 'b']) } }));
    expect((raw.panels as Array<Record<string, unknown>>)[0]).toMatchObject({
      dataset_id: 'ds1', filter: 2, reads: { shown: 40, in_scope: 40 },
    });
  });
});
