import { useEffect, useState, type RefObject } from 'react';

/** The nearest ancestor that scrolls vertically (a panel's body), or null. */
export function scrollParentOf(el: Element | null): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if (oy === 'auto' || oy === 'scroll') return p;
  }
  return null;
}

/**
 * The height a scroll box inside a scrolling panel takes so that it fills the panel (R4): the panel's visible height
 * less `reserve` (what stays stuck at the panel's top, e.g. its tabs, and a margin), never below `min`. Null when the
 * box is not inside a scrolling panel or the panel has no height yet (tests): the caller keeps its fixed cap then.
 * Follows the panel's size (window, docking, row resizes).
 */
export function useFillHeight(ref: RefObject<HTMLElement | null>, { min = 240, reserve = 64 }: { min?: number; reserve?: number } = {}): number | null {
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    const parent = scrollParentOf(el);
    if (!el || !parent) return;
    const measure = () => {
      const h = parent.clientHeight;
      setHeight(h > 0 ? Math.max(min, Math.round(h - reserve)) : null);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const ro = new ResizeObserver(() => measure());
    ro.observe(parent);
    return () => ro.disconnect();
  }, [ref, min, reserve]);
  return height;
}
