/**
 * NFR pairs (preview): one selection for the panel's arcs and matrix and the NFR track over the reads. The selected
 * element (an element of the shown run, or an NFR, 'N1') is the store's `focus`: its arcs only, in every view. A click
 * on a second element asks for the pair (the store's `pairRequest`: the panel inspects it), a click on the selected
 * one deselects it. An element inside the selected NFR (or the NFR of a selected variant) replaces the selection.
 */
import { useAccessibilityStore } from './accessibilityStore';
import { membersOf } from './nfrPairsLayout';

export type PickOutcome = 'selected' | 'cleared' | 'pair';

export function pickElement(id: string): PickOutcome {
  const s = useAccessibilityStore.getState();
  const current = s.focus;
  if (current === id) { s.setFilter({ focus: null }); return 'cleared'; }
  if (current && s.jobId && s.result) {
    const A = membersOf(s.result, current), B = membersOf(s.result, id);
    const nested = A.length > 0 && B.length > 0 && (B.every(x => A.includes(x)) || A.every(x => B.includes(x)));
    if (A.length && B.length && !nested) { s.requestPair(s.jobId, current, id); return 'pair'; }
  }
  s.setFilter({ focus: id });
  return 'selected';
}
