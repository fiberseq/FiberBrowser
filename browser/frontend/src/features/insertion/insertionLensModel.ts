import type { SvConflictReason } from '../../utils/svConflicts';
/**
 * Insertion lens: pure view logic (no React, no canvas).
 *
 * The backend (/api/insertions/lens) gives every read in lens-local
 * coordinates, left breakpoint at 0: left flank [-F, 0), insert [0, L_i),
 * right flank [L_i, L_i + F). Reference reads have L_i = 0. Intervals are
 * already split at the breakpoints, so each piece lies in one segment.
 *
 * Carriers are CIGAR insertions (the whole insert) or reads clipped at the
 * breakpoint (``kind: 'clip'``): a soft clip holds the insert's start
 * (``partial: 'start'``, drawn from the left breakpoint) or its end
 * (``partial: 'end'``, drawn up to the right breakpoint) in every anchor mode
 * (stretching a part of the insert to the whole would misplace it); a hard
 * clip (``hard``) has no inserted bases, only its flank.
 *
 * This module lays the reads on one display axis X in [0, 2F + L_display):
 *   left flank  X = x + F
 *   insert      X = F + insertX(x)        (anchor: left / right / stretch / consensus)
 *   right flank X = F + L_display + (x - L_i)
 * optionally mirrored (reversed view), and computes per-group profiles on it.
 * The results are ordinary CompactReads, so the read-track renderer draws them.
 */
import type { CompactRead, AnnotationLayer } from '../../components/tracks/read-track/types';

export type LensAnchor = 'left' | 'right' | 'stretch' | 'consensus';

export const LENS_ANCHORS: { key: LensAnchor; label: string; title: string }[] = [
  { key: 'left', label: 'Left', title: 'Inserts start together at the left breakpoint' },
  { key: 'right', label: 'Right', title: 'Inserts end together at the right breakpoint' },
  { key: 'stretch', label: 'Stretch', title: 'Each insert scaled to the display length' },
  { key: 'consensus', label: 'Consensus', title: 'Each insert placed on the consensus through its alignment (same element base, same column)' },
];

export interface LensStraddle { layer: string; start: number; end: number; size: number; side: string }

export type LensPartial = 'start' | 'end';

export interface LensEntry {
  evidence_reason?: SvConflictReason;
  evidence_level?: 'confirmed' | 'putative' | 'conflicting' | 'ambiguous';
  id: string;
  strand: '+' | '-';
  /** Carriers: a CIGAR insertion, or a read clipped at the breakpoint. */
  kind?: 'cigar' | 'clip';
  /** A clipped carrier holds the insert's start (alignment ends at the insertion) or its end. */
  partial?: LensPartial;
  /** Clipped bases on that side (soft + hard). */
  clip_len?: number;
  /** Hard-clipped: no inserted bases in the record (its flank only). */
  hard?: boolean;
  /** The record has an SA tag (the rest of the read aligns elsewhere). */
  sa?: boolean;
  ref: number;
  ref_end: number;
  q?: number;
  len: number;
  pieces?: number;
  read: CompactRead & { straddles?: LensStraddle[] };
  knots?: [number, number][];
  identity?: number;
  seq?: string;
}

