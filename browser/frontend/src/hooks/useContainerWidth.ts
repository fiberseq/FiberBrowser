import { useState, useEffect, useRef } from 'react';

/**
 * Tracks the width of a container element via ResizeObserver.
 * Returns [width, ref] — attach ref to the container div.
 */
export function useContainerWidth(initialWidth = 280): [number, React.RefObject<HTMLDivElement>] {
  const [width, setWidth] = useState(initialWidth);
  const ref = useRef<HTMLDivElement>(null!) as React.RefObject<HTMLDivElement>;

  useEffect(() => {
    // No ResizeObserver (tests, very old browsers): keep the initial width.
    if (!ref.current || typeof ResizeObserver === 'undefined') return;
    const obs = new ResizeObserver(entries => {
      for (const entry of entries) setWidth(entry.contentRect.width);
    });
    obs.observe(ref.current);
    return () => obs.disconnect();
  }, []);

  return [width, ref];
}
