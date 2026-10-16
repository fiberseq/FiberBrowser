import type { RegionEntry } from '../types/regions';
import { sameChrom } from './chromAliases';

/**
 * Which region "Find classes" analyses (fb-n5-classregion), said plainly in
 * its card ("Analyses: chr19:47,518,060–47,518,500 · 440 bp · the selected
 * peak") and outlined on the targeted panels.
 *
 * - 'peaks':  the selected peak(s), first start to last end (none selected: this view);
 * - 'view':   what the targeted panels show (their own locus or reference when they have one);
 * - 'region': the saved region (Regions) at this locus (none there: this view).
 *
 * Coordinates typed by hand in the card's Advanced settings, a region chosen
 * among panels at different loci, or a restored run are a fourth source,
 * 'custom' / that run's own, held by the card until the choice changes.
 * Nothing is padded: the request is exactly the region shown.
 */
export type ClassRegionMode = 'peaks' | 'view' | 'region' | 'matched';
export type ClassRegionSource = ClassRegionMode | 'custom';

/**
 * The choice a new session starts with. The shipped behaviour (3.0) is the
 * targeted panels' view; the selected peaks are used only when chosen. Switch
 * here once the region-length investigation (fh-napa-sens) settles the default.
 */
export const DEFAULT_CLASS_REGION_MODE: ClassRegionMode = 'view';

export const CLASS_REGION_MODES: readonly ClassRegionMode[] = ['peaks', 'view', 'region', 'matched'];
export const isClassRegionMode = (v: unknown): v is ClassRegionMode => CLASS_REGION_MODES.includes(v as ClassRegionMode);

export const CLASS_REGION_CHOICE_LABEL: Record<ClassRegionMode, string> = {
  matched: 'Selected matched regions',
  peaks: 'Selected peaks',
  view: 'This view',
  region: 'Saved region',
};

/** A region of one reference (genome null: the main genome); 0-based, end-exclusive. */
export interface ClassRange {
  chrom: string;
  start: number;
  end: number;
  genome: string | null;
}

export interface ResolvedClassRegion {
  range: ClassRange;
  source: ClassRegionSource;
  /** What it is, in words: "the selected peak", "this view", "saved region NAPA"... */
  what: string;
  /** The choice could not be honoured here and the view is used instead: why. */
  fallback: string | null;
}

/**
 * The region a run would analyse. `pinned` (typed coordinates, a region
 * chosen among panels, a restored run) wins; otherwise the mode, falling back
 * to the view (and saying so) when there is no peak or saved region here.
 * Null: nothing to analyse yet (no view).
 */
export function resolveClassRegion(opts: {
  mode: ClassRegionMode;
  view: ClassRange | null;
  /** Words for the view ("this view", or "the view of napa_ddda" for one of several panels). */
  viewWhat?: string;
  peaks: ClassRange | null;
  peakCount: number;
  /** The selected peaks are on several chromosomes or references (no single span). */
  peaksSplit?: boolean;
  saved: { range: ClassRange; label: string } | null;
  pinned: { range: ClassRange; source: ClassRegionSource; what: string } | null;
}): ResolvedClassRegion | null {
  const { mode, view, peaks, saved, pinned } = opts;
  if (mode === 'matched' && !pinned) return null;
  if (pinned) return { ...pinned, fallback: null };
  const viewWhat = opts.viewWhat ?? 'this view';
  if (mode === 'peaks' && peaks) {
    return { range: peaks, source: 'peaks', what: opts.peakCount === 1 ? 'the selected peak' : `the ${opts.peakCount} selected peaks`, fallback: null };
  }
  if (mode === 'region' && saved) {
    return { range: saved.range, source: 'region', what: `saved region ${saved.label}`, fallback: null };
  }
  if (!view) return null;
  const fallback = mode === 'peaks'
    ? (opts.peaksSplit ? 'the selected peaks are on different chromosomes or references' : 'no peak selected')
    : mode === 'region' ? 'no saved region here' : null;
  return { range: view, source: 'view', what: viewWhat, fallback };
}

/** "chr19:47,518,060–47,518,500 · 440 bp" (the coordinates as the request sends them). */
export function classRegionCoordinates(r: { chrom: string; start: number; end: number }): string {
  return `${r.chrom}:${r.start.toLocaleString()}–${r.end.toLocaleString()} · ${Math.max(0, r.end - r.start).toLocaleString()} bp`;
}

/** "chr19:47,518,060–47,518,500 · 440 bp · the selected peak". */
export function classRegionLine(r: { chrom: string; start: number; end: number }, what?: string | null, reference?: string | null): string {
  return `${reference ? `${reference} ` : ''}${classRegionCoordinates(r)}${what ? ` · ${what}` : ''}`;
}

/** Discovery tile width when the run's settings don't say (FiberHMM recaller.tile_bp default). */
export const DEFAULT_DISCOVERY_TILE_BP = 350;

/**
 * Below this a region is short for class discovery: two discovery tiles (the
 * recaller discovers in tiles of `tile_bp`, and a class near an edge needs
 * its scoring flank inside the region), so classes near its edges may be missed.
 */
export function shortClassRegionBp(tileBp: number | null | undefined): number {
  const tile = Number(tileBp);
  return 2 * (Number.isFinite(tile) && tile > 0 ? tile : DEFAULT_DISCOVERY_TILE_BP);
}

/**
 * The saved region at this locus: of the regions on the view's reference and
 * chromosome that overlap it, the one overlapping it most (then the smaller).
 */
export function savedRegionAt(entries: RegionEntry[], view: { chrom: string; start: number; end: number }): RegionEntry | null {
  let best: RegionEntry | null = null;
  let bestOverlap = 0;
  for (const e of entries) {
    if (!sameChrom(e.chrom, view.chrom) || !(e.end > e.start)) continue;
    const overlap = Math.min(e.end, view.end) - Math.max(e.start, view.start);
    if (overlap <= 0) continue;
    if (overlap > bestOverlap || (overlap === bestOverlap && best && e.end - e.start < best.end - best.start)) {
      best = e;
      bestOverlap = overlap;
    }
  }
  return best;
}

/** Words for a run's recorded region source (the request's `region_source`). */
export function regionSourceWords(source: unknown, count?: number): string | null {
  switch (source) {
    case 'matched': return 'selected matched regions';
    case 'peaks': return count && count > 1 ? `the ${count} selected peaks` : 'the selected peak';
    case 'view': return 'the view';
    case 'region': return 'a saved region';
    case 'custom': return 'coordinates set by hand';
    default: return typeof source === 'string' && source ? source : null;
  }
}
