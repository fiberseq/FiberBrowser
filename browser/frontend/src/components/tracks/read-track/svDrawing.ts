/**
 * Structural-variant display (fb-n9-sv): the pure decisions behind drawing
 * size-aware indels on reads and the SV summary band, so they are testable
 * without a canvas. SV events are in absolute reference coordinates
 * (services/sv_events.py); everything here converts with `ref - viewStart`,
 * never with the linked-mode offset (which is for region-relative intervals).
 */
import type { CompactRead, SvCluster, SvEvent, SvSummary } from './types';

export const SV_MIN_LEN_DEFAULT = 50;
export const SV_MIN_SUPPORT_DEFAULT = 3;
export const SV_MIN_LEN_LOWEST = 10;
export const SV_MIN_LEN_HIGHEST = 1_000_000;
/** Allele split: reads must reach this far past both breakpoints to be informative. */
export const SV_SPAN_MARGIN = 100;
/** The SV track's default height (its own row since fb-n11-tracks; the registry has its limits). */
export const SV_BAND_HEIGHT = 44;
/** Every SV glyph takes clicks and hovers over at least this many px across (faint ones too). */
export const SV_MIN_HIT_PX = 10;

export const SV_COLORS = {
  deletion: '#dc2626',
  insertion: '#7c3aed',
  clip: '#64748b',
  connector: '#64748b',
  selected: '#d97706',
  text: '#64748b',
} as const;

export function clampMinSvLen(value: unknown): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return SV_MIN_LEN_DEFAULT;
  return Math.max(SV_MIN_LEN_LOWEST, Math.min(SV_MIN_LEN_HIGHEST, n));
}

export function clampMinSvSupport(value: unknown): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.max(1, Math.min(1_000_000, n)) : SV_MIN_SUPPORT_DEFAULT;
}

function sizeText(len: number): string {
  if (len >= 10_000) return `${Math.round(len / 1000)} kb`;
  if (len >= 1000) return `${(len / 1000).toFixed(1)} kb`;
  return String(len);
}

/** "−1.8 kb" / "−312" for a deletion, "+312" / "+1.8 kb" for an insertion. */
export function formatSvSize(t: 'D' | 'I' | 'S', len: number): string {
  if (t === 'D') return `−${sizeText(len)}`;
  if (t === 'I') return `+${sizeText(len)}`;
  return `${sizeText(len)} clipped`;
}

/** "DEL 1.8 kb @ chr2L:1,234,567": an SV allele split's group-source label. */
export function svAlleleLabel(t: 'D' | 'I', ref: number, len: number, chrom: string): string {
  const size = len >= 1000 ? `${(len / 1000).toFixed(1)} kb` : `${len} bp`;
  return `${t === 'D' ? 'DEL' : 'INS'} ${size} @ ${chrom}:${(ref + 1).toLocaleString('en-US')}`;
}

export const SV_GROUP_NAMES = ['carriers', 'reference', 'not informative'] as const;

export interface ReadSvDraw {
  /** Deleted spans, view-relative [start, end). */
  deletions: Array<{ start: number; end: number; len: number }>;
  /** Insertion points, view-relative. */
  insertions: Array<{ pos: number; len: number; q: number; ref: number }>;
  clips: Array<{ pos: number; side: 'L' | 'R'; len: number }>;
}

const EMPTY_DRAW: ReadSvDraw = { deletions: [], insertions: [], clips: [] };

/** A read's SV events to draw, at least `minLen`, in view-relative coordinates. */
export function readSvDraw(read: Pick<CompactRead, 'sv'>, viewStart: number, viewEnd: number, minLen: number): ReadSvDraw {
  const events = read.sv;
  if (!events || events.length === 0) return EMPTY_DRAW;
  const out: ReadSvDraw = { deletions: [], insertions: [], clips: [] };
  for (const ev of events) {
    if (ev.t === 'SA' || ev.len < minLen) continue;
    if (ev.t === 'D') {
      if (ev.ref + ev.len <= viewStart || ev.ref >= viewEnd) continue;
      out.deletions.push({ start: ev.ref - viewStart, end: ev.ref + ev.len - viewStart, len: ev.len });
    } else if (ev.t === 'I') {
      if (ev.ref < viewStart || ev.ref > viewEnd) continue;
      out.insertions.push({ pos: ev.ref - viewStart, len: ev.len, q: ev.q, ref: ev.ref });
    } else if (ev.t === 'S') {
      if (ev.ref < viewStart || ev.ref > viewEnd) continue;
      out.clips.push({ pos: ev.ref - viewStart, side: ev.side, len: ev.len });
    }
  }
  return out;
}

