/**
 * The graph panel's own coordinates (DESIGN_GRAPH_PANEL.md §1): a target-binding viewport drawn across the panel
 * body right of its label gutter. Nothing here reads the linear panels' axis, insertion expansion or pan offset;
 * a user-reversed panel mirrors the drawing once, leaving biological coordinates unchanged.
 */

export const GRAPH_MAX_TARGET_BP = 50_000;
export const GRAPH_MIN_TARGET_BP = 40;
export const GRAPH_DEFAULT_TARGET_BP = 10_000;

export interface GraphViewport { contig: string; start: number; end: number }

export interface GraphTransform {
  start: number;
  end: number;
  /** Drawing area: x of the data's left edge and its width (CSS px). */
  left: number;
  width: number;
  reversed: boolean;
}

export function makeTransform(view: { start: number; end: number }, left: number, width: number, reversed = false): GraphTransform {
  return { start: view.start, end: Math.max(view.start + 1, view.end), left, width: Math.max(1, width), reversed };
}

/** Screen x of a target coordinate. */
export function toX(t: GraphTransform, pos: number): number {
  const f = (pos - t.start) / (t.end - t.start);
  return t.left + (t.reversed ? 1 - f : f) * t.width;
}

/** Target coordinate at a screen x (only meaningful on target-backed geometry). */
export function fromX(t: GraphTransform, x: number): number {
  let f = (x - t.left) / t.width;
  if (t.reversed) f = 1 - f;
  return t.start + f * (t.end - t.start);
}

/** Pixels per base pair. */
export function bpScale(t: GraphTransform): number {
  return t.width / (t.end - t.start);
}

/**
 * A viewport kept inside the graph's limits: at most 50 kb (the helper's hard ceiling), at least 40 bp, inside
 * [0, size) when the target's size is known (an inferred size is only a lower bound: no right clamp).
 */
export function clampViewport(view: GraphViewport, size: number | null, sizeInferred = false): GraphViewport {
  let width = Math.round(view.end - view.start);
  if (!Number.isFinite(width) || width < GRAPH_MIN_TARGET_BP) width = GRAPH_MIN_TARGET_BP;
  if (width > GRAPH_MAX_TARGET_BP) width = GRAPH_MAX_TARGET_BP;
  const centre = (view.start + view.end) / 2;
  let start = Math.round(centre - width / 2);
  const limit = size != null && !sizeInferred ? size : null;
  if (limit != null && width > limit) width = Math.max(1, limit);
  if (start < 0) start = 0;
  if (limit != null && start + width > limit) start = Math.max(0, limit - width);
  return { contig: view.contig, start, end: start + width };
}

/** The graph target window for a linear view: its centre, at most 50 kb wide. */
export function followViewport(linear: { chrom: string; start: number; end: number }, size: number | null, sizeInferred = false): GraphViewport {
  return clampViewport({ contig: linear.chrom, start: linear.start, end: linear.end }, size, sizeInferred);
}

export function panViewport(view: GraphViewport, deltaBp: number, size: number | null, sizeInferred = false): GraphViewport {
  const d = Math.round(deltaBp);
  return clampViewport({ ...view, start: view.start + d, end: view.end + d }, size, sizeInferred);
}

/** Zoom about `anchor`, keeping it at screen fraction `fraction` (default: its linear fraction of the window). */
export function zoomViewport(view: GraphViewport, factor: number, anchor: number, size: number | null, sizeInferred = false, fraction?: number): GraphViewport {
  const width = (view.end - view.start) * factor;
  const f = fraction ?? (anchor - view.start) / Math.max(1, view.end - view.start);
  const start = anchor - f * width;
  return clampViewport({ ...view, start, end: start + width }, size, sizeInferred);
}

/** "chr3:97,300-97,500" (one-based display is not used anywhere in the graph panel: start is zero-based). */
export function formatLocus(view: GraphViewport): string {
  return `${view.contig}:${Math.round(view.start).toLocaleString('en-US')}-${Math.round(view.end).toLocaleString('en-US')}`;
}

export function formatBp(bp: number): string {
  if (bp >= 10_000) return `${(bp / 1000).toFixed(1)} kb`;
  return `${Math.round(bp).toLocaleString('en-US')} bp`;
}

/** Parse "contig:start-end" (commas allowed); null when it is not one. */
export function parseLocus(text: string): GraphViewport | null {
  const m = text.trim().replace(/,/g, '').match(/^([^\s:]+):(\d+)\s*-\s*(\d+)$/);
  if (!m) return null;
  const start = Number(m[2]), end = Number(m[3]);
  return end > start ? { contig: m[1], start, end } : null;
}

/** Tick positions at a round step, about every 90 px. */
export function ticks(t: GraphTransform, minSpacingPx = 90): { step: number; positions: number[] } {
  const size = t.end - t.start;
  const target = Math.max(1, Math.min(8, Math.floor(t.width / minSpacingPx)));
  const raw = size / target;
  const magnitude = Math.pow(10, Math.floor(Math.log10(Math.max(1, raw))));
  const n = raw / magnitude;
  const step = (n <= 1.5 ? 1 : n <= 3 ? 2 : n <= 7 ? 5 : 10) * magnitude;
  const positions: number[] = [];
  for (let p = Math.ceil(t.start / step) * step; p < t.end; p += step) positions.push(p);
  return { step, positions };
}
