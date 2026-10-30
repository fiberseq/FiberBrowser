import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from './fixtures/graphExtras.json';
import { buildLayout } from './layout';
import { buildScene, xForOccurrence } from './scene';
import { graphCallLayers, packMolecules, placeRead, placeReads, placementIndex } from './readGeometry';
import { bandHeight, drawReads, effectiveReadLayers, emptyDrawStats } from './readCanvas';
import { chromatinStyle } from './chromatinStyle';
import { activeSiteSort, linearSiteOrder, siteAt, siteSortNotice, sortGraphSite } from './siteSort';
import { applyShown, desiredHandoff, useGraphSettings } from './handoff';
import { leaveGraph } from './hostMode';
import { useGraphStatusStore } from './statusStore';
import { useBrowserStore } from '../../stores/browserStore';
import { graphClusterPlan, graphRequestBody } from './graphCluster';
import { useGraphBindingsStore } from './bindingsStore';
import { initialGraphView } from './state';
import { graphParts } from './GraphPartsDialog';
import { runOutlines } from './runOutlines';
import { matchedRunCounts, withGraphSourceColumns, type ClusterMatchedRun } from '../../utils/clusterMatchedRun';
import { DEFAULT_COLORMAP, type PanelConfig } from '../../types';
import type { GraphBinding, GraphRead, GraphRegistration, GraphTopology } from './types';

const topology = fixture.topology as unknown as GraphTopology;
const bindings = fixture.bindings as unknown as GraphBinding[];
const reg: GraphRegistration = { id: 'package', label: 'Synthetic graph', producer: 'test', build_target: 'test',
  bindings, maps: [{ target: 'target', source: 'source' }], revisions: { package: 'p', graph: 'g', db: 'd', maps: 'm' } };
const view = { chrom: 'chrA', start: 0, end: 60, reference: 'reference' };
const basePanel = (id: string, extra: Partial<PanelConfig> = {}): PanelConfig => ({ id, datasetId: 'dataset', stateKey: id,
  contentType: 'dataset', subTracks: [], collapsed: false, layoutRow: 0, linkGroup: null, ...extra });
const host = () => basePanel('host', { viewMode: 'graph', graphView: { ...initialGraphView(reg, view),
  role: 'host', members: [{ panelId: 'host', binding: 'target' }, { panelId: 'folded', binding: 'source' },
    { panelId: 'popped', binding: 'source' }] } });
const panels = () => [host(), basePanel('folded', { graphMemberOf: 'host', collapsed: true, collapsedByGraphGroup: 'host' }),
  basePanel('popped', { graphMemberOf: 'host' })];
const scene = (reversed = false, bands?: Record<string, number>) => buildScene(buildLayout(topology, bindings), {
  width: 900, gutter: 52, rightPad: 6, rulerHeight: 30, laneHeight: 28, laneGap: 4, compression: 'log', reversed,
  colors: { target: '#334155', source: '#1d4ed8' }, smallBp: 0, bands });

