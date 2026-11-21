import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { clusterMatchedViews, type MatchedClusterResponse } from '../../../api/clustering';
import { useBrowserStore } from '../../../stores/browserStore';
import type { PeakMode } from '../../../types';
import { seedHistoryBaseline } from '../../../stores/historySlice';
import {
  comparisonViews,
  matchedFeaturePairs,
  summarizeComparison,
  TECHNICAL_SEPARATION_NMI,
  viewFeatures,
  type ComparisonSummaryRow,
  type ComparisonView,
} from '../../../utils/haplotypeComparison';
import { AnalysisButton } from '../shared';

type ComparisonMode = 'separate' | 'joint';

const MATCHED_VIEW_METHODS = new Set(['combinatorial', 'binary', 'kmeans', 'minibatch']);
// The toolbar Cluster group's names for its methods.
const METHOD_LABELS: Record<string, string> = {
  combinatorial: 'Combinatorial', binary: 'Combinatorial', kmeans: 'K-means (exact)', minibatch: 'K-means (fast)',
  hdbscan: 'HDBSCAN', agglom: 'Hierarchical',
};

interface CachedResult {
  response: MatchedClusterResponse;
  summary: ComparisonSummaryRow[];
}

const fmtNmi = (value: number | null | undefined) => (value == null ? '—' : value.toFixed(2));

/**
 * Clustering for an open haplotype comparison: cluster each view on its own,
 * or co-cluster both on their matched features (feature i of View 1 with
 * feature i of View 2) so a state means the same thing in both views and its
 * share can be compared.
 */
