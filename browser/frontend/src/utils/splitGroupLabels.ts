/**
 * What a split set is called in its header strip ("Split: INS 9.2 kb · 2 panels · ×", usability audit SV-7), shown
 * when more than one split set is open. Plugin packs (the SV split) can name their sets; otherwise the set's locus
 * label (what it was split for), else the group part its panels share.
 */
import type { PanelConfig } from '../types';

type SplitGroupLabeller = (groupId: string, panels: PanelConfig[]) => string | null | undefined;
const labellers: SplitGroupLabeller[] = [];

/** First non-null wins. */
export function registerSplitGroupLabel(labeller: SplitGroupLabeller): void {
  labellers.push(labeller);
}

export function splitGroupLabel(groupId: string, panels: PanelConfig[]): string {
  for (const labeller of labellers) {
    const label = labeller(groupId, panels);
    if (label) return label;
  }
  const subset = panels.find(p => p.readSubset)?.readSubset;
  if (subset?.locus?.label) return subset.locus.label;
  // "INS 400 bp @ chrSV:14,001 · Carriers" → "INS 400 bp @ chrSV:14,001" (the part the set's panels share).
  const labels = panels.map(p => p.readSubset?.label ?? '').filter(Boolean);
  if (labels.length) {
    const parts = labels.map(l => l.split(' · '));
    const shared: string[] = [];
    for (let i = 0; i < parts[0].length - 1; i++) {
      if (parts.every(p => p[i] === parts[0][i])) shared.push(parts[0][i]); else break;
    }
    if (shared.length) return shared.join(' · ');
  }
  return 'split';
}
