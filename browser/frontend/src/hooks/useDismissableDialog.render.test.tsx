import { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDismissableDialog } from './useDismissableDialog';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function Card({ onKey, otherDialog = false, fallback }: { onKey?: (e: KeyboardEvent) => boolean; otherDialog?: boolean; fallback?: string[] }) {
  const [open, setOpen] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  const dismiss = useDismissableDialog(ref, open, () => setOpen(false), onKey, fallback);
  return (
    <>
      {open && (
        <div ref={ref} role="dialog" aria-modal="true" tabIndex={-1} data-testid="card">
          <button type="button" onClick={dismiss}>×</button>
          <button type="button" data-testid="last">Last</button>
        </div>
      )}
      {otherDialog && <div role="dialog" data-testid="library">Library</div>}
    </>
  );
}

// Usability round 2, N12: the Welcome card is a dialog that Escape closes, with focus in and back.
describe('useDismissableDialog', () => {
  let container: HTMLDivElement;
  let root: Root;
  let opener: HTMLButtonElement;
  beforeEach(() => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => { cb(0); return 0; });
    opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    opener.remove();
    vi.restoreAllMocks();
  });
  const press = (key: string, init: KeyboardEventInit = {}) =>
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })); });

  it('takes focus on open; Escape closes it and gives focus back', async () => {
    await act(async () => root.render(<Card />));
    const card = container.querySelector('[data-testid="card"]');
    expect(document.activeElement).toBe(card);
    press('Escape');
    expect(container.querySelector('[data-testid="card"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  // Round 3, B4: the Welcome card opens with the page (focus on <body>): Escape left focus on <body>.
  it('with no opener to go back to, focus goes to the fallback (the toolbar\'s Open), never <body>', async () => {
    opener.blur();
    const open = document.createElement('button');
    open.dataset.testid = 'load-file-button';
    document.body.appendChild(open);
    try {
      await act(async () => root.render(<Card fallback={['[data-testid="missing"]', '[data-testid="load-file-button"]']} />));
      press('Escape');
      expect(container.querySelector('[data-testid="card"]')).toBeNull();
      expect(document.activeElement).toBe(open);
    } finally {
      open.remove();
    }
  });

  it('leaves Escape to a dialog open over it', async () => {
    await act(async () => root.render(<Card otherDialog />));
    press('Escape');
    expect(container.querySelector('[data-testid="card"]')).not.toBeNull();
  });

  it('passes other keys to onKey while it is topmost', async () => {
    const seen: string[] = [];
    await act(async () => root.render(<Card onKey={e => { seen.push(e.key); return e.key === 'k'; }} />));
    press('k', { metaKey: true });
    expect(seen).toEqual(['k']);
    expect(container.querySelector('[data-testid="card"]')).not.toBeNull();
  });

  it('keeps Tab inside it, both ways, and does not take focus from a dialog over it', async () => {
    await act(async () => root.render(<Card />));
    const [first, last] = [...container.querySelectorAll('button')];
    last.focus();
    press('Tab');
    expect(document.activeElement).toBe(first);
    press('Tab', { shiftKey: true });
    expect(document.activeElement).toBe(last);
    opener.focus();
    press('Tab');
    expect(document.activeElement).toBe(first);
    act(() => root.unmount());
    root = createRoot(container);
    const lib = document.createElement('div');
    lib.setAttribute('role', 'dialog');
    const input = document.createElement('input');
    lib.appendChild(input);
    document.body.appendChild(lib);
    input.focus();
    await act(async () => root.render(<Card />));
    expect(document.activeElement).toBe(input);
    lib.remove();
  });
});