/** [start, end) minus the cuts (sorted or not), as the pieces left. */
export function subtractSpans(start: number, end: number, cuts: Array<{ start: number; end: number }>): Array<[number, number]> {
  const sorted = [...cuts].sort((a, b) => a.start - b.start);
  const pieces: Array<[number, number]> = [];
  let cur = start;
  for (const cut of sorted) {
    if (cut.end <= cur) continue;
    if (cut.start >= end) break;
    if (cut.start > cur) pieces.push([cur, Math.min(cut.start, end)]);
    cur = Math.max(cur, cut.end);
    if (cur >= end) break;
  }
  if (cur < end) pieces.push([cur, end]);
  return pieces;
}

/** Pixel rectangles of a read body broken at its deletions (reverse-aware). */
export function bodyClipRects(
  extent: { start: number; end: number },
  deletions: Array<{ start: number; end: number }>,
  regionWidth: number,
  toX: (rel: number) => number,
): Array<{ x: number; w: number }> {
  const a = Math.max(0, extent.start);
  const b = Math.min(regionWidth, extent.end);
  if (b <= a) return [];
  return subtractSpans(a, b, deletions).map(([s, e]) => {
    const x1 = toX(s);
    const x2 = toX(e);
    return { x: Math.min(x1, x2), w: Math.max(1, Math.abs(x2 - x1)) };
  });
}

/** Whether a label of `text` fits in `px` of space at ~`charPx` per character. */
export function labelFits(text: string, px: number, charPx = 5.4, pad = 6): boolean {
  return px >= text.length * charPx + pad;
}

/** Font size for labels inside a read row; 0: the row is too short for text. */
export function rowLabelFontPx(rowHeight: number): number {
  if (rowHeight < 7) return 0;
  return Math.min(10, Math.floor(rowHeight - 1));
}

// ---------------------------------------------------------------------------
// Clusters (mirrors services/sv_events.py)

export function breakpointTolerance(len: number): number {
  return Math.max(20, 0.05 * Math.max(0, len));
}

export function eventsMatch(t: 'D' | 'I', ref: number, len: number, cRef: number, cLen: number): boolean {
  const tol = breakpointTolerance(Math.max(len, cLen));
  if (Math.abs(ref - cRef) > tol) return false;
  if (t === 'D' && Math.abs((ref + len) - (cRef + cLen)) > tol) return false;
  const big = Math.max(len, cLen);
  return big <= 0 || Math.abs(len - cLen) <= 0.2 * big;
}

/** Mirrors sv_events.carrier_evidence: evidence is independent of glyph size.
 * Insertion clips keep the existing >=50 bp floor, on either side/strand.
 */
