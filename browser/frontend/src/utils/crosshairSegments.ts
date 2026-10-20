/**
 * The container-wide crosshair (TrackContainer) is one vertical line over the panels under the pointer. Panels with
 * coordinates of their own (the graph view, DESIGN_GRAPH_PANEL.md §1) mark their element `data-crosshair-exclude`:
 * the line is cut where it would cross them, so a linear position never lands on a nonlinear panel.
 */
export interface CrosshairRect { left: number; right: number; top: number; bottom: number }
export interface CrosshairSegment { top: number; bottom: number }

/** The parts of [top, bottom) at x that no excluded rectangle covers (container coordinates). */
export function crosshairSegments(x: number, top: number, bottom: number, excluded: readonly CrosshairRect[]): CrosshairSegment[] {
  const cuts = excluded
    .filter(r => x >= r.left && x <= r.right && r.bottom > top && r.top < bottom)
    .map(r => ({ top: Math.max(top, r.top), bottom: Math.min(bottom, r.bottom) }))
    .sort((a, b) => a.top - b.top);
  const out: CrosshairSegment[] = [];
  let y = top;
  for (const cut of cuts) {
    if (cut.top > y) out.push({ top: y, bottom: cut.top });
    y = Math.max(y, cut.bottom);
  }
  if (bottom > y) out.push({ top: y, bottom });
  return out;
}

/** Whether a label box overlaps any excluded rectangle. */
export function overlapsExcluded(box: CrosshairRect, excluded: readonly CrosshairRect[]): boolean {
  return excluded.some(r => box.left < r.right && box.right > r.left && box.top < r.bottom && box.bottom > r.top);
}

/** The excluded rectangles inside a container, in its own (unzoomed, scrolled) coordinates. */
export function excludedRects(container: HTMLElement): CrosshairRect[] {
  const box = container.getBoundingClientRect();
  const zoom = container.offsetWidth > 0 && box.width > 0 ? box.width / container.offsetWidth : 1;
  return [...container.querySelectorAll<HTMLElement>('[data-crosshair-exclude]')].map(el => {
    const r = el.getBoundingClientRect();
    return {
      left: (r.left - box.left) / zoom + container.scrollLeft, right: (r.right - box.left) / zoom + container.scrollLeft,
      top: (r.top - box.top) / zoom + container.scrollTop, bottom: (r.bottom - box.top) / zoom + container.scrollTop,
    };
  });
}
