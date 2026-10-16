import type { BrowserState } from '../stores/browserStore';
import { useBrowserStore } from '../stores/browserStore';
import { clusterBasis, clusterWindows, matchedClusterWindows, type ClusterBasis, type RegionClusterWindow } from './clusterTargets';
import { registerClusterBasisRunner } from './clusterRunExtensions';
import { captureRunViews, runViewsStillCurrent } from './panelRunScope';
import { fetchJson } from '../api/sharedFetch';
import { useRunResultStore } from '../stores/runResultStore';
import { seedHistoryBaseline } from '../stores/historySlice';
import { getDatasetDisplayLabel } from './datasetLabels';
import { sortStateStillCurrent } from './sortScope';
import type { ClusterMatchedRun } from './clusterMatchedRun';

/** Use one pooled fit for every accepted correspondence. */
export function registerEquivalentClustering() { registerClusterBasisRunner('matched', runMatchedRegions); }

interface Response {
  results: Record<string, { assignments: Record<string, number> }>;
  matched: { lengths: number[]; balanced_fit_reads: number; balanced: boolean; fit_reads: number };
  window_separation_nmi: number | null;
  reference_separation_nmi: number | null;
}

/** Execute one window per region and dataset, retaining all copies for composition charts. */
export async function runMatchedRegions(s: BrowserState, basis: ClusterBasis, report: (tone: 'error' | 'note' | 'done', text: string, panelIds?: string[]) => void) {
  const mapped = matchedClusterWindows(clusterWindows({ ...s, selectedDatasets: new Set() }, s.datasets.map(d => d.id)), basis.regions);
  if (mapped.refusal || !mapped.windows.length) throw new Error(mapped.refusal ?? 'No panel contains a selected region.');
  await executeRegionWindows(s, basis, mapped.windows, report);
}

