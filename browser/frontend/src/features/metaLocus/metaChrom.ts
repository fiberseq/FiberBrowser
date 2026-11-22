/**
 * The meta contig (`meta:<pool id>`, coordinates [0, width), axis -flank..+flank) and the few rules that differ there.
 * Pure helpers on the chrom name and the pool's status, so any component can ask without importing the store.
 */
import type { MetaLocusStatus } from './api';

export const META_PREFIX = 'meta:';

export const isMetaChrom = (chrom: string | null | undefined): boolean => typeof chrom === 'string' && chrom.startsWith(META_PREFIX);

export function anchorWord(anchor: string | undefined): string {
  if (anchor === 'start') return 'TSS';
  if (anchor === 'end') return 'end';
  return 'centre';
}

/** "12.5 kb" / "800 bp". */
export function flankWords(flank: number): string {
  if (flank >= 1000) {
    const kb = flank / 1000;
    return `${Number.isInteger(kb) ? kb : kb.toFixed(1)} kb`;
  }
  return `${flank} bp`;
}

/** The meta-locus's name in the locus box and the ruler, e.g. "promoters_tss · TSS ± 10 kb". */
export function metaLabel(status: Pick<MetaLocusStatus, 'label' | 'name' | 'flank_bp' | 'spec'>): string {
  if (status.label) return status.label;
  const flank = Number(status.flank_bp ?? status.spec?.flank_bp ?? 0);
  return `${status.name || 'regions'} · ${anchorWord(status.spec?.anchor)} ± ${flankWords(flank)}`;
}

/** The locus box's words for a view of the meta contig: the label for the whole window, else the range on the axis. */
export function metaViewWords(status: MetaLocusStatus, start: number, end: number): string {
  const flank = Number(status.flank_bp ?? status.spec?.flank_bp ?? 0);
  const width = Number(status.width ?? 2 * flank);
  if (start <= 0 && end >= width) return metaLabel(status);
  const offset = Number(status.axis_offset ?? -flank);
  const fmt = (x: number) => {
    const d = Math.round(x + offset);
    return d === 0 ? anchorWord(status.spec?.anchor) : `${d > 0 ? '+' : ''}${d.toLocaleString()}`;
  };
  return `${status.name || 'regions'} · ${fmt(start)} to ${fmt(end)}`;
}

/** The axis zero (the anchor) in view coordinates, or null off the meta contig. */
export function metaAxisZero(chrom: string, status: MetaLocusStatus | null): number | null {
  if (!isMetaChrom(chrom) || !status) return null;
  const flank = Number(status.flank_bp ?? status.spec?.flank_bp ?? 0);
  return -Number(status.axis_offset ?? -flank);
}

/**
 * The widest view whose reads are fetched: the pool's whole window on the meta contig (it is one locus), except on
 * low-power clients, where the Open dialog caps the flank to their limit instead (so the limit stays theirs).
 */
export function metaReadLimit(chrom: string, maxRegionForReads: number, width: number, lowPower: boolean): number {
  if (!isMetaChrom(chrom) || lowPower || !width) return maxRegionForReads;
  return Math.max(maxRegionForReads, width);
}

/** The largest flank the Open dialog offers on this client (low-power clients: half their read-view limit). */
export function maxFlankFor(lowPower: boolean, maxRegionForReads: number, max = 50_000): number {
  return lowPower ? Math.min(max, Math.floor(maxRegionForReads / 2)) : max;
}

/**
 * Rows that need a real genome position, left out quietly on the meta contig (no banner): reference sequence, genes,
 * primers, Micro-C, the SV row, capture, external tracks (ortho-*) and annotation composites (motifs, bigBed sites).
 * Metaprofiles (computed from the reads) stay.
 */
export function metaHiddenTrack(type: string, metaprofileComposite = false): boolean {
  if (['sequence', 'gene', 'primer', 'microc', 'sv', 'capture'].includes(type)) return true;
  if (type.startsWith('ortho-')) return true;
  if (type.startsWith('composite-')) return !metaprofileComposite;
  return false;
}