export interface LensResponse {
  success: boolean;
  error?: string;
  dataset_id?: string;
  chrom: string;
  flank: number;
  site: { pos: number; tolerance: number; len_min: number; len_max: number | null };
  /** The insertion the reads were classified for (what "Split by this SV" takes). */
  sv?: { t: 'I'; ref: number; len: number; margin: number };
  cluster: {
    ref: number; len: number; len_lo: number; len_hi: number;
    /** Every carrier: CIGAR + clipped. */
    carriers: number;
    confirmed?: number; putative?: number; conflicting?: number; ambiguous?: number; evidence_total?: number;
    ref_len?: number; alt_len?: number;
    cigar?: number;
    /** Clipped at the breakpoint (hard-clipped included). */
    clipped?: number;
    hard?: number;
    reference: number;
  };
  carriers: LensEntry[];
  reference: LensEntry[];
  /** Reads at the site that are neither: another insertion there, or not spanning it. */
  excluded: { other_insert: number; not_informative: number };
  truncated: { carriers: number; reference: number };
  consensus?: {
    seq: string; length: number; n_reads: number; seconds: number;
    /** How it was built: FiberHMM's DAF-aware column calls (DAF datasets), or a majority vote. */
    method?: 'daf' | 'majority';
    method_label?: string;
    /** DAF-aware only: share of consensus columns at FiberHMM's quality floor (not per-base confidence). */
    confident_fraction?: number;
    carriers_ct?: number;
    carriers_ga?: number;
    /** A DAF dataset that got the majority vote: why the DAF-aware consensus was not used. */
    fallback?: string;
  };
  consensus_resource?: {
    status: 'budget_exceeded' | 'cancelled' | 'partial' | 'unavailable';
    reason: string;
    complete: false;
    parameters: Record<string, unknown>;
    budget_version: string;
  };
  /** What the run that called the BAM reports for this insertion (qc/<BAM>.insert_consensus.json). */
  run_consensus?: {
    path: string; used: boolean; carriers?: number | null; carriers_ct?: number | null; carriers_ga?: number | null;
    min_carriers?: number | null; consensus_length?: number | null; confident_fraction?: number | null;
  };
  seconds?: number;
}

/** The consensus's method for the panel: label and tooltip ('' without a consensus). */
export function consensusMethod(response: Pick<LensResponse, 'consensus' | 'run_consensus'>): { label: string; title: string } {
  const c = response.consensus;
  if (!c) return { label: '', title: '' };
  const label = c.method_label ?? 'majority vote';
  const parts: string[] = [];
  if (c.method === 'daf') {
    parts.push('Each column called by its variability per strand (FiberHMM 3.0): a column that is sometimes C, sometimes '
      + 'T on C→T reads is a C (deaminated in some molecules); G/A likewise on G→A reads.');
    if (c.carriers_ct !== undefined) parts.push(`${c.carriers_ct} C→T and ${c.carriers_ga ?? 0} G→A carriers voted.`);
    if (typeof c.confident_fraction === 'number') {
      parts.push(`${Math.round(c.confident_fraction * 100)}% of columns confident (Phred ≥ 20).`);
    }
  } else {
    parts.push('Each column takes the commonest base of the carriers.');
    if (c.fallback) parts.push(`Not DAF-aware: ${c.fallback}; heavily deaminated C/G columns may read as T/A.`);
  }
  const run = response.run_consensus;
  if (run) {
    parts.push(run.used
      ? `The run called this insertion against FiberHMM's consensus (${run.carriers ?? '?'} carriers, `
        + `${typeof run.confident_fraction === 'number' ? `${Math.round(run.confident_fraction * 100)}% confident columns` : 'confidence not reported'}).`
      : `The run left this insertion masked (${run.carriers ?? '?'} carriers; it needs ${run.min_carriers ?? 20}).`);
  }
  return { label, title: parts.join(' ') };
}

/** An insertion in view, as the SV summary clusters it (/api/insertions/clusters). */
export interface InsertionCluster {
  confirmed?: number; putative?: number; conflicting?: number; ambiguous?: number;
  uncertainty?: [number, number];
  id?: string;
  ref: number;
  len: number;
  /** Carrier reads (CIGAR + clipped). */
  carriers: number;
  /** Carriers clipped at the breakpoint. */
  clip_support?: number;
  /** Carriers plus reads spanning the site without it. */
  informative?: number;
}

/** What the lens shows; kept on the lens panel's PanelConfig (saved with sessions). */
export interface InsertionLensTarget {
  footprintGrouping?: import('../differences/footprintGroups').FootprintGrouping;
  footprintSites?: number;
  workspace?: { query: import('../differences/api').WorkspaceQuery; calls: import('../differences/api').WorkspaceCalls };
  includePutative?: boolean;
  includeConflicting?: boolean;
  includeAmbiguous?: boolean;
  genome?: string | null;
  datasetId: string;
  chrom: string;
  pos: number;
  tolerance: number;
  lenMin: number;
  lenMax: number | null;
  /** The SV cluster (ref, len) the lens classifies for; absent in older sessions (found at ``pos``). */
  ref?: number | null;
  len?: number | null;
  flank: number;
  anchor?: LensAnchor;
  reversed?: boolean;
}

