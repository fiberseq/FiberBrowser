/**
 * The workspace keys: P toggles Plots and the browser, H the Feature hub, Esc in Plots goes back; none fires while
 * typing, with a modifier, or behind a dialog; in Plots the read keys (R, S, 0–9, G, brackets) are inert. P no longer
 * steps saved regions (that is Shift+N). The ⌘K entries.
 */
import '../testSetup';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';
import { APP_COMMAND_INFO, runAppCommand } from '../../utils/appCommands';
import { KEYBOARD_SHORTCUTS, shortcutForCommand } from '../../utils/shortcuts';
import { findOpenAnalysisPanel } from '../../plugins/registry';
import { closePlots, FEATURE_HUB_PANEL, openDockedHub, openPlots, useWorkspaceStore, workspaceKeyAction } from './workspace';
import { setHubWorkspaceEnabled } from './hubWorkspaceFlag';
import { beforeEach as beforeEachFlag } from 'vitest';

// These tests exercise the full-window hub: the experimental flag on (hubWorkspaceFlag.test covers it off).
beforeEachFlag(() => { setHubWorkspaceEnabled(true, false); });

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const regionStep = vi.hoisted(() => vi.fn(() => null));
vi.mock('../../utils/regionNavigation', async importOriginal => ({
  ...(await importOriginal<typeof import('../../utils/regionNavigation')>()),
  stepRegion: regionStep,
}));

describe('workspaceKeyAction', () => {
  it('P and H in either workspace; Esc and the read keys only in Plots; never with a modifier', () => {
    expect(workspaceKeyAction({ key: 'p' }, 'browser')).toBe('toggle-plots');
    expect(workspaceKeyAction({ key: 'P' }, 'plots')).toBe('toggle-plots');
    expect(workspaceKeyAction({ key: 'h' }, 'browser')).toBe('toggle-hub');
    expect(workspaceKeyAction({ key: 'p', metaKey: true }, 'browser')).toBeNull();
    expect(workspaceKeyAction({ key: 'p', ctrlKey: true }, 'browser')).toBeNull();
    expect(workspaceKeyAction({ key: 'p', altKey: true }, 'browser')).toBeNull();
    expect(workspaceKeyAction({ key: 'P', shiftKey: true }, 'browser')).toBeNull();
    expect(workspaceKeyAction({ key: 'Escape' }, 'browser')).toBeNull();
    expect(workspaceKeyAction({ key: 'Escape' }, 'plots')).toBe('back-to-browser');
    expect(workspaceKeyAction({ key: 'Escape' }, 'hub')).toBe('back-to-browser');
    expect(workspaceKeyAction({ key: 'r' }, 'hub')).toBe('swallow');
    for (const key of ['r', 'S', 'g', '3', '0', '[', ']']) {
      expect(workspaceKeyAction({ key }, 'plots')).toBe('swallow');
      expect(workspaceKeyAction({ key }, 'browser')).toBeNull();
    }
    expect(workspaceKeyAction({ key: 'ArrowLeft' }, 'plots')).toBeNull();
  });
});

function Keys() {
  useKeyboardShortcuts({});
  return null;
}

