import { useState } from 'react';
import { OverlayProfileChart } from '../../charts/OverlayProfileChart';
import { getLayerColor, getLayerLabel } from '../../../utils/layerColors';
import { ProfileChart } from './ClusterCharts';
import { AnalysisButton } from '../shared';
import { useBrowserStore } from '../../../stores/browserStore';
import { seedHistoryBaseline } from '../../../stores/historySlice';
import { UNASSIGNED_CLUSTER_ID, getClusterColor, getClusterLabel } from '../../tracks/ReadTrack';
import { GripVertical, Split } from '../../ui/Icons';
import type { MergedClusterInfo } from '../../../stores/clusterMergeLog';

export type ClusterSummary = {
  cluster: number;
  color: string;
  counts: number[];
  totalCount: number;
};

type ClusterProportions = {
  proportions: Map<number, number[]>;
  counts: Map<number, number[]>;
  comparisonCounts: Map<number, number[]>;
  comparisonClusterIds: number[];
  datasetTotals: number[];
  colors: Map<number, string>;
  clusterIds: number[];
  label: string;
};

type OverviewTabContentProps = {
  clusterData: ClusterSummary[];
  datasetIds: string[];
  multiDs: boolean;
  clusterFocus: Record<string, Set<number> | null | undefined>;
  setClusterFocus: (datasetId: string, focus: Set<number> | null) => void;
  clusterOrder: Record<string, number[] | undefined>;
  setClusterOrder: (datasetId: string, order: number[]) => void;
  selectedClusters: Record<string, Set<number> | undefined>;
  setClusterSelection: (datasetId: string, clusterIds: Set<number> | number[]) => void;
  toggleClusterSelection: (datasetId: string, clusterId: number) => void;
  clearClusterSelection: (datasetId?: string) => void;
  mergeSelectedClusters: (datasetIds?: string[]) => number;
  combinedProfiles: Record<number, Record<string, number[]>>;
  enabledMetaProfiles: Record<string, boolean>;
  proportions: ClusterProportions | null;
  chartWidth: number;
  containerWidth: number;
  profileHeight: number;
  isReversed: boolean;
  dissolving: number | null;
  onDissolve: (cluster: number) => void;
  getDatasetLabel: (datasetId: string) => string;
  /** Unmerge: the clusters merged into each cluster on show (by its id), to split back one at a time. */
  mergedInto?: Record<number, MergedClusterInfo[]>;
  onSplitBack?: (stepId: string, cluster: number) => void;
};