beforeEach(() => {
  useGraphSettings.getState().set({ linearHostView: 'reveal_members', complexity: false, outBp: 50_000, inBp: 40_000 });
  useGraphStatusStore.setState({ status: { helper: { available: true }, registrations: [reg] } as never });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('site sorts and linear fallbacks', () => {
  it('sends a real host plan, commits the authoritative site and order, and rejects a late response', async () => {
    const h = host();
    useBrowserStore.setState({ panels: [h], datasets: [{ id: 'dataset', label: 'Synthetic', data_type: 'bam' } as never],
      chrom: 'chrA', start: 0, end: 60, currentGenome: 'reference', selectedDatasets: new Set(),
      selectedClusters: {}, clusterAssignments: {}, clusterOrder: {}, clusterFocus: {}, filteredReadIds: {},
      excludedReads: {}, selectedReadIds: {}, activeClusterTreeNodeId: null, fullViewPanelId: null, readSortOrder: {} });
    useGraphBindingsStore.setState({ byDataset: { dataset: [{ registration: reg, binding: { dataset_id: 'dataset',
      label: 'Synthetic', kind: 'native', revision: 'revision', paths: { target: 'chrA' }, problems: [], libraries: 1 } }] } });
    const plan = graphClusterPlan(useBrowserStore.getState(), { kind: 'peaks', regions: [{ start: 0, end: 60, mode: 'accessibility' }] })!;
    expect(plan.observations).toHaveLength(1);
    const site = { ...fixture.site, target_position: null };
    const response = { site, results: { [plan.observations[0].id]: { read_sort_order: ['a', 'b'] } } };
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => response });
    vi.stubGlobal('fetch', fetcher);
    await sortGraphSite('host', fixture.site, 'footprint');
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({ site: fixture.site, sort_by: 'footprint', target: 'target' });
    expect(useBrowserStore.getState().readSortOrder.host).toEqual(['a', 'b']);
    expect(siteSortNotice(useBrowserStore.getState().panels[0], ['a', 'b'])).toContain('carrier-only');
    fetcher.mockImplementation(async () => {
      useBrowserStore.setState({ end: 61 });
      return { ok: true, json: async () => response };
    });
    await expect(sortGraphSite('host', fixture.site, 'accessibility')).rejects.toThrow('view changed');
  });
  it('shares the backend visit fixture and inverts reverse visits in both screen orientations', () => {
    for (const reversed of [false, true]) {
      const sc = scene(reversed);
      const x = xForOccurrence(sc, fixture.site.occurrence, 32);
      expect(x, JSON.stringify(sc.occurrences)).not.toBeNull();
      expect(siteAt(sc, topology, x!, 'source')).toEqual(fixture.site);
    }
  });

  it('keeps target-aliased sorts and falls back to cluster order for a carrier-only site, preserving resume state', () => {
    const p = basePanel('host', { graphSiteSort: { site: { ...fixture.site, target_position: null },
      order: ['a', 'b'], registrationId: 'package' } });
    expect(linearSiteOrder(p, ['a', 'b'])).toEqual([]);
    expect(siteSortNotice(p, ['a', 'b'])).toContain('cluster order');
    expect(p.graphSiteSort!.order).toEqual(['a', 'b']);
    const aliased = { ...p, graphSiteSort: { ...p.graphSiteSort!, site: { ...fixture.site, target_position: 0 } } };
    expect(linearSiteOrder(aliased, ['a', 'b'])).toEqual(['a', 'b']);
    expect(siteSortNotice(aliased, ['a', 'b'])).toBeNull();
    expect(activeSiteSort(p, ['b', 'a'])).toBeNull();
    expect(activeSiteSort({ ...p, graphSiteSort: { site: null } as never }, ['a'])).toBeNull();
    expect(linearSiteOrder(p, [])).toEqual([]);
  });

  it('a subsequent ordinary sort clears graph-site provenance even if its order is identical', () => {
    const p = basePanel('host', { graphSiteSort: { site: fixture.site, order: ['a'], registrationId: reg.id } });
    useBrowserStore.setState({ panels: [p], readSortOrder: { host: ['a'] } });
    useBrowserStore.getState().setReadSortOrder('host', ['a']);
    expect(useBrowserStore.getState().panels[0].graphSiteSort).toBeUndefined();
  });
});