export async function executeRegionWindows(s: BrowserState, basis: ClusterBasis, windows: RegionClusterWindow[], report: (tone: 'error' | 'note' | 'done', text: string, panelIds?: string[]) => void) {
  const groups = [...new Set(basis.regions.map(p => p.match!.groupId))];
  const features = groups.map(id => basis.regions.find(p => p.match!.groupId === id)!);
  const digest = JSON.stringify(basis.regions);
  const originalPeaks = s.peaksByRule;
  const runNumber = useRunResultStore.getState().runs.cluster;
  const views = captureRunViews(s, windows.map(w => w.stateKey));
  const response = await fetchJson<Response>('/api/cluster-regions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ frame_id: groups.join('+'), digest,
      viewports: windows.map(({ panel: _panel, stateKey: _key, ...w }) => w),
      member_specific_features: features.flatMap((p, i) => p.match!.memberSpecific ? [i] : []),
      peak_regions: features.map(p => ({ start: 0, end: p.match!.length, mode: p.mode })),
      k: s.clusterK, method: s.clusterMethod, dataset_ids: [...new Set(windows.map(w => w.dataset_id))],
      max_reads: s.analysisSampleCount, sample_seed: s.analysisSampleSeed, cluster_feature_rules: s.clusterFeatureRules,
      subnucleosomal_threshold: s.subnucleosomalThreshold, accessibility_threshold: s.accessibilityThreshold,
      resolution: s.clusterResolution, balance_windows: true, feature_geometry: 'crop' }),
  });
  const now = useBrowserStore.getState();
  const current = clusterBasis(now).regions;
  if (runNumber !== useRunResultStore.getState().runs.cluster) return;
  if (windows.some(w => !sortStateStillCurrent(s, now, w.stateKey)) || now.activeClusterTreeNodeId !== s.activeClusterTreeNodeId || !runViewsStillCurrent(views, now) || (basis.kind === 'ordered' ? now.peaksByRule !== originalPeaks : JSON.stringify(current) !== digest))
    throw new Error('The regions, filters, branch or panel views changed while clustering. Cluster again here.');
  seedHistoryBaseline(now, 'Before clustering', 'clustering');
  const assignments = Object.fromEntries(Object.entries(response.results).map(([key, value]) => [key, value.assignments]));
  const panelAssignments: Record<string, Record<string, number>> = {};
  for (const w of windows) if (!(w.stateKey in panelAssignments)) panelAssignments[w.stateKey] = assignments[w.result_key] ?? {};
  const sourceClusterIds = [...new Set(windows.flatMap(w => [...(s.selectedClusters[w.stateKey]?.size
    ? s.selectedClusters[w.stateKey] : s.clusterFocus[w.stateKey] ?? [])]))].sort((a, b) => a - b);
  if (sourceClusterIds.length) {
    if (!now.activeClusterTreeNodeId) now.captureActiveClusterTreeNode({ name: 'All reads' });
    now.commitSubcluster(panelAssignments, { sourceClusterIds, sourceLabel: `from ${sourceClusterIds.map(c => `C${c}`).join('+')}`,
      name: 'Subcluster regions', readScope: Object.fromEntries(Object.keys(panelAssignments).map(key => [key, Object.keys(panelAssignments[key])])) });
    for (const key of Object.keys(panelAssignments)) panelAssignments[key] = useBrowserStore.getState().clusterAssignments[key];
  } else {
    for (const [key, value] of Object.entries(panelAssignments)) now.setClusterAssignments(key, value);
  }
  now.setDynamicClustering(false);
  now.setClusterPatterns({}); now.setClusterCentroids({}, []); now.setClusterWindowPeaks(null); now.setClusterPeakRegions([]);
  const run: ClusterMatchedRun = { groups: [...new Set(basis.regions.map(p => p.match!.correspondenceId ?? p.match!.groupId))],
    windows: windows.map(w => ({ key: w.result_key, stateKey: w.stateKey, panelId: w.panel.id, datasetId: w.dataset_id,
    label: `${w.region_label} · ${getDatasetDisplayLabel(s.datasets.find(d => d.id === w.dataset_id)!)}`, genome: w.genome })), assignments, panelAssignments,
    windowNmi: response.window_separation_nmi, referenceNmi: response.reference_separation_nmi,
    balancedFitReads: response.matched.balanced_fit_reads, lengths: response.matched.lengths };
  const copies = [...new Set(windows.map(w => w.stateKey))].flatMap(key => {
    const own = windows.filter(w => w.stateKey === key);
    return own.length > 1 ? [`${own[0].region_label} (copy a) shown on reads; ${own.slice(1).map(w => w.region_label).join(', ')} in the charts. Open as panels to show each region’s assignments`] : [];
  });
  const nmi = Math.max(run.windowNmi ?? 0, run.referenceNmi ?? 0);
  const wrapped = basis.regions.some(p => p.match!.wrapsOrigin);
  const total = Object.values(assignments).reduce((n, a) => n + Object.keys(a).length, 0);
  const empty = windows.filter(w => !Object.keys(assignments[w.result_key] ?? {}).length);
  run.details = `${total ? 'Clustered' : 'No reads covered'} ${basis.what}: ${run.windows.map(w => w.label).join(', ')}; ${run.lengths.join(' + ')} bp per feature; ${response.matched.balanced
    ? `fitted on ${run.balancedFitReads} reads per region (balanced)` : `used all ${response.matched.fit_reads} reads (${s.clusterMethod}; no balanced fit)`}. ${copies.join('. ')}`
    + (s.clusterMethod === 'graph' ? ' Graph uses one neighbourhood graph across all regions; choose k-means for a balanced fit.' : '')
    + (empty.length ? ` No reads covered ${empty.map(w => w.region_label).join(', ')}; balance applies to nonempty regions.` : '')
    + (wrapped ? ' Regions spanning the circular origin require full-length reads.' : '')
    + (nmi > 0.3 ? ` The clusters largely separate the regions (NMI ${nmi.toFixed(2)}): they may reflect reference, chemistry or depth rather than shared states.` : '')
    + (features.some(p => p.match!.memberSpecific) ? (s.clusterMethod === 'combinatorial' || s.clusterMethod === 'binary'
      ? ' Shared features use the correspondence blocks. Selected member-specific features are measured where present and unknown in the other members.'
      : ' Shared features use the correspondence blocks. Selected member-specific features are excluded from this numerical fit because they have no counterpart.') : ' Shared features use the correspondence blocks; insertion interiors and unaligned positions are excluded.')
    + (basis.unused ? ` ${basis.unused}.` : '');
  useBrowserStore.setState({ clusterMatchedRun: run });
  if (!sourceClusterIds.length) {
    if (now.activeClusterTreeNodeId) now.syncActiveClusterTreeNode(); else now.captureActiveClusterTreeNode({ name: 'All reads' });
  }
  now.pushSnapshot(basis.kind === 'ordered' ? 'Cluster across references' : 'Cluster matched regions');
  const sv = basis.regions.some(p => s.peakRules.find(r => r.id === (p.match!.correspondenceId ?? p.match!.groupId))?.matchGroup?.origin === 'sv');
  const shared = features.filter(p => !p.match!.memberSpecific).length;
  const warning = empty.length ? ' Some panels have no covering reads.'
    : nmi > 0.3 ? ' Clusters largely separate the regions; see Cluster detail.' : '';
  const summary = total ? `Clustered ${total.toLocaleString()} reads on ${shared} shared ${sv ? 'flank ' : ''}feature${shared === 1 ? '' : 's'}`
    + (response.matched.balanced ? `, balanced at ${run.balancedFitReads.toLocaleString()} read${run.balancedFitReads === 1 ? '' : 's'} per panel.` : '.')
    + (sv ? (windows.some(w => w.panel.altAllele) ? ' Insertion interior excluded.' : ' Unaligned positions excluded.') : '') + warning : 'No reads covered the selected regions. Check the regions and filters.';
  report(!total ? 'error' : warning ? 'note' : 'done', summary, windows.map(w => w.panel.id));
}
