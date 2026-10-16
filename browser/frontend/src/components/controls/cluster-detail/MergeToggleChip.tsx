import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../../stores/browserStore';
import { mergeLogStatus } from '../../../stores/clusterMergeLog';
import { Merge, Split } from '../../ui/Icons';

/**
 * Unmerge (fb-n5-projection): after Merge, Merge similar clusters or Delete,
 * "Merged: 12 → 8 clusters · Unmerge" switches back to the clustering before
 * the merges, and "Merge again" forward, without recomputing; each switch is
 * an undo step. Hidden when the clustering on show is neither (a new run).
 */
export function MergeToggleChip({ className = '' }: { className?: string }) {
  const { log, assignments, toggle } = useBrowserStore(useShallow(s => ({
    log: s.clusterMergeLog,
    assignments: s.clusterAssignments,
    toggle: s.toggleClusterMerge,
  })));
  const status = useMemo(() => mergeLogStatus(log, assignments), [log, assignments]);
  if (!log || !status) return null;
  const merged = status === 'merged';
  const steps = log.steps.map(step => `${step.label}${step.removed.length ? ` (${step.removed.map(c => `C${c}`).join(', ')})` : ''}`).join('; ');
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-fb border px-1.5 py-[1px] text-[11px] ${merged
        ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800/50 dark:bg-emerald-950/30 dark:text-emerald-200'
        : 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800/50 dark:bg-amber-950/30 dark:text-amber-200'} ${className}`}
      data-testid="cluster-merge-chip"
      data-merge-state={status}
      title={`Merges since the last clustering: ${steps}.`}
    >
      <span data-testid="cluster-merge-chip-text">
        {merged
          ? <>Merged: {log.originalCount} → {log.mergedCount} clusters</>
          : <>Before merging: {log.originalCount} clusters</>}
      </span>
      <button
        type="button"
        onClick={() => toggle()}
        data-testid="cluster-merge-toggle"
        className="inline-flex items-center gap-0.5 rounded px-1 font-semibold underline-offset-2 hover:underline focus-visible:outline-none focus-visible:shadow-focus"
        title={merged
          ? 'Show the clusters as they were before merging (Merge again switches back; Undo also works)'
          : `Show the merged clusters again (${log.mergedCount})`}
      >
        {merged ? <Split size={12} aria-hidden="true" /> : <Merge size={12} aria-hidden="true" />}
        {merged ? 'Unmerge' : 'Merge again'}
      </button>
    </span>
  );
}
