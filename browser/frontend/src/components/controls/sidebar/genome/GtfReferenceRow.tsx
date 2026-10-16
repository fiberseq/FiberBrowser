interface GtfReferenceRowProps {
  hasGtf: boolean;
  geneCount: number;
  loading: boolean;
  onLoad: () => void;
  onRemove: () => void;
}

export function GtfReferenceRow({
  hasGtf,
  geneCount,
  loading,
  onLoad,
  onRemove,
}: GtfReferenceRowProps) {
  if (!hasGtf) {
    return (
      <button
        onClick={onLoad}
        disabled={loading}
        data-tour="load-gtf"
        className="w-full text-left px-2 py-1 text-[12px] text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/5 rounded disabled:opacity-50"
      >
        Load gene annotation (GTF/GFF/BED)...
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1" data-tour="load-gtf">
      <span className="w-1.5 h-1.5 rounded-full bg-green-500 flex-shrink-0" />
      <span className="min-w-0 flex-1 text-[12px] text-gray-600 dark:text-gray-400 truncate" title={`Gene annotation loaded (${Number(geneCount).toLocaleString()} genes)`}>
        Gene annotation loaded
        <span className="text-[11px] text-ink-secondary ml-1">({Number(geneCount).toLocaleString()} genes)</span>
      </span>
      <button
        onClick={onRemove}
        className="px-1.5 py-0.5 text-[11px] text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 rounded"
        title="Unload GTF annotations"
      >
        Unload
      </button>
    </div>
  );
}