export interface LensAxis {
  flank: number;
  displayLen: number;
  total: number;
  reversed: boolean;
}

export interface LensRowMeta {
  evidenceReason?: SvConflictReason;
  evidenceLevel?: 'confirmed' | 'putative' | 'conflicting' | 'ambiguous';
  id: string; strand: '+' | '-'; len: number; identity?: number; carrier: boolean;
  partial?: LensPartial; hard?: boolean; clipLen?: number; sa?: boolean;
}

export interface LensLayout {
  axis: LensAxis;
  anchor: LensAnchor;
  carriers: CompactRead[];
  reference: CompactRead[];
  carrierRows: LensRowMeta[];
  /** Observed alternate coverage; annotation intervals themselves are not coverage. */
  carrierCoverage?: [number, number][][];
  referenceRows: LensRowMeta[];
}

/** The length the insert is drawn at: the consensus's when there is one (needed for consensus mode). */
export function displayLength(response: LensResponse, anchor: LensAnchor): number {
  const cons = response.consensus?.length ?? 0;
  if (cons > 0) return cons;
  if (anchor === 'consensus') return response.cluster.alt_len ?? response.cluster.len ?? 0;
  return response.cluster.alt_len ?? response.cluster.len ?? 0;
}

/** The anchor actually used: consensus mode falls back to stretch without a consensus. */
export function effectiveAnchor(response: LensResponse, anchor: LensAnchor): LensAnchor {
  return anchor === 'consensus' && !(response.consensus?.length) ? 'stretch' : anchor;
}

/** Read position -> consensus position by piecewise-linear interpolation of the knots. */
export function interpolateKnots(knots: [number, number][] | undefined, x: number): number {
  if (!knots || knots.length === 0) return x;
  if (x <= knots[0][0]) return knots[0][1] + (x - knots[0][0]);
  for (let i = 1; i < knots.length; i++) {
    const [a0, b0] = knots[i - 1];
    const [a1, b1] = knots[i];
    if (x <= a1) {
      if (a1 === a0) return b1;
      return b0 + ((x - a0) * (b1 - b0)) / (a1 - a0);
    }
  }
  const [aN, bN] = knots[knots.length - 1];
  return bN + (x - aN);
}

type Segment = 'left' | 'insert' | 'right';

interface ReadMapper {
  /** Map [s, e) (lens-local, any segment) to display pieces [X0, X1), clipped to the axis. */
  interval(s: number, e: number): [number, number][];
  /** The same pieces with each one's segment-local extent [s, e) (lens-local, before clipping). */
  pieces(s: number, e: number): { X: [number, number]; local: [number, number] }[];
  /** [s, e) (lens-local) restricted to the segment of ``local`` and projected without axis clipping. */
  project(s: number, e: number, local: [number, number]): [number, number];
  /** Map one base at x; null when it falls outside what is drawn. */
  point(x: number): number | null;
}

