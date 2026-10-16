import { useEffect, useState } from 'react';
import { confirmPlasmidLink, getChromosomes, getPlasmidLinks, type PlasmidLink, type PlasmidProblem } from '../../api/reference';
import { useBrowserStore } from '../../stores/browserStore';
import { isPublicMode } from '../../utils/publicMode';
import { plasmidLinkSummary } from '../../utils/plasmidLoader';

interface Props {
  /** The plasmid chromosome shown. */
  chrom: string;
}

/**
 * Which BAMs' reads are on this plasmid (a contig matched to the map by
 * sequence, possibly renamed or rotated), and the plasmid BAMs that did not
 * match, with what differs. A same-length contig that could not be checked
 * can be linked anyway.
 */
export function PlasmidLinksList({ chrom }: Props) {
  const datasets = useBrowserStore(s => s.datasets);
  const [links, setLinks] = useState<PlasmidLink[]>([]);
  const [problems, setProblems] = useState<PlasmidProblem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (!chrom || isPublicMode()) return;
    const controller = new AbortController();
    getPlasmidLinks(chrom, { signal: controller.signal })
      .then(result => {
        setLinks(result.links ?? []);
        setProblems(result.problems ?? []);
      })
      .catch(err => {
        if ((err as { name?: string })?.name !== 'AbortError') {
          setLinks([]);
          setProblems([]);
        }
      });
    return () => controller.abort();
  }, [chrom, datasets, generation]);

  const linkAnyway = async (problem: PlasmidProblem) => {
    if (!problem.dataset_id || !problem.contig) return;
    const key = `${problem.dataset_id}:${problem.contig}`;
    setBusy(key);
    setError(null);
    try {
      const result = await confirmPlasmidLink(problem.chrom || chrom, problem.dataset_id, problem.contig, problem.suggested_offset ?? 0);
      if (!result.success) {
        setError(result.error || 'Could not link it');
        return;
      }
      const store = useBrowserStore.getState();
      store.setChroms((await getChromosomes()).chroms);
      store.triggerRefresh();
      setGeneration(g => g + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not link it');
    } finally {
      setBusy(null);
    }
  };

  if (links.length === 0 && problems.length === 0 && !error) return null;
  return (
    <div className="space-y-1 rounded border border-teal-200 bg-teal-50/50 px-2 py-1.5 text-[11px] dark:border-teal-800/50 dark:bg-teal-900/10" data-testid="plasmid-links">
      {links.length > 0 && (
        <div className="space-y-0.5">
          <div className="font-medium text-teal-900 dark:text-teal-200">Reads on this plasmid</div>
          {links.map(link => (
            <div key={`${link.dataset_id}:${link.contig}`} className="truncate text-gray-700 dark:text-gray-300" title={link.detail || plasmidLinkSummary(link)}>
              {plasmidLinkSummary(link)}
            </div>
          ))}
        </div>
      )}
      {problems.map(problem => {
        const key = `${problem.dataset_id}:${problem.contig}:${problem.kind}`;
        return (
          <div key={key} className="text-amber-800 dark:text-amber-300">
            <span className="font-medium">{problem.dataset_label || problem.dataset_id}: </span>
            {problem.message}
            {problem.can_confirm && problem.contig && (
              <button
                type="button"
                className="ml-1 rounded border border-amber-400 px-1 text-[11px] hover:bg-amber-100 disabled:opacity-50 dark:hover:bg-amber-900/30"
                disabled={busy === `${problem.dataset_id}:${problem.contig}`}
                onClick={() => { void linkAnyway(problem); }}
                title={`Show ${problem.contig}'s reads on this map${problem.suggested_offset ? ` (origin shifted ${problem.suggested_offset} bp)` : ''}`}
              >
                Link anyway
              </button>
            )}
          </div>
        );
      })}
      {error && <div className="text-red-600 dark:text-red-400">{error}</div>}
    </div>
  );
}
