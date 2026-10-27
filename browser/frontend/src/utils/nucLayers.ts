/**
 * Nucleosome scan layers on read payloads (nucleosome panel DESIGN §5.4, §7.1; feature hub CONTRACTS §11.3).
 *
 * - `nucsz`: one mark per footprint (nucleosome and TF calls). Bytes: coarse (low 4 bits = code, +16 for a TF call
 *   or a footprint overlapping one), named (absolute calibration only), round(255 x posterior), z byte
 *   (clip(round(20 z + 128), 0, 254), 255 = missing). Marks recolour the nuc/tf items through colormap rules.
 * - `nucseg`: segment rows (code < 16) that partition the measurable stretches, and event rows (code >= 16) over
 *   them. Drawn as a thin lane at the bottom of each read row.
 * - `nucmol` / `nfrmol`: per-molecule scalar groups (one whole-read interval of codec bytes). Never drawn and never
 *   offered as a layer toggle.
 *
 * Older tables-mode scans name the bytes q0..q3; the byte order is the same, so bytes are read by position.
 */
import type { ColorRule } from '../types';

export const NUC_SIZE_LAYER = 'nucsz';
export const NUC_SEG_LAYER = 'nucseg';
export const NUC_GROUP_LAYERS = [NUC_SIZE_LAYER, NUC_SEG_LAYER] as const;

/** Per-molecule scalar groups: never a layer to draw or toggle. */
export const NUC_SCALAR_GROUPS: ReadonlySet<string> = new Set(['nucmol', 'nfrmol']);

/** Layers the generic overlay painter and the footprint hit test leave alone. */
export const NUC_UNDRAWN_LAYERS: ReadonlySet<string> = new Set([NUC_SIZE_LAYER, NUC_SEG_LAYER, ...NUC_SCALAR_GROUPS]);

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

/** Named codes (nucsz byte 2). Nonzero only with an absolute calibration. */
export const NUC_NAMED_CLASSES: readonly NucClass[] = [
  { code: 1, label: 'small' },
  { code: 2, label: 'hexasome' },
  { code: 3, label: 'octasome' },
  { code: 4, label: 'chromatosome' },
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

export function nucNamedName(code: number): string | null {
  if (!code) return null;
  return NUC_NAMED_CLASSES.find(c => c.code === code)?.label ?? `code ${code}`;
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
  named: number;
  posterior: number;
  z: number;
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
  const marks: NucSizeMark[] = [];
  let maxLen = 0;
  for (let i = 0; i < intervals.length; i++) {
    const [start, end] = intervals[i];
    const c = coarse[i];
    if (c === undefined || !Number.isFinite(start) || !Number.isFinite(end)) continue;
    marks.push({
      start,
      end,
      coarse: c,
      named: q[1]?.[i] ?? 0,
      posterior: q[2]?.[i] ?? 0,
      z: q[3]?.[i] ?? NUC_Z_MISSING,
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

/**
 * The mark of an item spanning [start, end) (view-relative, the payload's own frame): the mark with the identical
 * span, else the mark containing the item's midpoint. Calls split at deletions or lift gaps give several items that
 * share one mark. When marks overlap (a TF call over a nucleosome), the one overlapping the item most wins.
 */
export function nucSizeMarkFor(index: NucSizeIndex | null | undefined, start: number, end: number): NucSizeMark | null {
  if (!index) return null;
  const { marks } = index;
  for (let k = lowerBound(marks, start); k < marks.length && marks[k].start === start; k++) {
    if (marks[k].end === end) return marks[k];
  }
  const mid = (start + end) / 2;
  let best: NucSizeMark | null = null;
  let bestOverlap = -Infinity;
  for (let k = upperBound(marks, mid) - 1; k >= 0 && marks[k].start + index.maxLen > mid; k--) {
    const mark = marks[k];
    if (mark.end <= mid) continue;
    const overlap = Math.min(end, mark.end) - Math.max(start, mark.start);
    if (overlap > bestOverlap || (overlap === bestOverlap && best && mark.end - mark.start < best.end - best.start)) {
      best = mark;
      bestOverlap = overlap;
    }
  }
  return best;
}

/** The smallest mark covering a view-relative position (hover). */
export function nucSizeMarkAt(index: NucSizeIndex | null | undefined, pos: number): NucSizeMark | null {
  if (!index) return null;
  const { marks } = index;
  let best: NucSizeMark | null = null;
  for (let k = upperBound(marks, pos) - 1; k >= 0 && marks[k].start + index.maxLen > pos; k--) {
    const mark = marks[k];
    if (mark.end <= pos) continue;
    if (!best || mark.end - mark.start < best.end - best.start) best = mark;
  }
  return best;
}

/** One hover line for a size mark, e.g. "mono · z −0.4 · P 92%". */
export function describeNucSizeMark(mark: NucSizeMark): string {
  const parts = [nucCoarseName(nucCoarseCode(mark.coarse))];
  const named = nucNamedName(mark.named);
  if (named) parts.push(named);
  const z = nucZFromByte(mark.z);
  parts.push(z === null ? 'z missing' : `z ${formatSigned(z)}`);
  parts.push(`P ${Math.round(100 * nucPosteriorFromByte(mark.posterior))}%`);
  if (nucCoarseIsTf(mark.coarse)) parts.push('TF call or overlaps one');
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