describe('host-only setting and unavailable graph fallback', () => {
  it('keeps folded members hidden on the toggle and hand-off; manually popped panels stay visible', () => {
    useGraphSettings.getState().set({ linearHostView: 'host_only' });
    for (const next of [leaveGraph(panels(), 'host'), applyShown(panels(), 'host', 'linear', 'width')]) {
      expect(next[1]).toMatchObject({ collapsed: true, collapsedByGraphGroup: 'host' });
      expect(next[2]).toMatchObject({ collapsed: false });
      expect(applyShown(next, 'host', 'graph')[1].collapsed).toBe(true);
    }
    expect(JSON.parse(localStorage.getItem('fiberbrowser_graph_mode_settings_v1')!).linearHostView).toBe('host_only');
  });

  it('reconciles automatic reveals when the preference changes and leaves user pop-outs alone', () => {
    const linear = applyShown(panels(), 'host', 'linear', 'width');
    expect(linear[1].collapsed).toBe(false);
    useGraphSettings.getState().set({ linearHostView: 'host_only' });
    const next = applyShown(linear, 'host', 'linear', 'width');
    expect(next[1].collapsed).toBe(true);
    expect(next[2].collapsed).toBe(false);
  });

  it.each(['helper', 'package'])('falls back with a reason for a missing %s and resumes when available', missing => {
    const h = host();
    useGraphStatusStore.setState({ status: { helper: { available: missing !== 'helper' }, registrations: missing === 'package' ? [] : [reg] } as never });
    const wanted = desiredHandoff(h, view);
    expect(wanted).toEqual({ shown: 'linear', reason: 'unavailable' });
    const next = applyShown(panels(), 'host', wanted.shown, wanted.reason);
    expect(next[1].collapsed).toBe(false);
    useGraphStatusStore.setState({ status: { helper: { available: true }, registrations: [reg] } as never });
    expect(desiredHandoff(next[0], view)).toEqual({ shown: 'graph' });
  });

  it('snapshots run repeat and carrier options without enabling deferred masked fits', () => {
    const h = host();
    h.graphView!.runOptions = { repeat_columns: 'by_occurrence', carrier_features: 'drop' };
    const body = graphRequestBody(useBrowserStore.getState(), { host: h, registration: reg, target: 'target', regions: [], observations: [] });
    expect(body.options).toEqual({ repeat_columns: 'by_occurrence', carrier_features: 'drop', coverage_rule: 'require_all' });
    expect(JSON.parse(JSON.stringify(h)).graphView.runOptions).toEqual(h.graphView!.runOptions);
  });
});

function recordedRun(): ClusterMatchedRun {
  return { groups: ['graph'], windows: [{ key: 'obs', stateKey: 'host', panelId: 'host', label: 'Strain', genome: null }],
    assignments: { obs: { a: 0, b: 1 } }, panelAssignments: { host: { a: 0, b: 1 } }, windowNmi: null, referenceNmi: null,
    balancedFitReads: 2, lengths: [60], graph: { schema: 1, registrationId: reg.id, revisions: reg.revisions,
      target: 'target', hostPanelId: 'host', regions: [{ start: 0, end: 60, mode: 'accessibility' }],
      options: { repeat_columns: 'by_occurrence' }, observations: [{ id: 'obs', dataset_id: 'dataset', kind: 'graph',
        binding: 'source', hap: 'strain', label: 'Strain' }], stages: [], labelIds: {}, settings: {}, columns: {
        shared: [], carrier_sets: [{ carriers: ['obs'], features: [{ kind: 'insertion', label: 'Repeated sequence', length: 80,
          region: 0, samples: 8, nodes: ['["repeat","s-copy-a"]', '["repeat","s-copy-b"]'], anchor: [29, 30] }] }],
        dropped: [{ kind: 'insertion', label: 'Small part', length: 1, samples: 0, carriers: ['obs'], reason: 'No samples' }],
      } } };
}

describe('recorded graph parts and peer source columns', () => {
  it('lists each part with its carriers and explains dropped parts', () => {
    expect(graphParts(recordedRun())).toMatchObject([
      { part: { label: 'Repeated sequence' }, carriers: ['Strain'], status: 'Carrier refinement' },
      { part: { label: 'Small part' }, carriers: ['Strain'], status: 'No samples' },
    ]);
  });

  it('outlines occurrence-qualified repeat parts on the correct path', () => {
    const outlines = runOutlines(recordedRun(), scene(), reg.id, 'target');
    expect(outlines.some(o => o.kind === 'carrier')).toBe(true);
  });

  it('adds a source pop-out as a separate chart column while retaining one fitted observation', () => {
    const run = recordedRun();
    const source = basePanel('source-panel', { stateKey: 'source-key', title: 'Strain source',
      liftLink: { datasetId: 'dataset', hap: '0', hapLabel: 'strain' } as never });
    const chart = withGraphSourceColumns(run, [source], { 'source-key': { a: 0, b: 1 } })!;
    expect(chart.windows.map(w => w.label)).toEqual(['Strain', 'Strain source']);
    expect(matchedRunCounts(chart).map(c => c.counts)).toEqual([[1, 1], [1, 1]]);
    expect(chart.graph!.observations).toHaveLength(1);
    expect(withGraphSourceColumns({ ...run, windows: [{ ...run.windows[0], panelId: source.id }] }, [source],
      { 'source-key': { a: 0, b: 1 } })!.windows).toHaveLength(2);
    expect(run.windows).toHaveLength(1);
    expect(chart.balancedFitReads).toBe(2);
    expect(withGraphSourceColumns(run, [source], { 'source-key': { a: 9 } })).toBe(run);
    expect(withGraphSourceColumns(run, [{ ...source, collapsed: true }], { 'source-key': { a: 0 } })).toBe(run);
  });
});

