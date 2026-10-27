/**
 * Hub hits in other frames (feature hub G1; DESIGN §5.4): where a hit is on this genome, what its lift status and
 * graph columns say, in words, and how a comparison column's path covers it.
 *
 * - A hit in this genome's coordinates (linear, or a live-lift row frame) is where it says.
 * - A source-frame hit (a scan of a live-lift dataset's own assembly) keeps its source coordinates; it is placed by
 *   its lift (exact / split / partial), or, inside an insertion relative to this genome, at the insertion's junction.
 *   An unmapped hit off the map has no place here.
 * - Graph columns say which package paths carry the hit's sequence. A path that doesn't (an insertion only MAT and
 *   PAT carry, seen from GRCh38) is **absent** there: the hub shows "absent", never "not scanned".
 */
import type { Frame, GraphAlias, HitLiftInfo, PathStatus, TargetSpan } from './types';

export interface Placeable {
  chrom: string; start: number; end: number; anchor: number;
  frame?: Frame; target?: TargetSpan;
}

/** A hit with its lift (the hub's rows). */
export interface Lifted extends Placeable { lift?: HitLiftInfo; source?: { chrom: string; start: number; end: number } }

/** Whether a hit's own coordinates are this genome's. */
export const inThisGenome = (h: { frame?: Frame }) => !h.frame || h.frame.kind === 'linear' || h.frame.kind === 'lifted';

/** Where the hit is on this genome, or null (another assembly's coordinates that don't lift here). */
export function displaySpan(h: Placeable): TargetSpan | null {
  if (inThisGenome(h)) return { chrom: h.chrom, start: h.start, end: h.end, anchor: h.anchor };
  return h.target ?? null;
}

const where = (n: number) => (n + 1).toLocaleString('en-US');
// 1-based, as the hub's locus column: an interval; a boundary is named by the base after it (the column's "⋮").
const span = (chrom: string, a: number, b: number) => (b > a ? `${chrom}:${where(a)}-${b.toLocaleString('en-US')}` : `before ${chrom}:${where(a)}`);

/** A short chip for the lift status ('' for hits in this genome). */
export function liftChip(h: Lifted): { text: string; tone: 'ok' | 'warn' | 'muted' } | null {
  if (inThisGenome(h) || !h.lift) return null;
  const s = h.lift.status;
  if (s === 'exact') return { text: 'lifted', tone: 'ok' };
  if (s === 'split') return { text: 'lifted · split', tone: 'warn' };
  if (s === 'partial') return { text: 'lifted · partial', tone: 'warn' };
  return { text: h.target?.insertion ? 'in insertion' : 'unmapped', tone: 'muted' };
}

/** What the lift did, in words (hover and row detail). */
export function liftText(h: Lifted): string {
  if (inThisGenome(h) || !h.lift) return '';
  const lift = h.lift;
  const hap = h.frame?.kind === 'source' ? (h.frame.hapLabel ?? h.frame.hap ?? '') : '';
  const src = h.source ?? h;
  const from = `${hap ? `${hap} ` : ''}${span(src.chrom, src.start, src.end)}`;
  switch (lift.status) {
    case 'exact': return `Lifted from ${from} to ${span(lift.chrom ?? '', lift.start ?? 0, lift.end ?? 0)}: one placement, every base projected${lift.flipped ? ' (through a − chain)' : ''}.`;
    case 'split': return `Lifted from ${from}: its bases land in ${lift.placements ?? 2} placements; the one with the most bases is kept, ${span(lift.chrom ?? '', lift.start ?? 0, lift.end ?? 0)}.`;
    case 'partial': return `Lifted from ${from} to ${span(lift.chrom ?? '', lift.start ?? 0, lift.end ?? 0)}: some bases have no place on this genome (an insertion or gap inside the hit).`;
    default:
      if (h.target?.insertion) {
        const t = h.target;
        const at = t.end > t.start ? `between ${t.chrom}:${t.start.toLocaleString('en-US')} and ${where(t.end)}` : span(t.chrom, t.start, t.end);
        return `${from} is inside an insertion this genome lacks: it sits at the junction ${at}. Graph mode draws it on the inserted sequence.`;
      }
      return `${from} does not lift onto this genome (${(lift.reason ?? 'not lifted').replace(/_/g, ' ')}).`;
  }
}

const STATUS_WORD: Record<PathStatus, string> = { carried: 'carries it', partial: 'carries part of it', absent: 'absent (lacks this sequence)', unresolved: 'unresolved' };

/** Every path's status, in words. */
export function graphText(g: GraphAlias | undefined): string {
  if (!g) return '';
  const paths = Object.entries(g.paths).map(([, p]) => `${p.hap ?? p.label}: ${STATUS_WORD[p.status]}${p.status === 'partial' ? ` (${p.carried} of ${p.total} bp)` : ''}`);
  return `Graph: ${g.size.toLocaleString('en-US')} bp on ${g.columns.length} node run${g.columns.length === 1 ? '' : 's'}. ${paths.join('; ')}.`;
}

/**
 * How a comparison column's path covers a hit: the graph path holding that column's reads (a native dataset on the
 * target, a live-lift dataset's haplotype path), or undefined (no graph columns, or the column isn't on a path).
 * `column`: the hub's column key ('ds:<id>', 'ds:<id>:<HAP>', 'hap:<HAP>', …) with its dataset and haplotype.
 */
export function columnPathStatus(g: GraphAlias | undefined, column: { datasetId?: string; hap?: string }): PathStatus | undefined {
  if (!g || !column.datasetId) return undefined;
  const on = Object.values(g.paths).filter(p => p.datasets.includes(column.datasetId!));
  if (!on.length) return undefined;
  // A haplotype column of a live-lift dataset is that haplotype's path; a subgroup of a native dataset (its HP1/HP2
  // reads) is on the dataset's own path (the target's), which has no haplotype.
  let pick = column.hap ? on.filter(p => p.hap === column.hap) : on.filter(p => !p.hap);
  if (column.hap && !pick.length) pick = on.filter(p => !p.hap);
  return pick.length === 1 ? pick[0].status : undefined;
}

/** The target span of a hit for cluster regions and anchors: a junction (zero width) gets a small window. */
export const ZERO_WIDTH_PAD = 25;
export function regionOf(t: TargetSpan): { start: number; end: number } {
  return t.end > t.start ? { start: t.start, end: t.end } : { start: Math.max(0, t.start - ZERO_WIDTH_PAD), end: t.end + ZERO_WIDTH_PAD };
}
