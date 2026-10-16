import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useElementWidth } from './useElementWidth';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** Lens-like: the measured body lives in one tab; switching tabs unmounts it. */
function Lens({ onWidth }: { onWidth: (w: number) => void }) {
  const [tab, setTab] = useState<'one' | 'other'>('one');
  const [ref, width] = useElementWidth(240, 600);
  onWidth(width);
  return (
    <div>
      <button data-testid="tab" onClick={() => setTab(t => (t === 'one' ? 'other' : 'one'))} />
      {tab === 'one' ? <div ref={ref} data-testid="body" /> : <div>other</div>}
    </div>
  );
}

describe('a tab\'s body that mounts again is measured again', () => {
  let container: HTMLDivElement;
  let root: Root;
  let observed: Array<{ el: Element; cb: () => void }> = [];
  let clientWidth = 900;
  beforeEach(() => {
    observed = [];
    clientWidth = 900;
    vi.stubGlobal('ResizeObserver', class {
      cb: () => void;
      constructor(cb: () => void) { this.cb = cb; }
      observe(el: Element) { observed.push({ el, cb: this.cb }); }
      disconnect() { observed = observed.filter(o => o.cb !== this.cb); }
    });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return clientWidth; } });
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); delete (HTMLElement.prototype as any).clientWidth; });

  it('measures the body, follows resizes, and the new body after a tab round trip', () => {
    let width = 0;
    act(() => root.render(<Lens onWidth={w => { width = w; }} />));
    expect(width).toBe(900);
    clientWidth = 1400;  // the drawer widened / full view
    act(() => observed.forEach(o => o.cb()));
    expect(width).toBe(1400);
    act(() => (container.querySelector('[data-testid="tab"]') as HTMLButtonElement).click());
    expect(observed).toHaveLength(0);  // the old body is no longer watched
    clientWidth = 1100;  // side dock
    act(() => (container.querySelector('[data-testid="tab"]') as HTMLButtonElement).click());
    expect(width).toBe(1100);
    expect(observed.map(o => o.el)).toEqual([container.querySelector('[data-testid="body"]')]);
    clientWidth = 0;  // a hidden drawer tab keeps its width
    act(() => observed.forEach(o => o.cb()));
    expect(width).toBe(1100);
  });
});
