import { getClusterLabel } from '../../tracks/ReadTrack';
import type { ClusterPicks } from './clusterPicks';

interface ClusterPickChipsProps {
  clusters: Array<{ cluster: number; color: string }>;
  picks: ClusterPicks;
  /** Prefix for the chips' test ids (`<id>-chip-<cluster>`, `<id>-all`). */
  testId?: string;
}

/**
 * The clusters' names as toggles above a chart. Clicking a name picks it (the
 * chart then shows only the picked clusters); clicking it again unpicks it.
 * "All" shows every cluster. The pick is the app's cluster selection, shared
 * with the read panel, the Overview cards and the map.
 */
export function ClusterPickChips({ clusters, picks, testId = 'cluster-picks' }: ClusterPickChipsProps) {
  const visiblePicked = clusters.filter(c => picks.picked.has(c.cluster)).length;
  const anyPicked = visiblePicked > 0;
  // Picked clusters that are all hidden here: the chart shows every cluster; say so and offer the reset.
  const pickedHidden = picks.picked.size > 0 && !anyPicked;
  if (clusters.length < 2 && !pickedHidden) return null;
  return (
    <div className="flex flex-wrap items-center gap-1 text-[11px]" data-testid={testId} role="group" aria-label="Clusters shown">
      <span className="text-gray-500 dark:text-gray-400 mr-0.5">
        {anyPicked
          ? `Showing ${visiblePicked} of ${clusters.length}`
          : pickedHidden
            ? 'The picked clusters are hidden here, so all are shown'
            : 'Click names to pick clusters'}
      </span>
      {clusters.map(({ cluster, color }) => {
        const on = !anyPicked || picks.picked.has(cluster);
        const label = getClusterLabel(cluster, true);
        return (
          <button
            key={cluster}
            type="button"
            data-testid={`${testId}-chip-${cluster}`}
            aria-pressed={anyPicked && picks.picked.has(cluster)}
            onClick={() => picks.toggle(cluster)}
            title={picks.picked.has(cluster)
              ? `Unpick ${label}`
              : `Pick ${label}: the charts show the clusters you pick (also picked in the read panel)`}
            className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-[1px] transition-colors ${
              on
                ? 'border-gray-300 bg-white text-gray-700 dark:border-white/20 dark:bg-gray-900 dark:text-gray-200'
                : 'border-dashed border-gray-300 bg-transparent text-gray-400 dark:border-white/15 dark:text-gray-500'
            } ${anyPicked && picks.picked.has(cluster) ? 'font-semibold ring-1 ring-cyan-500/60' : ''}`}
          >
            <span
              className="inline-block h-2 w-2 rounded-sm"
              style={{ backgroundColor: color, opacity: on ? 1 : 0.35 }}
            />
            {label}
          </button>
        );
      })}
      <button
        type="button"
        data-testid={`${testId}-all`}
        disabled={picks.picked.size === 0}
        onClick={picks.clear}
        title="Show every cluster (clears the pick)"
        className="rounded px-1.5 py-[1px] text-cyan-700 hover:bg-cyan-50 disabled:text-gray-300 disabled:hover:bg-transparent dark:text-cyan-300 dark:hover:bg-cyan-900/30 dark:disabled:text-gray-600"
      >
        All
      </button>
    </div>
  );
}
