/**
 * A difference in its haplotype's source view: the linked source panel (P3) jumps to it without moving the main
 * view; without one, the difference-anchored source view opens (sourceView.ts).
 */
import type { DifferenceSelection } from '../../differences/selectionStore';
import { useBrowserStore } from '../../../stores/browserStore';
import { useLiveLiftStore } from '../store';
import { jumpLinkedSource, linkedSourcePanels } from './liftLink';

export function jumpLinkedSourcesTo(datasetId: string, hap: string | undefined, src: { contig: string | null; start: number | null; end: number | null } | undefined): boolean {
  if (!src?.contig || src.start == null || src.end == null) return false;
  let moved = false;
  for (const panel of linkedSourcePanels(datasetId, hap || null)) moved = jumpLinkedSource(panel.id, { contig: src.contig, start: src.start, end: src.end }) || moved;
  return moved;
}

export async function showInSourceView(s: DifferenceSelection): Promise<void> {
  // A difference shared by both parents ("MAT+PAT") jumps each parent's linked panel to its own allele.
  const alleles = (s.difference as { alleles?: Array<{ hap_label: string; src?: typeof s.difference.src }> }).alleles;
  const own = alleles?.length ? alleles : [{ hap_label: s.difference.hap_label, src: s.difference.src }];
  let moved = false;
  for (const a of own) moved = jumpLinkedSourcesTo(s.datasetId, a.hap_label, a.src) || moved;
  if (moved) return;
  const { openSourceView } = await import('../sourceView');
  await openSourceView(s);
}

/**
 * An insertion expanded in a lifted panel's view shows its inserted bases in that haplotype's linked source panel
 * (the plain click on an insertion expands it; P3's insertion jump follows the expansion).
 */
const expansionKeys = (expansions: Record<string, Array<{ ins_id: string }>> | undefined) =>
  new Set(Object.entries(expansions ?? {}).flatMap(([view, list]) => list.map(e => `${view}|${e.ins_id}`)));

export function followExpansions(): void {
  let seen = expansionKeys(useBrowserStore.getState().liveLiftExpansions);
  useBrowserStore.subscribe((state, previous) => {
    if (state.liveLiftExpansions === previous.liveLiftExpansions) return;
    // A restore (session, undo) brings expansions and panels back together: the saved source views stay as saved.
    const restoring = state.panels !== previous.panels;
    const now = new Set<string>();
    for (const [view, list] of Object.entries(state.liveLiftExpansions ?? {})) {
      for (const e of list) {
        const key = `${view}|${e.ins_id}`;
        now.add(key);
        if (restoring || seen.has(key) || !useLiveLiftStore.getState().enabled || !e.datasetId) continue;
        const own = e.alleles?.length ? e.alleles : [{ hap_label: e.hap_label, src: e.src }];
        for (const allele of own) jumpLinkedSourcesTo(e.datasetId, allele.hap_label, allele.src);
      }
    }
    seen = now;
  });
}