export function readCarriesCluster(read: Pick<CompactRead, 'sv' | 'sv_evidence'>, cluster: Pick<SvCluster, 't' | 'ref' | 'len'>, chrom?: string): boolean {
  const events = read.sv_evidence ?? read.sv ?? [];
  for (const ev of events) {
    if (ev.t === cluster.t && eventsMatch(cluster.t, ev.ref, ev.len, cluster.ref, cluster.len)) return true;
  }
  if (cluster.t === 'I') {
    const tol = Math.max(20, Math.min(breakpointTolerance(cluster.len), 50));
    return events.some(ev => ev.t === 'S' && ev.len >= 50 && Math.abs(ev.ref - cluster.ref) <= tol);
  }
  const end = cluster.ref + cluster.len;
  const tol = breakpointTolerance(cluster.len);
  const clips = events.filter((ev): ev is Extract<SvEvent, { t: 'S' }> => ev.t === 'S');
  const segments = events.filter((ev): ev is Extract<SvEvent, { t: 'SA' }> => ev.t === 'SA');
  for (const clip of clips) {
    for (const seg of segments) {
      if (chrom && seg.chrom !== chrom) continue;
      if (seg.same_strand === false) continue;  // an inversion's segment
      if (clip.side === 'R' && Math.abs(clip.ref - cluster.ref) <= tol && Math.abs(seg.pos - end) <= tol) return true;
      if (clip.side === 'L' && Math.abs(clip.ref - end) <= tol && Math.abs(seg.pos + seg.cigar_ref_len - cluster.ref) <= tol) return true;
    }
  }
  return false;
}

/** Ids of the reads (among `reads`) that carry a cluster's event. */
export function supportingReadIds(reads: CompactRead[], cluster: SvCluster, chrom?: string): string[] {
  return [...new Set(reads.filter(read => readCarriesCluster(read, cluster, chrom)).map(read => read.id))];
}

/** Size and independent-read support gates for summary glyphs and their hit targets. */
export function visibleSvSummary(summary: SvSummary | null | undefined, minLen: number, minSupport = SV_MIN_SUPPORT_DEFAULT): SvSummary | null {
  if (!summary) return null;
  const clusters = summary.clusters.filter(c => c.len >= minLen && c.support >= minSupport);
  const clips = summary.clips.filter(c => c.n >= minSupport);
  if (clusters.length === 0 && clips.length === 0) return null;
  return { ...summary, clusters, clips };
}

/** Glyph sizes for a track `height` px tall: everything scales with the row (fb-n11-tracks). */
export interface SvBandMetrics {
  /** Label font (px). */
  labelPx: number;
  /** Caption font (px). */
  captionPx: number;
  /** Room above the tallest arc for its label. */
  labelRoom: number;
  /** Arcs/flags rise up to this many px above the baseline. */
  inner: number;
  /** Insertion flag width / height. */
  flagW: number;
  flagH: number;
  /** The tallest clip-pile tick. */
  clipMax: number;
  lineWidth: number;
}

export function svBandMetrics(height: number): SvBandMetrics {
  const h = Math.max(16, height);
  const labelPx = Math.round(Math.min(12, Math.max(9, h / 5.5)));
  const captionPx = Math.round(Math.min(11, Math.max(8, h / 6)));
  const labelRoom = labelPx + 4;
  const inner = Math.max(6, h - 3 - labelRoom);
  const flagW = Math.round(Math.min(12, Math.max(7, h / 6)));
  return {
    labelPx, captionPx, labelRoom, inner, flagW, flagH: Math.round(flagW * 0.85),
    clipMax: Math.max(8, Math.round(inner * 0.3)),
    lineWidth: h >= 90 ? 2 : 1.5,
  };
}

/** The pixel span a cluster occupies in the band (arc or flag), reverse-aware. */
export function clusterPixelSpan(c: SvCluster, viewStart: number, toX: (rel: number) => number): [number, number] {
  const a = toX(c.ref - viewStart);
  const b = toX((c.t === 'D' ? c.end : c.ref) - viewStart);
  return [Math.min(a, b), Math.max(a, b)];
}

/**
 * A glyph's hit box in the band (px): its drawn span (an insertion with its
 * flag), widened to at least SV_MIN_HIT_PX so a faint, narrow one is as easy
 * to hover and click as a strong one.
 */
export function clusterHitSpan(c: SvCluster, viewStart: number, toX: (rel: number) => number, flagW = 7, isReversed = false): [number, number] {
  let [a, b] = clusterPixelSpan(c, viewStart, toX);
  if (c.t === 'I') {
    // The stem with half a hit box either side, and the flag beside it.
    a -= SV_MIN_HIT_PX / 2;
    b += SV_MIN_HIT_PX / 2;
    if (isReversed) a = Math.min(a, a + SV_MIN_HIT_PX / 2 - flagW); else b = Math.max(b, b - SV_MIN_HIT_PX / 2 + flagW);
  }
  const short = SV_MIN_HIT_PX - (b - a);
  if (short > 0) {
    a -= short / 2;
    b += short / 2;
  }
  return [a, b];
}

