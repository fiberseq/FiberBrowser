/** Convert viewport pixels to the logical pixels used by track drawing.
 * CSS zoom is already included in DOMRect, but not clientWidth/clientHeight.
 */
export function logicalOffset(offset:number,logicalSize:number,renderedSize:number):number {
  return renderedSize>0&&logicalSize>0?offset*logicalSize/renderedSize:offset;
}

/**
 * Where the hover crosshair of the track container ends (audit L8): the
 * bottom of the lowest panel under the pointer (`[data-panel-id]`, any row),
 * in the container's logical pixels; null when no panel is under it. Without
 * it the line ran on past the panels to the window's bottom edge.
 */
export function crosshairBottomAt(container: Element, clientX: number): number | null {
  const box = container.getBoundingClientRect();
  let bottom: number | null = null;
  container.querySelectorAll('[data-panel-id]').forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0 || clientX < r.left || clientX > r.right) return;
    bottom = Math.max(bottom ?? -Infinity, r.bottom);
  });
  if (bottom === null) return null;
  const logical = logicalOffset(Math.min(bottom, box.bottom) - box.top, container.clientHeight, box.height);
  return Math.max(0, logical);
}
