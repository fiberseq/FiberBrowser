/**
 * The hand-off's 150 ms crossfade (DESIGN_GRAPH_PRIMARY §7.3 "The return is a 150 ms crossfade"): when a host's body
 * switches between its graph and its linear tracks, the new body fades in over 150 ms. Nothing moves for a viewer
 * who asked for reduced motion, or where the Web Animations API is missing (tests, old engines).
 */
export const CROSSFADE_MS = 150;

export function prefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** Fade elements in (opacity 0 → 1, 150 ms). Returns how many were animated. */
export function fadeIn(elements: Iterable<Element | null | undefined>, ms = CROSSFADE_MS): number {
  if (prefersReducedMotion()) return 0;
  let n = 0;
  for (const el of elements) {
    if (!el || typeof (el as HTMLElement).animate !== 'function') continue;
    (el as HTMLElement).animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms, easing: 'ease-out' });
    n++;
  }
  return n;
}

/** The parts of a panel below its header (its body), found from an element in the header's notices: the panel's
 * children after the one holding it. The linear tracks are drawn by the dataset panel itself, so they are faded
 * from here. */
export function panelBodyParts(insideHeader: Element | null): Element[] {
  const panel = insideHeader?.closest('[data-panel-id]');
  if (!panel) return [];
  const children = [...panel.children];
  const at = children.findIndex(c => c.contains(insideHeader));
  return at < 0 ? [] : children.slice(at + 1);
}
