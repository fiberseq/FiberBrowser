import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * An element's width, kept current as it resizes (drawer, side dock, full view) and when the element
 * itself is replaced (a tab's body unmounted and mounted again): returns a callback ref to put on it.
 * A hidden element (width 0: an inactive drawer tab) keeps the last width rather than shrinking to `min`.
 */
export function useElementWidth(min: number, initial: number): [(el: HTMLElement | null) => void, number] {
  const [width, setWidth] = useState(initial);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    const update = () => {
      const w = Math.floor(el.clientWidth);
      if (w > 0) setWidth(Math.max(min, w));
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    observer.current = new ResizeObserver(update);
    observer.current.observe(el);
  }, [min]);
  useEffect(() => () => observer.current?.disconnect(), []);
  return [ref, width];
}
