import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeBrowserAction } from './browserActions';
import { useBrowserStore } from '../stores/browserStore';
import { registerClusterRunner } from '../utils/clusterRunner';
import type { BrowserState } from '../stores/browserStore';

vi.mock('../utils/copilotAnchors', () => ({
  highlightForAction: vi.fn(async () => undefined),
  COPILOT_ANCHORS: {} as Record<string, unknown>,
}));

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('round-6 action fixes: selected-peak clustering under a cluster rule', () => {
  beforeEach(() => {
    useBrowserStore.setState(useBrowserStore.getInitialState(), true);
    const base = {
      id: 'panel-ds1', contentType: 'dataset', datasetId: 'ds1', subTracks: [],
      collapsed: false, linkGroup: null, layoutRow: 0,
    };
    useBrowserStore.setState({
      chrom: '2R', start: 1000, end: 2000,
      datasets: [{ id: 'ds1', label: 'Dataset 1', available_layers: { tf: true, nuc: true } }],
      panels: [base, { ...base, id: 'copy', stateKey: 'copy', viewportOverride: { chrom: '3L', start: 5000, end: 6000 } }],
      selectedDatasets: new Set<string>(),
    } as unknown as Partial<BrowserState>);
    const ruleId = useBrowserStore.getState().peakRules[0].id;
    useBrowserStore.getState().setPeaksByRule(ruleId, [{ start: 1200, end: 1300, index: 0, layer: 0 }]);
    useBrowserStore.setState({
      clusterAssignments: { copy: { c1: 4, c2: 5 } },
      selectedPeaks: new Set([0]),
      clusterPeakMode: 'cluster_rule:r1',
      clusterFeatureRules: [{ id: 'r1', name: 'Promoter', enabled: true, scope: { kind: 'currentWindow' }, terms: [] }],
    } as unknown as Partial<BrowserState>);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    registerClusterRunner(null);
  });

  it('runs the panel-aware button on the selected peaks, then restores the rule mode', async () => {
    const seen: unknown[] = [];
    registerClusterRunner(async () => {
      seen.push(useBrowserStore.getState().clusterPeakMode);
      useBrowserStore.getState().setClusterAssignments('ds1', { r1: 0, r2: 1 });
    });
    const message = await executeBrowserAction({ type: 'cluster_selected_peaks' });
    expect(message).toMatch(/Clustered 2 reads/);
    expect(seen).toEqual(['accessibility']);
    expect(useBrowserStore.getState().clusterPeakMode).toBe('cluster_rule:r1');
    expect(useBrowserStore.getState().clusterAssignments.copy).toEqual({ c1: 4, c2: 5 });
  });

  it('the fallback (no browser view) writes only to panels showing the main view', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({
      results: { ds1: { assignments: { r1: 0, r2: 1 } } },
    })));
    await executeBrowserAction({ type: 'cluster_selected_peaks' });
    const after = useBrowserStore.getState().clusterAssignments;
    expect(after.ds1).toEqual({ r1: 0, r2: 1 });
    expect(after.copy).toEqual({ c1: 4, c2: 5 });
  });
});

describe('round-6 store fixes', () => {
  beforeEach(() => {
    useBrowserStore.setState(useBrowserStore.getInitialState(), true);
  });

  it('a new custom peak never reuses an index a surviving custom peak still has', () => {
    const store = useBrowserStore.getState();
    const customId = store.getCustomRuleId();
    // Only the second of two drawn peaks survived (the first was pruned on navigation).
    const surviving = { start: 500, end: 600, index: 0, layer: 0, isCustom: true, ruleId: customId, chrom: '2L' };
    const idx = store.peakRules.findIndex(r => r.id === customId);
    surviving.index = idx * 10000 + 1;
    useBrowserStore.setState({ peaksByRule: { [customId]: [surviving] } } as unknown as Partial<BrowserState>);
    useBrowserStore.getState().addCustomPeak(900, 1000);
    const peaks = useBrowserStore.getState().peaksByRule[customId];
    expect(new Set(peaks.map(p => p.index)).size).toBe(2);
  });

  it('loading a peak preset clears the selection of the old peaks', () => {
    const store = useBrowserStore.getState();
    useBrowserStore.setState({
      savedPeakPresets: [{ name: 'P', rules: store.peakRules.map(r => ({ ...r })) }],
      selectedPeaks: new Set([0, 1]),
      peakModes: { 0: 'tf' },
    } as unknown as Partial<BrowserState>);
    useBrowserStore.getState().loadPeakPreset('P');
    const st = useBrowserStore.getState();
    expect(st.selectedPeaks.size).toBe(0);
    expect(st.peakModes).toEqual({});
    expect(st.peaksByRule).toEqual({});
  });
});