export function makeReadMapper(
  len: number, axis: LensAxis, anchor: LensAnchor, knots?: [number, number][], partial?: LensPartial,
): ReadMapper {
  const { flank: F, displayLen: D, total } = axis;
  const insertX = (x: number): number => {
    // A part of the insert keeps its own scale: from the left breakpoint, or up to the right one.
    if (partial) {
      if (anchor === 'consensus' && knots?.length) return interpolateKnots(knots, x);
      return partial === 'start' ? x : x + (D - len);
    }
    switch (anchor) {
      case 'left': return x;
      case 'right': return x + (D - len);
      case 'stretch': return len > 0 ? (x * D) / len : 0;
      case 'consensus': return interpolateKnots(knots, x);
    }
  };
  const seg = (x: number): Segment => (x < 0 ? 'left' : x < len ? 'insert' : 'right');
  const toX = (x: number, segment: Segment): number => {
    if (segment === 'left') return x + F;
    if (segment === 'right') return F + D + (x - len);
    return F + insertX(x);
  };
  const bounds = (segment: Segment): [number, number] => {
    if (segment === 'left') return [0, F];
    if (segment === 'right') return [F + D, total];
    return [F, F + D];
  };
  const mirror = (lo: number, hi: number): [number, number] => (axis.reversed ? [total - hi, total - lo] : [lo, hi]);
  const pieces = (s: number, e: number): { X: [number, number]; local: [number, number] }[] => {
    const cuts = [s];
    if (s < 0 && e > 0) cuts.push(0);
    if (len > 0 && s < len && e > len) cuts.push(len);
    cuts.push(e);
    const out: { X: [number, number]; local: [number, number] }[] = [];
    for (let i = 0; i + 1 < cuts.length; i++) {
      const a = cuts[i];
      const b = cuts[i + 1];
      if (b <= a) continue;
      const segment = seg(a);
      if (segment === 'insert' && len === 0) continue;
      const [lo, hi] = bounds(segment);
      const x0 = Math.max(lo, toX(a, segment));
      const x1 = Math.min(hi, toX(b, segment));
      if (x1 > x0) out.push({ X: mirror(x0, x1), local: [a, b] });
    }
    return out;
  };
  return {
    pieces,
    interval(s, e) {
      return pieces(s, e).map(p => p.X);
    },
    project(s, e, local) {
      const segment = seg(local[0]);
      const [segLo, segHi] = segment === 'left' ? [-Infinity, 0] : segment === 'insert' ? [0, len] : [len, Infinity];
      const a = Math.max(s, segLo);
      const b = Math.min(e, segHi);
      if (!(b > a)) return mirror(toX(local[0], segment), toX(local[1], segment));
      return mirror(toX(a, segment), toX(b, segment));
    },
    point(x) {
      const segment = seg(x);
      if (segment === 'insert' && len === 0) return null;
      const [lo, hi] = bounds(segment);
      const X = toX(x, segment);
      if (X < lo || X >= hi) return null;
      return axis.reversed ? total - 1 - X : X;
    },
  };
}

function mapIntervals(
  intervals: number[][] | undefined,
  mapper: ReadMapper,
): { intervals: number[][]; origin: number[]; local: [number, number][] } {
  const out: number[][] = [];
  const origin: number[] = [];
  const local: [number, number][] = [];
  (intervals ?? []).forEach((iv, index) => {
    const [s, e, ...rest] = iv;
    for (const piece of mapper.pieces(s, e)) {
      out.push([piece.X[0], piece.X[1], ...rest]);
      origin.push(index);
      local.push(piece.local);
    }
  });
  // Mirroring reverses the order; renderers expect intervals by start.
  const order = out.map((_, i) => i).sort((a, b) => out[a][0] - out[b][0]);
  return { intervals: order.map(i => out[i]), origin: order.map(i => origin[i]), local: order.map(i => local[i]) };
}

/** Edge-quality channels that trade places when the lens is mirrored. */
const EDGE_PAIRS: [string, string][] = [['el', 'er'], ['lq', 'rq']];

function follow<T>(values: T[], origin: number[]): T[] {
  return origin.map(i => values[i]);
}

function mapLayer(layer: AnnotationLayer, mapper: ReadMapper, reversed: boolean): AnnotationLayer {
  const n = layer.intervals?.length ?? 0;
  const { intervals, origin, local } = mapIntervals(layer.intervals as number[][], mapper);
  const out: Record<string, unknown> = { ...layer, intervals };
  for (const [key, value] of Object.entries(layer)) {
    if (key === 'intervals' || key === 'quality_names' || !Array.isArray(value)) continue;
    if (key === 'qualities') {
      let channels = (value as unknown[]).map(ch => (Array.isArray(ch) && ch.length === n ? follow(ch, origin) : ch));
      if (reversed && layer.quality_names) {
        // Mirrored, a call's left edge is drawn on the right: its edge qualities follow.
        const names = layer.quality_names;
        channels = channels.slice();
        for (const [l, r] of EDGE_PAIRS) {
          const li = names.indexOf(l);
          const ri = names.indexOf(r);
          if (li >= 0 && ri >= 0 && li < channels.length && ri < channels.length) {
            [channels[li], channels[ri]] = [channels[ri], channels[li]];
          }
        }
      }
      out[key] = channels;
    } else if (key === 'source_intervals' && value.length === n) {
      // The whole call's extent, projected into each piece's segment.
      out[key] = origin.map((i, k) => {
        const [s, e, ...rest] = value[i] as number[];
        const [x0, x1] = mapper.project(s, e, local[k]);
        return [x0, x1, ...rest];
      });
    } else if (value.length === n) {
      out[key] = follow(value as unknown[], origin);
    }
  }
  return out as unknown as AnnotationLayer;
}

