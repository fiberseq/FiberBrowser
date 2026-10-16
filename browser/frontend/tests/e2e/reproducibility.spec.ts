/**
 * Reproducibility roundtrip tests: session frontend state and notebook-synced
 * browser state survive the full backend server boundary.
 */
import { test, expect } from './fixtures/server';

test('session export/import preserves locked peaks, history, cart, and manifest state', async ({ server, request }) => {
  const frontend = {
    analysisSampleSeed: 'e2e-seed',
    analysisSampleCount: 5000,
    downsampleCount: 1000,
    peaksLocked: true,
    selectedPeaks: [3],
    peakRules: [{ id: 'rule-e2e', source: 'accessibility', enabled: true }],
    peaksByRule: { 'rule-e2e': [{ index: 3, chrom: 'chr2L', start: 120, end: 180 }] },
    clusterAssignments: { primary: { read_a: 0, read_b: 1 } },
    clusterOrder: { primary: [0, 1] },
    readSortOrder: { primary: ['read_a', 'read_b'] },
    captureRegions: [{ id: 'cap-e2e', name: 'cap', chrom: 'chr2L', start: 100, end: 200, padding: 25, addedAt: 1, source: 'custom' }],
    catalog: [{ id: 'cat-e2e', source: 'local', kind: 'bigbed', label: 'TF', loaded: false }],
    compositeTracks: [{ id: 'comp-e2e', label: 'TF', kind: 'annotation', sources: [], scaleMode: 'auto', logScale: false, visible: true, groupAutoscaleSelected: false, showAxes: true }],
    savedTracks: [{ id: 'saved-e2e', name: 'TF preset', savedAt: '2026-04-30T00:00:00Z', composite: { label: 'TF', kind: 'annotation', sources: [], scaleMode: 'auto', logScale: false, visible: true, groupAutoscaleSelected: false, showAxes: true } }],
    historySnapshots: [{ label: 'Locked peaks', timestamp: 1, kind: 'analysis', state: { chrom: 'chr2L', start: 100, end: 300 } }],
    sessionManifest: { sessionName: 'E2E session', reproducibility: { seed: 'e2e-seed' }, warnings: [] },
  };

  const exported = await request.post(`${server.baseUrl}/api/session/export`, {
    data: {
      chrom: 'chr2L',
      start: 100,
      end: 300,
      frontend_state: frontend,
    },
  });
  expect(exported.ok()).toBeTruthy();
  const session = await exported.json();
  expect(session.frontend.sessionManifest.reproducibility.seed).toBe('e2e-seed');
  expect(session.frontend.historySnapshots[0].kind).toBe('analysis');

  const imported = await request.post(`${server.baseUrl}/api/session/import`, { data: { session } });
  expect(imported.ok()).toBeTruthy();
  const payload = await imported.json();
  expect(payload.frontend.peaksLocked).toBe(true);
  expect(payload.frontend.clusterOrder.primary).toEqual([0, 1]);
  expect(payload.frontend.captureRegions[0].id).toBe('cap-e2e');
  expect(payload.frontend.savedTracks[0].id).toBe('saved-e2e');
});

test('jupyter analysis_state exposes panel and cluster reproducibility state', async ({ server, request }) => {
  const snapshot = {
    analysis_sample_seed: 'notebook-e2e',
    selected_peaks: [1],
    selected_peak_count: 1,
    peaks_by_rule: { rule: [{ index: 1, start: 10, end: 20 }] },
    active_panels: [{ id: 'panel-cluster-detail', content_type: 'cluster-detail' }],
    hidden_strip_panels: ['history'],
    cluster_assignments: { primary: { read_a: 0 } },
    cluster_order: { primary: [0] },
    read_sort_order: { primary: ['read_a'] },
    session_manifest: { sessionName: 'Notebook E2E', reproducibility: { seed: 'notebook-e2e' }, warnings: [] },
  };

  const synced = await request.post(`${server.baseUrl}/api/jupyter/settings/sync`, { data: snapshot });
  expect(synced.ok()).toBeTruthy();

  const state = await request.get(`${server.baseUrl}/api/jupyter/analysis_state`);
  expect(state.ok()).toBeTruthy();
  const payload = await state.json();
  expect(payload.manifest.sessionName).toBe('Notebook E2E');
  expect(payload.active_panels[0].content_type).toBe('cluster-detail');
  expect(payload.hidden_strip_panels).toEqual(['history']);
  expect(payload.clusters.read_sort_order.primary).toEqual(['read_a']);
});
