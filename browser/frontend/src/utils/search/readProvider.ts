/**
 * Read names as search suggestions (fb-r4-clicks): a read name (or a list of
 * them) typed or pasted into a locus box or the palette is a "Read"
 * suggestion; running it finds the reads, shows them and highlights them
 * (utils/readLocate.ts). Only text shaped like read names is offered
 * (utils/readNames: PacBio, Nanopore, Illumina, SRA, or "read: <name>"), so a
 * gene or a region's name never is.
 */
import { describeReadNames, parseReadNames } from '../readNames';
import { goToReads } from '../readLocate';
import { useBrowserStore } from '../../stores/browserStore';
import { genomeKeyFor, panelGenomeKey } from '../regionNavigation';
import { SEARCH_SCORE, type SearchContext, type SearchProvider } from './providers';

/**
 * A panel's box looks in the datasets on its own reference only (its
 * navigation would otherwise take it to another assembly's coordinates);
 * the main box and the palette look everywhere (the read's own panel shows it).
 */
function datasetScope(ctx: SearchContext): string[] | undefined {
  if (!ctx.navigate) return undefined;
  const s = useBrowserStore.getState();
  const reference = genomeKeyFor(ctx.genome, s);
  return [...new Set(s.panels
    .filter(p => p.contentType === 'dataset' && p.datasetId && panelGenomeKey(p, s) === reference)
    .map(p => p.datasetId!))];
}

export const readNameProvider: SearchProvider = {
  id: 'read-names',
  kind: 'read',
  label: 'Reads',
  order: 40,
  // The palette looks everywhere once: the read's own panel shows it (not one target per reference).
  perReference: false,
  search: (query) => {
    const names = parseReadNames(query);
    if (!names) return [];
    return [{
      id: `read:${names.join(',')}`,
      kind: 'read',
      label: names.length === 1 ? names[0] : `${names.length} reads`,
      detail: names.length === 1
        ? 'Go to this read and highlight it'
        : `Go to ${describeReadNames(names)}, select and highlight them`,
      // A read name's shape is unambiguous: above gene matches.
      score: SEARCH_SCORE.read,
      run: async (ctx) => {
        const res = await goToReads(names, {
          viewport: ctx.viewport,
          navigate: ctx.navigate,
          signal: ctx.signal,
          onProgress: ctx.onProgress,
          datasetIds: datasetScope(ctx),
          target: ctx.target,
        });
        return { ok: res.ok, message: res.message, cancelled: res.cancelled };
      },
    }];
  },
};