describe('workspace keys in the app', () => {
  let container: HTMLDivElement;
  let root: Root;
  const press = (key: string, init: KeyboardEventInit = {}, target: EventTarget = window) =>
    act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })); });

  beforeEach(() => {
    useWorkspaceStore.setState({ view: 'browser' });
    useBrowserStore.setState({ chrom: 'chr1', start: 1000, end: 2000, chroms: [{ name: 'chr1', size: 100000 }] } as never);
    regionStep.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<Keys />));
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); document.body.innerHTML = ''; });

  it('P opens Plots and P again goes back; Esc goes back too', () => {
    press('p');
    expect(useWorkspaceStore.getState().view).toBe('plots');
    press('p');
    expect(useWorkspaceStore.getState().view).toBe('browser');
    press('P');
    expect(useWorkspaceStore.getState().view).toBe('plots');
    press('Escape');
    expect(useWorkspaceStore.getState().view).toBe('browser');
  });

  it('not while typing in a field, nor behind a modal dialog', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    press('p', {}, input);
    expect(useWorkspaceStore.getState().view).toBe('browser');
    const text = document.createElement('textarea');
    document.body.appendChild(text);
    press('p', {}, text);
    expect(useWorkspaceStore.getState().view).toBe('browser');
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    document.body.appendChild(dialog);
    press('p');
    expect(useWorkspaceStore.getState().view).toBe('browser');
    dialog.remove();
    press('p');
    expect(useWorkspaceStore.getState().view).toBe('plots');
  });

  it('Esc with a menu open belongs to the menu, not the workspace', () => {
    openPlots();
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    document.body.appendChild(menu);
    press('Escape');
    expect(useWorkspaceStore.getState().view).toBe('plots');
    menu.remove();
    press('Escape');
    expect(useWorkspaceStore.getState().view).toBe('browser');
  });

  it('in Plots, R does not reset the reads behind it and ← / → pan the shared locus', () => {
    const reset = vi.spyOn(useBrowserStore.getState(), 'toggleGenomeOverview');
    openPlots();
    press('g');
    expect(reset).not.toHaveBeenCalled();
    press('ArrowRight');
    press('ArrowRight');
    press('ArrowRight');
    expect(useBrowserStore.getState().start).toBe(1750);
    expect(useBrowserStore.getState().end).toBe(2750);
    press('ArrowLeft');
    expect(useBrowserStore.getState().start).toBe(1500);
    closePlots();
  });

  it('H opens the Feature hub full window and H or Esc goes back; from Plots too', () => {
    press('h');
    expect(useWorkspaceStore.getState().view).toBe('hub');
    press('h');
    expect(useWorkspaceStore.getState().view).toBe('browser');
    press('h');
    press('Escape');
    expect(useWorkspaceStore.getState().view).toBe('browser');
    openPlots();
    press('h');
    expect(useWorkspaceStore.getState().view).toBe('hub');
    press('p');
    expect(useWorkspaceStore.getState().view).toBe('plots');
    closePlots();
  });

  it('the docked hub stays the find side: Dock opens the panel beside the reads', () => {
    useWorkspaceStore.setState({ view: 'hub' });
    openDockedHub();
    expect(useWorkspaceStore.getState().view).toBe('browser');
    expect(findOpenAnalysisPanel(useBrowserStore.getState().panels, FEATURE_HUB_PANEL)).toBeTruthy();
  });
});

describe('P no longer steps saved regions', () => {
  it('the shortcut list says N / Shift+N for regions and P for Plots', () => {
    expect(shortcutForCommand('previous-region')).toBe('Shift+N');
    expect(shortcutForCommand('next-region')).toBe('N');
    expect(shortcutForCommand('open-plots')).toBe('P');
    expect(shortcutForCommand('toggle-feature-hub')).toBe('H');
    const keys = KEYBOARD_SHORTCUTS.map(s => s.key);
    expect(keys.filter(k => k === 'P')).toHaveLength(1);
  });
});

describe('⌘K entries', () => {
  beforeEach(() => { useWorkspaceStore.setState({ view: 'browser' }); });

  it('"Open Plots" and "New plot from current view" are listed and work', () => {
    expect(APP_COMMAND_INFO['open-plots']?.label).toBe('Open Plots');
    expect(APP_COMMAND_INFO['new-plot-from-view']?.label).toBe('New plot from current view');
    expect(runAppCommand('open-plots')).toBe(true);
    expect(useWorkspaceStore.getState().view).toBe('plots');
    expect(APP_COMMAND_INFO['back-to-browser']?.disabledReason?.()).toBeNull();
    expect(runAppCommand('back-to-browser')).toBe(true);
    expect(useWorkspaceStore.getState().view).toBe('browser');
    expect(APP_COMMAND_INFO['back-to-browser']?.disabledReason?.()).toBeTruthy();
  });

  it('New plot from current view starts a fresh follow plot (saved plots stay)', () => {
    useBrowserStore.setState({ datasets: [{ id: 'd1', label: 'D1' }] } as never);
    const s = useBrowserStore.getState();
    s.setPlotsWorkspace(ws => ({ ...ws, current: { ...ws.current, name: 'old', groupBy: 'cluster' }, saved: [ws.current] }));
    const before = useBrowserStore.getState().plotsWorkspace;
    expect(runAppCommand('new-plot-from-view')).toBe(true);
    const after = useBrowserStore.getState().plotsWorkspace;
    expect(after.current.id).not.toBe(before.current.id);
    expect(after.current).toMatchObject({ name: '', groupBy: 'dataset', where: 'view', pinned: null, type: 'size-enrichment' });
    expect(after.saved).toEqual(before.saved);
    closePlots();
  });
});

describe('a panel opened while Plots covers the reads', () => {
  it('goes back to the browser so the panel shows', () => {
    openPlots();
    useBrowserStore.getState().openAnalysisPanel('cluster-detail' as never);
    expect(useWorkspaceStore.getState().view).toBe('browser');
  });
});
