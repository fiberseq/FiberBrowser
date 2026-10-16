import { useEffect, useMemo, useRef, useState } from 'react';
import { useBrowserStore } from '../../../stores/browserStore';
import { useShallow } from 'zustand/react/shallow';
import { clusterByAnnotations } from '../../../api/annotations';
import { buildStateKeyToDs, useFocusedReadIds } from '../../../hooks/useFocusedReadIds';
import { annotationRegionScopes, annotationScopeSignature } from './annotationScopes';
import { sameChrom } from '../../../utils/chromAliases';
import { AnalysisButton, AnalysisStatus } from '../shared';

export function ClusterTab() {
  const {
    annotationFiles,
    chrom, start, end,
    getAllPeaks, selectedPeaks,
    datasets,
    panels,
    analysisSampleSeed,
    setClusterAssignments,
    setClusterOrder,
    setClusterPatterns,
  } = useBrowserStore(useShallow(s => ({
    annotationFiles: s.annotationFiles,
    chrom: s.chrom, start: s.start, end: s.end,
    getAllPeaks: s.getAllPeaks, selectedPeaks: s.selectedPeaks,
    datasets: s.datasets,
    panels: s.panels,
    analysisSampleSeed: s.analysisSampleSeed,
    setClusterAssignments: s.setClusterAssignments,
    setClusterOrder: s.setClusterOrder,
    setClusterPatterns: s.setClusterPatterns,
  })));

  const { targetDatasetIds, targetStateKeys, stateKeyMap } = useFocusedReadIds();

  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());
  const [method, setMethod] = useState('combinatorial');
  const [k, setK] = useState(5);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ reads: number; clusters: number } | null>(null);
  const requestSeqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const uniqueTypes = useMemo(() => {
    const allTypes = annotationFiles
      .filter(f => f.active)
      .flatMap(f => f.annotationTypes ?? []);
    return [...new Map(allTypes.map(t => [t.name, t])).values()];
  }, [annotationFiles]);

  // Get selected peaks
  const allPeaks = getAllPeaks();
  // The request is the main view's: a selected peak on another chromosome (a
  // panel copy there) or outside the view would be read at these coordinates
  // on the main chromosome, so it's left out. Untagged peaks are the main view's.
  const peakRegions = useMemo(() => [...selectedPeaks]
    .map(idx => allPeaks.find(p => p.index === idx))
    .filter((p): p is NonNullable<typeof p> => Boolean(p))
    .filter(p => (!p.chrom || sameChrom(p.chrom, chrom)) && p.end > start && p.start < end)
    .map(p => ({ start: p.start, end: p.end })), [allPeaks, selectedPeaks, chrom, start, end]);
  // The selected panels (all when none is selected), as FilterTab scopes them:
  // results go to each panel's state key, so duplicated panels get them too.
  const scopedDatasetIds = useMemo(
    () => targetDatasetIds.length > 0 ? targetDatasetIds : datasets.map(d => d.id),
    [datasets, targetDatasetIds],
  );
  const scopedStateKeys = useMemo(
    () => targetStateKeys.length > 0 ? targetStateKeys : scopedDatasetIds,
    [scopedDatasetIds, targetStateKeys],
  );
  // The selected peaks are the main view's: only panels showing it are
  // clustered (a copy at another locus keeps its own clusters).
  const mainScope = useMemo(() => {
    const scopes = annotationRegionScopes(scopedStateKeys, buildStateKeyToDs(stateKeyMap), panels, { chrom, start, end });
    return scopes.find(sc => !sc.genome && sc.chrom === chrom && sc.start === start && sc.end === end) ?? null;
  }, [scopedStateKeys, stateKeyMap, panels, chrom, start, end]);
  const datasetIds = useMemo(() => mainScope?.datasetIds ?? [], [mainScope]);
  const datasetKey = mainScope ? annotationScopeSignature([mainScope]) : '';
  const selectedTypeKey = useMemo(() => [...selectedTypes].sort().join('\0'), [selectedTypes]);
  const peakRegionKey = useMemo(
    () => peakRegions.map(p => `${p.start}-${p.end}`).join('\0'),
    [peakRegions],
  );

  const handleToggle = (name: string) => {
    setSelectedTypes(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  useEffect(() => () => {
    requestSeqRef.current += 1;
    abortRef.current?.abort();
  }, []);

  useEffect(() => {
    requestSeqRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
    setError(null);
    setResult(null);
  }, [chrom, start, end, method, k, datasetKey, selectedTypeKey, peakRegionKey, analysisSampleSeed]);

  const handleCluster = async () => {
    if (peakRegions.length === 0 || selectedTypes.size === 0 || !mainScope) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const requestSeq = requestSeqRef.current + 1;
    requestSeqRef.current = requestSeq;
    setLoading(true);
    setError(null);
    setResult(null);
    // The branch and each panel's clustering when the request starts: a result
    // arriving after either changed belongs to a clustering no longer shown.
    const before = useBrowserStore.getState();
    const branchAtStart = before.activeClusterTreeNodeId;
    const assignmentsAtStart: Record<string, unknown> = {};
    for (const keys of Object.values(mainScope.stateKeysByDataset)) {
      for (const key of keys) assignmentsAtStart[key] = before.clusterAssignments[key];
    }
    try {
      const res = await clusterByAnnotations(
        peakRegions, [...selectedTypes], method, k, datasetIds, chrom, start, end, analysisSampleSeed,
        { signal: controller.signal },
      );
      if (requestSeqRef.current !== requestSeq || controller.signal.aborted) return;
      const now = useBrowserStore.getState();
      if (now.activeClusterTreeNodeId !== branchAtStart) {
        setError('The cluster branch changed while clustering ran; run it again.');
        return;
      }
      // A panel reclustered meanwhile keeps its newer clusters, and with them
      // their patterns and reassignment setting: the whole result is dropped
      // (assignments, patterns and settings go together or not at all).
      const changed = Object.values(mainScope.stateKeysByDataset).flat()
        .some(key => now.clusterAssignments[key] !== assignmentsAtStart[key]);
      if (changed) {
        setError('The clustering changed while annotation clustering ran; run it again.');
        return;
      }

      // Each dataset's own assignments go to its own panels (a read name two
      // datasets share is two molecules); older servers send one flat map.
      for (const [dsId, stateKeys] of Object.entries(mainScope.stateKeysByDataset)) {
        const assignments = res.assignments_by_dataset?.[dsId] ?? res.assignments;
        for (const stateKey of stateKeys) {
          setClusterAssignments(stateKey, assignments);
          setClusterOrder(stateKey, res.order);
        }
      }
      if (res.patterns) {
        setClusterPatterns(res.patterns);
      }
      // Annotation-presence patterns aren't footprint features: dynamic
      // reassignment would read them as accessibility bits and undo these clusters.
      useBrowserStore.getState().setDynamicClustering(false);
      setResult({
        reads: Object.keys(res.assignments ?? {}).length,
        clusters: new Set(Object.values(res.assignments ?? {})).size,
      });
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError' || requestSeqRef.current !== requestSeq) return;
      console.error('Cluster error:', err);
      setError('Failed to cluster by annotations');
    } finally {
      if (requestSeqRef.current === requestSeq) {
        abortRef.current = null;
        setLoading(false);
      }
    }
  };

  return (
    <div className="space-y-3">
      <div className="text-[11px] text-gray-500">
        Cluster reads by annotation patterns at selected peaks.
      </div>

      {peakRegions.length === 0 && (
        <div className="text-xs text-amber-600 dark:text-amber-400">
          Select peaks on the track first (click peak markers).
        </div>
      )}
      {error && (
        <AnalysisStatus kind="error" compact>
          {error}
        </AnalysisStatus>
      )}
      {result && (
        <AnalysisStatus kind="success" compact>
          Assigned {result.reads.toLocaleString()} read{result.reads !== 1 ? 's' : ''} to {result.clusters.toLocaleString()} annotation cluster{result.clusters !== 1 ? 's' : ''}.
        </AnalysisStatus>
      )}

      <div>
        <div className="text-[11px] text-gray-500 mb-1">Annotation types as features:</div>
        <div className="space-y-1">
          {uniqueTypes.map(t => (
            <label key={t.name} className="flex items-center gap-2 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={selectedTypes.has(t.name)}
                onChange={() => handleToggle(t.name)}
                className="w-3 h-3"
              />
              {t.name}
            </label>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <label className="text-[11px] text-gray-500">Method:</label>
        <select
          value={method}
          onChange={e => setMethod(e.target.value)}
          className="text-xs px-1 py-0.5 rounded border border-gray-300 dark:border-white/20 bg-white dark:bg-gray-800"
        >
          <option value="combinatorial">Combinatorial</option>
          <option value="kmeans">K-means</option>
        </select>
        {method === 'kmeans' && (
          <>
            <label className="text-[11px] text-gray-500">k:</label>
            <input
              type="number"
              min={2}
              max={20}
              value={k}
              onChange={e => setK(parseInt(e.target.value) || 5)}
              className="w-12 text-xs px-1 py-0.5 rounded border border-gray-300 dark:border-white/20 bg-white dark:bg-gray-800"
            />
          </>
        )}
      </div>

      <AnalysisButton
        onClick={handleCluster}
        disabled={loading || peakRegions.length === 0 || selectedTypes.size === 0}
        theme="violet"
        variant="primary"
        size="sm"
        className="px-3"
        data-tour="annotations-cluster-button"
      >
        {loading ? 'Clustering...' : `Cluster (${peakRegions.length} peaks)`}
      </AnalysisButton>
    </div>
  );
}
