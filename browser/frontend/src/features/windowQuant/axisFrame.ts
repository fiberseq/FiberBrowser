/**
 * Relative coordinates for the metaprofiles (and the quantification window): the x-axis in genome coordinates, or as
 * the distance from an anchor (a gene's TSS or end, the view centre, a typed or clicked position, or the meta-locus
 * site). Pure helpers; the choice lives in the window-quant state (sessions) and in a PlotSpec.
 *
 * Direction rule: a plot is never flipped on its own. Its x-axis runs as the reads beside it do (the browser's
 * Reverse view). Relative numbers are signed by the anchor's direction (upstream negative on either strand), so an
 * unflipped minus-strand gene reads with positive numbers on the left, and the axis label says so. "Flip to gene
 * direction" turns Reverse on for the view, so reads and plots flip together. Meta-locus pools are already oriented
 * per site (minus-strand sites flipped in the pool, reads and profiles alike): their anchor is '+'.
 */
import type { Gene } from '../../types';
import { geneTss } from '../../utils/coordinates';
import { niceTicks } from '../../utils/niceTicks';
import { sameChrom } from '../../utils/chromAliases';

export type AnchorKind = 'tss' | 'gene-end' | 'centre' | 'position' | 'site';

export interface AxisFrame {
  mode: 'genome' | 'relative';
  anchor: AnchorKind;
  /** tss / gene-end: a gene by id; null: the gene nearest the view centre. */
  gene: string | null;
  /** position: the anchor position (genomic bp). */
  position: number | null;
}

export const DEFAULT_AXIS_FRAME: AxisFrame = Object.freeze({ mode: 'genome', anchor: 'tss', gene: null, position: null }) as AxisFrame;

export function normalizeAxisFrame(raw: unknown): AxisFrame {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const anchors: AnchorKind[] = ['tss', 'gene-end', 'centre', 'position', 'site'];
  return {
    mode: r.mode === 'relative' ? 'relative' : 'genome',
    anchor: anchors.includes(r.anchor as AnchorKind) ? r.anchor as AnchorKind : 'tss',
    gene: typeof r.gene === 'string' && r.gene ? r.gene : null,
    position: typeof r.position === 'number' && Number.isFinite(r.position) ? Math.round(r.position) : null,
  };
}

export interface ResolvedAnchor {
  pos: number;
  strand: '+' | '-';
  /** "TSS of GATA1", "view centre", "site centre" (read after "the"). */
  name: string;
  /** "Distance from the TSS of GATA1 (bp, gene on − strand)". */
  axisLabel: string;
}

export interface AnchorContext {
  chrom: string;
  start: number;
  end: number;
  genes: readonly Gene[];
  /** On a meta contig: the site's position on the contig (the flank) and the pool's anchor word. */
  meta?: { site: number; word: string } | null;
}

/** The TSS base as the browser marks it (utils/coordinates.geneTss); the gene end: its last base downstream. */
const tssOf = (g: Pick<Gene, 'start' | 'end' | 'strand'>) => geneTss(g);
const endOf = (g: Pick<Gene, 'start' | 'end' | 'strand'>) => (g.strand === '-' ? g.start : g.end - 1);

/** A gene's anchor base: its TSS or its end (strand-aware). */
export const geneAnchorPos = (g: Pick<Gene, 'start' | 'end' | 'strand'>, anchor: 'tss' | 'gene-end'): number => (anchor === 'tss' ? tssOf(g) : endOf(g));

/** The genes in view (on this chromosome, overlapping it), nearest the centre first. */
export function genesInView(ctx: Pick<AnchorContext, 'chrom' | 'start' | 'end' | 'genes'>): Gene[] {
  const c = (ctx.start + ctx.end) / 2;
  return ctx.genes.filter(g => (!g.chrom || sameChrom(g.chrom, ctx.chrom)) && g.end > ctx.start && g.start < ctx.end)
    .sort((a, b) => Math.abs(tssOf(a) - c) - Math.abs(tssOf(b) - c) || a.id.localeCompare(b.id));
}

function label(name: string, strand: '+' | '-', gene: boolean): string {
  return `Distance from the ${name} (bp${gene ? `, gene on ${strand === '-' ? '−' : '+'} strand` : ''})`;
}

