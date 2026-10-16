import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReadContextMenu } from './ReadContextMenu';
import { buildReadMenu } from './readMenuModel';
import { openOverlayState } from '../../../hooks/useKeyboardShortcuts';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

const entries = buildReadMenu({
  readId: 'm1/1/ccs', footprint: null, readSelected: false, selectedCount: 0, hasReadFilter: false,
  excludedCount: 0, readHighlighted: false, anyHighlight: false, isMac: true,
});

function open(onAction = vi.fn(), onClose = vi.fn()) {
  act(() => root!.render(<ReadContextMenu x={20} y={30} entries={entries} title="m1/1/ccs" onAction={onAction} onClose={onClose} />));
  const menu = document.querySelector('[data-testid="read-context-menu"]') as HTMLElement;
  return { menu, onAction, onClose };
}
const key = (el: Element, k: string) => act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); });

/** fb-r4-clicks: the read menu is a keyboard-usable menu that closes like one. */
describe('ReadContextMenu', () => {
  it('is a menu the app knows is open (Escape is its own), focused on its first item', () => {
    const { menu } = open();
    expect(menu.getAttribute('role')).toBe('menu');
    expect(menu.getAttribute('aria-label')).toBe('Actions for m1/1/ccs');
    expect(openOverlayState().overlay).toBe(true);
    expect(document.activeElement?.getAttribute('data-action')).toBe('select-read');
    // The footprint item is disabled (no footprint here) and shows its click.
    const fp = menu.querySelector('[data-action="select-footprint"]') as HTMLButtonElement;
    expect(fp.disabled).toBe(true);
    expect(menu.textContent).toContain('⇧-click');
  });

  it('arrow keys move past disabled items; End/Home jump; the app never sees the arrows', () => {
    const { menu } = open();
    const seen: string[] = [];
    const onWindow = (e: KeyboardEvent) => { if (!e.defaultPrevented) seen.push(e.key); };
    window.addEventListener('keydown', onWindow);
    key(document.activeElement!, 'ArrowDown');
    expect(document.activeElement?.getAttribute('data-action')).toBe('open-read-stats');
    key(document.activeElement!, 'ArrowUp');
    expect(document.activeElement?.getAttribute('data-action')).toBe('select-read');
    key(document.activeElement!, 'End');
    const last = [...menu.querySelectorAll('[role="menuitem"]:not([disabled])')].pop();
    expect(document.activeElement).toBe(last);
    key(document.activeElement!, 'Home');
    expect(document.activeElement?.getAttribute('data-action')).toBe('select-read');
    window.removeEventListener('keydown', onWindow);
    expect(seen).toEqual([]);
  });

  it('focus goes back where it was, unless the action moved it (Go to a read by name focuses the locus box)', () => {
    const before = document.createElement('button');
    const box = document.createElement('input');
    document.body.append(before, box);
    before.focus();
    act(() => root!.render(<ReadContextMenu x={1} y={1} entries={entries} onAction={() => box.focus()} onClose={() => act(() => root!.render(<></>))} />));
    expect(document.activeElement?.getAttribute('data-action')).toBe('select-read');
    act(() => { (document.querySelector('[data-action="copy-read-name"]') as HTMLButtonElement).click(); });
    expect(document.activeElement).toBe(box);

    before.focus();
    act(() => root!.render(<ReadContextMenu x={1} y={1} entries={entries} onAction={() => {}} onClose={() => {}} />));
    key(document.activeElement!, 'Escape');
    act(() => root!.render(<></>));
    expect(document.activeElement).toBe(before);
    before.remove();
    box.remove();
  });

  it('Enter acts and closes; Escape and a click elsewhere close', () => {
    const { menu, onAction, onClose } = open();
    const copy = menu.querySelector('[data-action="copy-read-name"]') as HTMLButtonElement;
    act(() => { copy.click(); });
    expect(onAction).toHaveBeenCalledWith('copy-read-name');
    expect(onClose).toHaveBeenCalled();

    const second = open();
    key(document.activeElement!, 'Escape');
    expect(second.onClose).toHaveBeenCalled();

    const third = open();
    act(() => { document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })); });
    expect(third.onClose).toHaveBeenCalled();
  });
});