function mapPoints(values: number[] | undefined, mapper: ReadMapper): number[] | undefined {
  if (!values) return undefined;
  const out: number[] = [];
  for (const x of values) {
    const X = mapper.point(x);
    if (X !== null) out.push(X);
  }
  return out.sort((a, b) => a - b);
}

function mapPairs(values: number[][] | undefined, mapper: ReadMapper): number[][] | undefined {
  if (!values) return undefined;
  const out: number[][] = [];
  for (const [x, ...rest] of values) {
    const X = mapper.point(x);
    if (X !== null) out.push([X, ...rest]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/** One lens read (lens-local) as a CompactRead on the display axis. */
export function mapLensRead(entry: LensEntry, axis: LensAxis, anchor: LensAnchor): CompactRead {
  const mapper = makeReadMapper(entry.len, axis, anchor, entry.knots, entry.partial);
  const read = entry.read as CompactRead & Record<string, unknown>;
  const out: Record<string, unknown> = { ...read };
  delete out.straddles;
  const primary = mapIntervals(read.intervals as number[][], mapper);
  out.intervals = primary.intervals;
  if (Array.isArray(read.qualities) && read.qualities.length === (read.intervals?.length ?? -1)) {
    out.qualities = follow(read.qualities as number[], primary.origin);
  }
  if (read.fire) out.fire = mapIntervals(read.fire as number[][], mapper).intervals;
  for (const field of ['methyl', 'methyl_m6a', 'methyl_m5c', 'possible_deam_ct', 'possible_deam_ga'] as const) {
    if (read[field]) out[field] = mapPoints(read[field] as number[], mapper);
  }
  for (const field of ['deam'] as const) {
    if (read[field]) out[field] = mapPairs(read[field] as unknown as number[][], mapper);
  }
  if (read.layers) {
    const layers: Record<string, AnnotationLayer> = {};
    for (const [name, layer] of Object.entries(read.layers)) layers[name] = mapLayer(layer, mapper, axis.reversed);
    out.layers = layers;
  }
  return out as unknown as CompactRead;
}

export function layoutLens(response: LensResponse, anchorWanted: LensAnchor, reversed: boolean): LensLayout {
  const anchor = effectiveAnchor(response, anchorWanted);
  const displayLen = displayLength(response, anchor);
  const flank = response.flank;
  const axis: LensAxis = { flank, displayLen, total: 2 * flank + displayLen, reversed };
  const row = (e: LensEntry, carrier: boolean): LensRowMeta => ({
    evidenceLevel: e.evidence_level, evidenceReason: e.evidence_reason,
    id: e.id, strand: e.strand, len: e.len, identity: e.identity, carrier,
    ...(e.partial ? { partial: e.partial, clipLen: e.clip_len, sa: Boolean(e.sa) } : {}),
    ...(e.hard ? { hard: true } : {}),
  });
  return {
    axis,
    anchor,
    carriers: response.carriers.map(e => mapLensRead(e, axis, anchor)),
    reference: response.reference.map(e => mapLensRead(e, axis, anchor)),
    carrierRows: response.carriers.map(e => row(e, true)),
    carrierCoverage: response.carriers.map(e => e.hard ? [] : makeReadMapper(e.len, axis, anchor, e.knots, e.partial).interval(0, e.len)),
    referenceRows: response.reference.map(e => row(e, false)),
  };
}

/** What a carrier row is, in words (its tooltip). */
export function describeCarrier(row: LensRowMeta): string {
  if (row.evidenceReason) return `conflicting · ${row.evidenceReason.message}`;
  const size = (n: number) => `${n.toLocaleString()} bp`;
  if (!row.partial) {
    return `insert ${size(row.len)}${row.identity !== undefined ? ` · ${(row.identity * 100).toFixed(1)}% identity to consensus` : ''}`;
  }
  const where = row.partial === 'start' ? 'its alignment ends at the insertion' : 'its alignment starts at the insertion';
  const sa = row.sa ? ', rest in a supplementary alignment' : '';
  if (row.hard) return `hard-clipped (${size(row.clipLen ?? 0)}): ${where}${sa}; the inserted bases are not in this record`;
  const part = row.partial === 'start' ? 'first' : 'last';
  return `clipped (${size(row.clipLen ?? row.len)}${sa}): the insert's ${part} ${size(row.len)} from the soft clip`
    + `${row.identity !== undefined ? ` · ${(row.identity * 100).toFixed(1)}% identity to consensus` : ''}`;
}

// ---------------------------------------------------------------------------
// Axis readout

/** What display position X is, in words: flank coordinate on the genome, or insert base. */
export function describeAxisPosition(
  X: number, axis: LensAxis, response: Pick<LensResponse, 'chrom' | 'cluster'>, anchor: LensAnchor,
): string {
  const x = axis.reversed ? axis.total - X : X;
  const { flank: F, displayLen: D } = axis;
  if (x < F) {
    return `left flank ${response.chrom}:${Math.round(response.cluster.ref - (F - x)).toLocaleString()}`;
  }
  if (x >= F + D) {
    return `right flank ${response.chrom}:${Math.round(response.cluster.ref + (x - F - D)).toLocaleString()}`;
  }
  const where = anchor === 'consensus' ? 'consensus' : anchor === 'stretch' ? 'scaled insert' : 'insert';
  return `${where} base ${Math.floor(x - F + 1).toLocaleString()} of ${D.toLocaleString()}`;
}

/** Tick positions and labels for the lens axis. */
export function axisTicks(axis: LensAxis): { X: number; label: string; major: boolean }[] {
  const { flank: F, displayLen: D, total } = axis;
  const ticks: { X: number; label: string; major: boolean }[] = [];
  const at = (x: number) => (axis.reversed ? total - x : x);
  const kb = (bp: number) => (Math.abs(bp) >= 1000 ? `${(bp / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} kb` : `${bp} bp`);
  if (F > 0) ticks.push({ X: at(0), label: `−${kb(F)}`, major: false });
  ticks.push({ X: at(F), label: 'left bp', major: true });
  const step = D > 4000 ? 1000 : D > 1500 ? 500 : D > 400 ? 100 : 50;
  for (let p = step; p < D - step / 3; p += step) ticks.push({ X: at(F + p), label: p.toLocaleString(), major: false });
  ticks.push({ X: at(F + D), label: 'right bp', major: true });
  if (F > 0) ticks.push({ X: at(total), label: `+${kb(F)}`, major: false });
  return ticks;
}

// ---------------------------------------------------------------------------
// Profiles

export interface LensProfile {
  bins: number;
  binWidth: number;
  /** Reads covering each bin (fractional, by covered bases / bin width). */
  coverage: number[];
  /** Fraction of covered bases inside a nucleosome call (null: no coverage). */
  nuc: (number | null)[];
  /** Fraction of covered bases inside an MSP / accessible call. */
  msp: (number | null)[];
  /** Marks (m6A, 5mC or deamination) per 100 covered bases. */
  marks: (number | null)[];
}

const NUC_LAYERS = ['nuc'];
const MSP_LAYERS = ['msp', 'fire'];

function addSpan(acc: number[], a: number, b: number, binWidth: number) {
  if (b <= a) return;
  const first = Math.max(0, Math.floor(a / binWidth));
  const last = Math.min(acc.length - 1, Math.floor((b - 1e-9) / binWidth));
  for (let k = first; k <= last; k++) {
    const lo = Math.max(a, k * binWidth);
    const hi = Math.min(b, (k + 1) * binWidth);
    if (hi > lo) acc[k] += hi - lo;
  }
}

function unionSpans(spans: [number, number][]): [number, number][] {
  const sorted = spans.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [a, b] of sorted) {
    if (out.length && a <= out[out.length - 1][1]) out[out.length - 1][1] = Math.max(out[out.length - 1][1], b);
    else out.push([a, b]);
  }
  return out;
}

function layerSpans(read: CompactRead, names: string[]): [number, number][] {
  const spans: [number, number][] = [];
  for (const name of names) {
    for (const iv of read.layers?.[name]?.intervals ?? []) spans.push([iv[0], iv[1]]);
  }
  return unionSpans(spans);
}

export function computeLensProfile(reads: CompactRead[], total: number, maxBins = 600): LensProfile {
  const bins = Math.max(1, Math.min(maxBins, Math.ceil(total)));
  const binWidth = total / bins;
  const covered = new Array(bins).fill(0);
  const nuc = new Array(bins).fill(0);
  const msp = new Array(bins).fill(0);
  const marks = new Array(bins).fill(0);
  for (const read of reads) {
    const body: [number, number][] = [];
    for (const iv of read.intervals ?? []) body.push([iv[0], iv[1]]);
    for (const layer of Object.values(read.layers ?? {})) for (const iv of layer.intervals ?? []) body.push([iv[0], iv[1]]);
    for (const [a, b] of unionSpans(body)) addSpan(covered, a, b, binWidth);
    for (const [a, b] of layerSpans(read, NUC_LAYERS)) addSpan(nuc, a, b, binWidth);
    for (const [a, b] of layerSpans(read, MSP_LAYERS)) addSpan(msp, a, b, binWidth);
    const points = read.methyl_m6a ?? read.methyl_m5c ?? (read.deam ? read.deam.map(d => d[0]) : read.methyl) ?? [];
    for (const p of points) {
      const k = Math.floor(p / binWidth);
      if (k >= 0 && k < bins) marks[k] += 1;
    }
  }
  const frac = (num: number[]) => num.map((v, k) => (covered[k] > 0 ? Math.min(1, v / covered[k]) : null));
  return {
    bins,
    binWidth,
    coverage: covered.map(c => c / binWidth),
    nuc: frac(nuc),
    msp: frac(msp),
    marks: marks.map((m, k) => (covered[k] > 0 ? (100 * m) / covered[k] : null)),
  };
}

/** Profile series as TSV (one row per bin), for the profile's data export. */
export function profilesTsv(axis: LensAxis, groups: { label: string; profile: LensProfile }[]): string {
  if (groups.length === 0) return '';
  const header = ['bin_start', 'bin_end'];
  for (const g of groups) header.push(`${g.label}_reads`, `${g.label}_nuc_frac`, `${g.label}_msp_frac`, `${g.label}_marks_per_100bp`);
  const lines = [header.join('\t')];
  const { bins, binWidth } = groups[0].profile;
  const fmt = (v: number | null) => (v === null ? '' : v.toFixed(4));
  for (let k = 0; k < bins; k++) {
    const row = [((k * binWidth) - axis.flank).toFixed(1), (((k + 1) * binWidth) - axis.flank).toFixed(1)];
    for (const g of groups) {
      row.push(g.profile.coverage[k].toFixed(2), fmt(g.profile.nuc[k]), fmt(g.profile.msp[k]), fmt(g.profile.marks[k]));
    }
    lines.push(row.join('\t'));
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Sequences

const COMPLEMENT: Record<string, string> = { A: 'T', C: 'G', G: 'C', T: 'A', N: 'N', a: 't', c: 'g', g: 'c', t: 'a', n: 'n' };

export function reverseComplement(seq: string): string {
  let out = '';
  for (let i = seq.length - 1; i >= 0; i--) out += COMPLEMENT[seq[i]] ?? 'N';
  return out;
}

export function wrapFasta(header: string, seq: string, width = 70): string {
  const lines = [`>${header}`];
  for (let i = 0; i < seq.length; i += width) lines.push(seq.slice(i, i + width));
  return lines.join('\n') + '\n';
}

export function insertionName(response: Pick<LensResponse, 'chrom' | 'cluster'>): string {
  return `ins_${response.chrom}_${response.cluster.ref}_len${response.cluster.len}`;
}

export function consensusFasta(response: LensResponse, reversed: boolean): string {
  const seq = response.consensus?.seq ?? '';
  const n = response.carriers.length;
  const strand = reversed ? ' reverse-complemented' : '';
  return wrapFasta(
    `${insertionName(response)}_n${n} consensus of ${n} carrier reads${strand} (FiberBrowser insertion lens`
      + `${response.consensus?.method_label ? `, ${response.consensus.method_label}` : ''})`,
    reversed ? reverseComplement(seq) : seq,
  );
}

export function insertsFasta(entries: LensEntry[], response: Pick<LensResponse, 'chrom' | 'cluster'>, reversed: boolean): string {
  const name = insertionName(response);
  return entries
    .filter(e => e.seq)
    .map(e => wrapFasta(
      `${e.id} ${name} strand=${e.strand} len=${e.len}${e.partial ? ` partial=${e.partial} (clipped read)` : ''}${reversed ? ' reverse-complemented' : ''}`,
      reversed ? reverseComplement(e.seq as string) : (e.seq as string),
    ))
    .join('');
}

// ---------------------------------------------------------------------------
// Requests and targets

export function lensParams(target: InsertionLensTarget, extra: Record<string, string> = {}): URLSearchParams {
  const params = new URLSearchParams({
    chrom: target.chrom,
    pos: String(Math.round(target.pos)),
    dataset_id: target.datasetId,
    tolerance: String(target.tolerance),
    len_min: String(target.lenMin),
    flank: String(target.flank),
    ...extra,
  });
  if (target.genome) params.set('panel_genome', target.genome);
  if (target.lenMax !== null && target.lenMax !== undefined) params.set('len_max', String(target.lenMax));
  if (target.ref != null && target.len != null) {
    params.set('ref', String(Math.round(target.ref)));
    params.set('length', String(Math.round(target.len)));
  }
  return params;
}

/** A lens target for one insertion cluster (the SV summary's, or the lens list's). */
export function targetForCluster(
  cluster: Pick<InsertionCluster, 'ref' | 'len' | 'uncertainty'>, datasetId: string, chrom: string, previous?: Partial<InsertionLensTarget>,
): InsertionLensTarget {
  return {
    datasetId,
    chrom,
    pos: cluster.ref,
    ref: cluster.ref,
    len: cluster.len,
    // Kept for the fallback (a session without ref/len): the cluster's length class.
    tolerance: Math.max(50, (cluster.uncertainty?.[1] ?? cluster.ref) - cluster.ref),
    lenMin: Math.max(1, Math.floor(cluster.len * 0.8)),
    lenMax: Math.ceil(cluster.len * 1.2),
    ...(previous?.genome !== undefined ? { genome: previous.genome } : {}),
    flank: previous?.flank ?? 1000,
    anchor: previous?.anchor ?? 'consensus',
    reversed: previous?.reversed ?? false,
    ...(previous?.includePutative !== undefined ? { includePutative: previous.includePutative } : {}),
    ...(previous?.includeConflicting !== undefined ? { includeConflicting: previous.includeConflicting } : {}),
    ...(previous?.includeAmbiguous !== undefined ? { includeAmbiguous: previous.includeAmbiguous } : {}),
  };
}

/** The cluster to open from a click at ``pos``: the one with most carriers, nearest first on ties. */
export function pickCluster(clusters: InsertionCluster[], pos: number): InsertionCluster | null {
  let best: InsertionCluster | null = null;
  for (const c of clusters) {
    if (!best || c.carriers > best.carriers
      || (c.carriers === best.carriers && Math.abs(c.ref - pos) < Math.abs(best.ref - pos))) best = c;
  }
  return best;
}
