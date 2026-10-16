const TYPE_COLORS: Record<string, string> = {
  bigWig: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  wig: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300',
  bigBed: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
  bed: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300',
  genePred: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300',
  rmsk: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300',
  narrowPeak: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  psl: 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300',
  chain: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
};

export function TrackTypeBadge({ type }: { type: string }) {
  if (!type) return null;
  const colors = TYPE_COLORS[type] || 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400';
  return (
    <span className={`px-1 py-0.5 rounded text-[11px] font-medium flex-shrink-0 ${colors}`}>
      {type}
    </span>
  );
}
