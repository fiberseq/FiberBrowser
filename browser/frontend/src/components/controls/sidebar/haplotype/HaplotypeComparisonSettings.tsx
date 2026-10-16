import { useEffect, useMemo, useRef, useState } from 'react';
import { searchGene } from '../../../../api/reference';
import { useBrowserStore } from '../../../../stores/browserStore';
import { detectHaplotypePairs } from '../../../../utils/haplotypePairs';
import { SidebarSubSection } from '../../SidebarSubSection';
import { ActiveHaplotypeComparisonNotice } from './ActiveHaplotypeComparisonNotice';
import { findChromInfo } from '../../../../utils/chromAliases';
import { HaplotypeComparisonForm } from './HaplotypeComparisonForm';
import type { ChromInfo } from '../../../../types';
import { HaplotypeClusteringControls } from '../../haplotype/HaplotypeClusteringControls';
import { useHaplotypeCompareRequest } from '../../haplotype/haplotypeCompareRequest';

/**
 * The main view's coordinates for a comparison of chrom1 and chrom2, clamped
 * to the shorter of the two; the first 20 kb when the view lies beyond them.
 */
export function currentViewOn(chroms: ChromInfo[], chrom1: string, chrom2: string): { start: number; end: number } {
  const { start: viewStart, end: viewEnd } = useBrowserStore.getState();
  const sizes = [chrom1, chrom2].map(c => findChromInfo(chroms, c)?.size).filter((n): n is number => typeof n === 'number');
  const limit = sizes.length ? Math.min(...sizes) : Infinity;
  const start = Math.max(0, Math.round(viewStart));
  const end = Math.min(limit, Math.round(viewEnd));
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) return { start, end };
  return { start: 0, end: Math.min(20000, limit) };
}

