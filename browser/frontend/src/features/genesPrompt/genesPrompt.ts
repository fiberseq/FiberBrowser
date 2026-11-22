/**
 * "No genes loaded for dm6 · Load dm6 genes": when the reference has no gene annotation, the main view says so and
 * offers the one click that loads it, instead of leaving it to Reference & Tracks.
 *
 * - A catalog (online) genome, or the genome the data points to: its annotation through the one-step loader
 *   (utils/annotationReset; the download-warning size asks first). Shown only where that loader may run
 *   (services/genome_check ``can_reset``: not on a public server or in a tour tab).
 * - A local FASTA with no known annotation: "Load a GTF…" through the upload path (a browser file input, never a
 *   native dialog), not on a public server or in a tour tab.
 *
 * The Genes track shows it in place; when no main-genome Genes track is shown, a small dismissible notice under the
 * genome banner does (dismissed per genome, in browser storage when it is available).
 */
import type { GenomeCheckResponse } from '../../api/genomeCheck';
import type { PanelConfig } from '../../types';

export type GenesPrompt =
  | { kind: 'download'; key: string; genomeId: string; name: string; cached: boolean }
  | { kind: 'upload'; key: string; label: string };

export function genesPromptFor(check: GenomeCheckResponse | null | undefined,
  env: { publicMode: boolean; sandbox: boolean }): GenesPrompt | null {
  const annotation = check?.annotation;
  if (!check || !annotation || annotation.loaded) return null;
  const target = annotation.target;
  if (target) {
    return annotation.can_reset
      ? { kind: 'download', key: `genome:${target.genome_id}`, genomeId: target.genome_id, name: target.name, cached: target.cached }
      : null;
  }
  if (env.publicMode || env.sandbox) return null;
  if (check.reference?.kind === 'fasta') {
    const label = check.reference.label || check.reference.assembly || 'this reference';
    return { kind: 'upload', key: `fasta:${label}`, label };
  }
  return null;
}

/** Whether some shown dataset panel draws the main genome's Genes track (a panel on its own genome draws that one's).
 *  As TrackContainer lays them out: a maximized panel hides the others, and a collapsed layout row hides its panels. */
export function mainGenesTrackShown(panels: PanelConfig[],
  layout: { collapsedRows?: ReadonlySet<number> | null; fullViewPanelId?: string | null } = {}): boolean {
  const full = layout.fullViewPanelId && panels.some(p => p.id === layout.fullViewPanelId) ? layout.fullViewPanelId : null;
  return panels.some(p => p.contentType === 'dataset' && !p.genome
    && (full ? p.id === full : !p.collapsed && !layout.collapsedRows?.has(p.layoutRow ?? 0))
    && (p.subTracks ?? []).some(st => st.type === 'gene' && st.visible && !st.removed));
}

const DISMISS_PREFIX = 'fiberbrowser.genesPrompt.dismissed.';

/** Dismissed for this genome in this browser (no storage: never dismissed, so the notice keeps showing). */
export function genesNoticeDismissed(key: string): boolean {
  try {
    return window.localStorage.getItem(DISMISS_PREFIX + key) === '1';
  } catch {
    return false;
  }
}

export function dismissGenesNotice(key: string): void {
  try {
    window.localStorage.setItem(DISMISS_PREFIX + key, '1');
  } catch {
    /* no storage: the notice shows again next time */
  }
}
