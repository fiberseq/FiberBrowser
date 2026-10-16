/**
 * "Go to <dataset>'s reads" in a read panel's empty card: while it searches,
 * a Cancel button; when the search finds nothing, the reason (e.g. "No reads
 * from X map to the loaded genome (dm6).") instead of a silent no-op.
 */
export interface FindReadsControlProps {
  datasetId: string;
  label: string;
  finding: boolean;
  message: string | null;
  onFind: () => void;
  onCancel: () => void;
}

export function FindReadsControl({ datasetId, label, finding, message, onFind, onCancel }: FindReadsControlProps) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={onFind}
          disabled={finding}
          data-testid={`go-to-reads-${datasetId}`}
          className="rounded bg-blue-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {finding ? 'Finding reads…' : `Go to ${label}'s reads`}
        </button>
        {finding && (
          <button
            type="button"
            onClick={onCancel}
            data-testid={`cancel-find-reads-${datasetId}`}
            className="rounded border border-gray-300 dark:border-white/20 px-2 py-0.5 text-[11px] text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/10"
          >
            Cancel
          </button>
        )}
      </div>
      {message && !finding && (
        <div role="status" data-testid={`find-reads-message-${datasetId}`} className="max-w-xs text-[11px] text-amber-700 dark:text-amber-300">
          {message}
        </div>
      )}
    </div>
  );
}
