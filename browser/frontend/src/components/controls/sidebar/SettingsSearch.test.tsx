/**
 * The settings sidebar's search field filters its sections and settings live,
 * with the command palette's matching; nothing matching offers the palette.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// The sidebar's sections ask the server for things; none of that matters here.
vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
// jsdom has no scrollIntoView (a subsection jump scrolls its header into view).
Element.prototype.scrollIntoView ??= function scrollIntoView() {};

import { useBrowserStore } from '../../../stores/browserStore';
import { Sidebar } from '../Sidebar';
import { setSettingsSearchQuery, useSettingsSearchStore } from '../../../utils/settingsSearchStore';
import { useCommandPaletteStore, closeCommandPalette } from '../../../utils/commandPaletteStore';
import { computeSettingsFilter } from './settingsFilter';

const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
const visibleSections = () => [...document.querySelectorAll('[data-testid="settings-sidebar"] [data-sidebar-section]')].map(el => el.getAttribute('data-sidebar-section'));
const title = () => document.querySelector('[data-testid="settings-sidebar-title"]')?.textContent;
const style = () => document.querySelector('[data-testid="settings-search-style"]')?.textContent ?? '';

describe('settings search', () => {
  const initial = useBrowserStore.getState();
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useBrowserStore.setState({ sidebarOpen: true, publicMode: false, activeSection: 'file' });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => setSettingsSearchQuery(''));
    act(() => closeCommandPalette());
    act(() => root.unmount());
    container.remove();
    useBrowserStore.setState(initial, true);
  });

  it('works out sections, subsections and settings from the registry', () => {
    const f = computeSettingsFilter('terminal');
    expect(f.active).toBe(true);
    expect([...f.sections]).toEqual(['view']);
    expect([...f.subsections]).toEqual(['view.advanced']);
    expect(f.shownIds.has('view.hide-terminal-gaps')).toBe(true);
    expect(f.shownIds.has('view.fill-gaps')).toBe(false);
    // A subsection's name shows all of it; a section's name, all of that.
    const sub = computeSettingsFilter('read filters');
    expect(sub.shownIds.has('view.fill-gaps') && sub.shownIds.has('view.min-footprints')).toBe(true);
    const section = computeSettingsFilter('analysis reproducibility');
    expect(section.sections.has('analysis')).toBe(true);
    expect(section.subsections.has('analysis.peaks')).toBe(true);
    expect(computeSettingsFilter('').active).toBe(false);
  });

  it('filters the sidebar live and offers the palette when nothing matches', async () => {
    act(() => root.render(<Sidebar onExport={() => {}} onCopyLink={() => {}} linkCopied={false} onAutozoom={() => {}} />));
    await flush();
    // One page: the section picked in the rail.
    expect(visibleSections()).toEqual(['file']);
    expect(title()).toBe('Data & Sessions');
    const field = document.querySelector<HTMLInputElement>('[data-testid="settings-search-input"]')!;
    expect(field.getAttribute('aria-label')).toBe('Search settings');

    act(() => setSettingsSearchQuery('terminal gaps'));
    await flush();
    expect(visibleSections()).toEqual(['view']);
    // Each matching section under a heading of its own.
    expect(document.getElementById('sidebar-section-view-header')?.textContent).toBe('Reads & Display');
    expect(title()).toBe('Search settings');
    // Its subsection is open and the setting is there; the others in it are hidden by the filter's style.
    const setting = document.querySelector('[data-testid="settings-sidebar"] [data-setting-id="view.hide-terminal-gaps"]');
    expect(setting?.textContent).toContain('Hide terminal gaps');
    expect(style()).toContain('[data-setting-id="view.fill-gaps"]');
    // A block's own heading (CIGAR Display, Read separators) goes when none of its settings is shown.
    expect(style()).toMatch(/\[data-setting-group\]:not\(\[data-setting-group~="view\.hide-terminal-gaps"\]\)[^{]*\{ display: none/);
    expect(style()).not.toMatch(/\[data-setting-id="view\.hide-terminal-gaps"\][^{]*\{ display: none/);
    expect(document.querySelector('[data-testid="settings-search-count"]')?.textContent).toMatch(/settings? below/);

    // Searching leaves the page picked alone.
    expect(useBrowserStore.getState().activeSection).toBe('file');
    // A search for everything lists every section, in rail order.
    act(() => setSettingsSearchQuery('a'));
    await flush();
    expect(visibleSections().length).toBeGreaterThan(1);

    // Matches elsewhere (the toolbar) are listed with Show.
    act(() => setSettingsSearchQuery('row height'));
    await flush();
    expect(document.querySelector('[data-testid="settings-search-elsewhere"]')?.textContent).toContain('Read row height');

    act(() => setSettingsSearchQuery('qqqzzz'));
    await flush();
    expect(visibleSections()).toEqual([]);
    const tryPalette = document.querySelector<HTMLButtonElement>('[data-testid="settings-search-try-palette"]')!;
    act(() => tryPalette.click());
    expect(useCommandPaletteStore.getState()).toMatchObject({ open: true, initialQuery: 'qqqzzz' });

    // Cleared: back to the page picked.
    act(() => setSettingsSearchQuery(''));
    await flush();
    expect(visibleSections()).toEqual(['file']);
    expect(title()).toBe('Data & Sessions');
    expect(style()).toBe('');
  });

  it('a jump to a page (open-sidebar-section) shows it, clearing a search that would hide it', async () => {
    useBrowserStore.setState({ sidebarOpen: false, activeSection: 'file' });
    act(() => root.render(<Sidebar onExport={() => {}} onCopyLink={() => {}} linkCopied={false} onAutozoom={() => {}} />));
    const jump = (sectionId: string) => act(() => { window.dispatchEvent(new CustomEvent('fiberbrowser:open-sidebar-section', { detail: { sectionId } })); });
    jump('genome');
    await flush();
    expect(useBrowserStore.getState()).toMatchObject({ sidebarOpen: true, activeSection: 'genome' });
    expect(visibleSections()).toEqual(['genome']);
    expect(document.querySelector('[data-tour="sidebar-genome"]')).not.toBeNull();
    // A search with matches in that section stays.
    act(() => setSettingsSearchQuery('terminal gaps'));
    jump('view');
    await flush();
    expect(useSettingsSearchStore.getState().query).toBe('terminal gaps');
    // One that would hide it is cleared.
    jump('analysis');
    await flush();
    expect(useSettingsSearchStore.getState().query).toBe('');
    expect(visibleSections()).toEqual(['analysis']);
    // A subsection the search hides is shown too (Codex review).
    act(() => setSettingsSearchQuery('row height'));
    jump('view');
    expect(useSettingsSearchStore.getState().query).toBe('row height');
    act(() => { window.dispatchEvent(new CustomEvent('fiberbrowser:open-sidebar-section', { detail: { sectionId: 'view', subsectionId: 'view.advanced' } })); });
    expect(useSettingsSearchStore.getState().query).toBe('');
    // Closing ends a search: Cmd/Ctrl+B reopens on the page, not the results (Codex review).
    act(() => setSettingsSearchQuery('terminal gaps'));
    await flush();
    act(() => useBrowserStore.getState().toggleSidebar());
    await flush();
    expect(useSettingsSearchStore.getState().query).toBe('');
    act(() => useBrowserStore.getState().toggleSidebar());
    await flush();
    expect(visibleSections()).toEqual(['view']);
    jump('analysis');
    // An unknown section opens the sidebar on the page it had.
    jump('history');
    expect(useBrowserStore.getState().activeSection).toBe('analysis');
  });
});
