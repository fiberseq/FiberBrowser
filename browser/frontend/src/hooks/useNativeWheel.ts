import { useEffect, type RefObject, type WheelEvent as ReactWheelEvent } from 'react';

/** React delegates wheel events with a passive listener. A track needs a non-passive listener so its modified
 * wheel gesture can prevent browser zoom and horizontal page scrolling. Handlers only use shared event fields. */
export function useNativeWheel<T extends HTMLElement>(ref: RefObject<T>, handler: (event: ReactWheelEvent<T>) => void): void {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => handler(event as unknown as ReactWheelEvent<T>);
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  });
}
