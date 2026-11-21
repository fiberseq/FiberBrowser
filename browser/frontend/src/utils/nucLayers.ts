/**
 * Nucleosome scan layers on read payloads (nucleosome panel DESIGN §5.4, §7.1; feature hub CONTRACTS §11.3).
 *
 * - `nucsz`: one mark per footprint (nucleosome and TF calls). Bytes: coarse (low 4 bits = code, +16 for a TF call
 *   or a footprint overlapping one), round(255 x posterior), z byte (clip(round(20 z + 128), 0, 254), 255 =
 *   missing). Marks recolour the nuc/tf items through colormap rules. FiberHMM before 3.2.0 wrote a named-class byte
 *   second (four bytes); named classes were removed (owner, 20 Nov 2026), so that byte is skipped and never read
 *   (`nucszByteIndex`).
 * - `nucseg`: segment rows (code < 16) that partition the measurable stretches, and event rows (code >= 16) over
 *   them. Drawn as a thin lane at the bottom of each read row.
 * - `nucreg`: regularity tiles (score byte, period byte; FiberHMM fiberhmm.nuc.regularity). Drawn as an
 *   interpolated colour lane over the top of each read row.
 * - `nucmol` / `nfrmol`: per-molecule scalar groups (one whole-read interval of codec bytes). Never drawn and never
 *   offered as a layer toggle.
 *
 * Older tables-mode scans name the bytes q0..q3; the byte order is the same, so bytes are read by position.
 */

/** Positions of the nucsz bytes read (coarse, posterior, z) for a layer with `tracks` byte tracks: four (FiberHMM before
 * 3.2.0: coarse, named, posterior, z; the named byte is skipped) or three (coarse, posterior, z). */
export function nucszByteIndex(tracks: number): { coarse: 0; posterior: number; z: number } {
  return tracks === 3 ? { coarse: 0, posterior: 1, z: 2 } : { coarse: 0, posterior: 2, z: 3 };
}
import { patchLabelsFor, patchLabelsVersion } from './nucPatchLabels';
import type { ColorRule } from '../types';

export const NUC_SIZE_LAYER = 'nucsz';
export const NUC_SEG_LAYER = 'nucseg';
export const NUC_GROUP_LAYERS = [NUC_SIZE_LAYER, NUC_SEG_LAYER, 'nucreg', 'nucpatch'] as const;

/** Per-molecule scalar groups: never a layer to draw or toggle. */
export const NUC_SCALAR_GROUPS: ReadonlySet<string> = new Set(['nucmol', 'nfrmol']);

/** Layers the generic overlay painter and the footprint hit test leave alone. */
export const NUC_UNDRAWN_LAYERS: ReadonlySet<string> = new Set([NUC_SIZE_LAYER, NUC_SEG_LAYER, 'nucreg', 'nucpatch', ...NUC_SCALAR_GROUPS]);

/** Item layers whose calls have a `nucsz` mark: primary footprints and the nuc/tf layers. */
export const NUC_MARK_ITEM_LAYERS: ReadonlySet<string> = new Set(['nuc', 'footprint', 'tf']);

export function isNucScalarGroup(name: string): boolean {
  return NUC_SCALAR_GROUPS.has(name);
}

// ---------------------------------------------------------------------------
// Size classes (nucsz)

export interface NucClass {
  code: number;
  label: string;
}

/** Coarse codes (nucsz byte 1, low 4 bits). */
export const NUC_COARSE_CLASSES: readonly NucClass[] = [
  { code: 1, label: 'short' },
  { code: 2, label: 'mono' },
  { code: 3, label: 'long' },
  { code: 4, label: 'multi (2)' },
  { code: 5, label: 'multi (3+)' },
  { code: 0, label: "can't tell" },
  { code: 6, label: 'edge-truncated' },
];

export const NUC_TF_BIT = 16;
export const NUC_Z_MISSING = 255;

export function nucCoarseCode(coarseByte: number): number {
  return coarseByte & 15;
}

export function nucCoarseIsTf(coarseByte: number): boolean {
  return (coarseByte & NUC_TF_BIT) !== 0;
}

export function nucCoarseName(code: number): string {
  return NUC_COARSE_CLASSES.find(c => c.code === code)?.label ?? `code ${code}`;
}

/** The density-matched z of a z byte (null for the missing byte 255). */
export function nucZFromByte(zByte: number): number | null {
  if (!Number.isFinite(zByte) || zByte >= NUC_Z_MISSING) return null;
  return (zByte - 128) / 20;
}

