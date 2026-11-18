import { useState, useEffect, useRef } from 'react';

/**
 * Tracks the width of a container element via ResizeObserver.
 * Returns [width, ref] — attach ref to the container div.
 *
 * The element may change (a component that first returns an empty state, then its content, in another div): each
 * render checks which element the ref holds and observes that one, so the width never stays at the first element's
 * (or the initial value when the first render had none).
 */
export function useContainerWidth(initialWidth = 280): [number, React.RefObject<HTMLDivElement>] {
  const [width, setWidth] = useState(initialWidth);
  const ref = useRef<HTMLDivElement>(null!) as React.RefObject<HTMLDivElement>;
  const observed = useRef<{ el: HTMLDivElement; obs: ResizeObserver } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (observed.current?.el === el) return;
    observed.current?.obs.disconnect();
    observed.current = null;
    // No ResizeObserver (tests, very old browsers): keep the initial width.
    if (!el || typeof ResizeObserver === 'undefined') return;
    const obs = new ResizeObserver(entries => {
      for (const entry of entries) setWidth(entry.contentRect.width);
    });
    obs.observe(el);
    observed.current = { el, obs };
  });

  useEffect(() => () => { observed.current?.obs.disconnect(); observed.current = null; }, []);

  return [width, ref];
}
