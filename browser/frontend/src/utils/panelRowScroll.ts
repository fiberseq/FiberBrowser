/**
 * Where a sideways-scrolling panel row (the scroll policy, utils/panelRowLayout.ts) shows what (usability audit
 * round 2, N4). Pure: positions in the row's content coordinates (0 = the content's left edge), so the scroll target
 * is a `scrollLeft`.
 *
 * - `offscreenPanels`: which panels are not wholly in view, on each side (the edge fades' counts, "◂ 3 panels").
 * - `scrollToReveal`: the scroll that brings the nearest hidden panel on one side wholly into view (a fade's click).
 * - `scrollForOpened`: the scroll after panels open. Only as far as needed to show the new panel (a set of panels, as one
 *   opening: the whole set, or its start), and the panel the user last worked in stays in view whenever both fit (it is
 *   never pushed off the left edge when that is avoidable). When both don't fit the new panels win: the user just asked
 *   for them, and the edge chip on the side where the other went pulses (`sideOf`).
 */

export interface PanelSpan {
  id: string;
  /** Its left and right edges in the row's content (px). */
  left: number;
  right: number;
}

export interface RowViewport {
  scrollLeft: number;
  /** The scroller's visible width. */
  clientWidth: number;
  /** The scroller's content width (scrollLeft runs from 0 to scrollWidth - clientWidth). */
  scrollWidth: number;
  /** Visible width covered at the right (a pinned drawer over the row): panels under it are not in view. */
  rightInset?: number;
}

/** A panel this close to wholly visible (px cut off) counts as in view: a gap or a rounding never makes a fade. */
export const OFFSCREEN_TOLERANCE = 8;
/** Room left between a panel brought into view and the row's edge (the gap between panels). */
export const REVEAL_MARGIN = 8;

function visibleRange(v: RowViewport): [number, number] {
  return [v.scrollLeft, v.scrollLeft + Math.max(0, v.clientWidth - (v.rightInset ?? 0))];
}

function clampScroll(v: RowViewport, x: number): number {
  return Math.max(0, Math.min(Math.max(0, v.scrollWidth - v.clientWidth), Math.round(x)));
}

/** The panels cut off at the left and at the right (in row order). A panel wider than the view counts on the left. */
export function offscreenPanels(spans: PanelSpan[], v: RowViewport, tolerance = OFFSCREEN_TOLERANCE): { left: PanelSpan[]; right: PanelSpan[] } {
  const [lo, hi] = visibleRange(v);
  const left: PanelSpan[] = [];
  const right: PanelSpan[] = [];
  for (const s of [...spans].sort((a, b) => a.left - b.left)) {
    if (s.left < lo - tolerance) left.push(s);
    else if (s.right > hi + tolerance) right.push(s);
  }
  return { left, right };
}

/**
 * The scroll that shows `span` wholly, moving as little as possible. A panel wider than the view shows its left edge,
 * unless that is in view already and the move is rightwards (`towards` 'right'): then its right edge, so a cue's
 * clicks always move on.
 */
function scrollToShow(span: PanelSpan, v: RowViewport, margin: number, towards?: 'left' | 'right'): number {
  const width = Math.max(0, v.clientWidth - (v.rightInset ?? 0));
  const lo = span.left - margin;
  const hi = span.right + margin;
  if (hi - lo >= width) {
    const leftInView = span.left >= v.scrollLeft - OFFSCREEN_TOLERANCE && span.left <= v.scrollLeft + OFFSCREEN_TOLERANCE + margin;
    return clampScroll(v, towards === 'right' && leftInView ? hi - width : lo);
  }
  return clampScroll(v, Math.min(lo, Math.max(v.scrollLeft, hi - width)));
}

/** Whether `span` is wholly in view (within the tolerance). */
export function inView(span: PanelSpan, v: RowViewport, tolerance = OFFSCREEN_TOLERANCE): boolean {
  const [lo, hi] = visibleRange(v);
  return span.left >= lo - tolerance && span.right <= hi + tolerance;
}

