/**
 * Pasted DNA in a locus box (or the command palette) offers "Find this sequence in the genome": running it opens
 * the Find sequence panel with the sequence and starts the search there (its progress, Cancel and hits live in the
 * panel). Only text shaped like DNA is offered (model.looksLikeSequence: 12+ bases of A/C/G/T and IUPAC codes),
 * so coordinates, gene names and read names never are. It searches the main genome; a panel's own box on another
 * assembly does not offer it.
 */
import { isPublicServerPage } from '../../utils/publicServerFlag';
import { SEARCH_SCORE, type SearchProvider } from '../../utils/search/providers';
import { looksLikeSequence, parseSequence } from './model';
import { openSequenceSearch } from './store';

export const SEQUENCE_SUGGESTION_SCORE = SEARCH_SCORE.strong + 100;

export const sequenceSearchProvider: SearchProvider = {
  id: 'sequence-search',
  kind: 'sequence',
  label: 'Sequence',
  order: 50,
  perReference: false,
  mightAnswer: (query) => looksLikeSequence(query),
  search: (query, ctx) => {
    if (isPublicServerPage() || !looksLikeSequence(query) || ctx.genome) return [];
    const parsed = parseSequence(query, 1);
    if (!parsed.ok) return [];
    return [{
      id: `sequence:${parsed.seq.slice(0, 40)}:${parsed.seq.length}`,
      kind: 'sequence',
      label: 'Find this sequence in the genome',
      detail: `${parsed.seq.length.toLocaleString()} bases: ${parsed.seq.slice(0, 24)}${parsed.seq.length > 24 ? '…' : ''}`,
      // Strong (Enter runs it), below an exact gene or region name and coordinates.
      score: SEQUENCE_SUGGESTION_SCORE,
      run: () => {
        openSequenceSearch(query, true);
        // No line under the locus box (it would cover the toolbar): the panel shows the progress and the hits.
        return { ok: true };
      },
    }];
  },
};
