import { type RefObject, useEffect } from 'react';
import { useEphemeralStore } from '../stores/ephemeralStore';
import { useBrowserPerformanceProfile } from '../utils/performanceProfile';
const promoted = new Set<HTMLElement>();

interface PanOffsetTransformOptions {
  enabled?: boolean;
  /** The view this element shows ('main', or a panel navigated on its own):
   * it follows only a pan offset of that scope. */
  scope?: string;
}

export function usePanOffsetTransform<T extends HTMLElement>(
  ref: RefObject<T>,
  { enabled = true, scope = 'main' }: PanOffsetTransformOptions = {},
): void {
  const { useGpuPanTransforms: promote, maxPromotedCanvases } = useBrowserPerformanceProfile();
  useEffect(() => {
    const element = ref.current;
    if (!element || !enabled) {
      if (element) {
        element.style.transform = '';
        element.style.willChange = '';
      }
      return;
    }

    let lastVisualOffset: number | null = null;
    const apply = (offset: number) => {
      const visualOffset = offset;
      if (visualOffset === lastVisualOffset) return;
      lastVisualOffset = visualOffset;
      if (visualOffset === 0) {
        promoted.delete(element);
        element.style.transform = '';
        element.style.willChange = '';
        return;
      }
      const useGpu = promote && (promoted.has(element) || promoted.size < maxPromotedCanvases);
      if (useGpu) promoted.add(element);
      element.style.transform = useGpu
        ? `translate3d(${visualOffset}px, 0, 0)`
        : `translateX(${visualOffset}px)`;
      element.style.willChange = useGpu ? 'transform' : '';
    };

    const offsetFor = (state: { panOffset: number; panScope: string }) => (
      state.panScope === scope ? state.panOffset : 0
    );
    apply(offsetFor(useEphemeralStore.getState()));
    const unsubscribe = useEphemeralStore.subscribe(state => apply(offsetFor(state)));
    return () => {
      unsubscribe();
      promoted.delete(element);
      element.style.transform = '';
      element.style.willChange = '';
    };
  }, [ref, enabled, scope, promote, maxPromotedCanvases]);
}
