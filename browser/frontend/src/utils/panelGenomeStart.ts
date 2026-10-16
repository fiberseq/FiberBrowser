/**
 * Where a panel on a dataset's own reference starts when it has no locus on
 * that reference yet: a window opened after "Open with dm6 in its own panel"
 * (a fresh browser profile) put the dm6 panels at the first chromosome's
 * 0-10,000, with no reads (audit L12). The server remembers each dataset's
 * best-covered window from when it was given the reference
 * (GET /api/panel_genomes `loci`).
 *
 * Only panels not yet on their reference get one: a locus passed for a panel
 * already there would move it (panelsForGenomes opens a dataset given a
 * reference again at its new locus).
 */
import type { PanelConfig } from '../types';
import type { Locus } from './panelNavigation';

export function startLociForPanels(
  panels: PanelConfig[],
  assignments: Record<string, string>,
  loci: Record<string, Locus>,
  hasChrom: (genome: string, chrom: string) => boolean,
): Record<string, Locus> {
  const out: Record<string, Locus> = {};
  for (const [datasetId, locus] of Object.entries(loci)) {
    const want = assignments[datasetId];
    if (!want || !locus || !hasChrom(want, locus.chrom)) continue;
    const mine = panels.filter(p => p.datasetId === datasetId);
    if (mine.length === 0) continue;
    const placed = mine.some(p => p.genome === want && !!p.viewportOverride && hasChrom(want, p.viewportOverride.chrom));
    if (!placed) out[datasetId] = { chrom: locus.chrom, start: locus.start, end: locus.end };
  }
  return out;
}