export function HaplotypeClusteringControls() {
  const {
    panels, chrom, peakRules, peaksByRule, selectedPeaks, peakModes, filteredReadIds,
    clusterMethod, clusterK, analysisSampleCount, analysisSampleSeed,
    subnucleosomalThreshold, accessibilityThreshold, datasets,
  } = useBrowserStore(useShallow(state => ({
    panels: state.panels,
    chrom: state.chrom,
    peakRules: state.peakRules,
    peaksByRule: state.peaksByRule,
    selectedPeaks: state.selectedPeaks,
    peakModes: state.peakModes,
    filteredReadIds: state.filteredReadIds,
    clusterMethod: state.clusterMethod,
    clusterK: state.clusterK,
    analysisSampleCount: state.analysisSampleCount,
    analysisSampleSeed: state.analysisSampleSeed,
    subnucleosomalThreshold: state.subnucleosomalThreshold,
    accessibilityThreshold: state.accessibilityThreshold,
    datasets: state.datasets,
  })));
  const [reverseView2, setReverseView2] = useState(false);
  const [balanceViews, setBalanceViews] = useState(true);
  const [running, setRunning] = useState<ComparisonMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeMode, setActiveMode] = useState<ComparisonMode | null>(null);
  const [cache, setCache] = useState<Partial<Record<ComparisonMode, CachedResult>>>({});
  const runRef = useRef(0);

  const views = useMemo(() => comparisonViews(panels), [panels]);
  const selected = useMemo(() => {
    const allPeaks = useBrowserStore.getState().getAllPeaks();
    return [...selectedPeaks]
      .map(index => allPeaks.find(peak => peak.index === index))
      .filter((peak): peak is NonNullable<typeof peak> => Boolean(peak))
      .map(peak => ({ start: peak.start, end: peak.end, chrom: peak.chrom, mode: peakModes[peak.index] ?? 'accessibility' }));
    // peakRules/peaksByRule: the peak list getAllPeaks reads.
  }, [selectedPeaks, peakModes, peakRules, peaksByRule]);
  const features = useMemo(() => views.map(view => viewFeatures(view, selected, chrom)), [views, selected, chrom]);
  const pairs = features.length === 2 ? matchedFeaturePairs(features[0], features[1], reverseView2) : [];

  // What a result was computed from: when it changes, cached results are stale.
  const definitionKey = JSON.stringify({
    clusterMethod, clusterK, reverseView2, balanceViews, analysisSampleCount, analysisSampleSeed,
    subnucleosomalThreshold, accessibilityThreshold,
    views: views.map((view, index) => ({ chrom: view.chrom, start: view.start, end: view.end,
      keys: view.panels.map(panel => panel.stateKey), features: features[index] })),
  });
  useEffect(() => {
    runRef.current += 1;
    setCache({});
    setActiveMode(null);
    setRunning(null);
  }, [definitionKey]);

  if (views.length !== 2) {
    return (
      <div className="rounded border border-gray-200 bg-gray-50 p-2 text-[11px] text-gray-500 dark:border-white/10 dark:bg-white/5">
        Comparison clustering needs a dataset in each view.
      </div>
    );
  }

  const methodSupported = MATCHED_VIEW_METHODS.has(clusterMethod);
  const countsMatch = features[0].length > 0 && features[0].length === features[1].length;
  const datasetName = (id: string) => datasets.find(dataset => dataset.id === id)?.label ?? id;

  const apply = (response: MatchedClusterResponse, mode: ComparisonMode) => {
    const store = useBrowserStore.getState();
    seedHistoryBaseline(store, 'Before comparison clustering', 'clustering');
    for (const [stateKey, result] of Object.entries(response.results)) {
      useBrowserStore.getState().setClusterAssignments(stateKey, result.assignments ?? {});
    }
    // Matched-domain states are fitted on resampled features, so they are not
    // reassigned as the view moves: they stay as computed until a rerun.
    const after = useBrowserStore.getState();
    after.setClusterPatterns(response.cluster_patterns ?? {});
    after.setClusterCentroids({}, []);
    after.setClusterPeakRegions(features[0].map(feature => ({ ...feature, chrom: views[0].chrom })));
    after.setDynamicClustering(false);
    if (after.activeClusterTreeNodeId) after.syncActiveClusterTreeNode();
    else after.captureActiveClusterTreeNode({ name: 'All reads' });
    useBrowserStore.getState().pushSnapshot(mode === 'joint'
      ? `Co-cluster matched domains (${METHOD_LABELS[clusterMethod] ?? clusterMethod})`
      : `Cluster each view separately (${METHOD_LABELS[clusterMethod] ?? clusterMethod})`);
  };

  const run = async (mode: ComparisonMode) => {
    if (!methodSupported) return;
    if (!countsMatch) {
      setError('Select the same number of peaks in both views: feature 1 of View 1 is matched with feature 1 of View 2, left to right.');
      return;
    }
    const runId = ++runRef.current;
    setRunning(mode);
    setError(null);
    try {
      const response = await clusterMatchedViews({
        views: views.map((view: ComparisonView, index) => ({
          id: view.id,
          chrom: view.chrom,
          start: view.start,
          end: view.end,
          reverse: index === 1 && reverseView2,
          peak_regions: features[index].map(({ start, end, mode: featureMode }) => ({ start, end, mode: featureMode as PeakMode })),
          panels: view.panels.map(panel => {
            const filter = filteredReadIds[panel.stateKey];
            return {
              dataset_id: panel.datasetId,
              result_key: panel.stateKey,
              ...(filter ? { read_ids: [...filter] } : {}),
              ...(panel.strand ? { strand: panel.strand } : {}),
              ...(panel.liftHap ? { lift_hap: panel.liftHap } : {}),
            };
          }),
        })),
        mode,
        k: clusterK,
        method: clusterMethod,
        balanceViews,
        maxReads: analysisSampleCount ?? undefined,
        sampleSeed: analysisSampleSeed,
        subnucleosomalThreshold,
        accessibilityThreshold,
      });
      if (runId !== runRef.current) return; // the comparison changed while this ran
      const result = { response, summary: summarizeComparison(response, views) };
      setCache(previous => ({ ...previous, [mode]: result }));
      setActiveMode(mode);
      apply(response, mode);
    } catch (caught) {
      if (runId === runRef.current) setError(caught instanceof Error ? caught.message : 'Clustering failed');
    } finally {
      if (runId === runRef.current) setRunning(null);
    }
  };

  const show = (mode: ComparisonMode) => {
    const cached = cache[mode];
    if (!cached) return void run(mode);
    apply(cached.response, mode);
    setActiveMode(mode);
  };

  const active = activeMode ? cache[activeMode] : undefined;
  const methodLabel = METHOD_LABELS[clusterMethod] ?? clusterMethod;
  const kNote = clusterMethod === 'kmeans' || clusterMethod === 'minibatch' ? `, K=${clusterK}` : '';
  const technical = active && active.response.label_space === 'shared'
    && ((active.response.view_separation_nmi ?? 0) > TECHNICAL_SEPARATION_NMI
      || (active.response.dataset_separation_nmi ?? 0) > TECHNICAL_SEPARATION_NMI);

  return (
    <div className="space-y-2 rounded border border-gray-200 bg-white p-2 dark:border-white/10 dark:bg-white/5" data-testid="haplotype-clustering-controls">
      <div>
        <div className="text-xs font-semibold text-gray-800 dark:text-gray-200">Comparison clustering</div>
        <div className="text-[11px] text-gray-500">
          Select peaks in both views (scan or draw them in the comparison panels). Feature 1 of View 1 is matched with feature 1 of View 2, left to right.
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {views.map((view, index) => (
          <div key={view.id} className="min-w-0 rounded bg-gray-50 p-1.5 dark:bg-black/10">
            <div className="truncate text-[11px] font-semibold text-gray-700 dark:text-gray-300" title={view.panels.map(panel => datasetName(panel.datasetId)).join(', ')}>
              {view.label}: {view.chrom} · {[...new Set(view.panels.map(panel => datasetName(panel.datasetId)))].join(', ')}
            </div>
            <div className="mt-1 space-y-0.5 text-[11px] text-gray-500">
              {features[index].length === 0 ? 'No peaks selected' : features[index].map((feature, featureIndex) => (
                <div key={`${feature.start}-${feature.end}`} className="font-mono">
                  F{index === 1 && reverseView2 ? features[index].length - featureIndex : featureIndex + 1}: {feature.start.toLocaleString()}–{feature.end.toLocaleString()}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {features[0].length > 0 && features[1].length > 0 && !countsMatch && (
        <div className="rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
          {features[0].length} peaks in View 1 and {features[1].length} in View 2: select the same number in both.
        </div>
      )}
      {countsMatch && pairs.some(([a, b]) => Math.abs((a.end - a.start) - (b.end - b.start)) > 0) && (
        <div className="text-[11px] text-gray-500">Matched features differ in width; each is resampled to the same length before clustering.</div>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-600 dark:text-gray-400">
        <label className="flex items-center gap-1" title="View 2 is inverted relative to View 1: match its features right to left and read each in reverse">
          <input type="checkbox" checked={reverseView2} onChange={event => setReverseView2(event.target.checked)} />
          Reverse View 2
        </label>
        <label className="flex items-center gap-1" title="Fit the states on the same number of reads from every panel, so a deeper view or dataset does not define them alone; every read is then assigned">
          <input type="checkbox" checked={balanceViews} onChange={event => setBalanceViews(event.target.checked)} />
          Balance views
        </label>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <AnalysisButton size="sm" theme="red" variant={activeMode === 'separate' ? 'primary' : 'outline'}
          onClick={() => show('separate')} disabled={running !== null || !methodSupported || !countsMatch}>
          {running === 'separate' ? 'Clustering…' : cache.separate ? 'Show separate result' : 'Cluster each view separately'}
        </AnalysisButton>
        <AnalysisButton size="sm" theme="red" variant={activeMode === 'joint' ? 'primary' : 'outline'}
          onClick={() => show('joint')} disabled={running !== null || !methodSupported || !countsMatch}>
          {running === 'joint' ? 'Co-clustering…' : cache.joint ? 'Show co-clustered result' : 'Co-cluster matched domains'}
        </AnalysisButton>
      </div>
      <div className="text-[11px] text-gray-500">
        {methodSupported
          ? `Method ${methodLabel}${kNote}, from the toolbar's Cluster group.`
          : `The toolbar's clustering method (${methodLabel}) can't be used here: choose Combinatorial, K-means (exact) or K-means (fast).`}
      </div>

      {error && <div className="rounded bg-red-50 px-2 py-1 text-[11px] text-red-700 dark:bg-red-900/20 dark:text-red-300">{error}</div>}

      {active && (
        <div className="space-y-1 overflow-x-auto" data-testid="haplotype-comparison-summary">
          <div className="text-[11px] text-gray-500">
            {active.response.label_space === 'shared'
              ? <>Fitted on {active.response.balanced_fit_reads.toLocaleString()} of {active.response.total_reads.toLocaleString()} reads · view separation (NMI) {fmtNmi(active.response.view_separation_nmi)} · dataset separation {fmtNmi(active.response.dataset_separation_nmi)}</>
              : <>Each view has its own states (numbered apart); shares can't be compared state by state.</>}
          </div>
          {technical && (
            <div className="rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
              The states largely separate the views or datasets. Check for a technical difference (depth, chemistry, quality) before reading this as biology.
            </div>
          )}
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-left text-gray-500">
                <th className="font-medium">State</th>
                <th className="font-medium">View 1</th>
                <th className="font-medium">View 2</th>
                {active.response.label_space === 'shared' && <th className="font-medium">Shift</th>}
              </tr>
            </thead>
            <tbody>
              {active.summary.map(row => (
                <tr key={row.label} className="border-t border-gray-100 dark:border-white/10">
                  <td className="font-mono">{row.name}</td>
                  <td>{(100 * row.fractions[0]).toFixed(1)}% ({row.counts[0]})</td>
                  <td>{(100 * row.fractions[1]).toFixed(1)}% ({row.counts[1]})</td>
                  {row.shiftPp != null && (
                    <td className={row.shiftPp >= 0 ? 'text-emerald-600' : 'text-rose-600'}>
                      {row.shiftPp >= 0 ? '+' : ''}{row.shiftPp.toFixed(1)} pp
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
