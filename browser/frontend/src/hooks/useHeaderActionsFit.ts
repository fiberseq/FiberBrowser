import { useLayoutEffect, useRef, useState } from 'react';

/**
 * Panel header actions that fit (fb-n11-tracks): the owner found close,
 * minimise and expand hidden behind "…" with plenty of room. Headers show as
 * many actions as fit, as icon buttons, in order of importance; only the rest
 * go to "…". Widths are measured (a hidden row of the same buttons, and the
 * header with a ResizeObserver), never assumed.
 */
export interface HeaderActionsFit<K extends string> {
  /** Shown as buttons (importance order). */
  shown: K[];
  /** In the "…" menu (importance order). */
  overflow: K[];
  /** The labelled action (e.g. "Tracks") shows its text too. */
  labelled: boolean;
}

/**
 * Which actions fit in `room` px. `actions` in importance order with their
 * measured widths; `labelExtra`: what the labelled action's text adds; `moreWidth`:
 * the "…" button. Undefined room (no layout): everything, labelled.
 */
export function fitHeaderActions<K extends string>(
  room: number | undefined,
  actions: Array<{ key: K; width: number }>,
  opts: { gap?: number; moreWidth?: number; labelExtra?: number } = {},
): HeaderActionsFit<K> {
  const gap = opts.gap ?? 4;
  const moreWidth = opts.moreWidth ?? 24;
  const labelExtra = opts.labelExtra ?? 0;
  const keys = actions.map(a => a.key);
  if (room === undefined || !Number.isFinite(room)) return { shown: keys, overflow: [], labelled: true };
  const span = (n: number) => actions.slice(0, n).reduce((sum, a) => sum + a.width, 0) + gap * Math.max(0, n - 1);
  const all = span(actions.length);
  if (all <= room) {
    return { shown: keys, overflow: [], labelled: labelExtra > 0 ? all + labelExtra <= room : true };
  }
  let n = actions.length - 1;
  while (n > 0 && span(n) + gap + moreWidth > room) n--;
  return { shown: keys.slice(0, n), overflow: keys.slice(n), labelled: false };
}

/**
 * Measure a header: its width (ResizeObserver) and each action button's
 * width from a hidden row rendered with `data-measure-key` per button.
 */
export function useHeaderMeasure(deps: unknown[]) {
  const headerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<{ width: number | undefined; widths: Record<string, number> }>({ width: undefined, widths: {} });
  const depsKey = JSON.stringify(deps);
  useLayoutEffect(() => {
    const header = headerRef.current;
    const measure = measureRef.current;
    if (!header) return;
    const update = () => {
      const width = header.clientWidth;
      const widths: Record<string, number> = {};
      for (const el of Array.from(measure?.querySelectorAll<HTMLElement>('[data-measure-key]') ?? [])) {
        widths[el.dataset.measureKey!] = el.getBoundingClientRect().width;
      }
      // No layout (jsdom, display: none): leave it to the caller's fallback.
      const next = width > 0 ? width : undefined;
      setState(prev => (prev.width === next && JSON.stringify(prev.widths) === JSON.stringify(widths) ? prev : { width: next, widths }));
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(header);
    if (measure) observer.observe(measure);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depsKey]);
  return { headerRef, measureRef, ...state };
}
