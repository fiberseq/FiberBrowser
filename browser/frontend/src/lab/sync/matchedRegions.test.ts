import '../testSetup';
import { beforeEach, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { DEFAULT_PEAK_RULES } from '../../types';
import { rigidMatchedRegions } from '../../utils/matchedRegions';
import { clusterBasis, clusterRunPlan, clusterTargetPlan } from '../../utils/clusterTargets';
import { beginRun } from '../../stores/runResultStore';
import { fetchJson } from '../../api/sharedFetch';
import { runMatchedRegions } from './matchedRegions';
vi.mock('../../api/sharedFetch', () => ({ fetchJson: vi.fn() }));
beforeEach(() => {
  vi.clearAllMocks();
  useBrowserStore.setState({ peakRules: DEFAULT_PEAK_RULES, peaksByRule: {}, selectedPeaks: new Set(), peakModes: {},
    chrom: 'chr1', start: 0, end: 300, datasets: [{ id: 'd', label: 'native' }, { id: 'e', label: 'copies' }] as never,
    panels: [{ id: 'p', datasetId: 'd', contentType: 'dataset' }, { id: 'q', datasetId: 'e', contentType: 'dataset', genome: 'alt', viewportOverride: { chrom: 'chr2', start: 400, end: 1000 } }] as never,
    clusterAssignments: {}, clusterMatchedRun: null, activeClusterTreeNodeId: null, clusterTreeNodes: {}, clusterTreeRootIds: [],
    selectedClusters: {}, clusterFocus: {}, filteredReadIds: {}, selectedDatasets: new Set(), selectedFeatures: [],
    clusterMethod: 'kmeans', _historyStack: [], _historyPointer: -1 });
  const regions = rigidMatchedRegions([{ index: 0, chrom: 'chr1', start: 100, end: 200 }, { index: 1, chrom: 'chr2', genome: 'alt', start: 500, end: 600 }, { index: 2, chrom: 'chr2', genome: 'alt', start: 800, end: 900 }], 'chr1');
  regions[1].match!.copy = 'a'; regions[2].match!.copy = 'b';
  useBrowserStore.getState().upsertMatchedGroup({ id: 'matched-f', name: 'F1', regions });
  useBrowserStore.getState().selectMatchedGroup('matched-f');
  beginRun('cluster');
  vi.mocked(fetchJson).mockResolvedValue({ results: { 'd@matched-f:W1': { assignments: { r: 0 } }, 'e@matched-f:W2': { assignments: { r: 1 } }, 'e@matched-f:W3': { assignments: { r: 0 } } },
    matched: { lengths: [100], balanced_fit_reads: 1, balanced: true, fit_reads: 3 }, window_separation_nmi: 0.5, reference_separation_nmi: 0.4 });
});
it('applies copy a to reads, saves all copy assignments, and reports balance and separation', async () => {
  const report = vi.fn(), s = useBrowserStore.getState();
  await runMatchedRegions(s, clusterBasis(s), report);
  const now = useBrowserStore.getState();
  expect(now.clusterAssignments).toMatchObject({ d: { r: 0 }, e: { r: 1 } });
  expect(now.clusterMatchedRun?.windows).toHaveLength(3);
  expect(now.clusterMatchedRun?.assignments['e@matched-f:W3']).toEqual({ r: 0 });
  expect(now.dynamicClustering).toBe(false);
  expect(report).toHaveBeenCalledWith('note', expect.stringContaining('Clusters largely separate'), ['p', 'q', 'q']);
  expect(now.clusterMatchedRun?.details).toContain('W2 (copy a) shown on reads; W3 in the charts');
  expect(now.clusterMatchedRun?.details).toContain('NMI 0.50');
  const body = JSON.parse(vi.mocked(fetchJson).mock.calls[0][1]!.body as string);
  expect(body.viewports.map((w: any) => w.genome)).toEqual([null, 'alt', 'alt']);
  expect(body.peak_regions).toEqual([{ start: 0, end: 100, mode: 'accessibility' }]);
});
it('does not apply a response after a region is reversed', async () => {
  const s = useBrowserStore.getState();
  const promise = runMatchedRegions(s, clusterBasis(s), vi.fn());
  s.reverseMatchedRegion(20000);
  await expect(promise).rejects.toThrow('changed while clustering');
  expect(useBrowserStore.getState().clusterAssignments).toEqual({});
});

it('allows plain peaks across references with an order-pairing note and a link', () => {
  const s = useBrowserStore.getState();
  s.removeMatchedGroup('matched-f');
  s.addCustomPeak(100, 200, 'chr1'); s.addCustomPeak(500, 620, 'chr2', 'alt');
  s.replacePeakSelection([10000, 10001]);
  const plan = clusterRunPlan(useBrowserStore.getState());
  expect(plan.refusal).toBeNull();
  expect(plan.basis.kind).toBe('ordered');
  expect(plan.rows.every(r => r.inRun)).toBe(true);
  expect(plan.advice?.action).toEqual({ label: 'Synchronise regions', panel: 'sync-regions' });
  expect(plan.advice?.text).toContain('not verified matches');
  expect(plan.advice?.text).not.toContain('same offsets');
});
it.each([[], ['p'], ['p', 'q']])('keeps the original plan when only the other reference has a selected peak (targets: %j)', (...targets) => {
  const s = useBrowserStore.getState();
  s.removeMatchedGroup('matched-f');
  s.addCustomPeak(500, 600, 'chr2', 'alt');
  s.replacePeakSelection([10000]);
  useBrowserStore.setState({ selectedDatasets: new Set(targets) });
  const now = useBrowserStore.getState(), basis = clusterBasis(now);
  const plan = clusterRunPlan(now);
  expect(plan).toMatchObject(clusterTargetPlan(now, basis.regions, undefined, basis));
  expect(plan.basis.kind).toBe('peaks');
  if (targets.length) expect(plan.refusal).toContain("Cluster can't include native");
  else {
    expect(plan.refusal).toBeNull();
    expect(plan.chip).toBe('Panels: copies · 1 left out');
    expect(plan.rows.map(r => r.inRun)).toEqual([false, true]);
  }
});
it.each(['reference', 'chromosome', 'coordinates', 'selection', 'count'])('does not pair when a panel lacks its own equal selected peaks: %s', async boundary => {
  const s = useBrowserStore.getState();
  s.removeMatchedGroup('matched-f');
  s.addCustomPeak(100, 200, 'chr1');
  s.addCustomPeak(boundary === 'coordinates' ? 1100 : 500, boundary === 'coordinates' ? 1200 : 600,
    boundary === 'chromosome' ? 'chr3' : 'chr2', boundary === 'reference' ? undefined : 'alt');
  if (boundary === 'count') s.addCustomPeak(800, 900, 'chr2', 'alt');
  s.replacePeakSelection(boundary === 'selection' ? [10000] : boundary === 'count' ? [10000, 10001, 10002] : [10000, 10001]);
  const now = useBrowserStore.getState(), basis = clusterBasis(now);
  expect(clusterRunPlan(now)).toMatchObject(clusterTargetPlan(now, basis.regions, undefined, basis));
  const { clusterBasisRunner } = await import('../../utils/clusterRunExtensions');
  await expect(clusterBasisRunner('ordered')!(now, { ...basis, kind: 'ordered' }, vi.fn())).rejects.toThrow('same number of peaks in each panel');
  expect(fetchJson).not.toHaveBeenCalled();
});
it('sends ordinary peaks on their own references through the ordered window runner', async () => {
  const s = useBrowserStore.getState();
  s.removeMatchedGroup('matched-f'); s.addCustomPeak(100, 200, 'chr1'); s.addCustomPeak(500, 620, 'chr2', 'alt');
  s.replacePeakSelection([10000, 10001]);
  const now = useBrowserStore.getState();
  const plan = clusterRunPlan(now);
  const { clusterBasisRunner } = await import('../../utils/clusterRunExtensions');
  await clusterBasisRunner(plan.basis.kind)!(now, plan.basis, vi.fn());
  const body = JSON.parse(vi.mocked(fetchJson).mock.calls[0][1]!.body as string);
  expect(body.viewports.map((w: any) => w.blocks[0].genomic)).toEqual([[100, 200], [510, 610]]);
  expect(body.viewports.map((w: any) => w.genome)).toEqual([null, 'alt']);
});

it('adds a typed region to the selected rigid group and keeps partner orientation', async () => {
  const { regionAnalysisExtension } = await import('../../utils/regionAnalysis');
  const s=useBrowserStore.getState();
  const old=s.peaksByRule['matched-f'][0];
  s.reverseMatchedRegion(old.index);
  regionAnalysisExtension()!.link({chrom:'chr2',start:1100,end:1200,genome:'alt'});
  const now=useBrowserStore.getState();
  expect(now.peakRules.filter(r=>r.source==='matched')).toHaveLength(1);
  expect(now.peaksByRule['matched-f']).toHaveLength(4);
  expect(now.peaksByRule['matched-f'][0].match?.reversed).toBe(true);
  regionAnalysisExtension()!.link({chrom:'chr2',start:1100,end:1200,genome:'alt'});
  expect(useBrowserStore.getState().peaksByRule['matched-f']).toHaveLength(4);
});

it('extends a manual group without duplicating its selected source peaks, including cropped sources', async () => {
  const { linkSelectedRegions } = await import('./matchedRegions');
  const s = useBrowserStore.getState();
  s.removeMatchedGroup('matched-f');
  s.addCustomPeak(100, 200, 'chr1'); s.addCustomPeak(500, 620, 'chr2', 'alt');
  s.replacePeakSelection([10000, 10001]);
  const id = linkSelectedRegions()!;
  s.addCustomPeak(800, 900, 'chr2', 'alt');
  useBrowserStore.setState(st => ({ selectedPeaks: new Set([...st.selectedPeaks, 10002]) }));
  expect(linkSelectedRegions()).toBe(id);
  expect(useBrowserStore.getState().peaksByRule[id]).toHaveLength(3);
});

it('crops the longest block shared by every window without crossing the origin or changing orientation', async () => {
  const { longestSharedBlock } = await import('./matchedRegions');
  const peaks = useBrowserStore.getState().peaksByRule['matched-f'].map(p => ({ ...p, match: { ...p.match!, length: 500,
    blocks: [{ frame: [0, 150] as [number, number], genomic: [900, 1050] as [number, number] },
      { frame: [200, 500] as [number, number], genomic: [0, 300] as [number, number] }], wrapsOrigin: true } }));
  peaks[1].match.reversed = true;
  peaks[2].match.blocks = [{ frame: [250, 430], genomic: [500, 680] }];
  const result = longestSharedBlock(peaks, 100)!;
  expect(result.map(p => [p.start, p.end])).toEqual([[50, 230], [70, 250], [500, 680]]);
  expect(result[1].match?.reversed).toBe(true);
  expect(result.every(p => !p.match?.wrapsOrigin && p.match?.length === 180)).toBe(true);
  expect(longestSharedBlock(peaks, 181)).toBeNull();
  expect(peaks[0].match.blocks).toHaveLength(2);
});

it('offers a shared-block action that creates and selects a new rigid group and can be undone', async () => {
  const { selectedAnalysisWindows } = await import('../../utils/regionAnalysis');
  const s = useBrowserStore.getState();
  const peaks = s.peaksByRule['matched-f'].map(p => ({ ...p, end: p.end + 200, match: { ...p.match!, length: 300,
    blocks: [{ frame: [0, 100] as [number, number], genomic: [p.start, p.start + 100] as [number, number] },
      { frame: [100, 300] as [number, number], genomic: [p.start + 100, p.start + 300] as [number, number] }] } }));
  s.upsertMatchedGroup({ id: 'matched-f', name: 'F1', regions: peaks });
  const before = useBrowserStore.getState().peaksByRule['matched-f'];
  const choice = selectedAnalysisWindows(useBrowserStore.getState(), ['d', 'e']);
  expect(choice.recovery?.label).toBe('Use the longest shared block');
  choice.recovery!.run();
  const now = useBrowserStore.getState();
  const group = now.peakRules.find(r => r.name === 'F1 · shared block')!;
  expect(now.peaksByRule[group.id]).toHaveLength(3);
  expect(now.peaksByRule[group.id].every(p => now.selectedPeaks.has(p.index))).toBe(true);
  expect(now.peaksByRule['matched-f']).toBe(before);
  expect(before.every(p => !now.selectedPeaks.has(p.index))).toBe(true);
  now.undo();
  expect(useBrowserStore.getState().peakRules.some(r => r.id === group.id)).toBe(false);
});

it('shares selection and focus across all panels of the current run, including duplicate windows', async () => {
  const s = useBrowserStore.getState();
  await runMatchedRegions(s, clusterBasis(s), vi.fn());
  useBrowserStore.setState(st => ({ clusterAssignments: { ...st.clusterAssignments, outside: { x: 1 } } }));
  s.setClusterSelection('d', [1]);
  expect(useBrowserStore.getState().selectedClusters).toEqual({ d: new Set([1]), e: new Set([1]) });
  s.toggleClusterSelection('e', 0);
  expect(useBrowserStore.getState().selectedClusters).toEqual({ d: new Set([0, 1]), e: new Set([0, 1]) });
  s.toggleClusterSelection('d', 1);
  expect(useBrowserStore.getState().selectedClusters.e).toEqual(new Set([0]));
  s.clearClusterSelection('e');
  expect(useBrowserStore.getState().selectedClusters).toEqual({});
  s.setClusterFocus('e', new Set([1]));
  expect(useBrowserStore.getState().clusterFocus).toEqual({ d: new Set([1]), e: new Set([1]) });
  s.focusClustersIn(['d'], null);
  expect(useBrowserStore.getState().clusterFocus).toEqual({ d: null, e: null });
  s.setClusterSelection('outside', [1]);
  expect(useBrowserStore.getState().selectedClusters).toEqual({ outside: new Set([1]) });
});

it('stops sharing picks when a displayed assignment changes', async () => {
  const s = useBrowserStore.getState();
  await runMatchedRegions(s, clusterBasis(s), vi.fn());
  s.setClusterAssignments('e', { r: 7 });
  s.setClusterSelection('d', [0]);
  expect(useBrowserStore.getState().selectedClusters).toEqual({ d: new Set([0]) });
});

it('explains that graph pools every region without a balanced fit', async () => {
  useBrowserStore.setState({ clusterMethod: 'graph' });
  const s = useBrowserStore.getState(), report = vi.fn();
  await runMatchedRegions(s, clusterBasis(s), report);
  expect(useBrowserStore.getState().clusterMatchedRun?.details).toContain('one neighbourhood graph across all regions');
});

it('toggles an action targeting both run panels only once', async () => {
  const s = useBrowserStore.getState();
  await runMatchedRegions(s, clusterBasis(s), vi.fn());
  const { executeBrowserAction } = await import('../../actions/browserActions');
  useBrowserStore.setState({ selectedDatasets: new Set(['p', 'q']) });
  await executeBrowserAction({ type: 'toggle_cluster_selection', cluster_id: 1 });
  expect(useBrowserStore.getState().selectedClusters).toEqual({ d: new Set([1]), e: new Set([1]) });
  await executeBrowserAction({ type: 'toggle_cluster_selection', cluster_id: 1 });
  expect(useBrowserStore.getState().selectedClusters).toEqual({});
});


it.each(['signal', 'filter', 'undo'])('refuses a pending comparison after %s changes the read scope', async kind => {
  const s = useBrowserStore.getState();
  const pending = runMatchedRegions(s, clusterBasis(s), vi.fn());
  if (kind === 'signal') s.setSignalFilters({ requireDetectable: true });
  if (kind === 'filter') useBrowserStore.setState({ filteredReadIds: { d: new Set(['different']) } });
  if (kind === 'undo') useBrowserStore.setState({ _lastRestoreTime: s._lastRestoreTime + 1 });
  await expect(pending).rejects.toThrow('changed while clustering');
  expect(useBrowserStore.getState().clusterAssignments).toEqual({});
});

it('reports successful shared features plainly and keeps geometry in Cluster detail and history', async () => {
  vi.mocked(fetchJson).mockResolvedValue({ results: { 'd@matched-f:W1': { assignments: { r: 0, s: 1 } },
    'e@matched-f:W2': { assignments: { r: 1 } }, 'e@matched-f:W3': { assignments: { r: 0 } } },
    matched: { lengths: [100], balanced_fit_reads: 1, balanced: true, fit_reads: 3 },
    window_separation_nmi: 0, reference_separation_nmi: 0 });
  const report = vi.fn(), s = useBrowserStore.getState();
  await runMatchedRegions(s, clusterBasis(s), report);
  expect(report).toHaveBeenCalledWith('done', 'Clustered 4 reads on 1 shared feature, balanced at 1 read per panel.', ['p', 'q', 'q']);
  const details = useBrowserStore.getState().clusterMatchedRun?.details;
  expect(details).toContain('100 bp per feature');
  useBrowserStore.getState().undo();
  useBrowserStore.getState().redo();
  expect(useBrowserStore.getState().clusterMatchedRun?.details).toBe(details);
});
