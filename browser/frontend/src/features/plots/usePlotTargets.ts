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
  /** Datasets in scope that are left out because they are live-lifted (their labels, in panel order). */
  liftedLeftOut: string[];
}

/** The one-line notice Plots and the Quantify card show for left-out live-lifted datasets ('' when none). The headless
 * numbers (services/meta_locus_numbers.py, LIFTED_LEFT_OUT_NOTE) say the same. */
export const LIFTED_LEFT_OUT_NOTE = "Live-lifted datasets aren't plotted or quantified yet";
export function liftedLeftOutNotice(labels: readonly string[] | null | undefined): string {
  return labels?.length ? `${LIFTED_LEFT_OUT_NOTE}: left out ${labels.join(', ')}.` : '';
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

/** `invokedFrom`: the panel a plot was made from (PlotSpec.panel), plotted as the active panel would be. */
export function usePlotTargets(invokedFrom?: string | null): PlotTargets {
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
  const invokedPanel = useMemo(() => (invokedFrom ? panels.find(q => q.id === invokedFrom && q.contentType === 'dataset' && !!q.datasetId) : undefined), [invokedFrom, panels]);
  const stateKeyToDs = useMemo(() => {
    const m = buildStateKeyToDs(stateKeyMap);
    if (invokedPanel) m[invokedPanel.stateKey ?? invokedPanel.datasetId!] ??= invokedPanel.datasetId!;
    return m;
  }, [stateKeyMap, invokedPanel]);
  const panelOf = useCallback((key: string): FootprintSizePanel => {
    const datasetId = stateKeyToDs[key] || key;
    const ds = datasets.find(d => d.id === datasetId);
    const split = panels.find(p => p.readSubset && p.stateKey === key);
    return {
      key, datasetId, label: split ? `${ds?.label ?? key} · ${split.readSubset!.label}` : ds?.label ?? key,
      datasetLabel: ds?.label, color: split?.readSubset!.colour ?? ds?.color,
    };
  }, [stateKeyToDs, datasets, panels]);

  // The panel a plot was made from (PlotSpec.panel): its state key is plotted even when the selection names another
  // panel, so a "here" request never plots the selected panel's reads at the asking panel's locus.
  const invokedKey = invokedPanel ? (invokedPanel.stateKey ?? invokedPanel.datasetId!) : null;
  const scopedKeys = useMemo(() => (invokedKey && !targetStateKeys.includes(invokedKey) ? [invokedKey, ...targetStateKeys] : targetStateKeys), [invokedKey, targetStateKeys]);
  // Live-lifted datasets are not plotted yet (as in Clusters › Footprint sizes): left out, and said so.
  const keys = useMemo(() => scopedKeys.filter(key => {
    const ds = datasets.find(d => d.id === (stateKeyToDs[key] || key));
    return Boolean(ds) && ds!.data_type !== 'bam_livelift';
  }), [scopedKeys, datasets, stateKeyToDs]);
  const liftedLeftOut = useMemo(() => {
    const labels: string[] = [];
    for (const key of scopedKeys) {
      const ds = datasets.find(d => d.id === (stateKeyToDs[key] || key));
      if (ds?.data_type === 'bam_livelift' && !labels.includes(ds.label ?? ds.id)) labels.push(ds.label ?? ds.id);
    }
    return labels;
  }, [scopedKeys, datasets, stateKeyToDs]);

  const allReads = useMemo<FootprintSizesTarget>(() => {
    const sc = clusterChartScope(scopeState, keys, invokedFrom);
    return { chrom: sc.view.chrom, start: Math.round(sc.view.start), end: Math.round(sc.view.end), genome: sc.view.genome ?? null, panels: sc.keys.map(panelOf) };
  }, [scopeState, keys, panelOf, invokedFrom]);

  const clustered = useMemo(() => keys.filter(k => Object.keys(clusterAssignments[k] ?? {}).length > 0), [keys, clusterAssignments]);
  const clusters = useMemo<FootprintSizesClusters | null>(() => {
    if (!clustered.length) return null;
    const sc = clusterChartScope(scopeState, clustered, invokedFrom);
    if (!sc.keys.length) return null;
    const visible = scopedClusters(sc.keys, { clusterAssignments, clusterOrder, clusterFocus, selectedClusters }).visible;
    return {
      chrom: sc.view.chrom, start: Math.round(sc.view.start), end: Math.round(sc.view.end), genome: sc.view.genome ?? null,
      panels: sc.keys.map(panelOf),
      rounds: clusterOperationRounds(sc.keys, stateKeyToDs, clusterAssignments),
      visible,
      assignmentSignature: buildClusterAssignmentSignature(clusterAssignments as Record<string, Record<string, number>>, sc.keys),
    };
  }, [clustered, scopeState, clusterAssignments, clusterOrder, clusterFocus, selectedClusters, panelOf, stateKeyToDs, invokedFrom]);

  return { allReads, clusters, hasClusters: clusters != null, liftedLeftOut };
}