/** A fade's click: the nearest panel cut off on that side, wholly in view (null: nothing hidden there). */
export function scrollToReveal(spans: PanelSpan[], v: RowViewport, side: 'left' | 'right', margin = REVEAL_MARGIN): number | null {
  const hidden = offscreenPanels(spans, v);
  const order = side === 'left' ? [...hidden.left].reverse() : hidden.right;
  // The nearest one that moves the row (a panel wider than the view may be as far as it goes already).
  for (const next of order) {
    const target = scrollToShow(next, v, margin, side);
    if (target !== Math.round(v.scrollLeft)) return target;
  }
  return null;
}

/** The least move that shows [lo, hi] (content px) wholly, or its left end when it is wider than the view. */
function scrollToSpan(lo: number, hi: number, v: RowViewport): number {
  const width = Math.max(0, v.clientWidth - (v.rightInset ?? 0));
  if (hi - lo >= width) return clampScroll(v, lo);
  return clampScroll(v, Math.min(lo, Math.max(v.scrollLeft, hi - width)));
}

/**
 * After panels open (`opened`, in the row): the scroll that shows them, keeping the panel the user last worked in
 * (`keep`) in view too when that fits. Null: no scroll needed (everything asked for is already in view, or nothing
 * opened here).
 *
 * - One panel: only as far as needed to show it; the working one stays too when both fit, else the new panel wins (the
 *   user just asked for it; the edge chip says where the other went).
 * - A set (a split's panels, reference copies; usability round 3, R2): one opening. The whole set when it fits in the
 *   view (and the working panel too when that also fits); else its start (its first group, and the split strip over
 *   it) at the left edge. The set's nearest panel being in view is not enough: a split inserted left of the view showed
 *   one panel and hid the other (B8).
 */
export function scrollForOpened(opened: PanelSpan[], keep: PanelSpan | null, v: RowViewport, margin = REVEAL_MARGIN): number | null {
  if (!opened.length) return null;
  const width = Math.max(0, v.clientWidth - (v.rightInset ?? 0));
  const set = [...opened].sort((a, b) => a.left - b.left);
  const lo = set[0].left - margin;
  const hi = Math.max(...set.map(s => s.right)) + margin;
  const other = keep && !set.some(s => s.id === keep.id) ? keep : null;
  if (set.every(s => inView(s, v))) {
    // A set already in view: the working panel comes back too when the panels inserted before it pushed it off and
    // both fit (Codex review). One panel asked for again moves nothing (the working panel is never brought back by it).
    if (set.length < 2 || !other || inView(other, v)) return null;
    const lo2 = Math.min(lo, other.left - margin);
    const hi2 = Math.max(hi, other.right + margin);
    if (hi2 - lo2 > width) return null;
    const next = scrollToSpan(lo2, hi2, v);
    return next === Math.round(v.scrollLeft) ? null : next;
  }
  let next: number;
  if (hi - lo <= width) {
    // The whole set (one panel, or a set that fits): with the working panel too when both fit.
    const withKeep = other ? [Math.min(lo, other.left - margin), Math.max(hi, other.right + margin)] : null;
    next = withKeep && withKeep[1] - withKeep[0] <= width ? scrollToSpan(withKeep[0], withKeep[1], v) : scrollToSpan(lo, hi, v);
  } else if (set.length === 1) {
    next = scrollToShow(set[0], v, margin);
  } else {
    // Wider than the view: its start at the left edge.
    next = clampScroll(v, lo);
  }
  return next === Math.round(v.scrollLeft) ? null : next;
}

/**
 * Where the working panel is after a scroll to `scrollLeft`: past the left or the right edge (its edge chip then
 * pulses, round 3 R2), or null when it is in view (or there is none).
 */
export function sideOf(keep: PanelSpan | null, v: RowViewport, scrollLeft: number): 'left' | 'right' | null {
  if (!keep) return null;
  const at = { ...v, scrollLeft };
  if (inView(keep, at)) return null;
  const [lo] = visibleRange(at);
  return keep.left < lo - OFFSCREEN_TOLERANCE ? 'left' : 'right';
}

/** "3 panels" / "1 panel". */
export function panelCountLabel(n: number): string {
  return `${n} panel${n === 1 ? '' : 's'}`;
}
