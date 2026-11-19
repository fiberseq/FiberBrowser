/**
 * FiberHMM variant-allele (`fiberhmm_var`) and structural-event (`fiberhmm_sv`) layers on a bigBed dataset's read
 * rows (browser/services/fiberhmm_variant_layers.py). `fiberhmm-extract --all` writes these routinely, so nothing is
 * fetched until the user turns a layer on for the dataset; then `/api/fiberhmm_layers/reads` gives each read's SV
 * events (the BAM reads' `sv` schema, absolute coordinates) and its alleles at the sites in view, merged here onto
 * the panel's reads so the SV band, deletion breaks, insertion and clip marks and their tooltips are the BAM ones.
 */
import type { Dataset } from '../../types/dataset';
import type { CompactRead, SvEvent, SvSummary } from '../../components/tracks/read-track/types';

export const ALLELE_OTHER = -1;
export const ALLELE_DELETED = -2;
export const ALLELE_AMBIGUOUS = -3;

/** [pos (absolute, 0-based), REF length, allele]: allele >= 0 is the VCF allele index (0 REF). */
export type VariantMark = [number, number, number];

export interface FiberhmmLayerSettings {
  /** SV events on the read rows (and the SV band). */
  sv: boolean;
  /** Per-read allele marks at the var layer's sites. */
  var: boolean;
  minMapq: number;
  hideSupplementary: boolean;
  /** Use the SA tag: split-read pieces joined by a connector, SA-supported deletion carriers. */
  linkSplit: boolean;
  /** The UCSC chain the server draws the layers through (null: as stored); part of the request's identity. */
  lift?: string | null;
}

export const DEFAULT_LAYER_SETTINGS: FiberhmmLayerSettings = {
  sv: false, var: false, minMapq: 0, hideSupplementary: false, linkSplit: true,
};

export interface OverlayRead { sv?: SvEvent[]; var?: VariantMark[]; mapq?: number; read_len?: number }

export interface OverlayPiece { id: string; start: number; end: number; strand: string; mapq: number; flag: number; sv: SvEvent[] }

export interface FiberhmmOverlay {
  dataset_id: string;
  region: { chrom: string; start: number; end: number };
  reads: Record<string, OverlayRead>;
  pieces: OverlayPiece[];
  sv_summary?: SvSummary | null;
  sites?: { pos: number; ref_len: number; reads: number }[];
}

/** A read row drawn for a supplementary record (its own row, joined to its primary by the split link). */
export interface SupplementaryRow extends CompactRead { supplementaryOf: string; supplementary: true }

export type FiberhmmRead = CompactRead & { var?: VariantMark[]; supplementaryOf?: string; supplementary?: boolean };

/** Which variant layers a dataset has (its companions, or its own files). */
export function datasetVariantLayers(d: Pick<Dataset, 'data_type' | 'companion_layers' | 'layer_type'> | undefined | null): { var: boolean; sv: boolean } {
  if (!d || d.data_type !== 'bigbed') return { var: false, sv: false };
  const companions = d.companion_layers ?? {};
  const own = String(d.layer_type ?? '');
  return { var: Boolean(companions.var?.length) || own === 'var', sv: Boolean(companions.sv?.length) || own === 'sv' };
}

export function hasVariantLayers(d: Parameters<typeof datasetVariantLayers>[0]): boolean {
  const l = datasetVariantLayers(d);
  return l.var || l.sv;
}

/** The read track's read set: QC-fail reads shown by choice; uncalled reads shown only by
 *  Min footprints' "All reads, including uncalled". */
export interface OverlayReadSet { includeQcfail?: boolean; hideUncalled?: boolean; includeDuplicates?: boolean }

/** The overlay request's query string (only what is on, and the read set when not the default). */
export function overlayQuery(datasetId: string, chrom: string, start: number, end: number, s: FiberhmmLayerSettings,
  minSvLen: number, readSet: OverlayReadSet = {}): string | null {
  const layers = [s.sv ? 'sv' : '', s.var ? 'var' : ''].filter(Boolean);
  if (!layers.length || !datasetId || !chrom || end <= start) return null;
  const q = new URLSearchParams({
    dataset_id: datasetId, chrom, start: String(Math.max(0, Math.floor(start))), end: String(Math.ceil(end)),
    layers: layers.join(','), min_sv_len: String(minSvLen), min_mapq: String(s.minMapq),
    hide_supplementary: String(s.hideSupplementary), link_split: String(s.linkSplit),
    ...(s.lift ? { lift: s.lift } : {}),
    ...(readSet.includeQcfail ? { include_qcfail: 'true' } : {}),
    ...(readSet.includeDuplicates ? { include_duplicates: 'true' } : {}),
    ...(readSet.hideUncalled === false ? { hide_uncalled: 'false' } : {}),
  });
  return `/api/fiberhmm_layers/reads?${q.toString()}`;
}

export const supplementaryRowId = (piece: Pick<OverlayPiece, 'id' | 'start'>) => `${piece.id}~supp@${piece.start}`;

/** The read id a row stands for (a supplementary row's primary read). */
export function baseReadId(read: Pick<FiberhmmRead, 'id' | 'supplementaryOf'>): string {
  return read.supplementaryOf ?? read.id;
}

/**
 * The panel's reads with the overlay merged on: each read's `sv` (when the SV layer is on; a BAM-style read keeps
 * its own) and `var`, and the supplementary records in view as their own rows, each right after its primary when
 * the split link is on (else at the end). Reads the overlay doesn't name are returned as they are.
 */