export function nucPosteriorFromByte(byte: number): number {
  return Math.max(0, Math.min(255, byte)) / 255;
}

/** Template colours per coarse code (the "Nucleosome size classes" rules). */
export const NUC_SIZE_CLASS_COLORS: Readonly<Record<number, string>> = {
  1: '#f59e0b',  // short: amber
  2: '#16a34a',  // mono: green
  3: '#0d9488',  // long: teal
  4: '#2563eb',  // multi (2): blue
  5: '#7c3aed',  // multi (3+): violet
  0: '#9ca3af',  // can't tell: grey
  6: '#d1d5db',  // edge-truncated: light grey
};

export const NUC_SIZE_RULE_ID_PREFIX = 'nuc-size-';

/** The built-in "Nucleosome size classes" rules: one per coarse code, nucleosome calls only. */
export function nucSizeClassRules(): ColorRule[] {
  return NUC_COARSE_CLASSES.map(cls => ({
    id: `${NUC_SIZE_RULE_ID_PREFIX}${cls.code}`,
    name: `Nuc ${cls.label}`,
    color: NUC_SIZE_CLASS_COLORS[cls.code],
    opacity: 1,
    sizeMin: 1,
    sizeMax: null,
    targetLayers: [],
    conditions: [],
    nucCoarse: [cls.code],
    nucTf: false,
    enabled: true,
  }));
}

/** One `nucsz` mark: its view-relative span and bytes. */
export interface NucSizeMark {
  start: number;
  end: number;
  coarse: number;
  posterior: number;
  z: number;
  /** The footprint's molecular length (the interval's third value), kept through clipping: two overlapping
   * footprints clipped to the same displayed span still differ by it. Absent: unknown. */
  len?: number;
}

/** A read's `nucsz` marks sorted by start, for lookups by item span or position. */
export interface NucSizeIndex {
  marks: NucSizeMark[];
  /** Longest mark (bp): bounds the backward scan of a containment lookup. */
  maxLen: number;
}

interface LayerLike {
  intervals?: [number, number, number][];
  qualities?: (number[] | undefined)[] | null;
}

const sizeIndexCache = new WeakMap<object, NucSizeIndex | null>();

/**
 * Index a `nucsz` layer (built once per payload object). Null when the layer is absent or ships no qualities:
 * a mark without its bytes cannot answer a class condition.
 */
export function nucSizeIndex(layer: LayerLike | null | undefined): NucSizeIndex | null {
  if (!layer || typeof layer !== 'object') return null;
  if (sizeIndexCache.has(layer)) return sizeIndexCache.get(layer) ?? null;
  const index = buildNucSizeIndex(layer);
  sizeIndexCache.set(layer, index);
  return index;
}

export function buildNucSizeIndex(layer: LayerLike): NucSizeIndex | null {
  const intervals = layer.intervals ?? [];
  const q = layer.qualities ?? [];
  const coarse = q[0];
  if (!intervals.length || !coarse) return null;
  const at = nucszByteIndex(q.length);
  const marks: NucSizeMark[] = [];
  let maxLen = 0;
  for (let i = 0; i < intervals.length; i++) {
    const [start, end, len] = intervals[i];
    const c = coarse[i];
    if (c === undefined || !Number.isFinite(start) || !Number.isFinite(end)) continue;
    marks.push({
      start,
      end,
      coarse: c,
      posterior: q[at.posterior]?.[i] ?? 0,
      z: q[at.z]?.[i] ?? NUC_Z_MISSING,
      ...(Number.isFinite(len) ? { len } : {}),
    });
    if (end - start > maxLen) maxLen = end - start;
  }
  if (!marks.length) return null;
  marks.sort((a, b) => a.start - b.start || a.end - b.end);
  return { marks, maxLen };
}