/** Analysis panels that need a real genome position (or, for the feature hub, real-coordinate scan tables in v1):
 * not offered on the meta contig. */
export const META_HIDDEN_PANELS: ReadonlySet<string> = new Set([
  'primer-design', 'contact-map', 'graph-view', 'variants', 'circular-genome', 'capture', 'annotations', 'track-browser',
  'feature-hub', 'insertion-lens',
]);

// ---------------------------------------------------------------------------------------------------- the contig's ends

/** Widths of the meta contigs this page knows (set by the meta-locus store; read by the viewport to clamp pans). */
const contigWidths = new Map<string, number>();

export function setMetaContigWidth(chrom: string, width: number): void {
  if (isMetaChrom(chrom) && width > 0) contigWidths.set(chrom, width);
}

export function metaContigWidth(chrom: string | null | undefined): number | null {
  return isMetaChrom(chrom) ? contigWidths.get(chrom as string) ?? null : null;
}

/**
 * A view of a meta contig kept within its ends [0, width): a span wider than the contig becomes the whole contig, and
 * a pan past an end stops there with the span's size kept. Off a meta contig (or before its width is known): as given.
 */
export function clampMetaSpan(chrom: string, start: number, end: number): [number, number] {
  const width = metaContigWidth(chrom);
  if (!width) return [start, end];
  const size = Math.min(width, Math.max(1, end - start));
  let s = Math.max(0, Math.min(start, width - size));
  if (!Number.isFinite(s)) s = 0;
  return [s, s + size];
}

// ---------------------------------------------------------------------------------------------------- real coordinates

/** A meta read's site, as exports name it. */
export interface MetaSite { chrom?: string; window?: [number, number]; strand?: '+' | '-'; site?: number; site_name?: string; origin?: number }

/** A virtual span [a, b) of a read (view coordinates of the meta contig) at its site's real locus: the site window's
 * logical start (`origin`: unclamped near a contig start, where the window's own start is clamped at 0) plus the
 * offset on plus-strand sites, mirrored from its end on minus-strand ones (half-open kept). */
export function metaRealSpan(meta: MetaSite | null | undefined, a: number, b: number): [number, number] | null {
  if (!meta?.window) return null;
  const [ws, we] = meta.window;
  const origin = typeof meta.origin === 'number' ? meta.origin : ws;
  return meta.strand === '-' ? [we - b, we - a] : [origin + a, origin + b];
}

/** The export columns a meta-locus row adds (next to its virtual coordinates). */
export const META_EXPORT_COLUMNS = ['real_chrom', 'real_start', 'real_end', 'site_strand', 'site', 'site_name'] as const;

/** Those columns' values for a virtual span [a, b) of a read (empty when the read has no site). */
export function metaExportValues(meta: MetaSite | null | undefined, a: number, b: number): unknown[] {
  const span = metaRealSpan(meta, a, b);
  if (!meta || !span) return META_EXPORT_COLUMNS.map(() => '');
  return [meta.chrom ?? '', span[0], span[1], meta.strand ?? '', meta.site ?? '', meta.site_name ?? ''];
}

/** Every reference to an old meta contig (``from``: values and record keys alike) renamed to ``to``; the saved
 *  meta-locus keeps its own payload (its pool id is the server's to give). */
export function renameMetaChroms<T>(value: T, to: string | null, from: Array<string | null | undefined>): T {
  const old = new Set(from.filter((c): c is string => !!c && c !== to));
  if (!to || old.size === 0) return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return old.has(v) ? to : v;
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== 'object') return v;
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return v;  // (only plain records: a saved state is JSON)
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [old.has(k) ? to : k, walk(x)]));
  };
  const out = walk(value) as T;
  const meta = (value as { metaLocus?: unknown })?.metaLocus;
  return meta !== undefined && out && typeof out === 'object' ? { ...out, metaLocus: meta } as T : out;
}
