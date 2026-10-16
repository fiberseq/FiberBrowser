import { useMemo } from 'react';
import { useBrowserStore, getTargetDatasetIds } from '../stores/browserStore';
import type { FirePeak } from '../types';

export function useAnalysisContext() {
  // Viewport
  const chrom = useBrowserStore(s => s.chrom);
  const start = useBrowserStore(s => s.start);
  const end = useBrowserStore(s => s.end);
  const isReversed = useBrowserStore(s => s.isReversed);
  const hasFasta = useBrowserStore(s => s.hasFasta);
  const spanningOnly = useBrowserStore(s => s.spanningOnly);

  // Datasets
  const datasets = useBrowserStore(s => s.datasets);
  const selectedDatasets = useBrowserStore(s => s.selectedDatasets);
  const panels = useBrowserStore(s => s.panels);

  // Derived: target dataset IDs
  const targetDatasetIds = useMemo(
    () => getTargetDatasetIds(selectedDatasets, panels, datasets),
    [selectedDatasets, panels, datasets]
  );
  const targetDatasets = useMemo(
    () => targetDatasetIds.map(id => datasets.find(d => d.id === id)).filter(Boolean) as typeof datasets,
    [datasets, targetDatasetIds]
  );

  // Clusters
  const clusterAssignments = useBrowserStore(s => s.clusterAssignments);
  const clusterFocus = useBrowserStore(s => s.clusterFocus);
  const clusterOrder = useBrowserStore(s => s.clusterOrder);
  const clusterPatterns = useBrowserStore(s => s.clusterPatterns);

  // Selections
  const selectedPeaks = useBrowserStore(s => s.selectedPeaks);
  const selectedGenes = useBrowserStore(s => s.selectedGenes);
  const selectedFootprints = useBrowserStore(s => s.selectedFootprints);
  const footprintGroups = useBrowserStore(s => s.footprintGroups);

  // Peaks — use rule-based system
  const getAllPeaks = useBrowserStore(s => s.getAllPeaks);
  const peaksByRule = useBrowserStore(s => s.peaksByRule);
  const peakRules = useBrowserStore(s => s.peakRules);
  const allPeaks = useMemo<FirePeak[]>(
    () => getAllPeaks(),
    [peaksByRule, peakRules]
  );

  // Actions
  const setClusterAssignments = useBrowserStore(s => s.setClusterAssignments);
  const setFilteredReadIds = useBrowserStore(s => s.setFilteredReadIds);
  const setClusterFocus = useBrowserStore(s => s.setClusterFocus);

  return {
    chrom, start, end, isReversed, hasFasta, spanningOnly,
    datasets, selectedDatasets, panels,
    targetDatasetIds, targetDatasets,
    clusterAssignments, clusterFocus, clusterOrder, clusterPatterns,
    selectedPeaks, selectedGenes, selectedFootprints, footprintGroups,
    allPeaks,
    setClusterAssignments, setFilteredReadIds, setClusterFocus,
  };
}

export type AnalysisContext = ReturnType<typeof useAnalysisContext>;
