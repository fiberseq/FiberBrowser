interface FastaReferenceRowProps {
  hasFasta: boolean;
  fastaPath: string | null;
  loading: boolean;
  onLoad: () => void;
}

export function FastaReferenceRow({
  hasFasta,
  fastaPath,
  loading,
  onLoad,
}: FastaReferenceRowProps) {
  return (
    <div className="flex items-center gap-1" data-tour="load-fasta">
      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${hasFasta ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'}`} />
      {hasFasta && fastaPath ? (
        <span className="flex-1 text-[12px] text-gray-600 dark:text-gray-400 truncate" title={fastaPath}>
          {fastaPath.split('/').pop() || 'FASTA loaded'}
        </span>
      ) : (
        <button
          onClick={onLoad}
          disabled={loading}
          className="flex-1 text-left text-[12px] text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 disabled:opacity-50"
        >
          {loading ? 'Loading FASTA...' : 'Load Reference FASTA...'}
        </button>
      )}
      {hasFasta && (
        <button
          onClick={onLoad}
          disabled={loading}
          className="px-1.5 py-0.5 text-[11px] text-gray-500 hover:bg-gray-100 dark:hover:bg-white/10 rounded"
          title="Change reference FASTA"
        >
          Change
        </button>
      )}
    </div>
  );
}
