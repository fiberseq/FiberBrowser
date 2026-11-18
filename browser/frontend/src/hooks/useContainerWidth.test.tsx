/** useContainerWidth follows the element its ref holds, also when a later render puts the ref on another element. */
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useContainerWidth } from './useContainerWidth';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('useContainerWidth', () => {
  const observed: Element[] = [];
  const callbacks: Array<(entries: Array<{ contentRect: { width: number } }>) => void> = [];
  afterEach(() => { vi.unstubAllGlobals(); observed.length = 0; callbacks.length = 0; });

  it('observes the element the ref is on now, not only the first one', () => {
    vi.stubGlobal('ResizeObserver', class {
      cb: (e: Array<{ contentRect: { width: number } }>) => void;
      constructor(cb: (e: Array<{ contentRect: { width: number } }>) => void) { this.cb = cb; callbacks.push(cb); }
      observe(el: Element) { observed.push(el); }
      disconnect() { /* none */ }
    });
    let show: (v: boolean) => void = () => {};
    let seen = 0;
    function Probe() {
      const [content, setContent] = useState(false);
      show = setContent;
      const [width, ref] = useContainerWidth(400);
      seen = width;
      // First an empty state with no measured element, then the content in a div that carries the ref.
      return content ? <div ref={ref} data-testid="content" /> : <span>empty</span>;
    }
    const host = document.createElement('div');
    const root = createRoot(host);
    act(() => root.render(<Probe />));
    expect(observed).toHaveLength(0);
    act(() => show(true));
    expect(observed).toHaveLength(1);
    expect((observed[0] as HTMLElement).dataset.testid).toBe('content');
    act(() => callbacks[0]([{ contentRect: { width: 640 } }]));
    expect(seen).toBe(640);
    act(() => root.unmount());
  });
});