/**
 * The cluster under a band pixel: the narrowest glyph whose hit box holds it
 * (nested arcs and a faint flag beside a strong arc stay reachable).
 */
export function clusterAtBandX(summary: SvSummary | null, x: number, viewStart: number, toX: (rel: number) => number, flagW = 7, isReversed = false): SvCluster | null {
  if (!summary) return null;
  let best: SvCluster | null = null;
  let bestWidth = Infinity;
  for (const c of summary.clusters) {
    const [a, b] = clusterHitSpan(c, viewStart, toX, flagW, isReversed);
    if (x < a || x > b) continue;
    const width = b - a;
    if (width < bestWidth) {
      best = c;
      bestWidth = width;
    }
  }
  return best;
}

/** A clip pile within half a hit box of the pixel (its tick is drawn at the clip position). */
export function clipPileAtBandX(summary: SvSummary | null, x: number, viewStart: number, toX: (rel: number) => number): SvSummary['clips'][number] | null {
  if (!summary) return null;
  let best: SvSummary['clips'][number] | null = null;
  let bestDist = SV_MIN_HIT_PX / 2 + 0.001;
  for (const pile of summary.clips) {
    const dist = Math.abs(toX(pile.ref - viewStart) - x);
    if (dist < bestDist) {
      best = pile;
      bestDist = dist;
    }
  }
  return best;
}

/** What one cluster is, for its tooltip (fb-n11-tracks: faint ones say what they are). */
export interface SvClusterDescription {
  /** "DEL 1.5 kb" / "INS 312 bp". */
  title: string;
  /** "chr2L:10,001–11,503" (deletion) or "after chr2L:14,003" (insertion), with the spread of the reads' breakpoints. */
  where: string;
  /** "Sizes 1,498–1,503 bp" when the carriers differ, else "". */
  sizes: string;
  /** "13 of 21 informative loaded reads carry it (3 by split reads)". */
  support: string;
  /** The CIGAR of its carriers ("1502D in 10 reads, 1498D in 3"), and split-read support. */
  cigar: string;
  /** Faint: weak next to the strongest SV in view. */
  faint: string;
  /** Looks like aligner jitter: other clusters of the same kind and size a few bp apart. */
  jitter: string;
  /** A carrier read and its event (insertions: for the inserted bases). */
  example: { readId: string; event: Extract<SvEvent, { t: 'D' | 'I' }> } | null;
}

const bp = (n: number) => n.toLocaleString('en-US');