export function OverviewTabContent({
  clusterData,
  datasetIds,
  multiDs,
  clusterFocus,
  setClusterFocus,
  clusterOrder,
  setClusterOrder,
  selectedClusters,
  setClusterSelection,
  clearClusterSelection,
  mergeSelectedClusters,
  combinedProfiles,
  enabledMetaProfiles,
  proportions,
  chartWidth,
  containerWidth,
  profileHeight,
  isReversed,
  dissolving,
  onDissolve,
  getDatasetLabel,
  mergedInto,
  onSplitBack,
}: OverviewTabContentProps) {
  const [dragCluster, setDragCluster] = useState<number | null>(null);
  const [dragOverCluster, setDragOverCluster] = useState<number | null>(null);
  const firstDsId = datasetIds[0];
  const selectedUnion = new Set<number>();
  for (const dsId of datasetIds) {
    for (const cluster of selectedClusters[dsId] ?? []) selectedUnion.add(cluster);
  }
  const selectedCount = selectedUnion.size;
  const allClusterIds = clusterData.map(d => d.cluster);
  const visibleClusterIds = firstDsId ? clusterFocus[firstDsId] : null;
  const hiddenClusterIds = visibleClusterIds
    ? allClusterIds.filter(cluster => !visibleClusterIds.has(cluster))
    : [];
  const hiddenClusterSet = new Set(hiddenClusterIds);
  const selectedHiddenClusters = [...selectedUnion].filter(cluster => hiddenClusterSet.has(cluster));
  const selectedHiddenCount = selectedHiddenClusters.length;
  const selectedOnlyUnassigned = selectedCount === 1 && selectedUnion.has(UNASSIGNED_CLUSTER_ID);
  const hasHiddenClusters = hiddenClusterIds.length > 0;
  const canHideSelected = datasetIds.some(dsId => {
    const currentVisible = clusterFocus[dsId] ?? new Set(allClusterIds);
    const selectedVisible = [...selectedUnion].some(cluster => currentVisible.has(cluster));
    const remainingVisible = allClusterIds.some(cluster => currentVisible.has(cluster) && !selectedUnion.has(cluster));
    return selectedVisible && remainingVisible;
  });

  const handleMergeSelected = () => {
    mergeSelectedClusters(datasetIds);
  };

  const handleHideSelected = () => {
    if (!canHideSelected) return;
    seedHistoryBaseline(useBrowserStore.getState(), 'Before cluster visibility change', 'clustering');
    const selected = selectedUnion;
    for (const dsId of datasetIds) {
      const currentVisible = clusterFocus[dsId] ?? new Set(allClusterIds);
      const nextVisible = new Set(allClusterIds.filter(cluster => currentVisible.has(cluster) && !selected.has(cluster)));
      if (nextVisible.size === 0) continue;
      setClusterFocus(dsId, nextVisible.size >= allClusterIds.length ? null : nextVisible);
    }
    useBrowserStore.getState().pushSnapshot('Hide selected clusters', { kind: 'clustering' });
  };

  const handleHideOthers = () => {
    if (selectedCount === 0) return;
    seedHistoryBaseline(useBrowserStore.getState(), 'Before cluster visibility change', 'clustering');
    const selected = new Set(selectedUnion);
    for (const dsId of datasetIds) {
      setClusterFocus(dsId, selected.size === allClusterIds.length ? null : new Set(selected));
    }
    useBrowserStore.getState().pushSnapshot('Hide unselected clusters', { kind: 'clustering' });
  };

  const applyClusterFocus = (clusters: Set<number> | null) => {
    for (const dsId of datasetIds) {
      setClusterFocus(dsId, clusters ? new Set(clusters) : null);
    }
  };

  const handleUnhideSelected = () => {
    if (selectedHiddenCount === 0) return;
    seedHistoryBaseline(useBrowserStore.getState(), 'Before cluster visibility change', 'clustering');
    const visible = new Set(visibleClusterIds ?? allClusterIds);
    for (const cluster of selectedHiddenClusters) visible.add(cluster);
    applyClusterFocus(visible.size >= allClusterIds.length ? null : visible);
    useBrowserStore.getState().pushSnapshot('Unhide selected clusters', { kind: 'clustering' });
  };

  const handleUnhideAll = () => {
    if (!hasHiddenClusters) return;
    seedHistoryBaseline(useBrowserStore.getState(), 'Before cluster visibility change', 'clustering');
    applyClusterFocus(null);
    useBrowserStore.getState().pushSnapshot('Unhide all clusters', { kind: 'clustering' });
  };

  const handleDeleteSelected = () => {
    if (selectedCount !== 1 || allClusterIds.length <= 1 || selectedOnlyUnassigned) return;
    const [cluster] = [...selectedUnion];
    if (cluster === undefined) return;
    onDissolve(cluster);
    datasetIds.forEach(dsId => clearClusterSelection(dsId));
  };

  return (
    <>
      {hasHiddenClusters && (
        <div className="mb-2 flex flex-wrap items-center gap-1 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
          <span className="font-medium">
            {hiddenClusterIds.length} hidden
          </span>
          <AnalysisButton
            onClick={handleUnhideAll}
            theme="amber"
            variant="soft"
            className="px-1.5 py-0"
            title="Restore every hidden cluster"
            data-tour="cluster-unhide-all"
          >
            Unhide all
          </AnalysisButton>
        </div>
      )}

      {selectedCount > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-1 rounded border border-blue-200 bg-blue-50 px-2 py-1 text-[11px] text-blue-800 dark:border-blue-900/50 dark:bg-blue-950/30 dark:text-blue-300">
          <span className="font-medium">{selectedCount} selected</span>
          {selectedHiddenCount > 0 && (
            <AnalysisButton
              onClick={handleUnhideSelected}
              theme="amber"
              variant="primary"
              className="px-1.5 py-0"
              title="Restore selected hidden clusters"
            >
              Unhide
            </AnalysisButton>
          )}
          <AnalysisButton
            onClick={handleMergeSelected}
            disabled={selectedCount < 2}
            data-copilot-anchor="cluster-merge-button"
            theme="emerald"
            variant="primary"
            className="px-1.5 py-0"
            title="Merge selected clusters into the first selected cluster in the current order"
          >
            Merge
          </AnalysisButton>
          <AnalysisButton
            onClick={handleHideSelected}
            disabled={!canHideSelected}
            variant="neutral"
            className="px-1.5 py-0"
            title={!canHideSelected ? 'At least one cluster must remain visible' : 'Hide selected clusters'}
          >
            Hide
          </AnalysisButton>
          <AnalysisButton
            onClick={handleHideOthers}
            disabled={selectedCount === 0}
            variant="neutral"
            className="px-1.5 py-0"
            title="Show only selected clusters"
          >
            Hide others
          </AnalysisButton>
          <AnalysisButton
            onClick={handleDeleteSelected}
            disabled={selectedCount !== 1 || allClusterIds.length <= 1 || selectedOnlyUnassigned || dissolving !== null}
            variant="dangerOutline"
            className="px-1.5 py-0"
            title={selectedOnlyUnassigned ? 'Unassigned reads can be hidden but are not a fitted cluster' : allClusterIds.length <= 1 ? 'At least two clusters are required before deleting one' : selectedCount === 1 ? 'Delete selected cluster by reassigning reads to nearest remaining cluster' : 'Select exactly one cluster to delete'}
          >
            {dissolving !== null ? 'Deleting...' : 'Delete'}
          </AnalysisButton>
          <AnalysisButton
            onClick={() => datasetIds.forEach(dsId => clearClusterSelection(dsId))}
            variant="neutral"
            className="px-1.5 py-0"
          >
            Clear
          </AnalysisButton>
        </div>
      )}
      {clusterData.map(({ cluster, color, counts, totalCount }) => {
        const isSelected = selectedUnion.has(cluster);
        const isFocused = !visibleClusterIds || visibleClusterIds.has(cluster);
        const isDragging = dragCluster === cluster;
        const isDragOver = dragOverCluster === cluster && dragCluster !== cluster;
        const profile = combinedProfiles[cluster];

        return (
          <div
            key={cluster}
            data-copilot-anchor={`cluster-row-${cluster}`}
            draggable
            onDragStart={e => {
              setDragCluster(cluster);
              e.dataTransfer.effectAllowed = 'move';
            }}
            onDragEnd={() => {
              setDragCluster(null);
              setDragOverCluster(null);
            }}
            onDragOver={e => {
              e.preventDefault();
              setDragOverCluster(cluster);
            }}
            onDragLeave={() => setDragOverCluster(null)}
            onDrop={e => {
              e.preventDefault();
              if (dragCluster !== null && dragCluster !== cluster) {
                let reordered = false;
                for (const dsId of datasetIds) {
                  const currentOrder =
                    clusterOrder[dsId] || clusterData.map(d => d.cluster);
                  const newOrder = [...currentOrder];
                  const fromIdx = newOrder.indexOf(dragCluster);
                  const toIdx = newOrder.indexOf(cluster);
                  if (fromIdx !== -1 && toIdx !== -1) {
                    if (!reordered) {
                      seedHistoryBaseline(useBrowserStore.getState(), 'Before cluster reorder', 'clustering');
                    }
                    newOrder.splice(fromIdx, 1);
                    newOrder.splice(toIdx, 0, dragCluster);
                    setClusterOrder(dsId, newOrder);
                    reordered = true;
                  }
                }
                if (reordered) {
                  useBrowserStore.getState().pushSnapshot('Reorder clusters', {
                    kind: 'clustering',
                    coalesceKey: 'cluster-reorder',
                    coalesceMs: 2500,
                  });
                }
              }
              setDragCluster(null);
              setDragOverCluster(null);
            }}
            className={`border rounded px-1.5 py-1 cursor-pointer select-none transition-all
              ${!isFocused ? 'opacity-40' : ''}
              ${isSelected ? 'ring-2 ring-blue-500 bg-blue-50 dark:bg-blue-950/30' : ''}
              ${isDragging ? 'opacity-50' : ''}
              ${isDragOver ? 'border-blue-500 border-2' : 'dark:border-white/10'}
            `}
            style={{ borderLeftWidth: 3, borderLeftColor: color }}
            onClick={(event) => {
              if (dragCluster !== null) return;
              const additive = event.shiftKey || event.metaKey || event.ctrlKey;
              // Capture picks before updating any linked panel.
              const selected = selectedClusters;
              for (const dsId of datasetIds) {
                if (additive) {
                  const next = new Set(selected[dsId] ?? []);
                  if (next.has(cluster)) next.delete(cluster); else next.add(cluster);
                  setClusterSelection(dsId, next);
                }
                else setClusterSelection(dsId, [cluster]);
              }
            }}
            title="Click to select, Shift/Cmd-click to add or remove from selection, Drag to reorder"
          >
            <div className="flex items-center gap-1.5">
              <span className="inline-flex text-gray-400 cursor-grab"><GripVertical size={11} /></span>
              <span
                className="w-2.5 h-2.5 rounded-sm flex-shrink-0"
                style={{ backgroundColor: color }}
              />
              <span className="text-[11px] font-semibold dark:text-gray-200 flex-shrink-0">
                {getClusterLabel(cluster, true)}
              </span>
              {cluster === UNASSIGNED_CLUSTER_ID && (
                <span className="rounded bg-gray-100 px-1 text-[11px] font-medium text-gray-500 dark:bg-gray-800 dark:text-gray-300">
                  no overlap
                </span>
              )}
              <span
                className="text-[11px] text-gray-500 dark:text-gray-400 flex-shrink-0"
                title="Assigned reads in this cluster across active dataset views"
              >
                {totalCount}
              </span>
              {multiDs && (
                <span className="text-[11px] text-gray-400 flex-shrink-0">
                  ({counts.join('/')})
                </span>
              )}
            </div>
            {onSplitBack && (mergedInto?.[cluster]?.length ?? 0) > 0 && (
              <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] text-gray-500 dark:text-gray-400" data-testid={`cluster-merged-in-${cluster}`}>
                <span>Merged in:</span>
                {mergedInto![cluster].map(info => (
                  <span key={`${info.stepId}:${info.cluster}`} className="inline-flex items-center gap-0.5 rounded border border-gray-200 px-1 dark:border-white/10" title={`${info.stepLabel}: ${info.reads} reads of ${getClusterLabel(info.cluster, true)}`}>
                    <span className="inline-block h-2 w-2 rounded-sm" style={{ background: getClusterColor(info.cluster) }} />
                    {getClusterLabel(info.cluster, true)}
                    <button
                      type="button"
                      onClick={e => { e.stopPropagation(); onSplitBack(info.stepId, info.cluster); }}
                      className="ml-0.5 inline-flex items-center gap-0.5 rounded px-0.5 font-medium text-emerald-700 hover:underline focus-visible:outline-none focus-visible:shadow-focus dark:text-emerald-300"
                      title={`Split ${getClusterLabel(info.cluster, true)} back out (its ${info.reads} reads); the other merges stay`}
                      data-testid={`cluster-split-back-${info.cluster}`}
                    >
                      <Split size={11} aria-hidden="true" /> Split back
                    </button>
                  </span>
                ))}
              </div>
            )}
            {profile && (() => {
              const activeKeys = Object.entries(enabledMetaProfiles)
                .filter(([, v]) => v)
                .map(([k]) => k);
              const series = activeKeys
                .map(k => ({ data: profile[k] ?? [], color: getLayerColor(k), label: getLayerLabel(k) }))
                .filter(s => s.data.length > 0);
              const fallback = profile.nuc ?? profile.footprint ?? Object.values(profile)[0];
              return (
                <div className="mt-0.5">
                  {series.length > 0 ? (
                    <OverlayProfileChart
                      series={series}
                      width={chartWidth}
                      height={profileHeight}
                      showLegend={series.length > 1}
                      isReversed={isReversed}
                      noAxes
                      filename={`cluster_${cluster}_overview`}
                    />
                  ) : fallback ? (
                    <ProfileChart
                      data={fallback}
                      color={color}
                      label={getClusterLabel(cluster, true)}
                      width={chartWidth}
                      height={profileHeight}
                      isReversed={isReversed}
                    />
                  ) : null}
                </div>
              );
            })()}
          </div>
        );
      })}

    </>
  );
}
