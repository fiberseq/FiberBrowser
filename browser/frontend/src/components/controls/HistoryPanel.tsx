import { useMemo } from 'react';
import { useBrowserStore } from '../../stores/browserStore';
import { useShallow } from 'zustand/react/shallow';
import { formatTimeAgo } from '../../utils/time';
import { AnalysisButton, AnalysisStatus } from './shared';
import { describeStepLocus, panelLociChanged } from '../../utils/historyLabels';

const SNAPSHOT_CHANGE_FIELDS = {
  view: ['chrom', 'start', 'end', 'isReversed', 'showRelativeCoords', 'relativeTSS'],
  clusters: ['clusterK', 'clusterResolution', 'clusterMethod', 'clusterFeatureRules', 'clusterAssignments', 'clusterOrder', 'clusterPatterns', 'clusterPeakRegions', 'dynamicClustering', 'readSortOrder'],
  peaks: ['selectedPeaks', 'peakModes', 'peakRules', 'peaksByRule', 'peaksLocked'],
  filters: ['filteredReadIds', 'clusterFocus', 'readStateDetails', 'transcriptionStateFilters', 'minFpQuality', 'minFootprints', 'showDuplicateReads'],
  tracks: ['catalog', 'compositeTracks', 'savedTracks', 'enabledModTypes', 'enabledMetaProfiles', 'cachedLayerTypes'],
  labeling: ['activeColormap'],
  selection: ['selectedReadIds', 'selectedDatasets', 'selectedFootprints', 'footprintGroups', 'selectedGenes'],
  settings: ['spanningOnly', 'downsampleCount', 'readDisplayMode', 'allReadsDisplayCap', 'backgroundReadCap', 'clusterPreparationCount', 'clusterPreparationSamples', 'analysisSampleCount', 'analysisSampleSeed', 'classRegionMode', 'clickTargetLayer', 'footprintAnalysisLayer', 'readRowHeight'],
} as const;

function stableValue(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function hasChanged(prev: Record<string, unknown> | undefined, next: Record<string, unknown>, keys: readonly string[]): boolean {
  if (!prev) return false;
  return keys.some(key => stableValue(prev[key]) !== stableValue(next[key]));
}

function snapshotChanges(
  prev: Record<string, unknown> | undefined,
  next: Record<string, unknown>,
): string[] {
  if (!prev) return ['Baseline'];
  const changes: string[] = [];
  if (hasChanged(prev, next, SNAPSHOT_CHANGE_FIELDS.view) || panelLociChanged(prev, next)) changes.push('View');
  if (hasChanged(prev, next, SNAPSHOT_CHANGE_FIELDS.clusters)) changes.push('Clusters');
  if (hasChanged(prev, next, SNAPSHOT_CHANGE_FIELDS.peaks)) changes.push('Peaks');
  if (hasChanged(prev, next, SNAPSHOT_CHANGE_FIELDS.filters)) changes.push('Filters');
  if (hasChanged(prev, next, SNAPSHOT_CHANGE_FIELDS.tracks)) changes.push('Tracks');
  if (hasChanged(prev, next, SNAPSHOT_CHANGE_FIELDS.labeling)) changes.push('Labeling');
  if (hasChanged(prev, next, SNAPSHOT_CHANGE_FIELDS.selection)) changes.push('Selection');
  if (hasChanged(prev, next, SNAPSHOT_CHANGE_FIELDS.settings)) changes.push('Settings');
  return changes.length > 0 ? changes : ['Snapshot'];
}


export function HistoryPanel() {
  const {
    historyStack, historyPointer, jumpToSnapshot, restoreSnapshot, clearHistory,
  } = useBrowserStore(useShallow(s => ({
    historyStack: s._historyStack,
    historyPointer: s._historyPointer,
    jumpToSnapshot: s.jumpToSnapshot,
    restoreSnapshot: s.restoreSnapshot,
    clearHistory: s.clearHistory,
  })));

  const labels = useMemo(() =>
    historyStack.map((snap, i) => ({
      label: snap.label,
      timestamp: snap.timestamp,
      isCurrent: i === historyPointer,
      // The panels' locus (each panel's own in Per panel mode, audit L1), not only the main one.
      viewport: describeStepLocus(
        snap.state as unknown as Record<string, unknown>,
        i > 0 ? historyStack[i - 1]?.state as unknown as Record<string, unknown> : undefined,
      ),
      changes: snapshotChanges(
        i > 0 ? historyStack[i - 1]?.state as unknown as Record<string, unknown> : undefined,
        snap.state as unknown as Record<string, unknown>,
      ),
    })),
    [historyStack, historyPointer]
  );

  if (labels.length === 0) {
    return (
      <AnalysisStatus kind="empty" center title="No history yet" className="m-3">
        Actions like clustering, sorting, and navigation are tracked here.
      </AnalysisStatus>
    );
  }

  return (
    <div className="space-y-1">
      {/* Undo/Redo are the buttons this list opens from. */}
      <div className="flex items-center gap-1 px-3 py-1">
        <span className="text-[11px] font-medium text-gray-700 dark:text-gray-200">History</span>
        <span className="text-[11px] text-ink-secondary">click a step to restore it · View also jumps there</span>
        <div className="flex-1" />
        <AnalysisButton onClick={clearHistory} variant="dangerOutline" size="sm" title="Clear history" data-tour="history-clear">
          Clear
        </AnalysisButton>
      </div>

      {/* Timeline */}
      <div className="px-3 max-h-64 overflow-y-auto space-y-1" data-tour="history-steps">
        {[...labels].reverse().map((entry, reverseIdx) => {
          const originalIdx = labels.length - 1 - reverseIdx;
          return (
            <div
              key={originalIdx}
              className={`w-full flex items-start gap-2 rounded px-1.5 py-1 text-xs transition-colors ${
                entry.isCurrent
                  ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                  : 'hover:bg-gray-100 dark:hover:bg-white/5 text-gray-600 dark:text-gray-400'
              }`}
            >
              {/* Timeline dot */}
              <div className="flex-shrink-0 mt-1">
                <div
                  className={`w-1.5 h-1.5 rounded-full ${
                    entry.isCurrent
                      ? 'bg-blue-500'
                      : 'bg-gray-300 dark:bg-gray-600'
                  }`}
                />
              </div>
              <button
                type="button"
                onClick={() => jumpToSnapshot(originalIdx)}
                className="min-w-0 flex-1 text-left"
                title="Restore this snapshot's analysis/UI state without moving the viewport"
              >
                <div className="truncate leading-tight">{entry.label}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1">
                  {entry.changes.map(change => (
                    <span
                      key={change}
                      className="rounded bg-white/70 px-1 py-0.5 text-[11px] leading-none text-gray-500 ring-1 ring-gray-200 dark:bg-white/10 dark:text-gray-300 dark:ring-white/10"
                    >
                      {change}
                    </span>
                  ))}
                </div>
                <div className="mt-0.5 truncate text-[11px] leading-tight text-ink-secondary">
                  {formatTimeAgo(entry.timestamp)} · {entry.viewport}
                </div>
              </button>
              <AnalysisButton
                type="button"
                onClick={() => restoreSnapshot(originalIdx, { restoreViewport: true })}
                theme="blue"
                variant="outline"
                className="mt-0.5"
                data-tour="history-view-step"
                title="Restore analysis/UI state and jump to this snapshot's viewport"
              >
                View
              </AnalysisButton>
            </div>
          );
        })}
      </div>
    </div>
  );
}
