import { useLayoutEffect, useRef, useState } from 'react';
import { fitRow } from '../utils/overflowFit';

/**
 * Fit a row of items (tabs, strip chips) to its width; the rest go to a More
 * menu. Render every item once more, invisibly, inside `measureRef` (in the
 * same order and styling) so their natural widths can be read; `rowRef` is the
 * element whose width the row may use.
 */
export function useRowOverflow(
  count: number,
  options: { gap?: number; moreWidth?: number; pinned?: number[]; deps?: unknown[] } = {},
) {
  const rowRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState<number[]>([]);
  const pinnedKey = (options.pinned ?? []).join(',');
  const depsKey = JSON.stringify(options.deps ?? []);

  useLayoutEffect(() => {
    const row = rowRef.current;
    const measure = measureRef.current;
    if (!row || !measure) return;
    const update = () => {
      const widths = Array.from(measure.children).slice(0, count).map(el => (el as HTMLElement).getBoundingClientRect().width);
      const available = row.clientWidth;
      // No layout (jsdom, display: none): show everything.
      const next = available <= 0 ? [] : fitRow(widths, available, {
        gap: options.gap, moreWidth: options.moreWidth, pinned: options.pinned,
      }).overflow;
      setOverflow(prev => (prev.length === next.length && prev.every((v, i) => v === next[i]) ? prev : next));
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(row);
    observer.observe(measure);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, pinnedKey, depsKey, options.gap, options.moreWidth]);

  // Until the layout effect runs again, the last measurement can name items
  // that are gone (the row just lost some): never hand those out.
  return { rowRef, measureRef, overflow: overflow.some(i => i >= count) ? overflow.filter(i => i < count) : overflow };
}
