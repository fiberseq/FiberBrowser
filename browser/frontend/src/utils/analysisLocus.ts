import type { PanelConfig } from '../types';
import { sameChrom } from './chromAliases';
import { formatCoordinates } from './coordinates';

/**
 * The region an analysis of the targeted panels runs on (fb-r2-integ).
 *
 * A panel shows the main view, or a locus of its own: a copy at another
 * locus, "Each panel navigates", or its dataset's own reference (another
 * assembly). An analysis that takes one region (footprint classes,
 * co-occupancy, transcription states) takes it from the panels it targets,
 * never silently from the main view; when they show different regions the
 * user chooses one.
 */
export interface AnalysisLocus {
  chrom: string;
  start: number;
  end: number;
  /** The panels' reference (PanelConfig.genome); null: the main genome. */
  genome: string | null;
  /** Datasets and state keys of the targeted panels showing it, in panel order. */
  datasetIds: string[];
  stateKeys: string[];
  panelIds: string[];
}

interface LocusState {
  panels: PanelConfig[];
  chrom: string;
  start: number;
  end: number;
}

export const locusKey = (l: { chrom: string; start: number; end: number; genome?: string | null }): string =>
  `${l.genome ?? ''}|${l.chrom}:${l.start}-${l.end}`;

export const sameLocus = (a: { chrom: string; start: number; end: number; genome?: string | null },
  b: { chrom: string; start: number; end: number; genome?: string | null }): boolean =>
  (a.genome ?? null) === (b.genome ?? null) && sameChrom(a.chrom, b.chrom) && a.start === b.start && a.end === b.end;

/** Where a panel is: its own locus, else the main view (on the main genome). */
export function panelLocus(panel: PanelConfig, main: { chrom: string; start: number; end: number }) {
  const v = panel.viewportOverride;
  return { chrom: v?.chrom ?? main.chrom, start: v?.start ?? main.start, end: v?.end ?? main.end, genome: panel.genome ?? null };
}


/**
 * The distinct regions the targeted panels show, in panel order. `stateKeys`:
 * the targeted panels' state keys; `extraDatasetIds`: datasets chosen by hand
 * (all their panels count). Minimized and folded panels count too: their
 * datasets are in the analysis request all the same. None: the main view.
 */
export function analysisLoci(st: LocusState, stateKeys: string[], extraDatasetIds: string[] = []): AnalysisLocus[] {
  const keys = new Set(stateKeys);
  const extra = new Set(extraDatasetIds);
  const main = { chrom: st.chrom, start: st.start, end: st.end };
  const byKey = new Map<string, AnalysisLocus>();
  for (const p of st.panels.filter(x => x.contentType === 'dataset' && x.datasetId)) {
    const sk = p.stateKey ?? p.datasetId!;
    if (!keys.has(sk) && !extra.has(p.datasetId!)) continue;
    const at = panelLocus(p, main);
    const key = locusKey(at);
    const locus = byKey.get(key) ?? { ...at, datasetIds: [], stateKeys: [], panelIds: [] };
    locus.panelIds.push(p.id);
    if (!locus.datasetIds.includes(p.datasetId!)) locus.datasetIds.push(p.datasetId!);
    if (!locus.stateKeys.includes(sk)) locus.stateKeys.push(sk);
    byKey.set(key, locus);
  }
  if (byKey.size === 0) return [{ ...main, genome: null, datasetIds: [], stateKeys: [], panelIds: [] }];
  return [...byKey.values()];
}

/** State keys of the dataset panels showing this locus (where an analysis of it puts its results). */
export function stateKeysAtLocus(st: Pick<LocusState, 'panels' | 'chrom' | 'start' | 'end'>,
  locus: { chrom: string; start: number; end: number; genome?: string | null }): string[] {
  const main = { chrom: st.chrom, start: st.start, end: st.end };
  const out: string[] = [];
  for (const p of st.panels) {
    if (p.contentType !== 'dataset' || !p.datasetId) continue;
    if (!sameLocus(panelLocus(p, main), locus)) continue;
    const sk = p.stateKey ?? p.datasetId;
    if (!out.includes(sk)) out.push(sk);
  }
  return out;
}

/** "dm6 chr2L:1,000-2,000 · fly" for a region choice. */
export function analysisLocusLabel(locus: AnalysisLocus, referenceLabel: (key: string) => string,
  datasetLabel: (id: string) => string): string {
  const where = formatCoordinates(locus.chrom, locus.start, locus.end);
  const ref = locus.genome ? `${referenceLabel(locus.genome)} ` : '';
  const who = locus.datasetIds.map(datasetLabel).join(', ');
  return `${ref}${where}${who ? ` · ${who}` : ''}`;
}
