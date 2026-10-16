import { beforeEach, describe, expect, it } from 'vitest';
import { createTestStore } from '../stores/__tests__/helpers';
import { rigidMatchedRegions } from './matchedRegions';
import { DEFAULT_PEAK_RULES } from '../types';
import { serializeState, deserializeSavedState, onlyDerivedHistoryChange } from '../stores/historySlice';
import { clusterBasis, clusterRunPlan } from './clusterTargets';
import { currentMatchedRun, matchedRunCounts, type ClusterMatchedRun } from './clusterMatchedRun';

let store: ReturnType<typeof createTestStore>;
const regions = () => rigidMatchedRegions([{ index: 0, start: 100, end: 200, chrom: 'chr1' }, { index: 1, start: 500, end: 620, chrom: 'chr2', genome: 'alt' }], 'chr1');
const add = (id = 'matched-test') => store.getState().upsertMatchedGroup({ id, name: id === 'matched-test' ? 'F1' : 'F2', regions: regions() });
beforeEach(() => { localStorage.clear(); store = createTestStore(); });

it('selects partners, shift toggles groups, preserves plain selections and applies one mode per group', () => {
  add(); add('matched-other');
  store.setState({ selectedPeaks: new Set([0]) });
  const s = store.getState();
  s.selectMatchedGroup('matched-test');
  expect([...store.getState().selectedPeaks]).toEqual([0, 20000, 20001]);
  s.setPeakMode(20000, 'modification');
  expect(store.getState().peakModes[20001]).toBe('modification');
  s.selectMatchedGroup('matched-other', true);
  expect(store.getState().selectedPeaks.size).toBe(5);
  s.selectMatchedGroup('matched-test');
  expect([...store.getState().selectedPeaks]).toEqual([0]);
  s.reverseMatchedRegion(20000);
  expect(store.getState().peaksByRule['matched-test'][0].match?.reversed).toBe(true);
});

it('keeps groups, modes and selection through navigation, presets, reordering and reset', () => {
  add();
  store.getState().selectMatchedGroup('matched-test');
  store.getState().setPeakMode(20000, 'modification');
  for (const act of [() => store.getState().setViewport('chr5', 1000, 2000), () => store.getState().setViewport('chr5', 2000, 3000),
    () => store.getState().resetView(), () => store.getState().clearPeaksByRule()]) {
    act();
    expect(store.getState().peaksByRule['matched-test']).toHaveLength(2);
    expect(store.getState().selectedPeaks.has(20001)).toBe(true);
    expect(store.getState().peakModes[20001]).toBe('modification');
  }
  store.getState().savePeakPreset('plain');
  expect(store.getState().savedPeakPresets[0].rules.some(r => r.source === 'matched')).toBe(false);
  store.getState().loadPeakPreset('plain');
  store.getState().setPeakRules([DEFAULT_PEAK_RULES[1]]);
  expect(store.getState().peaksByRule['matched-test'][0].index).toBe(10000);
  expect(store.getState().selectedPeaks.has(10001)).toBe(true);
  expect(store.getState().peakModes[10001]).toBe('modification');
});

it('round trips maps and keeps authored regions as undo steps', () => {
  const before = serializeState(store.getState());
  add(); store.getState().selectMatchedGroup('matched-test');
  const saved = serializeState(store.getState());
  expect(onlyDerivedHistoryChange(before, saved)).toBe(false);
  const restored = deserializeSavedState(JSON.parse(JSON.stringify(saved)));
  expect(restored.peaksByRule).toEqual(store.getState().peaksByRule);
  expect(restored.selectedPeaks).toEqual(store.getState().selectedPeaks);
  const bad = JSON.parse(JSON.stringify(saved));
  bad.peaksByRule['matched-test'][0].match.blocks[0].genomic[1]++;
  expect(deserializeSavedState(bad).peaksByRule!['matched-test']).toHaveLength(1);
});

it('clears transient pooled profiles on navigation, undo and group removal', () => {
  add();
  const scan = { peaks: [], n_reads: 10, profiles: [], members: {} };
  const put = () => store.getState().setCorrespondenceScans('default-accessibility', { 'matched-test': scan });
  put();
  store.getState().setViewport('chr8', 1000, 2000);
  expect(store.getState().correspondenceScans).toEqual({});
  put();
  expect(deserializeSavedState(serializeState(store.getState())).correspondenceScans).toEqual({});
  store.getState().removeMatchedGroup('matched-test');
  expect(store.getState().correspondenceScans['default-accessibility']).toEqual({});
});

