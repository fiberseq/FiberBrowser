import { useEffect, useState, type RefObject } from 'react';
import { useBrowserPerformanceProfile } from '../utils/performanceProfile';

export function useCanvasVisibility<T extends Element>(
  ref: RefObject<T>,
  forceVisible = false,
  rootMargin = '800px',
): boolean {
  const lowMemory = useBrowserPerformanceProfile().tier === 'low';
  const margin = lowMemory ? '100px' : rootMargin;
  const [visible, setVisible] = useState(() => {
    if (forceVisible) return true;
    if (typeof window === 'undefined') return true;
    return !('IntersectionObserver' in window);
  });

  useEffect(() => {
    if (forceVisible) {
      setVisible(true);
      return;
    }
    if (typeof window === 'undefined' || !('IntersectionObserver' in window)) {
      setVisible(true);
      return;
    }
    const element = ref.current;
    if (!element) {
      setVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      entries => {
        const inView = entries.some(entry => entry.isIntersecting);
        if (!inView && lowMemory && element instanceof HTMLCanvasElement) {
          element.width = 1;
          element.height = 1;
        }
        setVisible(inView);
      },
      { root: null, rootMargin: margin },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, forceVisible, margin, lowMemory]);

  return visible;
}
