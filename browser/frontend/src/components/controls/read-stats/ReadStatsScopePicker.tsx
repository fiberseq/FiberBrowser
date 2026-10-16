import type { ReadStatsScope, ReadStatsScopeOption } from '../../../utils/readStatsScope';

/**
 * Which reads Read Stats describes: the selected reads, every read shown, or
 * one cluster. The same statistics and distributions follow the choice.
 */
export function ReadStatsScopePicker({ options, scope, onChange, truncated }: {
  options: ReadStatsScopeOption[];
  scope: ReadStatsScope;
  onChange: (scope: ReadStatsScope) => void;
  /** The group is larger than one request takes. */
  truncated: { shown: number; total: number } | null;
}) {
  const current = options.find(o => o.key === scope);
  const clusters = options.filter(o => o.key.startsWith('cluster:'));
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 px-2 py-1.5 dark:border-white/10" data-tour="read-stats-scope">
      <label htmlFor="read-stats-scope" className="text-[11px] font-medium text-gray-500 dark:text-gray-400">Reads</label>
      <span className="flex items-center gap-1.5">
        {current?.color && <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: current.color }} aria-hidden="true" />}
        <select
          id="read-stats-scope"
          data-testid="read-stats-scope"
          value={scope}
          onChange={event => onChange(event.target.value as ReadStatsScope)}
          className="input-tool h-7 max-w-[16rem] text-xs"
          title="Which reads the statistics describe. Shift+click reads to select them."
        >
          {/* An empty group can't be described: it stays listed (so the
              choice is discoverable) but can't be picked. */}
          {options.filter(o => !o.key.startsWith('cluster:')).map(o => (
            <option key={o.key} value={o.key} disabled={o.count === 0 && o.key !== scope}>
              {o.label} ({o.count.toLocaleString()})
            </option>
          ))}
          {clusters.length > 0 && (
            <optgroup label="Clusters">
              {clusters.map(o => (
                <option key={o.key} value={o.key}>{o.label} ({o.count.toLocaleString()})</option>
              ))}
            </optgroup>
          )}
        </select>
      </span>
      {truncated && (
        <span className="text-[11px] text-amber-700 dark:text-amber-300" data-testid="read-stats-truncated">
          First {truncated.shown.toLocaleString()} of {truncated.total.toLocaleString()} reads
        </span>
      )}
    </div>
  );
}