export function describeSvCluster(c: SvCluster, summary: SvSummary | null, reads: CompactRead[], chrom: string): SvClusterDescription {
  const size = c.len >= 1000 ? `${(c.len / 1000).toFixed(1)} kb` : `${bp(c.len)} bp`;
  const events: { readId: string; event: Extract<SvEvent, { t: 'D' | 'I' }> }[] = [];
  const seen = new Set<string>();
  for (const read of reads) {
    if (seen.has(read.id)) continue;
    for (const ev of read.sv_evidence ?? read.sv ?? []) {
      if (ev.t === c.t && eventsMatch(c.t, ev.ref, ev.len, c.ref, c.len)) {
        events.push({ readId: read.id, event: ev as Extract<SvEvent, { t: 'D' | 'I' }> });
        seen.add(read.id);
        break;
      }
    }
  }
  const refs = events.map(e => e.event.ref);
  const lens = events.map(e => e.event.len);
  const spread = refs.length > 1 ? Math.max(...refs) - Math.min(...refs) : 0;
  const where = c.t === 'D'
    ? `${chrom}:${bp(c.ref + 1)}–${bp(c.end)}${spread > 0 ? ` (breakpoints vary by ${bp(spread)} bp)` : ''}`
    : `after ${chrom}:${bp(c.ref)}${spread > 0 ? ` (positions vary by ${bp(spread)} bp)` : ''}`;
  const sizes = lens.length > 1 && Math.min(...lens) !== Math.max(...lens)
    ? `Sizes ${bp(Math.min(...lens))}–${bp(Math.max(...lens))} bp` : '';
  const extra = [
    c.sa_support > 0 ? `${c.sa_support} by split reads` : '',
    (c.clip_support ?? 0) > 0 ? `${c.clip_support} clipped at the breakpoint` : '',
  ].filter(Boolean).join(', ');
  // Its denominator and scope (audit SV-3): of the reads loaded for drawing, or of every read in view; the split and
  // the insertion lens always count every read in view.
  const scope = summary?.scope === 'loaded' ? 'loaded reads' : 'reads in view';
  const support = `${c.support.toLocaleString()} of ${c.informative.toLocaleString()} informative ${scope} carry it${extra ? ` (${extra})` : ''}`
    + (summary?.scope === 'loaded' ? ' · the split and the lens count every read in view' : '');
  const op = c.t === 'D' ? 'D' : 'I';
  const counts = new Map<number, number>();
  for (const len of lens) counts.set(len, (counts.get(len) ?? 0) + 1);
  const ops = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const shown = ops.slice(0, 3).map(([len, n], i) => `${len}${op} in ${n}${i === 0 ? ` read${n === 1 ? '' : 's'}` : ''}`);
  const cigar = events.length > 0
    ? `CIGAR ${shown.join(', ')}${ops.length > 3 ? `, ${ops.length - 3} other size${ops.length - 3 === 1 ? '' : 's'}` : ''}`
      + (events.length < c.support ? ` · ${c.support - events.length} by clips / split reads` : '')
    : (c.support > 0 ? `${c.support} read${c.support === 1 ? '' : 's'} by clips / split reads (no CIGAR ${op} in the reads drawn)` : '');
  const maxSupport = Math.max(1, ...(summary?.clusters ?? [c]).map(x => x.support));
  const faint = isMinorCluster(c.support, maxSupport)
    ? `Faint: weak next to the strongest SV in view (${bp(c.support)} vs ${bp(maxSupport)} reads)` : '';
  const near = (summary?.clusters ?? []).filter(o => o.id !== c.id && o.t === c.t
    && Math.abs(o.ref - c.ref) <= breakpointTolerance(Math.max(o.len, c.len)) * 3
    && Math.abs(o.len - c.len) <= Math.max(10, 0.3 * Math.max(o.len, c.len)));
  const jitter = near.length > 0
    ? `Looks like aligner jitter: ${near.length} other ${c.t === 'D' ? 'deletion' : 'insertion'} cluster${near.length === 1 ? '' : 's'} of similar size within ${bp(Math.max(...near.map(o => Math.abs(o.ref - c.ref))))} bp (the same event placed slightly differently)`
    : '';
  return {
    title: `${c.t === 'D' ? 'DEL' : 'INS'} ${size}`,
    where, sizes, support, cigar, faint, jitter,
    example: events[0] ?? null,
  };
}

/**
 * "Split by SV at cursor": the largest-support cluster whose locus (both
 * breakpoints, with their tolerance and a few pixels) contains the position.
 */
export function clusterAtCursor(summary: SvSummary | null, pos: number, bpPerPx = 0): SvCluster | null {
  if (!summary || !Number.isFinite(pos)) return null;
  let best: SvCluster | null = null;
  for (const c of summary.clusters) {
    const tol = breakpointTolerance(c.len) + 4 * bpPerPx;
    const end = c.t === 'D' ? c.end : c.ref;
    if (pos < c.ref - tol || pos > end + tol) continue;
    if (!best || c.support > best.support || (c.support === best.support && c.len > best.len)) best = c;
  }
  return best;
}

