import '../testSetup';
import { beforeEach, expect, it } from 'vitest';
import { useBrowserStore as store } from '../../stores/browserStore';
import { DEFAULT_PEAK_RULES, type PanelConfig } from '../../types';
import { rigidMatchedRegions } from '../../utils/matchedRegions';
import { openRegionPanels, closeRegionPanels } from '../../utils/regionPanels';
import { clusterWindows, matchedClusterWindows, clusterBasis } from '../../utils/clusterTargets';
import { panelReversed } from '../../hooks/usePanelDisplayStore';
import { splitStripSegments } from '../../components/tracks/SplitGroupStrip';

beforeEach(() => {
  store.setState({ peakRules: DEFAULT_PEAK_RULES, peaksByRule: {}, selectedPeaks: new Set(), peakModes: {},
    fullViewPanelId: null, collapsedRows: new Set(), chrom: 'chr1', start: 0, end: 2000, isReversed: false, navigationMode: 'linked',
    datasets: [{ id: 'd', label: 'copies' }, { id: 'e', label: 'native' }] as never,
    panels: [{ id: 'p', datasetId: 'd', contentType: 'dataset', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0 }],
    clusterAssignments: {}, clusterMatchedRun: null, selectedClusters: {}, clusterFocus: {}, filteredReadIds: {}, selectedDatasets: new Set(),
    selectedFeatures: [], _historyStack: [], _historyPointer: -1 });
});
function group(twoDatasets = false) {
  if (twoDatasets) store.setState(s => ({ panels: [...s.panels, { ...s.panels[0], id: 'q', datasetId: 'e' }] }));
  const regions = rigidMatchedRegions([100, 600, 1100].map((start, index) => ({ index, chrom: 'chr1', start, end: start + 100 })), 'chr1');
  regions.forEach((p, i) => { p.match!.datasetId = twoDatasets && i === 0 ? 'e' : 'd'; p.match!.reversed = i === 2; });
  store.getState().upsertMatchedGroup({ id: 'matched-g', name: 'Copies', regions });
}
it.each([false, true])('opens each copy independently across two datasets: %s', two => {
  group(two); openRegionPanels('matched-g');
  const s = store.getState(), panels = s.panels.filter(p => p.regionPanelGroup);
  expect(panels).toHaveLength(3);
  expect(new Set(panels.map(p => p.stateKey)).size).toBe(3);
  expect(panels.map(p => p.datasetId)).toEqual(two ? ['e', 'd', 'd'] : ['d', 'd', 'd']);
  expect(panels.map(p => p.viewportOverride!.end - p.viewportOverride!.start)).toEqual([140, 140, 140]);
  expect(panels.map(p => panelReversed(s, p.id))).toEqual([false, false, true]);
  const mapped = matchedClusterWindows(clusterWindows(s, ['d', 'e']), clusterBasis(s).regions);
  expect(mapped.windows.map(w => w.stateKey)).toEqual(panels.map(p => p.stateKey));
  expect(mapped.windows.map(w => w.region_label)).toEqual(['W1', 'W2', 'W3']);
  expect(splitStripSegments(panels.map(p => ({ panels: [p] })), [300, 300, 300], [true, true, true], 4)).toHaveLength(1);
});
it('reuses an exact panel and does not reopen an open group', () => {
  group(); store.setState(s => ({ panels: s.panels.map(p => ({ ...p, viewportOverride: { chrom: 'chr1', start: 80, end: 220 } })) }));
  openRegionPanels('matched-g');
  expect(store.getState().panels.filter(p => p.regionPanelGroup)[0].id).toBe('p');
  const panels = store.getState().panels; openRegionPanels('matched-g'); expect(store.getState().panels).toBe(panels);
});
it('close restores the previous layout, including after serialization and closing the first copy', () => {
  group(); const before = store.getState().panels;
  openRegionPanels('matched-g');
  const saved: PanelConfig[] = JSON.parse(JSON.stringify(store.getState().panels));
  store.setState({ panels: saved.filter(p => p.id !== saved[0].id) });
  closeRegionPanels('matched-g');
  expect(store.getState().panels).toEqual(before);
  expect(store.getState().navigationMode).toBe('linked');
});
it('undo restores the layout and per-panel Reverse', () => {
  group(); const before = store.getState().panels;
  openRegionPanels('matched-g'); const id = store.getState().panels[0].id;
  store.getState().setPanelReversed(id, true);
  expect(panelReversed(store.getState(), id)).toBe(true);
  store.getState().undo(); expect(panelReversed(store.getState(), id)).toBe(false);
  store.getState().undo(); expect(store.getState().panels).toEqual(before);
});
it('linked Reverse remains global', () => {
  store.getState().setPanelReversed('p', true);
  expect(panelReversed(store.getState(), 'p')).toBe(false);
  store.getState().toggleReversed(); expect(panelReversed(store.getState(), 'p')).toBe(true);
});

it('restores group panels and orientation through session serialization', async () => {
  const { serializeState, deserializeSavedState } = await import('../../stores/historySlice');
  group(); openRegionPanels('matched-g');
  const saved = JSON.parse(JSON.stringify(serializeState(store.getState())));
  closeRegionPanels('matched-g');
  store.setState(deserializeSavedState(saved));
  const panels = store.getState().panels.filter(p => p.regionPanelGroup);
  expect(panels).toHaveLength(3);
  expect(panelReversed(store.getState(), panels[2].id)).toBe(true);
  closeRegionPanels('matched-g'); expect(store.getState().panels.map(p => p.id)).toEqual(['p']);
});

