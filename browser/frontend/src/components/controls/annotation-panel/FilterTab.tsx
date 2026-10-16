import { useEffect, useMemo, useRef, useState } from 'react';
import { useBrowserStore } from '../../../stores/browserStore';
import { useShallow } from 'zustand/react/shallow';
import { filterByAnnotations } from '../../../api/annotations';
import { buildStateKeyToDs, useFocusedReadIds } from '../../../hooks/useFocusedReadIds';
import { annotationRegionScopes, annotationScopeSignature } from './annotationScopes';
import { invalidateFilterRequests, isCurrentFilterRequest, nextFilterRequest } from '../../../utils/filterRequests';
import { groupStillShown } from '../../../utils/filterScopes';
import { AnalysisButton, AnalysisStatus, AnalysisToggleGroup } from '../shared';

type FilterMode = 'has_any' | 'has_all' | 'lacks_all';

const FILTER_MODE_OPTIONS: Array<{ value: FilterMode; label: string }> = [
  { value: 'has_any', label: 'Has Any' },
  { value: 'has_all', label: 'Has All' },
  { value: 'lacks_all', label: 'Lacks All' },
];

export function FilterTab() {
  const {
    annotationFiles,
    enabledAnnotationTypes,
    chrom, start, end,
    datasets,
    panels,
    analysisSampleSeed,
    setFilteredReadIds,
  } = useBrowserStore(useShallow(s => ({
    annotationFiles: s.annotationFiles,
    enabledAnnotationTypes: s.enabledAnnotationTypes,
    chrom: s.chrom, start: s.start, end: s.end,
    datasets: s.datasets,
    panels: s.panels,
    analysisSampleSeed: s.analysisSampleSeed,
    setFilteredReadIds: s.setFilteredReadIds,
  })));
  const { targetDatasetIds, targetStateKeys, stateKeyMap } = useFocusedReadIds();

  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());
  const [filterMode, setFilterMode] = useState<FilterMode>('has_any');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ total: number; filtered: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestSeqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const scopedDatasetIds = useMemo(
    () => targetDatasetIds.length > 0 ? targetDatasetIds : datasets.map(d => d.id),
    [datasets, targetDatasetIds],
  );
  const scopedStateKeys = useMemo(
    () => targetStateKeys.length > 0 ? targetStateKeys : scopedDatasetIds,
    [scopedDatasetIds, targetStateKeys],
  );
  // Each panel is filtered at the region it shows (its own locus, else the main view).
  const regionScopes = useMemo(
    () => annotationRegionScopes(scopedStateKeys, buildStateKeyToDs(stateKeyMap), panels, { chrom, start, end }),
    [scopedStateKeys, stateKeyMap, panels, chrom, start, end],
  );
  const scopedDatasetKey = scopedDatasetIds.join('\0');
  const scopedStateKey = annotationScopeSignature(regionScopes);
  const selectedTypeKey = useMemo(() => [...selectedTypes].sort().join('\0'), [selectedTypes]);

  const allTypes = annotationFiles
    .filter(f => f.active)
    .flatMap(f => f.annotationTypes ?? []);
  const uniqueTypes = [...new Map(allTypes.map(t => [t.name, t])).values()];

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
  }, [chrom, start, end, filterMode, scopedDatasetKey, scopedStateKey, selectedTypeKey, analysisSampleSeed]);

  const handleApply = async () => {
    if (selectedTypes.size === 0) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const requestSeq = requestSeqRef.current + 1;
    requestSeqRef.current = requestSeq;
    // Also a read-filter request like the Rules filter's and Copilot's: the
    // toolbar Clear (or a newer filter from any of them) supersedes it.
    const sharedRequest = nextFilterRequest();
    setLoading(true);
    setError(null);
    try {
      const responses = await Promise.all(regionScopes.map(scope => filterByAnnotations(
        [...selectedTypes], filterMode, scope.chrom, scope.start, scope.end, scope.datasetIds, analysisSampleSeed,
        { signal: controller.signal },
      )));
      if (requestSeqRef.current !== requestSeq || controller.signal.aborted) return;
      if (!isCurrentFilterRequest(sharedRequest)) return;
      let total = 0;
      let filtered = 0;
      const now = useBrowserStore.getState();
      regionScopes.forEach((scope, i) => {
        // Panels moved meanwhile (Each panel navigates: the main locus doesn't move) keep their reads.
        if (!groupStillShown(scope, now.panels, { chrom: now.chrom, start: now.start, end: now.end })) return;
        const res = responses[i];
        total += res.total;
        filtered += res.filtered;
        // Each dataset's own result goes to its own panels (a read name two
        // datasets share is two molecules); older servers send one flat list.
        for (const [dsId, stateKeys] of Object.entries(scope.stateKeysByDataset)) {
          const ids = res.by_dataset ? (res.by_dataset[dsId]?.read_ids ?? []) : res.read_ids;
          const readIdSet = new Set(ids);
          for (const stateKey of stateKeys) {
            setFilteredReadIds(stateKey, readIdSet, {
              target: 'annotation-filter',
              label: 'Annotations > Filter',
            });
          }
        }
      });
      setResult({ total, filtered });
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError' || requestSeqRef.current !== requestSeq) return;
      console.error('Filter error:', err);
      setError('Failed to apply annotation filter');
    } finally {
      if (requestSeqRef.current === requestSeq) {
        abortRef.current = null;
        setLoading(false);
      }
    }
  };

  const handleClear = () => {
    requestSeqRef.current += 1;
    invalidateFilterRequests();
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
    setError(null);
    for (const stateKey of scopedStateKeys) {
      setFilteredReadIds(stateKey, null);
    }
    setResult(null);
  };

  return (
    <div className="space-y-3">
      <div className="text-[11px] text-gray-500">
        Filter reads by annotation type presence across the active panel scope.
      </div>
      <AnalysisStatus kind="info" compact>
        Scope: {scopedDatasetIds.length} dataset{scopedDatasetIds.length !== 1 ? 's' : ''}, {scopedStateKeys.length} panel state{scopedStateKeys.length !== 1 ? 's' : ''}
      </AnalysisStatus>
      {error && (
        <AnalysisStatus kind="error" compact>
          {error}
        </AnalysisStatus>
      )}

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

      <div data-tour="annotations-filter-mode">
        <AnalysisToggleGroup
          value={filterMode}
          onChange={value => { if (value) setFilterMode(value); }}
          options={FILTER_MODE_OPTIONS}
          theme="violet"
        />
      </div>

      <div className="flex gap-2">
        <AnalysisButton
          onClick={handleApply}
          disabled={loading || selectedTypes.size === 0}
          theme="violet"
          variant="primary"
          size="sm"
          className="px-3"
          data-tour="annotations-filter-apply"
        >
          {loading ? 'Filtering...' : 'Apply Filter'}
        </AnalysisButton>
        <AnalysisButton
          onClick={handleClear}
          variant="outline"
          size="sm"
          className="px-3"
        >
          Clear
        </AnalysisButton>
      </div>

      {result && (
        <div className="text-[11px] text-gray-500">
          {result.filtered} / {result.total} reads matched
        </div>
      )}
    </div>
  );
}