/** The SV event of one read nearest a position (within `tolBp`), for the read menu. */
export function readSvEventAt(read: Pick<CompactRead, 'sv' | 'sv_evidence'>, pos: number, tolBp: number, minLen: number): Extract<SvEvent, { t: 'D' | 'I' }> | null {
  let best: Extract<SvEvent, { t: 'D' | 'I' }> | null = null;
  let bestDist = Infinity;
  for (const ev of read.sv_evidence ?? read.sv ?? []) {
    if ((ev.t !== 'D' && ev.t !== 'I') || ev.len < minLen) continue;
    const end = ev.t === 'D' ? ev.ref + ev.len : ev.ref;
    const dist = pos < ev.ref ? ev.ref - pos : pos > end ? pos - end : 0;
    if (dist <= tolBp && dist < bestDist) {
      best = ev;
      bestDist = dist;
    }
  }
  return best;
}

/** The cluster of the summary a read's event belongs to (or a one-read cluster). */
export function clusterForEvent(summary: SvSummary | null, ev: Extract<SvEvent, { t: 'D' | 'I' }>): SvCluster {
  for (const c of summary?.clusters ?? []) {
    if (c.t === ev.t && eventsMatch(ev.t, ev.ref, ev.len, c.ref, c.len)) return c;
  }
  return {
    id: `${ev.t}:${ev.ref}:${ev.len}`, t: ev.t, ref: ev.ref, len: ev.len,
    end: ev.t === 'D' ? ev.ref + ev.len : ev.ref, support: 1, informative: 1, sa_support: 0, clip_support: 0,
  };
}

/** "13/21" (supporting / informative reads). */
export function clusterSupportLabel(c: SvCluster): string {
  return `${c.support}/${c.informative}`;
}

/** The arc's height in the band: by support relative to the strongest cluster. */
export function arcHeight(c: SvCluster, maxSupport: number, bandInner: number): number {
  const frac = maxSupport > 0 ? c.support / maxSupport : 1;
  return Math.max(6, Math.round(bandInner * (0.35 + 0.65 * frac)));
}

/** A label the SV band would like to draw (anchor in canvas px). */
export interface SvLabelCandidate {
  /** Texts to try, longest first ("+9.2 kb 3267/3600", then "3267/3600"). */
  texts: string[];
  x: number;
  y: number;
  align: 'left' | 'right' | 'center';
  /** Higher draws first and wins a collision (the cluster's support). */
  priority: number;
  color: string;
}

export interface SvPlacedLabel { text: string; x: number; y: number; align: 'left' | 'right' | 'center'; color: string }

/**
 * Labels that don't overlap: strongest first; a label that would collide with
 * one already placed tries its shorter text, else it is left out (the cluster's
 * mark stays and its tooltip still names it). Deep data puts the same SV a few
 * bp apart in several clusters (aligner placement in a repeat); without this
 * their labels printed over each other ("45/2308" + "3" read as "45/23083").
 */
export function placeSvLabels(
  candidates: SvLabelCandidate[], measure: (text: string) => number, fontPx = 9, gap = 3,
): SvPlacedLabel[] {
  const placed: { l: number; r: number; t: number; b: number }[] = [];
  const out: SvPlacedLabel[] = [];
  const order = [...candidates].sort((a, b) => b.priority - a.priority);
  for (const c of order) {
    for (const text of c.texts) {
      if (!text) continue;
      const w = measure(text);
      const l = c.align === 'center' ? c.x - w / 2 : c.align === 'right' ? c.x - w : c.x;
      const box = { l: l - gap, r: l + w + gap, t: c.y - fontPx / 2 - 1, b: c.y + fontPx / 2 + 1 };
      if (placed.some(p => box.l < p.r && box.r > p.l && box.t < p.b && box.b > p.t)) continue;
      placed.push(box);
      out.push({ text, x: c.x, y: c.y, align: c.align, color: c.color });
      break;
    }
  }
  return out;
}

/** A cluster this weak next to the strongest in view is drawn faintly (still hoverable). */
export function isMinorCluster(support: number, maxSupport: number): boolean {
  return maxSupport >= 50 && support < Math.max(2, 0.02 * maxSupport);
}
