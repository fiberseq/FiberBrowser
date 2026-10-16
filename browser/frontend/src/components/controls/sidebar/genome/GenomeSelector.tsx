import { useEffect, useState } from 'react';
import { getChromosomes, getGenomes, loadGenome, type GenomeInfo } from '../../../../api/reference';
import { getStatus } from '../../../../api/status';
import { useBrowserStore } from '../../../../stores/browserStore';
import { findChromInfo } from '../../../../utils/chromAliases';
import { autoSaveNow } from '../../../../hooks/useAutoSave';
import { genomeLoadHasFasta } from '../../../../utils/genomeAutoload';
import { GenomeSuggestionHint } from './GenomeSuggestionHint';
import { CheckCircle, Circle, X } from '../../../ui/Icons';

/** Compact genome list with load indicators. */
export function GenomeSelector() {
  const [genomes, setGenomes] = useState<GenomeInfo[]>([]);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const currentGenome = useBrowserStore(s => s.currentGenome);
  const setCurrentGenome = useBrowserStore(s => s.setCurrentGenome);
  const setHasFasta = useBrowserStore(s => s.setHasFasta);
  const setFastaPath = useBrowserStore(s => s.setFastaPath);

  useEffect(() => {
    getGenomes()
      .then(res => setGenomes(res.genomes))
      .catch(() => setError('Failed to fetch genomes'));
  }, []);

  const handleLoad = async (genome: GenomeInfo) => {
    setLoading(genome.id);
    setError(null);
    try {
      const res = await loadGenome(genome.id);
      if (res.success) {
        setHasFasta(genomeLoadHasFasta(res));
        // Registry genomes are identified by id; keeping fastaPath null
        // avoids sending reloads through the local-FASTA branch.
        setFastaPath(null);
        setCurrentGenome(genome.id);
        useBrowserStore.getState().triggerRefresh();
        getStatus().then(statusRes => {
          if (statusRes.initial_position) {
            useBrowserStore.getState().setViewport(
              statusRes.initial_position.chrom,
              statusRes.initial_position.start,
              statusRes.initial_position.end,
            );
          } else {
            getChromosomes().then(chromRes => {
              const store = useBrowserStore.getState();
              if (chromRes.chroms.length > 0 && !chromRes.chroms.some((c: { name: string }) => c.name === store.chrom)) {
                // The same contig under this genome's name keeps the view; else the first contig.
                const alias = findChromInfo(chromRes.chroms, store.chrom);
                if (alias) store.setViewport(alias.name, store.start, Math.min(store.end, alias.size));
                else {
                  const first = chromRes.chroms[0];
                  store.setViewport(first.name, 0, Math.min(20000, first.size));
                }
              }
            }).catch(() => {});
          }
        }).catch(() => {});
        setTimeout(() => { void autoSaveNow(); }, 500);
      } else {
        setError(res.fasta_error || res.gtf_error || 'Failed to load genome');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load genome');
    } finally {
      setLoading(null);
    }
  };

  if (genomes.length === 0 && !error) {
    return <div className="text-[11px] text-ink-secondary px-1 animate-pulse">Loading genomes...</div>;
  }

  return (
    <div className="space-y-0.5" data-tour="genome-selector">
      <GenomeSuggestionHint />
      {genomes.map(genome => (
        <button
          key={genome.id}
          onClick={() => handleLoad(genome)}
          disabled={loading !== null}
          className="w-full text-left px-2 py-1 text-[12px] text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/5 rounded disabled:opacity-50 flex items-center gap-1.5"
          title={genome.gtf_label ? `Gene annotations: ${genome.gtf_label}` : undefined}
        >
          <span className={currentGenome === genome.id ? 'text-green-500' : 'text-gray-300 dark:text-gray-600'}>
            {currentGenome === genome.id ? <CheckCircle size={12} aria-label="Current genome" /> : <Circle size={12} aria-hidden="true" />}
          </span>
          <span className="flex-1">{genome.name}</span>
          {loading === genome.id && (
            <span className="text-[11px] text-blue-500 animate-pulse">loading...</span>
          )}
        </button>
      ))}
      {error && (
        <div className="text-red-500 text-[11px] px-1">
          {error}
          <button onClick={() => setError(null)} className="ml-1 inline-flex align-[-2px] text-gray-500 hover:text-gray-700" aria-label="Dismiss"><X size={11} /></button>
        </div>
      )}
    </div>
  );
}