describe('every annotation layer on graph rows', () => {
  const names = ['fpcls', 'nfrvar', 'nfrmol', 'nucmol', 'custom', 'm5c', 'deam', 'deam_ct', 'deam_ga'];
  function row(): GraphRead {
    return { k: 'synthetic', d: 'dataset', lib: 0, q: 'synthetic', rec: 'record', b: 'target', c: 'chrA',
      st: '+', sup: false, s: 0, e: 30, cov: [[0, 10, 0, 1], [15, 30, 15, 1]], ins: [],
      layers: Object.fromEntries(names.map(name => [name, { iv: [[5, 25, 20]], id: ['call'], part: [[5, 0]],
        code: [42], custom_byte: [210], annotation_names: ['feature'] }])) as never };
  }

  it.each([false, true])('places and draws generic layers with whole sizes/bytes, clipped at holes (reversed=%s)', reversed => {
    const r = row(), sc = scene(reversed), index = placementIndex(sc, topology);
    const m = placeRead(r, index);
    expect(Object.keys(graphCallLayers(r)).filter(k => r.layers?.[k])).toEqual(names);
    for (const name of names) {
      const calls = m.calls.filter(c => c.layer === name);
      expect(calls).toHaveLength(2);
      expect(calls.every(c => c.call[2] === 20 && c.qualities.custom_byte === 210 && c.qualities.code === 42)).toBe(true);
      expect(calls.every(c => c.annotationName === 'feature')).toBe(true);
      expect(calls.every(c => c.s1 <= 10 || c.s0 >= 15)).toBe(true);
    }
    const lanes = packMolecules([m], 10);
    const banded = scene(reversed, { target: bandHeight(lanes.get('target')) });
    const ctx = new Proxy({}, { get: () => () => {}, set: () => true }) as CanvasRenderingContext2D;
    const on = emptyDrawStats(), off = emptyDrawStats();
    drawReads(ctx, banded, lanes, chromatinStyle(DEFAULT_COLORMAP), effectiveReadLayers(Object.fromEntries(names.map(n => [n, true]))), {}, 7, 2, 1, on);
    drawReads(ctx, banded, lanes, chromatinStyle(DEFAULT_COLORMAP), effectiveReadLayers({}), {}, 7, 2, 1, off);
    expect(on.extra).toEqual(Object.fromEntries(names.map(n => [n, 2])));
    expect(off.extra).toBeUndefined();
    expect(placeReads([r], index, 1).marksHidden).toBe(1);
  });

  it('uses the configured layer colour, opacity and quality-gated rules for custom annotations', () => {
    expect(chromatinStyle(DEFAULT_COLORMAP, { custom: '#123456' }).call('custom', 20, {})!.color).toBe('#123456');
    const rule = { ...DEFAULT_COLORMAP.rules[0], id: 'custom-rule', enabled: true, targetLayers: ['custom'],
      sizeMin: 1, sizeMax: null, conditions: [], qualityGates: [{ qualityName: 'custom_byte', minValue: 200 }], color: '#abcdef', opacity: 0.8 };
    const style = chromatinStyle({ ...DEFAULT_COLORMAP, rules: [rule] } as never);
    expect(style.call('custom', 20, { custom_byte: 210 })!.color).toBe('#abcdef');
    expect(style.call('custom', 20, { custom_byte: 10 })!.color).not.toBe('#abcdef');
  });
});