export function mergeOverlay(reads: CompactRead[], overlay: FiberhmmOverlay | null, s: FiberhmmLayerSettings,
  viewStart: number, viewEnd: number, opts: { showDuplicates?: boolean } = {}): FiberhmmRead[] {
  if (!overlay || (!s.sv && !s.var)) return reads;
  const out: FiberhmmRead[] = [];
  const pieces = new Map<string, OverlayPiece[]>();
  // Supplementary pieces only of reads in this panel (a split panel's cohort; reads a filter hid stay hidden).
  const cohort = new Set(reads.map(read => read.id));
  if (s.sv && !s.hideSupplementary) {
    for (const p of overlay.pieces ?? []) {
      if (!cohort.has(p.id)) continue;
      if (!opts.showDuplicates && ((p.flag ?? 0) & 0x400)) continue;
      if (p.end <= viewStart || p.start >= viewEnd) continue;
      if (s.minMapq > 0 && p.mapq < s.minMapq) continue;
      pieces.set(p.id, [...(pieces.get(p.id) ?? []), p]);
    }
  }
  const placed = new Set<string>();
  const rowOf = (p: OverlayPiece): SupplementaryRow => ({
    id: supplementaryRowId(p), supplementaryOf: p.id, supplementary: true,
    intervals: [[Math.max(p.start, viewStart) - viewStart, Math.min(p.end, viewEnd) - viewStart, 0]],
    ...(p.sv?.length ? { sv: p.sv } : {}),
  });
  for (const read of reads) {
    const extra = overlay.reads[read.id];
    let merged: FiberhmmRead = read;
    if (extra) {
      const patch: Partial<FiberhmmRead> = {};
      if (s.sv && extra.sv?.length && !read.sv) patch.sv = extra.sv;
      if (s.var && extra.var?.length) patch.var = extra.var;
      if (patch.sv || patch.var) merged = { ...read, ...patch };
    }
    out.push(merged);
    if (s.linkSplit && pieces.has(read.id)) {
      for (const p of pieces.get(read.id)!) out.push(rowOf(p));
      placed.add(read.id);
    }
  }
  for (const [id, list] of pieces) {
    if (placed.has(id)) continue;
    for (const p of list) out.push(rowOf(p));
  }
  return out;
}

/** What a read's allele at a site is called (tooltips and the legend). */
export function alleleName(allele: number): string {
  if (allele === 0) return 'REF';
  if (allele > 0) return allele === 1 ? 'ALT' : `ALT ${allele}`;
  if (allele === ALLELE_DELETED) return 'deleted';
  if (allele === ALLELE_AMBIGUOUS) return 'ambiguous (DAF)';
  return 'other base';
}

export const ALLELE_COLORS = {
  ref: '#64748b',
  alt: '#db2777',
  other: '#111827',
  deleted: '#111827',
  ambiguous: '#d97706',
} as const;

export function alleleColor(allele: number): string {
  if (allele === 0) return ALLELE_COLORS.ref;
  if (allele > 0) return ALLELE_COLORS.alt;
  if (allele === ALLELE_DELETED) return ALLELE_COLORS.deleted;
  if (allele === ALLELE_AMBIGUOUS) return ALLELE_COLORS.ambiguous;
  return ALLELE_COLORS.other;
}

/** A read's allele at an absolute position, if it covers a site there. */
export function alleleAt(read: Pick<FiberhmmRead, 'var'>, pos: number, tolBp = 0): VariantMark | null {
  for (const m of read.var ?? []) {
    if (pos >= m[0] - tolBp && pos < m[0] + Math.max(1, m[1]) + tolBp) return m;
  }
  return null;
}

/**
 * Split-read links among the visible rows: pairs of rows (by index) that are pieces of one read, and for each row
 * the SA segments that lie outside the view (drawn as an arrow at the row's clip, labelled with where it goes).
 */
export function splitLinks(rows: FiberhmmRead[], first: number, last: number, viewChrom: string, viewStart: number, viewEnd: number): {
  pairs: Array<[number, number]>;
  away: Array<{ row: number; side: 'L' | 'R'; ref: number; label: string }>;
} {
  const byBase = new Map<string, number[]>();
  for (let i = Math.max(0, first); i <= Math.min(last, rows.length - 1); i++) {
    const r = rows[i];
    if (!r) continue;
    const key = baseReadId(r);
    byBase.set(key, [...(byBase.get(key) ?? []), i]);
  }
  const pairs: Array<[number, number]> = [];
  for (const idx of byBase.values()) for (let k = 1; k < idx.length; k++) pairs.push([idx[0], idx[k]]);
  const away: Array<{ row: number; side: 'L' | 'R'; ref: number; label: string }> = [];
  for (let i = Math.max(0, first); i <= Math.min(last, rows.length - 1); i++) {
    const events = rows[i]?.sv ?? [];
    const clips = events.filter((e): e is Extract<SvEvent, { t: 'S' }> => e.t === 'S');
    for (const seg of events) {
      if (seg.t !== 'SA') continue;
      const inView = seg.chrom === viewChrom && seg.pos < viewEnd && seg.pos + seg.cigar_ref_len > viewStart;
      if (inView) continue;
      const clip = clips.sort((a, b) => b.len - a.len)[0];
      if (!clip) continue;
      away.push({ row: i, side: clip.side, ref: clip.ref, label: `${seg.chrom}:${(seg.pos + 1).toLocaleString()} ${seg.strand}` });
    }
  }
  return { pairs, away };
}
