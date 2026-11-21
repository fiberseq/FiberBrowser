/**
 * What a "current view" plot reads, live: the view the browser shows (panelScope's active panel, as the Clusters
 * charts use) with the dataset panels showing it, and, when the reads are clustered, the clustered panels there with
 * their clustering rounds. The Plots workspace debounces this (Follow) or swaps the locus for its pin.
 */
import { useCallback, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../stores/browserStore';
import { buildStateKeyToDs, useFocusedReadIds } from '../../hooks/useFocusedReadIds';
import { clusterChartScope, scopedClusters } from '../../components/controls/cluster-detail/clusterChartScope';
import { clusterOperationRounds } from '../../components/controls/cluster-detail/clusterOperationRounds';
import { buildClusterAssignmentSignature } from '../../utils/clusterDetailRequestKey';
import type { FootprintSizePanel, FootprintSizesClusters, FootprintSizesTarget } from '../../components/controls/cluster-detail/useFootprintSizeData';
import type { PlotLocus } from './plotModel';

export interface PlotTargets {
  allReads: FootprintSizesTarget;
  clusters: FootprintSizesClusters | null;
  /** Some reads in view are clustered. */
  hasClusters: boolean;
}

/** A target's identity for Follow (locus, reference, panels, and which read is in which cluster). */
export function targetKey(t: FootprintSizesTarget & { assignmentSignature?: string }): string {
  return `${t.genome ?? ''}|${t.chrom}:${t.start}-${t.end}|${t.panels.map(p => `${p.key}:${p.datasetId}`).join(',')}|${t.assignmentSignature ?? ''}`;
}

export const locusOf = (t: Pick<FootprintSizesTarget, 'chrom' | 'start' | 'end' | 'genome'>): PlotLocus => ({
  chrom: t.chrom, start: Math.round(t.start), end: Math.round(t.end), genome: t.genome ?? null,
});

/** `t` at `locus` (a pinned plot keeps its panels and clusters, at its own locus). */
export function atLocus<T extends FootprintSizesTarget>(t: T, locus: PlotLocus | null): T {
  return locus ? { ...t, chrom: locus.chrom, start: locus.start, end: locus.end, genome: locus.genome } : t;
}

export function usePlotTargets(): PlotTargets {
  const scopeState = useBrowserStore(useShallow(s => ({
    panels: s.panels, chrom: s.chrom, start: s.start, end: s.end, navigationMode: s.navigationMode,
    selectedDatasets: s.selectedDatasets, lastMovedPanels: s.lastMovedPanels, collapsedRows: s.collapsedRows,
    fullViewPanelId: s.fullViewPanelId, currentGenome: s.currentGenome, fastaPath: s.fastaPath,
  })));
  const { datasets, panels, clusterAssignments, clusterOrder, clusterFocus, selectedClusters } = useBrowserStore(useShallow(s => ({
    datasets: s.datasets, panels: s.panels, clusterAssignments: s.clusterAssignments, clusterOrder: s.clusterOrder,
    clusterFocus: s.clusterFocus, selectedClusters: s.selectedClusters,
  })));
  const { targetStateKeys, stateKeyMap } = useFocusedReadIds();
  const stateKeyToDs = useMemo(() => buildStateKeyToDs(stateKeyMap), [stateKeyMap]);
  const panelOf = useCallback((key: string): FootprintSizePanel => {
    const datasetId = stateKeyToDs[key] || key;
    const ds = datasets.find(d => d.id === datasetId);
    const split = panels.find(p => p.readSubset && p.stateKey === key);
    return {
      key, datasetId, label: split ? `${ds?.label ?? key} · ${split.readSubset!.label}` : ds?.label ?? key,
      datasetLabel: ds?.label, color: split?.readSubset!.colour ?? ds?.color,
    };
  }, [stateKeyToDs, datasets, panels]);

  // Live-lifted datasets are not plotted yet (as in Clusters › Footprint sizes).
  const keys = useMemo(() => targetStateKeys.filter(key => {
    const ds = datasets.find(d => d.id === (stateKeyToDs[key] || key));
    return Boolean(ds) && ds!.data_type !== 'bam_livelift';
  }), [targetStateKeys, datasets, stateKeyToDs]);

  const allReads = useMemo<FootprintSizesTarget>(() => {
    const sc = clusterChartScope(scopeState, keys);
    return { chrom: sc.view.chrom, start: Math.round(sc.view.start), end: Math.round(sc.view.end), genome: sc.view.genome ?? null, panels: sc.keys.map(panelOf) };
  }, [scopeState, keys, panelOf]);

  const clustered = useMemo(() => keys.filter(k => Object.keys(clusterAssignments[k] ?? {}).length > 0), [keys, clusterAssignments]);
  const clusters = useMemo<FootprintSizesClusters | null>(() => {
    if (!clustered.length) return null;
    const sc = clusterChartScope(scopeState, clustered);
    if (!sc.keys.length) return null;
    const visible = scopedClusters(sc.keys, { clusterAssignments, clusterOrder, clusterFocus, selectedClusters }).visible;
    return {
      chrom: sc.view.chrom, start: Math.round(sc.view.start), end: Math.round(sc.view.end), genome: sc.view.genome ?? null,
      panels: sc.keys.map(panelOf),
      rounds: clusterOperationRounds(sc.keys, stateKeyToDs, clusterAssignments),
      visible,
      assignmentSignature: buildClusterAssignmentSignature(clusterAssignments as Record<string, Record<string, number>>, sc.keys),
    };
  }, [clustered, scopeState, clusterAssignments, clusterOrder, clusterFocus, selectedClusters, panelOf, stateKeyToDs]);

  return { allReads, clusters, hasClusters: clusters != null };
}
