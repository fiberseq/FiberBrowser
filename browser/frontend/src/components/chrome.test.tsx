import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useBrowserStore } from '../stores/browserStore';
import '../plugins/builtinPanels';
import { HistoryQuickControls } from './controls/HistoryQuickControls';
import { NavBar } from './controls/NavBar';
import { AnalysisStrip } from './tracks/AnalysisStrip';
import { SidebarIconStrip } from './controls/SidebarIconStrip';
import { NavigationSettings } from './controls/sidebar/view/NavigationSettings';
import { KEYBOARD_SHORTCUTS } from '../utils/shortcuts';
import { setSettingsSearchQuery, useSettingsSearchStore } from '../utils/settingsSearchStore';
import { DatasetToolbar } from './controls/sidebar/dataset/DatasetToolbar';
import { SidebarSettingRow } from './controls/sidebar/shared/SidebarSetting';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('app chrome (round 3)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  const q = (sel: string) => container.querySelector(sel);

  // Audit M24 / design system (Toolbar): Reset view belongs in the App set's More menu, not
  // beside Undo/Redo (round 3 had put it there). It is still one undoable step.
  it('Reset view is in the More menu and is one undoable step (Undo restores, Redo clears again)', async () => {
    useBrowserStore.setState({ _historyStack: [], _historyPointer: -1, selectedPeaks: new Set([1, 2]) } as never);
    await act(async () => { root.render(<><HistoryQuickControls /><NavBar loading={false} scanning={false} clustering={false} /></>); });
    expect(q('[data-testid="quick-undo-button"]')!.parentElement!.querySelector('[data-testid="reset-view-button"]')).toBeNull();
    expect(q('[data-testid="reset-view-button"]')).toBeNull();
    await act(async () => { (q('[data-testid="toolbar-more-button"]') as HTMLButtonElement).click(); });
    const reset = q('[data-testid="toolbar-more-menu"] [data-testid="reset-view-button"]') as HTMLButtonElement;
    expect(reset).not.toBeNull();
    await act(async () => { reset.click(); });
    expect(q('[data-testid="toolbar-more-menu"]')).toBeNull();
    expect(useBrowserStore.getState().selectedPeaks.size).toBe(0);
    expect(useBrowserStore.getState()._historyStack.at(-1)!.label).toBe('Reset view');
    await act(async () => { useBrowserStore.getState().undo(); });
    expect([...useBrowserStore.getState().selectedPeaks]).toEqual([1, 2]);
    await act(async () => { useBrowserStore.getState().redo(); });
    expect(useBrowserStore.getState().selectedPeaks.size).toBe(0);
  });

  it('the top bar has no settings cog', async () => {
    await act(async () => { root.render(<NavBar loading={false} scanning={false} clustering={false} />); });
    expect(q('[data-testid="settings-toggle"]')).toBeNull();
  });

  it('the analysis strip has no Tour button and no Layout menu (the Layout panel arranges panels)', async () => {
    await act(async () => { root.render(<AnalysisStrip />); });
    expect(q('[data-testid="guided-tour-button"]')).toBeNull();
    expect(q('[data-testid="layout-menu-button"]')).toBeNull();
    expect(q('[data-testid="analysis-strip-button-dataset-layout"]')).not.toBeNull();
  });

  it('the side rail opens settings, with a labelled tooltip on each control', async () => {
    useBrowserStore.setState({ sidebarOpen: false, activeSection: 'file' } as never);
    await act(async () => { root.render(<SidebarIconStrip />); });
    // No open/close arrow: each icon opens its own page.
    expect(q('[data-testid="settings-toggle"]')).toBeNull();
    for (const id of ['file', 'genome', 'view', 'analysis']) {
      const icon = q(`[data-testid="settings-rail-${id}"]`)!;
      expect(icon.getAttribute('title')).toMatch(/^Settings: /);
      // Nothing is marked while the sidebar is closed.
      expect(icon.getAttribute('aria-pressed')).toBe('false');
    }
    await act(async () => { (q('[data-testid="settings-rail-view"]') as HTMLButtonElement).click(); });
    expect(useBrowserStore.getState()).toMatchObject({ sidebarOpen: true, activeSection: 'view' });
    expect(q('[data-testid="settings-rail-view"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(q('[data-testid="settings-rail-file"]')!.getAttribute('aria-pressed')).toBe('false');
    // Another icon switches the page; the page's own icon closes the sidebar.
    await act(async () => { (q('[data-testid="settings-rail-analysis"]') as HTMLButtonElement).click(); });
    expect(useBrowserStore.getState()).toMatchObject({ sidebarOpen: true, activeSection: 'analysis' });
    await act(async () => { (q('[data-testid="settings-rail-analysis"]') as HTMLButtonElement).click(); });
    expect(useBrowserStore.getState()).toMatchObject({ sidebarOpen: false, activeSection: 'analysis' });
    expect(container.querySelectorAll('[aria-pressed="true"][data-testid^="settings-rail-"]')).toHaveLength(0);
    // Cmd/Ctrl+B (toggleSidebar) reopens on the last page.
    await act(async () => { useBrowserStore.getState().toggleSidebar(); });
    expect(q('[data-testid="settings-rail-analysis"]')!.getAttribute('aria-pressed')).toBe('true');
    // While the settings search lists matches no page is on show: nothing is marked, and the
    // page's icon shows it again (clearing the search) instead of closing the sidebar.
    await act(async () => { setSettingsSearchQuery('seed'); });
    expect(container.querySelectorAll('[aria-pressed="true"][data-testid^="settings-rail-"]')).toHaveLength(0);
    await act(async () => { (q('[data-testid="settings-rail-analysis"]') as HTMLButtonElement).click(); });
    expect(useSettingsSearchStore.getState().query).toBe('');
    expect(useBrowserStore.getState()).toMatchObject({ sidebarOpen: true, activeSection: 'analysis' });
    expect(q('[data-testid="settings-rail-analysis"]')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('no click-target picker or click modes; right-click, Cmd/Shift-click and read names are in Keyboard shortcuts', async () => {
    await act(async () => { root.render(<NavigationSettings onAutozoom={() => {}} />); });
    expect(container.textContent).not.toMatch(/Click target/);
    const keys = KEYBOARD_SHORTCUTS.map(s => s.key);
    // Click modes are gone (fb-r4-clicks): no V cycle, no "in any click mode".
    expect(keys).not.toContain('V');
    expect(KEYBOARD_SHORTCUTS.some(s => /click mode/i.test(s.description))).toBe(false);
    expect(keys.some(k => /\+click read/.test(k))).toBe(true);
    expect(keys).toContain('Shift+click read');
    expect(keys.some(k => /^Right-click/.test(k))).toBe(true);
    expect(KEYBOARD_SHORTCUTS.some(s => /read name/i.test(s.key))).toBe(true);
  });

  it('sidebar rows wrap the control under its label instead of overlapping', async () => {
    await act(async () => { root.render(<SidebarSettingRow label="Analysis cap"><select><option>Off</option></select></SidebarSettingRow>); });
    expect((container.firstElementChild as HTMLElement).className).toContain('flex-wrap');
  });

  it("the sidebar's datasets toolbar opens the Layout panel (and has no second Reset view)", async () => {
    const onOpenLayoutPanel = vi.fn();
    await act(async () => {
      root.render(<DatasetToolbar selectedDatasetsCount={0} anyLinked={false} canLink={false} canMerge={false}
        selectedDatasetPanelCount={0} canUnmerge={false} unmergeCount={0}
        onOpenLayoutPanel={onOpenLayoutPanel} onLinkToggle={() => {}} onMerge={() => {}} onUnmerge={() => {}} />);
    });
    const open = q('[data-testid="sidebar-open-layout-panel"]') as HTMLButtonElement;
    expect(open.textContent).toMatch(/Arrange panels/);
    await act(async () => { open.click(); });
    expect(onOpenLayoutPanel).toHaveBeenCalled();
    expect(container.querySelectorAll('button')).toHaveLength(1);
  });
});