it('clearing one scanned rule drops its selection before a new scan reuses the indices', () => {
  const s = store.getState(), rule = s.peakRules[0].id;
  s.setPeaksByRule(rule, [{ index: 0, chrom: 'chr1', start: 10, end: 20 }]);
  s.replacePeakSelection([store.getState().peaksByRule[rule][0].index]);
  s.clearPeaksByRule(rule);
  s.setPeaksByRule(rule, [{ index: 0, chrom: 'chr1', start: 100, end: 120 }]);
  expect(store.getState().selectedPeaks.size).toBe(0);
});

it('deletes whole selected groups and reindexes later groups', () => {
  add(); add('matched-other');
  store.setState({ selectedPeaks: new Set([20001]) });
  store.getState().deleteSelectedPeaks();
  expect(store.getState().peakRules.some(r => r.id === 'matched-test')).toBe(false);
  expect(store.getState().peaksByRule['matched-other'][0].index).toBe(20000);
});

it('plans regions across references and refuses groups with different panel coverage', () => {
  add(); store.getState().selectMatchedGroup('matched-test');
  store.setState({ chrom: 'chr1', start: 0, end: 300, datasets: [{ id: 'd' }, { id: 'e' }] as never,
    panels: [{ id: 'a', datasetId: 'd', contentType: 'dataset' }, { id: 'b', datasetId: 'e', genome: 'alt', contentType: 'dataset', viewportOverride: { chrom: 'chr2', start: 400, end: 700 } }] as never });
  const basis = clusterBasis(store.getState());
  expect(basis.kind).toBe('matched'); expect(basis.what).toContain('F1 (2 regions · 100 bp)');
  const plan = clusterRunPlan(store.getState());
  expect(plan.refusal).toBeNull(); expect(plan.chip).toBe('Panels: F1 · 2 panels / 2 regions');
  expect(plan.headline).toContain('2 references');
  store.getState().upsertMatchedGroup({ id: 'matched-other', name: 'F2', regions: regions().slice(0, 1) });
  store.getState().selectMatchedGroup('matched-other', true);
  expect(clusterRunPlan(store.getState()).refusal).toContain('different panels or copies');
});

it('composition counts every copy and drops stale results', () => {
  const run: ClusterMatchedRun = { groups: ['g'], windows: ['a', 'b', 'c'].map(key => ({ key, stateKey: 'd', panelId: 'p', label: key, genome: null })),
    assignments: { a: { r: 0 }, b: { r: 1 }, c: { r: 1, s: 0 } }, panelAssignments: { d: { r: 0 } }, windowNmi: null, referenceNmi: null, lengths: [100], balancedFitReads: 1 };
  expect(currentMatchedRun(run, { d: { r: 0 } })).toBe(run);
  expect(matchedRunCounts(run)).toEqual([{ cluster: 0, counts: [1, 0, 1], totalCount: 2 }, { cluster: 1, counts: [0, 1, 1], totalCount: 2 }]);
  expect(currentMatchedRun(run, { d: { r: 1 } })).toBeNull();
});
it('pairs multiple groups only when all their panel and copy keys agree', () => {
  add(); add('matched-second');
  store.getState().selectMatchedGroup('matched-test');
  store.getState().selectMatchedGroup('matched-second', true);
  store.setState({ chrom: 'chr1', start: 0, end: 300, datasets: [{ id: 'd' }, { id: 'e' }] as never,
    panels: [{ id: 'a', datasetId: 'd', contentType: 'dataset' }, { id: 'b', datasetId: 'e', genome: 'alt', contentType: 'dataset', viewportOverride: { chrom: 'chr2', start: 400, end: 700 } }] as never });
  expect(clusterRunPlan(store.getState()).refusal).toBeNull();
  expect(clusterBasis(store.getState()).regions).toHaveLength(4);
});

it('allows automatic scanning after navigation with only a durable selection', async () => {
  const { hasOrdinaryPeakSelection } = await import('./matchedRegions');
  add(); store.getState().selectMatchedGroup('matched-test');
  store.getState().setViewport('chr9', 0, 1000);
  expect(hasOrdinaryPeakSelection(store.getState())).toBe(false);
  store.setState({ selectedPeaks: new Set([...store.getState().selectedPeaks, 10000]) });
  expect(hasOrdinaryPeakSelection(store.getState())).toBe(true);
});
