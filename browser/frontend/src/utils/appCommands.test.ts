import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { useBrowserStore } from '../stores/browserStore';
import { ensureBuiltinPanelsRegistered } from '../stores/__tests__/helpers';
import {
  APP_COMMANDS,
  BUILTIN_COMMANDS,
  COMPONENT_COMMANDS,
  currentLocus,
  registerAppCommand,
  runAppCommand,
} from './appCommands';
import { useAppCommand } from '../hooks/useAppCommand';
import { OPEN_LIBRARY_EVENT } from '../components/controls/library/libraryStore';

describe('app command bus', () => {
  const initial = useBrowserStore.getState();

  beforeEach(() => {
    ensureBuiltinPanelsRegistered();
    useBrowserStore.setState({ publicMode: false, chrom: 'chr7', start: 5_529_000, end: 5_531_500 });
  });

  afterEach(() => {
    useBrowserStore.setState(initial, true);
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('installs window.fiberbrowserCommand', () => {
    expect(window.fiberbrowserCommand).toBe(runAppCommand);
  });

  it('every command has exactly one kind of handler', () => {
    const names = new Set<string>(APP_COMMANDS);
    expect(names.size).toBe(APP_COMMANDS.length);
    for (const name of Object.keys(BUILTIN_COMMANDS)) expect(names.has(name)).toBe(true);
    for (const name of COMPONENT_COMMANDS) expect(BUILTIN_COMMANDS[name]).toBeUndefined();
    for (const name of APP_COMMANDS) {
      expect(Boolean(BUILTIN_COMMANDS[name]) || COMPONENT_COMMANDS.includes(name)).toBe(true);
    }
  });

  it('unknown commands and unmounted component commands return false', () => {
    expect(runAppCommand('no-such-command')).toBe(false);
    expect(runAppCommand('export-figure')).toBe(false);
  });

  it('dispatches store actions', () => {
    const zoomIn = vi.fn(), zoomOut = vi.fn(), goBack = vi.fn(), toggleSidebar = vi.fn(), setSidebarOpen = vi.fn();
    useBrowserStore.setState({ zoomIn, zoomOut, goBack, toggleSidebar, setSidebarOpen });
    expect(runAppCommand('zoom-in')).toBe(true);
    expect(runAppCommand('zoom-out')).toBe(true);
    expect(runAppCommand('back')).toBe(true);
    expect(runAppCommand('toggle-sidebar')).toBe(true);
    expect(runAppCommand('settings')).toBe(true);
    expect([zoomIn, zoomOut, goBack, toggleSidebar].map(f => f.mock.calls.length)).toEqual([1, 1, 1, 1]);
    expect(setSidebarOpen).toHaveBeenCalledWith(true);
  });

  it('highlight commands act on the store (fb-r4-regions via the palette)', () => {
    useBrowserStore.setState({ currentGenome: 'hg38', highlights: [], highlightDrawMode: false } as never);
    expect(runAppCommand('highlight-view')).toBe(true);
    expect(useBrowserStore.getState().highlights.map(h => [h.chrom, h.start, h.end])).toEqual([['chr7', 5_529_000, 5_531_500]]);
    expect(runAppCommand('toggle-highlight-mode')).toBe(true);
    expect(useBrowserStore.getState().highlightDrawMode).toBe(true);
    expect(runAppCommand('highlight-peaks')).toBe(false);  // no peaks selected
    expect(runAppCommand('clear-highlights')).toBe(true);
    expect(useBrowserStore.getState().highlights).toEqual([]);
    // No saved regions here: N / P have nothing to step through.
    expect(runAppCommand('next-region')).toBe(false);
  });

  it("undo/redo use the app history, or the focused field's undo while typing", () => {
    const undo = vi.fn(), redo = vi.fn();
    useBrowserStore.setState({ undo, redo });
    expect(runAppCommand('undo')).toBe(true);
    expect(runAppCommand('redo')).toBe(true);
    expect(undo).toHaveBeenCalledTimes(1);
    expect(redo).toHaveBeenCalledTimes(1);

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true });
    expect(runAppCommand('undo')).toBe('edit');
    expect(runAppCommand('redo')).toBe('edit');
    expect(execCommand.mock.calls).toEqual([['undo'], ['redo']]);
    expect(undo).toHaveBeenCalledTimes(1);
    expect(redo).toHaveBeenCalledTimes(1);
  });

  it('answers the locus and focuses the location box', () => {
    expect(currentLocus()).toBe('chr7:5529000-5531500');
    expect(runAppCommand('locus')).toBe('chr7:5529000-5531500');

    expect(runAppCommand('go-to-locus')).toBe(false);
    const box = document.createElement('input');
    box.dataset.testid = 'location-search-input';
    box.value = 'chr7:5,529,000-5,531,500';
    document.body.appendChild(box);
    expect(runAppCommand('go-to-locus')).toBe(true);
    expect(document.activeElement).toBe(box);
    expect(box.selectionStart).toBe(0);
    expect(box.selectionEnd).toBe(box.value.length);
  });

  it('toggles analysis panels like the analysis strip', () => {
    expect(runAppCommand('toggle-clusters')).toBe(true);
    expect(useBrowserStore.getState().panels.some(p => p.contentType === 'cluster-detail')).toBe(true);
    expect(runAppCommand('toggle-clusters')).toBe(true);
    expect(useBrowserStore.getState().panels.some(p => p.contentType === 'cluster-detail')).toBe(false);
  });

  it('sets the appearance', () => {
    const toggleDarkMode = vi.fn(() => useBrowserStore.setState(s => ({ darkMode: !s.darkMode })));
    useBrowserStore.setState({ darkMode: false, toggleDarkMode });
    runAppCommand('appearance-light');
    expect(toggleDarkMode).not.toHaveBeenCalled();
    runAppCommand('appearance-dark');
    runAppCommand('appearance-dark');
    expect(toggleDarkMode).toHaveBeenCalledTimes(1);
    expect(useBrowserStore.getState().darkMode).toBe(true);
  });

  it('local-only commands are unavailable on a public server', () => {
    const opened = vi.fn();
    window.addEventListener(OPEN_LIBRARY_EVENT, opened);
    expect(runAppCommand('library')).toBe(true);
    useBrowserStore.setState({ publicMode: true });
    expect(runAppCommand('library')).toBe(false);
    expect(runAppCommand('connect-cluster')).toBe(false);
    expect(runAppCommand('new-daf-run')).toBe(false);
    expect(runAppCommand('dataset-qc')).toBe(false);
    expect(runAppCommand('load-by-path')).toBe(false);
    window.removeEventListener(OPEN_LIBRARY_EVENT, opened);
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it('component handlers register while mounted, the latest one runs', () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const first = vi.fn(() => true), second = vi.fn(() => true);
    const Host = ({ handler }: { handler: () => boolean }) => { useAppCommand('export-figure', handler); return null; };
    const root = createRoot(document.createElement('div'));
    act(() => root.render(createElement(Host, { handler: first })));
    expect(runAppCommand('export-figure')).toBe(true);
    act(() => root.render(createElement(Host, { handler: second })));
    expect(window.fiberbrowserCommand?.('export-figure')).toBe(true);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    expect(runAppCommand('export-figure')).toBe(false);
  });

  it('async handlers report true and handler errors report false', async () => {
    const unregister = registerAppCommand('open-file', async () => { throw new Error('boom'); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(runAppCommand('open-file')).toBe(true);
    unregister();
    const unregister2 = registerAppCommand('open-file', () => { throw new Error('sync'); });
    expect(runAppCommand('open-file')).toBe(false);
    unregister2();
  });
});