/** First mark with start >= pos. */
function lowerBound(marks: NucSizeMark[], pos: number): number {
  let lo = 0, hi = marks.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (marks[mid].start < pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First mark with start > pos. */
function upperBound(marks: NucSizeMark[], pos: number): number {
  let lo = 0, hi = marks.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (marks[mid].start <= pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function sameMarkBytes(a: NucSizeMark, b: NucSizeMark): boolean {
  return a.coarse === b.coarse && a.posterior === b.posterior && a.z === b.z;
}

/**
 * The mark of an item spanning [start, end) (view-relative, the payload's own frame) whose molecular length is `len`
 * (the item interval's third value): the mark with the identical span, else the mark containing the item's
 * midpoint. Calls split at deletions or lift gaps give several items that share one mark. When marks overlap (a TF
 * call over a nucleosome), a mark of the item's own length wins, else the one overlapping the item most. Clipping can
 * give overlapping footprints the same displayed span: those are told apart by length. A mark of another known
 * length is never the item's (a filter may have removed the item's own mark: no mark, not a neighbour's); marks or
 * items without a length match by span. A tie that is still ambiguous (marks with different bytes) gives no mark
 * rather than another footprint's.
 */
export function nucSizeMarkFor(index: NucSizeIndex | null | undefined, start: number, end: number, len?: number): NucSizeMark | null {
  if (!index) return null;
  const { marks } = index;
  const hasLen = len !== undefined && Number.isFinite(len);
  const ofLen = (list: NucSizeMark[]) => {
    if (!hasLen) return list;
    const same = list.filter(mark => mark.len === len);
    return same.length ? same : list.filter(mark => mark.len === undefined);
  };
  const exact: NucSizeMark[] = [];
  for (let k = lowerBound(marks, start); k < marks.length && marks[k].start === start; k++) {
    if (marks[k].end === end) exact.push(marks[k]);
  }
  const pool = ofLen(exact);
  if (pool.length) return pool.every(mark => sameMarkBytes(mark, pool[0])) ? pool[0] : null;
  const mid = (start + end) / 2;
  const covering: NucSizeMark[] = [];
  for (let k = upperBound(marks, mid) - 1; k >= 0 && marks[k].start + index.maxLen > mid; k--) {
    if (marks[k].end > mid) covering.push(marks[k]);
  }
  let best: NucSizeMark | null = null;
  let bestOverlap = -Infinity;
  let ambiguous = false;
  for (const mark of ofLen(covering)) {
    const overlap = Math.min(end, mark.end) - Math.max(start, mark.start);
    const span = mark.end - mark.start;
    if (!best || overlap > bestOverlap || (overlap === bestOverlap && span < best.end - best.start)) {
      best = mark;
      bestOverlap = overlap;
      ambiguous = false;
    } else if (overlap === bestOverlap && span === best.end - best.start && !sameMarkBytes(mark, best)) {
      ambiguous = true;
    }
  }
  return ambiguous ? null : best;
}

/** The smallest mark covering a view-relative position (hover); among marks clipped to the same span, the shortest
 * footprint. */
export function nucSizeMarkAt(index: NucSizeIndex | null | undefined, pos: number): NucSizeMark | null {
  if (!index) return null;
  const { marks } = index;
  let best: NucSizeMark | null = null;
  for (let k = upperBound(marks, pos) - 1; k >= 0 && marks[k].start + index.maxLen > pos; k--) {
    const mark = marks[k];
    if (mark.end <= pos) continue;
    const span = mark.end - mark.start, bestSpan = best ? best.end - best.start : Infinity;
    if (!best || span < bestSpan || (span === bestSpan && (mark.len ?? Infinity) < (best.len ?? Infinity))) best = mark;
  }
  return best;
}

/** One hover line for a size mark, e.g. "mono · z −0.4 · P 92%". */
export function describeNucSizeMark(mark: NucSizeMark): string {
  const parts = [nucCoarseName(nucCoarseCode(mark.coarse))];
  const z = nucZFromByte(mark.z);
  parts.push(z === null ? 'z missing' : `z ${formatSigned(z)}`);
  parts.push(`P ${Math.round(100 * nucPosteriorFromByte(mark.posterior))}%`);
  if (nucCoarseIsTf(mark.coarse)) parts.push('TF call or overlaps one');
  return parts.join(' · ');
}

/** One hover line for class and z bytes alone (graph reads carry no posterior), e.g. "mono · z −0.4". */
export function describeNucClassBytes(coarse: number, zByte: number | null | undefined): string {
  const parts = [nucCoarseName(nucCoarseCode(coarse))];
  const z = zByte == null ? null : nucZFromByte(zByte);
  parts.push(z === null ? 'z missing' : `z ${formatSigned(z)}`);
  if (nucCoarseIsTf(coarse)) parts.push('TF call or overlaps one');
  return parts.join(' · ');
}

function formatSigned(value: number): string {
  const text = Math.abs(value).toFixed(1);
  return value < 0 ? `−${text}` : text;
}

// ---------------------------------------------------------------------------
// Array segments and events (nucseg)

export const NUC_SEG_REGULAR = 1;
export const NUC_SEG_DISORDERED = 2;
export const NUC_SEG_LOW_INFORMATION = 3;
export const NUC_SEG_UNDETERMINED = 4;
export const NUC_EVENT_UNDERSIZED = 16;
export const NUC_EVENT_MISSING = 17;

const NUC_SEG_NAMES: Record<number, string> = {
  [NUC_SEG_REGULAR]: 'regular',
  [NUC_SEG_DISORDERED]: 'disordered',
  [NUC_SEG_LOW_INFORMATION]: 'low information',
  [NUC_SEG_UNDETERMINED]: 'undetermined',
  [NUC_EVENT_UNDERSIZED]: 'undersized footprint run',
  [NUC_EVENT_MISSING]: 'missing nucleosome',
};

export function nucSegName(code: number): string {
  return NUC_SEG_NAMES[code] ?? `code ${code}`;
}

export function isNucSegEvent(code: number): boolean {
  return code >= 16;
}

/** Lane colours on a light and a dark read ground. Low information is drawn dotted in its colour. */
const NUC_SEG_COLORS: Record<'light' | 'dark', Record<number, string>> = {
  light: {
    [NUC_SEG_REGULAR]: '#15803d',
    [NUC_SEG_DISORDERED]: '#ea580c',
    [NUC_SEG_LOW_INFORMATION]: '#94a3b8',
    [NUC_SEG_UNDETERMINED]: '#cbd5e1',
    [NUC_EVENT_UNDERSIZED]: '#d97706',
    [NUC_EVENT_MISSING]: '#dc2626',
  },
  dark: {
    [NUC_SEG_REGULAR]: '#4ade80',
    [NUC_SEG_DISORDERED]: '#fb923c',
    [NUC_SEG_LOW_INFORMATION]: '#64748b',
    [NUC_SEG_UNDETERMINED]: '#475569',
    [NUC_EVENT_UNDERSIZED]: '#fbbf24',
    [NUC_EVENT_MISSING]: '#f87171',
  },
};

export function nucSegColor(code: number, dark = false): string {
  return NUC_SEG_COLORS[dark ? 'dark' : 'light'][code] ?? (dark ? '#475569' : '#cbd5e1');
}

/** One `nucseg` row: view-relative span, code and its two value bytes. */
export interface NucSegRow {
  start: number;
  end: number;
  code: number;
  /** Segments: round(255 x posterior). Events: round(10 x LLR), capped at 255. */
  value: number;
  /** Regular segments: q-hat − 100. Events: the count. Else 0. */
  extra: number;
}

export interface NucSegRows {
  segments: NucSegRow[];
  events: NucSegRow[];
}

const segRowsCache = new WeakMap<object, NucSegRows | null>();

/** A `nucseg` layer split into segment rows and event rows (built once per payload object). */
export function nucSegRows(layer: LayerLike | null | undefined): NucSegRows | null {
  if (!layer || typeof layer !== 'object') return null;
  if (segRowsCache.has(layer)) return segRowsCache.get(layer) ?? null;
  const rows = buildNucSegRows(layer);
  segRowsCache.set(layer, rows);
  return rows;
}

export function buildNucSegRows(layer: LayerLike): NucSegRows | null {
  const intervals = layer.intervals ?? [];
  const q = layer.qualities ?? [];
  const codes = q[0];
  if (!intervals.length || !codes) return null;
  const segments: NucSegRow[] = [];
  const events: NucSegRow[] = [];
  for (let i = 0; i < intervals.length; i++) {
    const [start, end] = intervals[i];
    const code = codes[i];
    if (code === undefined || !code || !Number.isFinite(start) || !Number.isFinite(end)) continue;
    const row = { start, end, code, value: q[1]?.[i] ?? 0, extra: q[2]?.[i] ?? 0 };
    (isNucSegEvent(code) ? events : segments).push(row);
  }
  if (!segments.length && !events.length) return null;
  return { segments, events };
}

/** The segment row and the event rows covering a view-relative position (hover). */
export function nucSegRowsAt(rows: NucSegRows | null | undefined, pos: number): { segment: NucSegRow | null; events: NucSegRow[] } {
  if (!rows) return { segment: null, events: [] };
  const covers = (row: NucSegRow) => row.start <= pos && pos < row.end;
  return { segment: rows.segments.find(covers) ?? null, events: rows.events.filter(covers) };
}

/** One hover line for a nucseg row, e.g. "regular · P 85% · q̂ 187 bp" or "missing nucleosome · LLR 5.1". */
export function describeNucSegRow(row: NucSegRow): string {
  const parts = [nucSegName(row.code)];
  if (isNucSegEvent(row.code)) {
    parts.push(`LLR ${(row.value / 10).toFixed(1)}${row.value >= 255 ? '+' : ''}`);
    if (row.extra > 0) {
      parts.push(row.code === NUC_EVENT_UNDERSIZED
        ? `${row.extra} footprint${row.extra === 1 ? '' : 's'}`
        : `${row.extra} mark${row.extra === 1 ? '' : 's'}`);
    }
  } else {
    parts.push(`${row.code === NUC_SEG_UNDETERMINED ? 'mean P(regular)' : 'P'} ${Math.round(100 * nucPosteriorFromByte(row.value))}%`);
    if (row.code === NUC_SEG_REGULAR) parts.push(`q̂ ${row.extra + 100} bp`);
  }
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Lane geometry

export interface NucSegLane {
  /** Top of the lane strip (canvas px). */
  y: number;
  /** Strip height (px). */
  h: number;
  /** A 1 px gap in the read's ground colour above the lane, so it reads apart from the calls. */
  gapAbove: boolean;
  /** Room for the missing-nucleosome triangle above the lane. */
  markers: boolean;
}

/**
 * The segment lane of a read row whose drawn body is [y, y + bodyH): the bottom 1–3 px. Rows thinner than 2 px get
 * no lane.
 */
export function nucSegLaneGeometry(y: number, bodyH: number): NucSegLane | null {
  if (!Number.isFinite(bodyH) || bodyH < 2) return null;
  const h = bodyH < 4 ? 1 : Math.min(3, Math.floor(bodyH * 0.35));
  return { y: y + bodyH - h, h, gapAbove: bodyH >= 10, markers: bodyH >= 6 };
}

/** The undersized-run bar inside a lane: its top part, leaving 1 px of the segment colour below when there is room. */
export function nucUndersizedBar(lane: NucSegLane): { y: number; h: number } {
  return lane.h >= 2 ? { y: lane.y, h: lane.h - 1 } : { y: lane.y, h: lane.h };
}

/** The missing-nucleosome triangle above the lane, pointing down at the event centre (null without room). */
export function nucMissingTriangle(lane: NucSegLane, cx: number): [number, number][] | null {
  if (!lane.markers) return null;
  const top = lane.y - (lane.gapAbove ? 1 : 0) - 3;
  return [[cx - 2.5, top], [cx + 2.5, top], [cx, lane.y]];
}

// ---------------------------------------------------------------------------
// Regularity (nucreg): FiberHMM's sliding-window FFT periodicity score per tile (fiberhmm.nuc.regularity)

export const NUC_REG_LAYER = 'nucreg';
/** Score byte: 1 + round(clip((score - SCORE_LO) / SCORE_SPAN, 0, 1) x 254); 0 = no score. */
export const NUC_REG_SCORE_LO = -2;
export const NUC_REG_SCORE_SPAN = 10;
/** Period byte: period - 100; 0 = none. */
export const NUC_REG_PERIOD_OFFSET = 100;
/** The lane scale without a computed reference (typical Hia5 random-packing median, three log2 units above it). */
export const NUC_REG_FALLBACK_SCALE: NucRegScale = { zero: 3, top: 6, reference: false };
/** The continuous ramp: pale at the random-packing reference median, deep blue at the observed 95th percentile. */
export const NUC_REG_RAMP = ['#f7f4dc', '#c7e4b4', '#6ebea5', '#2c8ca0', '#20528c', '#24225a'] as const;

export interface NucRegScale { zero: number; top: number; reference?: boolean }

export function nucRegScoreFromByte(q: number): number | null {
  if (!Number.isFinite(q) || q <= 0) return null;
  return NUC_REG_SCORE_LO + NUC_REG_SCORE_SPAN * (q - 1) / 254;
}

export function nucRegPeriodFromByte(q: number): number | null {
  return Number.isFinite(q) && q > 0 ? q + NUC_REG_PERIOD_OFFSET : null;
}

const hexRgb = (hex: string): [number, number, number] => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
const RAMP_RGB = NUC_REG_RAMP.map(hexRgb);

/** The ramp colour of t in [0, 1] (clipped), as rgb(). */
export function nucRegRampColor(t: number): string {
  const x = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0)) * (RAMP_RGB.length - 1);
  const i = Math.min(RAMP_RGB.length - 2, Math.floor(x));
  const f = x - i;
  const a = RAMP_RGB[i], b = RAMP_RGB[i + 1];
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)})`;
}

/** A score's position on the scale: 0 at (or below) the reference median, 1 at (or above) the top. */
export function nucRegScaleT(score: number, scale: NucRegScale): number {
  const span = scale.top - scale.zero;
  return span > 0 ? Math.max(0, Math.min(1, (score - scale.zero) / span)) : 0;
}

/** One scored tile: its view-relative span, centre, score (log2) and local repeat length. `refDelta`: the shift of
 * the random-packing reference at the tile's own window width (a live layer's `ref_delta` quality, ends 'truncated':
 * below 0 for the cut windows at read ends; 0 otherwise), so the lane reads the tile against its own width. */
export interface NucRegTile { start: number; end: number; centre: number; score: number; period: number | null; refDelta?: number }

/** A live nucreg layer's `ref_delta` byte: 128 + 40 x delta (log2); 0 = none (services/nuc/regularity.encode_ref_delta). */
export function nucRegRefDeltaFromByte(q: number): number {
  return Number.isFinite(q) && q > 0 ? (q - 128) / 40 : 0;
}

export interface NucRegRows {
  tiles: NucRegTile[]; scale: NucRegScale; step: number;
  /** View-relative span the window grid reaches: inside it a position without a score had too few calls (drawn
   * hatched); outside it no window reaches (left empty). Without the backend's reach: the first to the last tile. */
  reach: [number, number];
}

const regRowsCache = new WeakMap<object, NucRegRows | null>();

/** A `nucreg` layer's scored tiles sorted by start (built once per payload object). */
export function nucRegRows(layer: (LayerLike & { scale?: NucRegScale }) | null | undefined): NucRegRows | null {
  if (!layer || typeof layer !== 'object') return null;
  if (regRowsCache.has(layer)) return regRowsCache.get(layer) ?? null;
  const rows = buildNucRegRows(layer);
  regRowsCache.set(layer, rows);
  return rows;
}

export function buildNucRegRows(layer: LayerLike & { scale?: NucRegScale; reach?: [number, number]; quality_names?: string[] }): NucRegRows | null {
  const intervals = layer.intervals ?? [];
  const q = layer.qualities ?? [];
  const scores = q[0];
  if (!intervals.length || !scores) return null;
  const di = Array.isArray(layer.quality_names) ? layer.quality_names.indexOf('ref_delta') : -1;
  const deltas = di >= 0 ? q[di] : undefined;
  const tiles: NucRegTile[] = [];
  const lens: number[] = [];
  for (let i = 0; i < intervals.length; i++) {
    const [start, end, len] = intervals[i];
    const score = nucRegScoreFromByte(scores[i] ?? 0);
    if (score === null || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const tile: NucRegTile = { start, end, centre: (start + end) / 2, score, period: nucRegPeriodFromByte(q[1]?.[i] ?? 0) };
    if (deltas) tile.refDelta = nucRegRefDeltaFromByte(deltas[i] ?? 0);
    tiles.push(tile);
    if (Number.isFinite(len) && len > 0) lens.push(len);
  }
  if (!tiles.length) return null;
  tiles.sort((a, b) => a.start - b.start);
  const s = layer.scale;
  const scale = s && Number.isFinite(s.zero) && Number.isFinite(s.top) && s.top > s.zero ? s : NUC_REG_FALLBACK_SCALE;
  // The tile step: the median molecular tile length (read-end modes stretch the outermost tiles).
  lens.sort((a, b) => a - b);
  const step = lens.length ? lens[lens.length >> 1] : Math.max(...tiles.map(t => t.end - t.start));
  const r = layer.reach;
  const reach: [number, number] = Array.isArray(r) && r.length === 2 && Number.isFinite(r[0]) && Number.isFinite(r[1]) && r[1] > r[0]
    ? [r[0], r[1]] : [tiles[0].start, tiles[tiles.length - 1].end];
  return { tiles, scale, step, reach };
}

/** Whether a view-relative position lies inside the window grid's reach (a gap there: too few calls). */
export function nucRegInReach(rows: NucRegRows, pos: number): boolean {
  return pos >= rows.reach[0] && pos < rows.reach[1];
}

/** The tile covering a view-relative position (hover). */
export function nucRegTileAt(rows: NucRegRows | null | undefined, pos: number): NucRegTile | null {
  return rows?.tiles.find(t => t.start <= pos && pos < t.end) ?? null;
}

/** The interpolated score at a position: linear between neighbouring tile centres, flat within the outer half
 * tiles, none across a gap wider than one tile step (a window without a score). `againstWidth`: each tile's score
 * less its reference shift at its own window width (`refDelta`): what the lane's colour reads against the scale. */
export function nucRegScoreAt(rows: NucRegRows, pos: number, againstWidth = false): number | null {
  const t = rows.tiles;
  const sc = (x: NucRegTile) => (againstWidth ? x.score - (x.refDelta ?? 0) : x.score);
  let lo = 0, hi = t.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (t[mid].centre <= pos) lo = mid + 1; else hi = mid; }
  const right = lo < t.length ? t[lo] : null;
  const left = lo > 0 ? t[lo - 1] : null;
  const gap = 1.5 * rows.step;
  if (left && right && right.centre - left.centre <= gap) {
    const f = (pos - left.centre) / (right.centre - left.centre || 1);
    return sc(left) + (sc(right) - sc(left)) * f;
  }
  if (left && pos < left.end) return sc(left);
  if (right && pos >= right.start) return sc(right);
  return null;
}

export function describeNucRegTile(tile: NucRegTile, scale: NucRegScale): string {
  const above = tile.score - (tile.refDelta ?? 0) - scale.zero;
  const parts = [`regularity ${tile.score.toFixed(2)}`];
  if (scale.reference) parts.push(`${above >= 0 ? '+' : '−'}${Math.abs(above).toFixed(2)} vs random packing`);
  if (tile.period) parts.push(`repeat ${tile.period} bp`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Regularity patches (nucpatch): FiberHMM call_patches on the nucreg tiles (fiberhmm.nuc.patches), coloured by the
// shared geometry they belong to (the panel's last geometry analysis with these parameters)

export const NUC_PATCH_LAYER = 'nucpatch';
/** Patch kinds (FiberHMM nucpatch flag bit 4 marks a low-regularity patch). */
export type NucPatchKind = 'high' | 'low';
export const NUC_PATCH_LOW_FLAG = 16;
/** A high-regularity patch outside every geometry (the red landmark), and the high geometries' colours (warm hues). */
export const NUC_PATCH_COLOR = '#c8323c';
export const NUC_GEO_COLORS = ['#c8323c', '#7b2cbf', '#e07a1f', '#bc4b51', '#9c6644', '#ff006e', '#5f0f40', '#d4a017',
  '#a4133c', '#8338ec', '#f15bb5', '#6f1d1b'] as const;
/** A low-regularity patch outside every geometry, and the low geometries' colours (cool hues: blues, teals, greens). */
export const NUC_PATCH_LOW_COLOR = '#1e3a8a';
export const NUC_GEO_LOW_COLORS = ['#1d4ed8', '#0e7490', '#2b9348', '#3a86ff', '#1b998b', '#4361ee', '#0f766e', '#6a994e',
  '#0369a1', '#4d7c0f', '#155e75', '#475569'] as const;
const cycle = (list: readonly string[], n: number) => list[((Math.max(1, n) - 1) % list.length + list.length) % list.length];
/** The colour of a geometry by its 1-based number within its kind (folded geometries: their root's number). */
export const nucGeoColor = (n: number, kind: NucPatchKind = 'high') => cycle(kind === 'low' ? NUC_GEO_LOW_COLORS : NUC_GEO_COLORS, n);
/** A patch's colour in the read lane: its geometry's root, else the kind's own colour. */
export const nucPatchColor = (p: { root: number; kind: NucPatchKind }) =>
  p.root ? nucGeoColor(p.root, p.kind) : p.kind === 'low' ? NUC_PATCH_LOW_COLOR : NUC_PATCH_COLOR;

export interface NucPatch {
  start: number; end: number; score: number | null; period: number | null;
  openStart: boolean; openEnd: boolean; snappedStart: boolean; snappedEnd: boolean;
  /** 1-based geometry number within its kind (0 = in none) and the root it is folded into (itself when not folded). */
  geometry: number; root: number;
  kind: NucPatchKind;
}

const patchRowsCache = new WeakMap<object, { version: number; ds: string; rows: NucPatch[] | null }>();

/** The label overlay of a nucpatch layer (utils/nucPatchLabels.ts): its `lk`, `pg` and the row's dataset; undefined
 * when its own geometry/root bytes apply. */
export function nucPatchOverlay(layer: unknown, datasetId?: string | null): ReadonlyMap<number, [number, number]> | undefined {
  if (!layer || typeof layer !== 'object') return undefined;
  const l = layer as { lk?: unknown; pg?: unknown };
  return patchLabelsFor(l.lk, l.pg, datasetId);
}

/** A row's patches. Their geometry labels come from the lane's label overlay (utils/nucPatchLabels.ts: a live row's
 * `lk`, `pg` and `patch` index, from its dataset's entry) when the overlay's patch generation is the row's, else from
 * the row's own geometry/root bytes. */
export function nucPatchRows(layer: LayerLike | null | undefined, datasetId?: string | null): NucPatch[] | null {
  if (!layer || typeof layer !== 'object') return null;
  const version = patchLabelsVersion();
  const ds = datasetId ?? '';
  const hit = patchRowsCache.get(layer);
  if (hit && hit.version === version && hit.ds === ds) return hit.rows;
  const intervals = layer.intervals ?? [];
  const q = layer.qualities ?? [];
  const overlay = nucPatchOverlay(layer, datasetId);
  const out: NucPatch[] = [];
  for (let i = 0; i < intervals.length; i++) {
    const [start, end] = intervals[i];
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const flags = q[2]?.[i] ?? 0;
    out.push({ start, end, score: nucRegScoreFromByte(q[0]?.[i] ?? 0), period: nucRegPeriodFromByte(q[1]?.[i] ?? 0),
      openStart: !!(flags & 1), openEnd: !!(flags & 2), snappedStart: !!(flags & 4), snappedEnd: !!(flags & 8),
      ...labelsOf(q, i, overlay), kind: flags & NUC_PATCH_LOW_FLAG ? 'low' : 'high' });
  }
  out.sort((a, b) => a.start - b.start);
  const rows = out.length ? out : null;
  patchRowsCache.set(layer, { version, ds, rows });
  return rows;
}

function labelsOf(q: ReadonlyArray<ReadonlyArray<number> | undefined>, i: number,
  overlay: ReadonlyMap<number, [number, number]> | undefined): { geometry: number; root: number } {
  const index = q[5]?.[i];
  if (overlay && index) {
    const got = overlay.get(index - 1);
    return { geometry: got?.[0] ?? 0, root: got?.[1] ?? 0 };
  }
  return { geometry: q[3]?.[i] ?? 0, root: q[4]?.[i] ?? 0 };
}

/**
 * An interval's qualities by name, as rules read them (quality gates). For a nucpatch layer the `geometry` and `root`
 * values are the ones the lane draws: the label overlay's when it applies to the row (same patch generation), else
 * the row's own bytes; rules, Cluster enrichment and the lane never disagree on a patch's geometry.
 */
export function effectiveLayerQualities(layerName: string, layer: {
  quality_names?: string[]; qualities?: ReadonlyArray<ReadonlyArray<number> | undefined>;
} | null | undefined, i: number, overlay?: ReadonlyMap<number, [number, number]>): Record<string, number> {
  const out: Record<string, number> = {};
  if (!layer?.quality_names || !layer.qualities) return out;
  layer.quality_names.forEach((name, q) => {
    const value = layer.qualities?.[q]?.[i];
    if (value !== undefined) out[name] = value;
  });
  if (layerName === 'nucpatch' && overlay) {
    const index = out.patch;
    if (index) {
      const got = overlay.get(index - 1);
      out.geometry = got?.[0] ?? 0;
      out.root = got?.[1] ?? 0;
    }
  }
  return out;
}

export function nucPatchAt(rows: NucPatch[] | null | undefined, pos: number): NucPatch | null {
  return rows?.find(p => p.start <= pos && pos < p.end) ?? null;
}

export function describeNucPatch(p: NucPatch, scale?: NucRegScale): string {
  const parts = [p.kind === 'low' ? 'low-regularity patch' : 'high-regularity patch'];
  const L = p.kind === 'low' ? 'L' : 'G';
  if (p.geometry) parts.push(p.root && p.root !== p.geometry ? `${L}${p.geometry} (part of ${L}${p.root})` : `${L}${p.geometry}`);
  if (p.score != null) parts.push(scale?.reference ? `mean ${p.score.toFixed(2)} (${p.score - scale.zero >= 0 ? '+' : '−'}${Math.abs(p.score - scale.zero).toFixed(2)})` : `mean ${p.score.toFixed(2)}`);
  if (p.period) parts.push(`repeat ${p.period} bp`);
  const ends = [p.openStart ? 'open start' : p.snappedStart ? 'start snapped' : '', p.openEnd ? 'open end' : p.snappedEnd ? 'end snapped' : ''].filter(Boolean);
  if (ends.length) parts.push(ends.join(', '));
  return parts.join(' · ');
}
