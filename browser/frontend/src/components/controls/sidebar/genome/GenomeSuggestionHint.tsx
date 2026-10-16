import { useState } from 'react';
import { useGenomeCheckStore } from '../../../../stores/genomeCheckStore';
import { loadRegistryGenome } from '../../../../utils/registryGenomeLoad';

/**
 * In the genome picker: the registry genome the loaded data was aligned to
 * ("Suggested from your BAM: dm6"), when it isn't the loaded one.
 */
export function GenomeSuggestionHint() {
  const check = useGenomeCheckStore(s => s.check);
  const loadingGenome = useGenomeCheckStore(s => s.loadingGenome);
  const [error, setError] = useState<string | null>(null);
  const suggestion = check?.suggestion;
  if (!check || !suggestion || check.reference.assembly === suggestion.genome_id) return null;
  const from = suggestion.datasets ?? [];
  const source = from.length === 1 && /\.(bb|bigbed)$/i.test(from[0]) ? 'BigBed' : 'BAM';
  const busy = loadingGenome === suggestion.genome_id;
  return (
    <div
      className="flex items-center gap-1.5 rounded bg-blue-50 px-2 py-1 text-[12px] text-blue-800 dark:bg-blue-900/20 dark:text-blue-200"
      data-testid="genome-suggestion"
      title={from.length ? `From ${from.join(', ')}` : undefined}
    >
      <span className="flex-1">
        Suggested from your {from.length > 1 ? 'data' : source}: <span className="font-semibold">{suggestion.genome_id}</span>
      </span>
      {suggestion.can_load && (
        <button
          type="button"
          disabled={loadingGenome !== null}
          onClick={() => {
            setError(null);
            void loadRegistryGenome(suggestion.genome_id).then(res => { if (!res.success) setError(res.error ?? null); });
          }}
          className="rounded px-1.5 py-0.5 text-[11px] font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-50 dark:text-blue-300 dark:hover:bg-blue-900/40"
          data-testid="genome-suggestion-load"
        >
          {busy ? (suggestion.cached ? 'Loading…' : 'Downloading…') : 'Load'}
        </button>
      )}
      {error && <span className="basis-full text-red-500">{error}</span>}
    </div>
  );
}
