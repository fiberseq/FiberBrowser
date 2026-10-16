import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react';

/** Arrow keys move the drawer's edge this far (Shift: four times as far). */
export const DRAWER_RESIZE_STEP = 16;

/**
 * The next drawer width for a key on its resize handle (the handle is on the
 * drawer's left edge: Left widens it, Right narrows it), or null for other keys.
 */
export function drawerWidthForKey(key: string, shift: boolean, width: number, min: number, max: number): number | null {
  const step = DRAWER_RESIZE_STEP * (shift ? 4 : 1);
  const clamp = (w: number) => Math.max(min, Math.min(max, w));
  switch (key) {
    case 'ArrowLeft': return clamp(width + step);
    case 'ArrowRight': return clamp(width - step);
    case 'Home': return min;
    case 'End': return max;
    default: return null;
  }
}

/**
 * The side-panel drawer's left edge: drag to change its width, or focus it and
 * use the arrow keys (Home / End: narrowest / widest). Double-click: the default width.
 */
export function DrawerResizeHandle({ width, min, max, zoom = 1, onResize, onReset }: {
  width: number;
  min: number;
  max: number;
  /** The container's UI-size zoom: pointer moves are in screen px, widths in layout px. */
  zoom?: number;
  onResize: (width: number) => void;
  onReset: () => void;
}) {
  const drag = useRef<{ x: number; width: number; cursor: string; userSelect: string } | null>(null);
  // Ends a drag (pointer up or cancel, lost capture, or the drawer going away mid-drag):
  // the page's cursor and text selection come back as they were.
  const finish = () => {
    if (!drag.current) return;
    document.body.style.cursor = drag.current.cursor;
    document.body.style.userSelect = drag.current.userSelect;
    drag.current = null;
  };
  useEffect(() => finish, []);
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    finish();
    drag.current = { x: e.clientX, width, cursor: document.body.style.cursor, userSelect: document.body.style.userSelect };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const next = drag.current.width + (drag.current.x - e.clientX) / (zoom || 1);
    onResize(Math.max(min, Math.min(max, Math.round(next))));
  };
  const end = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    finish();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = drawerWidthForKey(e.key, e.shiftKey, width, min, max);
    if (next == null) return;
    // Handled here: the arrows must not pan the genome as well.
    e.preventDefault();
    e.stopPropagation();
    onResize(next);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the side panels"
      aria-valuenow={Math.round(width)}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      tabIndex={0}
      title="Drag to resize the side panels (arrow keys when focused; double-click for the default width)"
      data-testid="analysis-overlay-resize"
      className="group/drawer-resize absolute -left-1.5 top-0 bottom-0 z-20 flex w-3 cursor-col-resize items-center justify-center outline-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={finish}
      onDoubleClick={(e) => { e.stopPropagation(); onReset(); }}
      onKeyDown={onKeyDown}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div
        className="h-16 w-[3px] rounded-full bg-gray-400/70 opacity-40 transition-opacity group-hover/drawer-resize:opacity-100 group-focus-visible/drawer-resize:opacity-100 group-focus-visible/drawer-resize:bg-brand-500 dark:bg-white/40"
        aria-hidden="true"
      />
    </div>
  );
}