export function HaplotypeComparisonSettings({ embedded = false, acceptRequests = false }: {
  embedded?: boolean;
  /** Fill in from a dataset's ⋯ menu request (the Regions panel's form only). */
  acceptRequests?: boolean;
}) {
  const chroms = useBrowserStore(s => s.chroms);
  const datasets = useBrowserStore(s => s.datasets);
  const openHaplotypeComparison = useBrowserStore(s => s.openHaplotypeComparison);
  const panels = useBrowserStore(s => s.panels);

  // Each view's datasets; null = every dataset on both views (the default).
  const [datasets1, setDatasets1] = useState<string[] | null>(null);
  const [datasets2, setDatasets2] = useState<string[] | null>(null);
  const [chrom1, setChrom1] = useState('');
  const [chrom2, setChrom2] = useState('');
  const [region, setRegion] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const resolveSeqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const hapPairs = useMemo(
    () => detectHaplotypePairs(chroms.map(c => c.name)),
    [chroms],
  );
  const hasActiveComparison = panels.some(panel => panel.haplotypeGroup);
  const datasetIds = useMemo(() => datasets.map(dataset => dataset.id), [datasets]);
  const valid = (ids: string[] | null) => (ids ?? datasetIds).filter(id => datasetIds.includes(id));
  const view1Datasets = valid(datasets1);
  const view2Datasets = valid(datasets2);

  // Filled in from a dataset's ⋯ menu (Compare haplotypes…).
  const request = useHaplotypeCompareRequest(r => (acceptRequests ? r.request : null));
  useEffect(() => {
    if (!request) return;
    setChrom1(request.chrom1);
    setChrom2(request.chrom2);
    setRegion(request.region);
    setError(null);
    useHaplotypeCompareRequest.getState().set(null);
  }, [request]);

  useEffect(() => () => {
    resolveSeqRef.current += 1;
    abortRef.current?.abort();
  }, []);

  useEffect(() => {
    resolveSeqRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setResolving(false);
  }, [chrom1, chrom2, region, datasets1, datasets2]);

  const beginResolve = () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const resolveSeq = resolveSeqRef.current + 1;
    resolveSeqRef.current = resolveSeq;
    setResolving(true);
    return { controller, resolveSeq };
  };

  const isCurrentResolve = (resolveSeq: number, controller: AbortController) => (
    resolveSeqRef.current === resolveSeq && abortRef.current === controller && !controller.signal.aborted
  );

  const handleOpen = async () => {
    if (!chrom1 || !chrom2) {
      setError('Select two chromosomes');
      return;
    }
    if (chrom1 === chrom2) {
      setError('Select two different chromosomes');
      return;
    }
    if (datasetIds.length > 1 && (view1Datasets.length === 0 || view2Datasets.length === 0)) {
      setError('Select at least one dataset for each view');
      return;
    }

    setError(null);
    const { controller, resolveSeq } = beginResolve();

    try {
      let start = 0;
      let end = 20000;

      if (region.trim()) {
        const coordMatch = region.trim().match(/(?:\S+[:\s]+)?([0-9,]+)\s*[-\s]+\s*([0-9,]+)$/);
        if (coordMatch) {
          start = parseInt(coordMatch[1].replace(/,/g, ''));
          end = parseInt(coordMatch[2].replace(/,/g, ''));
        } else {
          const res = await searchGene(region.trim(), { signal: controller.signal });
          if (!isCurrentResolve(resolveSeq, controller)) return;
          if (res.found && res.start !== undefined && res.end !== undefined) {
            start = Math.max(0, res.start - 5000);
            end = res.end + 5000;
          } else {
            setError(`Could not resolve region: "${region}"`);
            return;
          }
        }
      } else {
        // No region given: the coordinates of the current view (not the
        // chromosome's first 20 kb, where the data rarely is).
        ({ start, end } = currentViewOn(chroms, chrom1, chrom2));
      }

      if (!isCurrentResolve(resolveSeq, controller)) return;
      // Every dataset on both views is the default layout (each open panel
      // copied to both); otherwise each view shows only its chosen datasets.
      const everyDatasetOnBoth = [view1Datasets, view2Datasets]
        .every(ids => ids.length === datasetIds.length);
      openHaplotypeComparison(everyDatasetOnBoth
        ? { chrom1, chrom2, start, end }
        : { chrom1, chrom2, start, end, datasets1: view1Datasets, datasets2: view2Datasets });
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError' || !isCurrentResolve(resolveSeq, controller)) return;
      setError('Failed to resolve region');
    } finally {
      if (isCurrentResolve(resolveSeq, controller)) {
        abortRef.current = null;
        setResolving(false);
      }
    }
  };

  if (chroms.length < 2) {
    return embedded ? (
      <div className="rounded border border-gray-200 bg-gray-50 p-3 text-xs text-gray-500 dark:border-white/10 dark:bg-white/5 dark:text-gray-400">
        Load a reference with at least two chromosomes to compare haplotypes.
      </div>
    ) : null;
  }

  const content = (
    <div className="space-y-1.5" data-tour="haplotype-compare-form">
      {hasActiveComparison ? (
        <>
          <ActiveHaplotypeComparisonNotice onClose={() => useBrowserStore.getState().closeHaplotypeComparison()} />
          <HaplotypeClusteringControls />
        </>
      ) : (
        <HaplotypeComparisonForm
          chroms={chroms}
          datasets={datasets}
          datasets1={view1Datasets}
          datasets2={view2Datasets}
          onDatasets1Change={setDatasets1}
          onDatasets2Change={setDatasets2}
          hapPairs={hapPairs}
          chrom1={chrom1}
          chrom2={chrom2}
          region={region}
          resolving={resolving}
          error={error}
          onChrom1Change={value => { setChrom1(value); setError(null); }}
          onChrom2Change={value => { setChrom2(value); setError(null); }}
          onRegionChange={setRegion}
          onErrorClear={() => setError(null)}
          onOpen={handleOpen}
        />
      )}
    </div>
  );

  if (embedded) return content;

  return (
    <SidebarSubSection
      id="genome.haplotype"
      label="Haplotype Comparison"
      defaultOpen={false}
      persist
      helpText="Compare two haplotype chromosomes side by side, then cluster each view separately or co-cluster their matched domains"
    >
      {content}
    </SidebarSubSection>
  );
}
