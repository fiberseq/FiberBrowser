import type { Dispatch, SetStateAction } from 'react';
import type { SavedCluster } from '../../../types/clustering';
import { AnalysisButton, AnalysisStatus } from '../shared';

export function SavedClustersTab({
  savedClusters,
  chrom,
  start,
  end,
  editingNameId,
  setEditingNameId,
  updateSavedClusterName,
  restoreSavedCluster,
  removeSavedCluster,
  clearSavedClusters,
}: {
  savedClusters: SavedCluster[];
  chrom: string;
  start: number;
  end: number;
  editingNameId: string | null;
  setEditingNameId: Dispatch<SetStateAction<string | null>>;
  updateSavedClusterName: (id: string, name: string) => void;
  restoreSavedCluster: (id: string) => void;
  removeSavedCluster: (id: string) => void;
  clearSavedClusters: () => void;
}) {
  if (savedClusters.length === 0) {
    return (
      <AnalysisStatus kind="empty" center>
        No saved clusters. Click "Snapshot" to keep the current clustering.
      </AnalysisStatus>
    );
  }

  return (
    <div className="space-y-1.5">
      {savedClusters.map(sc => {
        const nClusters = new Set(Object.values(sc.assignments).flatMap(a => Object.values(a))).size;
        const nReads = Object.values(sc.assignments).reduce((s, a) => s + Object.keys(a).length, 0);
        const nDatasets = Object.keys(sc.assignments).length;
        const isSameViewport = chrom === sc.chrom && start === sc.start && end === sc.end;
        const regionLabel = `${sc.chrom}:${sc.start.toLocaleString()}-${sc.end.toLocaleString()}`;
        const timeStr = new Date(sc.addedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        return (
          <div
            key={sc.id}
            className="border rounded px-2 py-1.5 dark:border-white/10 hover:border-cyan-300 dark:hover:border-cyan-700 transition-colors"
          >
            <div className="flex items-center gap-1 mb-0.5">
              {editingNameId === sc.id ? (
                <input
                  autoFocus
                  defaultValue={sc.name}
                  className="text-[11px] font-semibold flex-1 px-1 py-0 border rounded bg-transparent dark:text-gray-200 dark:border-gray-600 focus:outline-none focus:border-cyan-400"
                  onBlur={e => {
                    const val = e.target.value.trim();
                    if (val && val !== sc.name) updateSavedClusterName(sc.id, val);
                    setEditingNameId(null);
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    if (e.key === 'Escape') setEditingNameId(null);
                  }}
                />
              ) : (
                <span
                  className="text-[11px] font-semibold text-gray-700 dark:text-gray-200 cursor-text truncate flex-1"
                  onClick={() => setEditingNameId(sc.id)}
                  title="Click to rename"
                >
                  {sc.name}
                </span>
              )}
              <span className="text-[11px] text-ink-secondary flex-shrink-0">{timeStr}</span>
            </div>

            <div className="text-[11px] text-gray-500 dark:text-gray-400 flex items-center gap-1.5 flex-wrap">
              <span className={isSameViewport ? 'text-green-600 dark:text-green-400' : ''}>
                {regionLabel}
              </span>
              <span>{sc.clusterMethod}</span>
              <span>{nClusters}c / {nReads}r</span>
              {nDatasets > 1 && <span>{nDatasets}ds</span>}
            </div>

            <div className="flex items-center gap-1 mt-1">
              <AnalysisButton
                onClick={() => restoreSavedCluster(sc.id)}
                theme="cyan"
                variant="soft"
                title={isSameViewport ? 'Restore clustering' : `Navigate to ${regionLabel} and restore`}
              >
                {isSameViewport ? 'Restore' : 'Go & Restore'}
              </AnalysisButton>
              <AnalysisButton
                onClick={() => removeSavedCluster(sc.id)}
                variant="dangerOutline"
                title="Delete saved cluster"
              >
                Delete
              </AnalysisButton>
            </div>
          </div>
        );
      })}

      <div className="flex items-center gap-2 pt-1 border-t dark:border-white/10">
        <AnalysisButton
          onClick={() => {
            const data = JSON.stringify(savedClusters, null, 2);
            const blob = new Blob([data], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = 'saved_clusters.json'; a.click();
            URL.revokeObjectURL(url);
          }}
          variant="outline"
        >
          Export JSON
        </AnalysisButton>
        <AnalysisButton
          onClick={() => {
            const rows = ['name\tchrom\tstart\tend\tmethod\tclusters\treads\tdatasets'];
            for (const sc of savedClusters) {
              const nC = new Set(Object.values(sc.assignments).flatMap(a => Object.values(a))).size;
              const nR = Object.values(sc.assignments).reduce((s, a) => s + Object.keys(a).length, 0);
              const nD = Object.keys(sc.assignments).length;
              rows.push(`${sc.name}\t${sc.chrom}\t${sc.start}\t${sc.end}\t${sc.clusterMethod}\t${nC}\t${nR}\t${nD}`);
            }
            const blob = new Blob([rows.join('\n')], { type: 'text/tab-separated-values' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = 'saved_clusters.tsv'; a.click();
            URL.revokeObjectURL(url);
          }}
          variant="outline"
        >
          Export TSV
        </AnalysisButton>
        <AnalysisButton
          onClick={clearSavedClusters}
          variant="dangerOutline"
          className="ml-auto"
        >
          Clear All
        </AnalysisButton>
      </div>
    </div>
  );
}
