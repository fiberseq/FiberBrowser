import type { PanelConfig } from '../types';
import { isPanOrZoom } from '../stores/siteLock';
import type { Locus } from './panelNavigation';
import { mainReferenceIdentity } from './search/navigationIntent';

/**
 * Where an analysis request's panels were when it was sent (fb-n4-integ).
 *
 * Clustering and Sort read the reads of each target panel's own view (its
 * locus and reference). In "Each panel navigates" the main locus stops
 * moving, so checking it when the answer comes back says nothing about the
 * panels: a panel moved to another locus (which clears its clusters) would
 * get the old locus's result. Take `captureRunViews` before the request, and
 * apply the answer only while `runViewsStillCurrent`: every panel still
 * exists, has the same state key, is on the same reference and shows the same
 * locus (`exact`), or one a pan or zoom away (`panOrZoom`: what navigation
 * itself treats as staying put, so it keeps the panel's clusters).
 */

type ViewState = {
  panels: PanelConfig[];
  chrom: string;
  start: number;
  end: number;
  currentGenome?: string | null;
  fastaPath?: string | null;
};

export interface RunView extends Locus {
  /** The panel (null: a state key without a panel, read at the main locus). */
  panelId: string | null;
  stateKey: string;
  /** The panel's reference, exactly (a panel's own, else the main genome's registry id / FASTA). */
  reference: string;
}

const isDataset = (p: PanelConfig) => p.contentType === 'dataset' && !!p.datasetId;
const keyOf = (p: PanelConfig) => p.stateKey ?? p.datasetId!;
const referenceOf = (p: PanelConfig | null, s: ViewState) =>
  (p?.genome ? `panel:${p.genome}` : mainReferenceIdentity(s as never));
const locusOf = (p: PanelConfig | null, s: ViewState): Locus => {
  const v = p?.viewportOverride;
  return v ? { chrom: v.chrom, start: v.start, end: v.end } : { chrom: s.chrom, start: s.start, end: s.end };
};

/** The views of every dataset panel of these state keys (a key without a panel: the main locus). */
export function captureRunViews(s: ViewState, stateKeys: Iterable<string>): RunView[] {
  const out: RunView[] = [];
  for (const stateKey of new Set(stateKeys)) {
    const panels = s.panels.filter(p => isDataset(p) && keyOf(p) === stateKey);
    if (panels.length === 0) {
      out.push({ ...locusOf(null, s), panelId: null, stateKey, reference: referenceOf(null, s) });
      continue;
    }
    for (const p of panels) out.push({ ...locusOf(p, s), panelId: p.id, stateKey, reference: referenceOf(p, s) });
  }
  return out;
}

/** Every captured panel still shows its view (see the module comment for `mode`). */
export function runViewsStillCurrent(views: RunView[], s: ViewState, mode: 'exact' | 'panOrZoom' = 'exact'): boolean {
  return views.every(view => {
    const panel = view.panelId ? s.panels.find(p => p.id === view.panelId) ?? null : null;
    if (view.panelId && (!panel || !isDataset(panel) || keyOf(panel) !== view.stateKey)) return false;
    if (referenceOf(panel, s) !== view.reference) return false;
    const now = locusOf(panel, s);
    if (mode === 'panOrZoom') return isPanOrZoom(view, now);
    return now.chrom === view.chrom && now.start === view.start && now.end === view.end;
  });
}

/**
 * The locus a clustering request names. On the main genome: the main locus
 * (each window still goes with its own). On a panel's own reference: the first
 * window's (the main locus is a chromosome of another assembly there).
 */
export function clusterRequestLocus(
  main: Locus,
  windows: Array<Locus>,
  runGenome: string | null | undefined,
): Locus {
  const first = windows[0];
  return runGenome && first ? { chrom: first.chrom, start: first.start, end: first.end } : { ...main };
}