it('routes each response to its own panel and propagates cluster picks', async () => {
  const { vi } = await import('vitest');
  const { runMatchedRegions } = await import('./matchedRegions');
  const { beginRun } = await import('../../stores/runResultStore');
  const { clusterSelectionKeys } = await import('../../utils/clusterMatchedRun');
  group(); openRegionPanels('matched-g'); beginRun('cluster');
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
    const request = JSON.parse(options!.body as string);
    return new Response(JSON.stringify({ results: Object.fromEntries(request.viewports.map((w: any, i: number) => [w.result_key, { assignments: { r: i } }])),
      matched: { lengths: [100], balanced_fit_reads: 1, balanced: true, fit_reads: 3 }, window_separation_nmi: 0, reference_separation_nmi: 0 }), { status: 200 });
  });
  try {
    store.getState().addCustomPeak(100, 200, 'chr1');
    store.getState().replacePeakSelection(store.getState().getAllPeaks().filter(p => p.isCustom).map(p => p.index));
    const s = store.getState(), basis = clusterBasis(s);
    expect(basis.regions.every(p => p.match?.correspondenceId === 'matched-g')).toBe(true);
    await runMatchedRegions(s, basis, vi.fn());
    const now = store.getState(), panels = now.panels.filter(p => p.regionPanelGroup);
    expect(panels.map(p => now.clusterAssignments[p.stateKey!])).toEqual([{ r: 0 }, { r: 1 }, { r: 2 }]);
    expect(clusterSelectionKeys(now, panels[0].stateKey!)).toEqual(panels.map(p => p.stateKey));
    expect(now.clusterMatchedRun?.groups).toEqual(['matched-g']);
    closeRegionPanels('matched-g'); openRegionPanels('matched-g');
    const reopened = store.getState();
    expect(reopened.panels.filter(p => p.regionPanelGroup).map(p => reopened.clusterAssignments[p.stateKey!])).toEqual([{ r: 0 }, { r: 1 }, { r: 2 }]);
  } finally { fetch.mockRestore(); }
});

it('puts the template first and Undo reopens a closed group', () => {
  group();
  store.setState(s => ({ peaksByRule: { ...s.peaksByRule, 'matched-g': s.peaksByRule['matched-g'].map((p, i) => ({ ...p, match: { ...p.match!, template: i === 2 } })) } }));
  openRegionPanels('matched-g');
  expect(store.getState().panels.filter(p => p.regionPanelGroup).map(p => p.title)).toEqual(['W3', 'W1', 'W2']);
  closeRegionPanels('matched-g'); store.getState().undo();
  expect(store.getState().panels.filter(p => p.regionPanelGroup)).toHaveLength(3);
});

it.each(['before', 'open', 'saved', 'scanned'])('reopening a completed run preserves every assignment (cluster: %s)', when => {
  const whileOpen = when !== 'before';
  group();
  if (whileOpen) openRegionPanels('matched-g');
  const sources = store.getState().panels.filter(p => p.regionPanelGroup);
  const panelAssignments = whileOpen ? Object.fromEntries(sources.map((p, i) => [p.stateKey!, { r: i }])) : { d: { r: 0 } };
  store.setState({ clusterAssignments: panelAssignments, clusterMatchedRun: {
    groups: [when === 'scanned' ? 'matched-g:rule:0-100' : 'matched-g'], windows: [0, 1, 2].map(i => ({ key: `k${i}`, stateKey: sources[i]?.stateKey ?? 'd', panelId: sources[i]?.id ?? 'p', datasetId: when === 'open' ? 'd' : undefined, label: `W${i + 1} · copies`, genome: null })),
    assignments: { k0: { r: 0 }, k1: { r: 1 }, k2: { r: 2 } }, panelAssignments,
    windowNmi: 0, referenceNmi: 0, balancedFitReads: 1, lengths: [100],
  } });
  if (whileOpen) closeRegionPanels('matched-g');
  for (let i = 0; i < 3; i++) {
    openRegionPanels('matched-g');
    const s = store.getState();
    expect(s.panels.filter(p => p.regionPanelGroup).map(p => s.clusterAssignments[p.stateKey!])).toEqual([{ r: 0 }, { r: 1 }, { r: 2 }]);
    expect(s.clusterMatchedRun!.windows.map(w => w.stateKey)).toEqual(s.panels.filter(p => p.regionPanelGroup).map(p => p.stateKey));
    const { panels, clusterMatchedRun, clusterAssignments } = JSON.parse(JSON.stringify(s));
    store.setState({ panels, clusterMatchedRun, clusterAssignments });
    closeRegionPanels('matched-g');
  }
});

it('opens visibly from a full view or folded row and restores both on Close', () => {
  group(); store.setState({ fullViewPanelId: 'p', collapsedRows: new Set([0]) });
  openRegionPanels('matched-g');
  expect(store.getState().fullViewPanelId).toBeNull();
  expect(store.getState().collapsedRows.has(0)).toBe(false);
  closeRegionPanels('matched-g');
  expect(store.getState().fullViewPanelId).toBe('p');
  expect(store.getState().collapsedRows.has(0)).toBe(true);
});
