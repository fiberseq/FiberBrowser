import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../stores/browserStore';
import { analysisLoci, type AnalysisLocus } from '../utils/analysisLocus';

/** The distinct regions the targeted panels show (utils/analysisLocus): one, or several to choose from. */
export function useAnalysisLoci(stateKeys: string[], extraDatasetIds: string[] = []): AnalysisLocus[] {
  const { panels, chrom, start, end } = useBrowserStore(useShallow(s => ({
    panels: s.panels, chrom: s.chrom, start: s.start, end: s.end,
  })));
  const keys = stateKeys.join('\n');
  const extra = extraDatasetIds.join('\n');
  return useMemo(
    () => analysisLoci({ panels, chrom, start, end }, keys ? keys.split('\n') : [], extra ? extra.split('\n') : []),
    [panels, chrom, start, end, keys, extra],
  );
}
