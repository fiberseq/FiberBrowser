/**
 * The command palette's keyboard: ⌘K / Ctrl+K opens and closes it, arrows move,
 * Enter chooses, Escape closes and gives focus back, a toggle flips in place,
 * and no browser shortcut acts behind it.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { Footprint, LayoutColumns } from '../ui/Icons';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const { searchGene } = vi.hoisted(() => ({ searchGene: vi.fn() }));
vi.mock('../../api/reference', () => ({ searchGene }));

import { useBrowserStore } from '../../stores/browserStore';
import { ensureBuiltinPanelsRegistered } from '../../stores/__tests__/helpers';
import { CommandPaletteHost } from './CommandPalette';
import { useCommandPaletteStore, closeCommandPalette, openCommandPalette } from '../../utils/commandPaletteStore';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';
import { runAppCommand } from '../../utils/appCommands';

const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

function Harness() {
  useKeyboardShortcuts({});
  return <><input data-testid="outside" /><CommandPaletteHost /></>;
}

const key = (target: EventTarget, init: KeyboardEventInit) => act(() => {
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
});
const dialog = () => document.querySelector('[data-testid="command-palette"]');
const input = () => document.querySelector<HTMLInputElement>('[data-testid="command-palette-input"]')!;
const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
const activeOption = () => document.getElementById(input().getAttribute('aria-activedescendant') ?? '');

function type(text: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input(), text);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('command palette', () => {
  const initial = useBrowserStore.getState();
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => ensureBuiltinPanelsRegistered());
  beforeEach(() => {
    searchGene.mockReset().mockResolvedValue({ found: false, suggestions: [] });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<Harness />));
  });
  afterEach(() => {
    act(() => closeCommandPalette());
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = '';
    useBrowserStore.setState(initial, true);
    try { localStorage.clear(); } catch { /* jsdom */ }
  });

  it('⌘K / Ctrl+K opens it as an accessible dialog and closes it again', () => {
    expect(dialog()).toBeNull();
    key(window, { key: 'k', ctrlKey: true });
    expect(dialog()?.getAttribute('role')).toBe('dialog');
    expect(dialog()?.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(input());
    expect(input().getAttribute('role')).toBe('combobox');
    const listbox = document.getElementById(input().getAttribute('aria-controls')!);
    expect(listbox?.getAttribute('role')).toBe('listbox');
    // Before typing: suggested actions.
    expect(options().length).toBeGreaterThanOrEqual(3);
    key(input(), { key: 'k', metaKey: true });
    expect(dialog()).toBeNull();
  });

  it('opens from the command bus (menu bar, top bar button) and from a text field', () => {
    const outside = document.querySelector<HTMLInputElement>('[data-testid="outside"]')!;
    outside.focus();
    key(outside, { key: 'k', metaKey: true });
    expect(dialog()).not.toBeNull();
    key(input(), { key: 'Escape' });
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(outside);
    act(() => { runAppCommand('command-palette'); });
    expect(dialog()).not.toBeNull();
  });

  it('does not open over another dialog', () => {
    const other = document.createElement('div');
    other.setAttribute('role', 'dialog');
    other.setAttribute('aria-modal', 'true');
    document.body.appendChild(other);
    key(window, { key: 'k', ctrlKey: true });
    expect(dialog()).toBeNull();
    other.remove();
  });

  it('arrows move the active option, Enter runs it and closes', async () => {
    const zoomIn = vi.fn();
    useBrowserStore.setState({ zoomIn });
    act(() => openCommandPalette());
    type('zoom in');
    const first = activeOption();
    expect(first?.getAttribute('aria-selected')).toBe('true');
    expect(first?.dataset.paletteItem).toBe('cmd:zoom-in');
    key(input(), { key: 'ArrowDown' });
    expect(activeOption()).not.toBe(first);
    key(input(), { key: 'ArrowUp' });
    expect(activeOption()).toBe(first);
    key(input(), { key: 'Enter' });
    expect(dialog()).toBeNull();
    await flush();
    expect(zoomIn).toHaveBeenCalledTimes(1);
    // Picked recently: first next time.
    act(() => openCommandPalette());
    expect(options()[0].dataset.paletteItem).toBe('cmd:zoom-in');
  });

  it('“terminal” finds the setting and flips it in place', () => {
    useBrowserStore.setState({ hideTerminalGaps: false });
    act(() => openCommandPalette());
    type('terminal');
    const ids = options().map(o => o.dataset.paletteItem);
    expect(ids[0]).toBe('setting:view.hide-terminal-gaps');
    expect(ids[1]).toBe('toggle:view.hide-terminal-gaps');
    // ⌘/Ctrl+Enter on the setting flips it; the palette stays open.
    key(input(), { key: 'Enter', ctrlKey: true });
    expect(useBrowserStore.getState().hideTerminalGaps).toBe(true);
    expect(dialog()).not.toBeNull();
    expect(document.querySelector('[data-testid="command-palette-status"]')?.textContent).toBe('Hide terminal gaps: on');
    // The Turn off item now says so; a click flips it back.
    const flip = options().find(o => o.dataset.paletteItem === 'toggle:view.hide-terminal-gaps')!;
    expect(flip.textContent).toContain('Turn off: Hide terminal gaps');
    act(() => flip.click());
    expect(useBrowserStore.getState().hideTerminalGaps).toBe(false);
  });

  it('choosing a setting opens the settings sidebar', async () => {
    useBrowserStore.setState({ sidebarOpen: false });
    act(() => openCommandPalette());
    type('read-end footprints');
    expect(activeOption()?.dataset.paletteItem).toBe('setting:view.hide-short-end-footprints');
    key(input(), { key: 'Enter' });
    await flush();
    expect(useBrowserStore.getState().sidebarOpen).toBe(true);
  });

  it('no shortcut acts behind it', () => {
    const resetView = vi.fn();
    const undo = vi.fn();
    useBrowserStore.setState({ resetView, undo });
    act(() => openCommandPalette());
    // Keys typed in the field (R, arrows, ⌘Z) and keys sent elsewhere while it is open.
    key(input(), { key: 'r' });
    key(input(), { key: 'z', metaKey: true });
    key(document.body, { key: 'r' });
    key(document.body, { key: 'Escape' });
    expect(resetView).not.toHaveBeenCalled();
    expect(undo).not.toHaveBeenCalled();
    act(() => closeCommandPalette());
    key(document.body, { key: 'r' });
    expect(resetView).toHaveBeenCalledTimes(1);
  });

  it('a gene typed and Enter pressed at once goes there when the lookup answers', async () => {
    const setViewport = vi.fn();
    useBrowserStore.setState({ setViewport, chroms: [{ name: 'chr19', size: 58_000_000 }] as never, navigationMode: 'linked' });
    searchGene.mockResolvedValue({ found: true, chrom: 'chr19', start: 47_510_062, end: 47_520_062, gene_name: 'NAPA' });
    act(() => openCommandPalette());
    type('NAPA');
    key(input(), { key: 'Enter' });
    expect(setViewport).not.toHaveBeenCalled();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
    await flush();
    expect(dialog()).toBeNull();
    expect(setViewport).toHaveBeenCalledWith('chr19', 47_510_062, 47_520_062);
  });

  it('lists read names and saved regions too (the locus boxes\' providers)', async () => {
    const { useRegionCatalogStore } = await import('../../stores/regionCatalogStore');
    const { emptyCatalog, addCategory, addEntries } = await import('../../utils/regionCatalog');
    useBrowserStore.setState({ currentGenome: 'hg38', chroms: [{ name: 'chr19', size: 58_000_000 }] as never } as never);
    let c = emptyCatalog('hg38');
    const cat = addCategory(c, { name: 'Enhancers' }); c = cat.catalog;
    c = addEntries(c, cat.id, [{ chrom: 'chr19', start: 100, end: 200, label: 'napa enhancer', category: cat.id, source: 'saved' } as never]).catalog;
    act(() => useRegionCatalogStore.setState(st => ({ catalogs: { ...st.catalogs, hg38: c } })));
    try {
      act(() => openCommandPalette());
      type('napa enhancer');
      expect(options().some(o => o.dataset.paletteKind === 'goto' && /Go to napa enhancer/.test(o.textContent ?? '') && /Region/.test(o.textContent ?? ''))).toBe(true);
      type('m84046_240619_124816_s1/240062573/ccs');
      const read = options().find(o => o.dataset.paletteItem?.startsWith('goto:read-names:'));
      expect(read?.textContent).toContain('Read');
      expect(read?.getAttribute('aria-selected')).toBe('true');  // a strong hit: first
    } finally {
      act(() => useRegionCatalogStore.setState(st => { const { hg38: _gone, ...rest } = st.catalogs; return { catalogs: rest }; }));
    }
  });

  it('the menu bar does nothing behind it, and its Cmd+K closes it (Codex review)', () => {
    const zoomIn = vi.fn();
    useBrowserStore.setState({ zoomIn });
    act(() => openCommandPalette('terminal'));
    let result: unknown;
    act(() => { result = runAppCommand('zoom-in'); });
    expect(result).toBe(false);
    expect(zoomIn).not.toHaveBeenCalled();
    act(() => { runAppCommand('command-palette'); });
    expect(dialog()).toBeNull();
    act(() => { runAppCommand('zoom-in'); });
    expect(zoomIn).toHaveBeenCalledTimes(1);
    // Not over another dialog.
    const other = document.createElement('div');
    other.setAttribute('role', 'dialog');
    other.setAttribute('aria-modal', 'true');
    document.body.appendChild(other);
    act(() => { result = runAppCommand('command-palette'); });
    expect(result).toBe(false);
    expect(dialog()).toBeNull();
    other.remove();
  });

  it('Cmd/Ctrl+Enter flips an on/off setting listed under Recent (Codex review)', () => {
    useBrowserStore.setState({ hideTerminalGaps: false });
    localStorage.setItem('fiberbrowser_palette_recent_v1', JSON.stringify(['setting:view.hide-terminal-gaps']));
    act(() => openCommandPalette());
    expect(activeOption()?.dataset.paletteItem).toBe('setting:view.hide-terminal-gaps');
    key(input(), { key: 'Enter', ctrlKey: true });
    expect(useBrowserStore.getState().hideTerminalGaps).toBe(true);
    expect(dialog()).not.toBeNull();
  });

  it('a panel item shows that panel\'s own icon, as on its strip chip (fb-n6-icons)', () => {
    act(() => openCommandPalette());
    type('footprint analysis panel');
    const item = options().find(o => o.dataset.paletteItem === 'panel:footprint-analysis');
    expect(item, options().map(o => o.dataset.paletteItem).join(', ')).toBeTruthy();
    const icon = item!.querySelector('[data-panel-icon="footprint-analysis"] svg');
    expect(icon).not.toBeNull();
    // The Footprints panel's own icon (the owner's protected block on a read,
    // fix/fb-n6-icons 3e9d6c5f), not the generic panel (LayoutColumns, a framed grid).
    expect(icon!.innerHTML).toBe(renderToStaticMarkup(<Footprint />).replace(/^<svg[^>]*>|<\/svg>$/g, ''));
    expect(icon!.innerHTML).not.toBe(renderToStaticMarkup(<LayoutColumns />).replace(/^<svg[^>]*>|<\/svg>$/g, ''));
  });

  it('says when nothing matches', () => {
    act(() => openCommandPalette('qqqzzz'));
    expect(options()).toHaveLength(0);
    expect(document.querySelector('[data-testid="command-palette-empty"]')?.textContent).toContain('qqqzzz');
    expect(useCommandPaletteStore.getState().open).toBe(true);
  });
});
