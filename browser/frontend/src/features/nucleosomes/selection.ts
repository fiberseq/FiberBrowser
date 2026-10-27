/**
 * Selection from the nucleosome panel (DESIGN §6.1): a click on a size class, an NRL bin, a segment state or an event
 * highlights the observation's molecules that have it in every read track (the steady highlight of "Highlight read
 * in all panels"). The server names them by the observation's own row identities (record keys for lifted rows) and by
 * QNAME, so native panels, lifted panels and graph pop-outs (which sync by QNAME) all show the same molecules.
 */
import { useReadActionsStore } from '../../stores/readActionsStore';
import { nucSelect, type NucCategory } from './api';
import type { NucObservation } from './types';

export async function highlightCategory(observation: NucObservation, category: NucCategory, includeDuplicates = false): Promise<number> {
  const res = await nucSelect(observation, category, includeDuplicates);
  const ids = [...new Set([...res.readIds, ...res.qnames])];
  if (ids.length) useReadActionsStore.getState().highlightReads(ids);
  else useReadActionsStore.getState().clearHighlight();
  return res.qnames.length;
}

export function categoryLabel(category: NucCategory): string {
  if (category.kind === 'coarse') return `${category.name.replace('_', ' ')} footprints`;
  if (category.kind === 'nrl') return `NRL ${category.lo}–${category.hi} bp`;
  if (category.kind === 'segment') return `${category.state.replace('_', ' ')} segments`;
  return category.name === 'missing' ? 'missing nucleosomes' : 'undersized runs';
}