/** The anchor for a frame here, or why there is none (null + reason). */
export function resolveAnchor(f: AxisFrame, ctx: AnchorContext): ResolvedAnchor | { reason: string } {
  if (ctx.meta) {
    // A meta-locus is anchored on its sites already (start, centre or end, as the pool was built).
    const name = `site ${ctx.meta.word}`;
    return { pos: ctx.meta.site, strand: '+', name, axisLabel: label(name, '+', false) };
  }
  if (f.anchor === 'centre') { const pos = Math.round((ctx.start + ctx.end) / 2); return { pos, strand: '+', name: 'view centre', axisLabel: label('view centre', '+', false) }; }
  if (f.anchor === 'position') {
    if (f.position == null) return { reason: 'Type or click a position for the anchor.' };
    const name = `position ${f.position.toLocaleString('en-US')}`;
    return { pos: f.position, strand: '+', name, axisLabel: label(name, '+', false) };
  }
  if (f.anchor === 'site') return { reason: 'Site anchors need a meta-locus (a BED file pooled into one locus).' };
  const genes = genesInView(ctx);
  const g = f.gene ? ctx.genes.find(x => x.id === f.gene && (!x.chrom || sameChrom(x.chrom, ctx.chrom))) : genes[0];
  if (!g) return { reason: f.gene ? 'The chosen gene is not on this chromosome.' : 'No gene in view (load genes, or anchor on the view centre or a position).' };
  const strand = g.strand === '-' ? '-' : '+';
  const word = f.anchor === 'tss' ? 'TSS' : 'gene end';
  const name = `${word} of ${g.name || g.id}`;
  return { pos: f.anchor === 'tss' ? tssOf(g) : endOf(g), strand, name, axisLabel: label(name, strand, true) };
}

export const isResolved = (a: ResolvedAnchor | { reason: string } | null | undefined): a is ResolvedAnchor => !!a && 'pos' in a;

/** Genomic position → distance from the anchor, signed by its direction (upstream negative). */
export const toRelative = (g: number, a: Pick<ResolvedAnchor, 'pos' | 'strand'>): number => (a.strand === '-' ? a.pos - g : g - a.pos);
/** Distance from the anchor → genomic position. */
export const fromRelative = (r: number, a: Pick<ResolvedAnchor, 'pos' | 'strand'>): number => (a.strand === '-' ? a.pos - r : a.pos + r);

/** A relative window [from, to) (upstream..downstream) as genomic bp (half-open, low to high). */
export function relativeToGenomic(from: number, to: number, a: Pick<ResolvedAnchor, 'pos' | 'strand'>): [number, number] {
  const x = fromRelative(from, a), y = fromRelative(to, a);
  return [Math.min(x, y), Math.max(x, y)];
}

/** A genomic window as relative bounds [upstream end, downstream end]. */
export function genomicToRelative(from: number, to: number, a: Pick<ResolvedAnchor, 'pos' | 'strand'>): [number, number] {
  const x = toRelative(from, a), y = toRelative(to, a);
  return [Math.min(x, y), Math.max(x, y)];
}

/**
 * Where a genomic position is drawn, as a fraction of the plot's width: the reads' direction, nothing else
 * (reversed: right to left). The x-axis of a plot and the reads beside it agree by construction.
 */
export const screenFraction = (g: number, view: { start: number; end: number }, reversed: boolean): number => {
  const t = (g - view.start) / Math.max(1, view.end - view.start);
  return reversed ? 1 - t : t;
};

/** Target spacing between x ticks, px (the Plots rule: about one major tick per 60–90 px). */
export const X_TICK_TARGET_PX = 75;

/** A tick label: bp with thousands separators; relative distances signed (+150, 0, −300 as "-300"). */
export function tickLabel(v: number, relative: boolean): string {
  const s = Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-US') : String(+v.toPrecision(12));
  return relative && v > 0 ? `+${s}` : s;
}

/**
 * Tick marks for a plot spanning the view `widthPx` wide: nice 1-2-5 steps (utils/niceTicks, the Plots rule), about one
 * per X_TICK_TARGET_PX, as positions across the plot in screen order (the reads' direction) and labels, genome or
 * relative to the anchor. Relative ticks fall on round distances, 0 at the anchor whenever it is in view.
 */
export function axisTicks(view: { start: number; end: number }, reversed: boolean, a: ResolvedAnchor | null, widthPx = 400, targetPx = X_TICK_TARGET_PX): Array<{ t: number; label: string; value: number }> {
  const out: Array<{ t: number; label: string; value: number }> = [];
  if (!(view.end > view.start)) return out;
  if (a) {
    const r0 = toRelative(view.start, a), r1 = toRelative(view.end, a);
    const { major } = niceTicks(Math.min(r0, r1), Math.max(r0, r1), widthPx, targetPx);
    for (const r of major) out.push({ t: screenFraction(fromRelative(r, a), view, reversed), label: tickLabel(r, true), value: r });
  } else {
    const { major } = niceTicks(view.start, view.end, widthPx, targetPx);
    for (const g of major) out.push({ t: screenFraction(g, view, reversed), label: tickLabel(g, false), value: g });
  }
  return out.sort((x, y) => x.t - y.t);
}
