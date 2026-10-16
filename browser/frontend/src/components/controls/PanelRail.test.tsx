import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../plugins/builtinPanels';
import { useBrowserStore } from '../../stores/browserStore';
import { usePanelLauncherStore, PANEL_LAUNCHER_STORAGE_KEY } from '../../stores/panelLauncherStore';
import { useDrawerTabsStore } from '../../stores/drawerTabsStore';
import { SidebarIconStrip } from './SidebarIconStrip';
import { Sidebar } from './Sidebar';
import { PanelLauncherSettings, PANEL_LAUNCHER_SETTINGS } from './sidebar/view/PanelLauncherSettings';
import { allSettings } from '../../utils/settingsRegistry';
import { railTileColor, whiteContrast } from '../../utils/railTileColor';
import { getAllAnalysisPanels } from '../../plugins/registry';
import { HIDDEN_PANELS } from '../tracks/AnalysisStrip';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const datasetPanel = (id: string, collapsed = false) => ({
  id, contentType: 'dataset', datasetId: `ds-${id}`, subTracks: [], collapsed, linkGroup: null, layoutRow: 0,
});

describe('analysis panel launchers in the sidebar rail', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useBrowserStore.setState({
      panels: [datasetPanel('p1')],
      datasets: [{ id: 'ds-p1', label: 'napa_ddda', color: '#2563eb' }, { id: 'ds-p2', label: 'second_run', color: '#dc2626' }],
      hiddenStripPanels: new Set(),
      analysisStripCollapsed: false,
      sidebarOpen: false,
      publicMode: false,
    } as never);
    usePanelLauncherStore.setState({ mode: 'rail', coachSeen: true });
    useDrawerTabsStore.setState({ hidden: {}, active: {}, inDrawer: [] });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    usePanelLauncherStore.setState({ mode: 'strip' });
  });

  const q = (sel: string) => container.querySelector(sel) as HTMLElement | null;
  const tiles = () => Array.from(container.querySelectorAll<HTMLButtonElement>('[data-rail-tile]'));

  it('strip mode: the rail has only the settings icons', async () => {
    usePanelLauncherStore.setState({ mode: 'strip' });
    await act(async () => { root.render(<SidebarIconStrip />); });
    expect(q('[data-testid="panel-rail"]')).toBeNull();
    expect(q('[data-testid="settings-rail-view"]')).not.toBeNull();
  });

  it('rail mode: one coloured tile per strip panel, under the settings icons, named for screen readers', async () => {
    await act(async () => { root.render(<SidebarIconStrip />); });
    const rail = q('[data-testid="panel-rail"]')!;
    expect(rail).not.toBeNull();
    // Below the settings icons in the rail.
    const settings = q('[data-testid="settings-rail-analysis"]')!;
    expect(settings.compareDocumentPosition(rail) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const labels = tiles().map(t => t.getAttribute('aria-label'));
    for (const name of ['Clusters', 'Footprints', 'Transcription', 'Read Stats', 'Co-accessibility', 'Tracks', 'Labeling', 'Rules', 'Layout', 'Regions', 'Library']) {
      expect(labels).toContain(name);
    }
    // Compatibility-only panels and Contacts without a contact map stay out (as in the strip).
    expect(labels).not.toContain('Peak Detection');
    expect(labels).not.toContain('Contacts');
    // Each tile carries its panel's colour (shaded for the white icon) and no native title (the rail's own tooltip).
    const clusters = q('[data-testid="panel-rail-cluster-detail"]')!;
    expect(clusters.style.getPropertyValue('--tile-ring')).toBe('#0891b2');
    expect(clusters.style.getPropertyValue('--tile')).toBe(railTileColor('#0891b2'));
    expect(clusters.hasAttribute('title')).toBe(false);
  });

  it('puts the Library right after Tracks', async () => {
    await act(async () => { root.render(<SidebarIconStrip />); });
    const keys = tiles().map(t => t.getAttribute('data-panel-launcher'));
    expect(keys[keys.indexOf('track-browser') + 1]).toBe('library');
    // Tracks hidden: the Library still ends the View group.
    await act(async () => { useBrowserStore.setState({ hiddenStripPanels: new Set(['track-browser']) } as never); });
    const after = tiles().map(t => t.getAttribute('data-panel-launcher'));
    expect(after).toContain('library');
    expect(after.indexOf('library')).toBeLessThan(after.indexOf('history'));
  });

  it('a tile toggles its panel like the strip chip: opens, shows as pressed, closes', async () => {
    await act(async () => { root.render(<SidebarIconStrip />); });
    const tile = () => q('[data-testid="panel-rail-cluster-detail"]') as HTMLButtonElement;
    expect(tile().getAttribute('aria-pressed')).toBe('false');
    await act(async () => { tile().click(); });
    expect(useBrowserStore.getState().panels.some(p => p.contentType === 'cluster-detail')).toBe(true);
    expect(tile().getAttribute('aria-pressed')).toBe('true');
    await act(async () => { tile().click(); });
    expect(useBrowserStore.getState().panels.some(p => p.contentType === 'cluster-detail')).toBe(false);
    expect(tile().getAttribute('aria-pressed')).toBe('false');
  });

  it('a panel behind another drawer tab comes forward instead of closing', async () => {
    await act(async () => { root.render(<SidebarIconStrip />); });
    await act(async () => { (q('[data-testid="panel-rail-cluster-detail"]') as HTMLButtonElement).click(); });
    const id = useBrowserStore.getState().panels.find(p => p.contentType === 'cluster-detail')!.id;
    useDrawerTabsStore.setState({ hidden: { [id]: 0 }, active: { 0: 'other' } });
    await act(async () => { (q('[data-testid="panel-rail-cluster-detail"]') as HTMLButtonElement).click(); });
    expect(useBrowserStore.getState().panels.some(p => p.id === id)).toBe(true);
    expect(useDrawerTabsStore.getState().active[0]).toBe(id);
  });

  it('minimized dataset panels wait at the bottom of the rail; a click restores them', async () => {
    useBrowserStore.setState({ panels: [datasetPanel('p1'), datasetPanel('p2', true)] } as never);
    await act(async () => { root.render(<SidebarIconStrip />); });
    const restore = q('[data-testid="panel-rail-restore-p2"]') as HTMLButtonElement;
    expect(restore).not.toBeNull();
    expect(restore.getAttribute('aria-label')).toBe('Restore second_run');
    // Copilot's "restore a minimized panel" anchor (tutorialAnchors panel-expand) finds it in rail mode too.
    expect(restore.getAttribute('data-tour')).toBe('panel-expand');
    expect(tiles().at(-1)).toBe(restore);
    await act(async () => { restore.click(); });
    expect(useBrowserStore.getState().panels.find(p => p.id === 'p2')!.collapsed).toBe(false);
    expect(q('[data-testid="panel-rail-restore-p2"]')).toBeNull();
  });

  it('keyboard focus shows the full name and description, tied to the tile', async () => {
    await act(async () => { root.render(<SidebarIconStrip />); });
    const tile = q('[data-testid="panel-rail-footprint-analysis"]') as HTMLButtonElement;
    await act(async () => { tile.focus(); });
    const tip = document.querySelector('[data-testid="panel-rail-tooltip"]');
    expect(tip?.textContent).toContain('Footprints');
    expect(tip?.textContent).toContain('What is bound at a footprint');
    expect(tile.getAttribute('aria-describedby')).toBe('panel-rail-tooltip');
    await act(async () => { tile.blur(); });
    expect(document.querySelector('[data-testid="panel-rail-tooltip"]')).toBeNull();
  });

  it('Escape closes the tooltip and is consumed (it does not also clear the selection behind)', async () => {
    await act(async () => { root.render(<SidebarIconStrip />); });
    const tile = q('[data-testid="panel-rail-footprint-analysis"]') as HTMLButtonElement;
    await act(async () => { tile.focus(); });
    expect(document.querySelector('[data-testid="panel-rail-tooltip"]')).not.toBeNull();
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    await act(async () => { document.dispatchEvent(esc); });
    expect(esc.defaultPrevented).toBe(true);
    expect(document.querySelector('[data-testid="panel-rail-tooltip"]')).toBeNull();
  });

  it('a cancelled long press leaves no state behind: the next click opens the panel', async () => {
    await act(async () => { root.render(<SidebarIconStrip />); });
    const a = q('[data-testid="panel-rail-cluster-detail"]') as HTMLButtonElement;
    const b = q('[data-testid="panel-rail-read-stats"]') as HTMLButtonElement;
    vi.useFakeTimers();
    try {
      const touch = (type: string, el: HTMLElement) => el.dispatchEvent(Object.assign(new MouseEvent(type, { bubbles: true }), { pointerType: 'touch' }));
      await act(async () => { touch('pointerdown', a); vi.advanceTimersByTime(600); });
      expect(document.querySelector('[data-testid="panel-rail-tooltip"]')?.textContent).toContain('Clusters');
      await act(async () => { touch('pointercancel', a); });
    } finally {
      vi.useRealTimers();
    }
    await act(async () => { b.click(); });
    expect(useBrowserStore.getState().panels.some(p => p.contentType === 'read-stats')).toBe(true);
  });

  it('a long press on a tile shows its name without opening it', async () => {
    await act(async () => { root.render(<SidebarIconStrip />); });
    const a = q('[data-testid="panel-rail-cluster-detail"]') as HTMLButtonElement;
    vi.useFakeTimers();
    try {
      const touch = (type: string) => a.dispatchEvent(Object.assign(new MouseEvent(type, { bubbles: true }), { pointerType: 'touch' }));
      await act(async () => { touch('pointerdown'); vi.advanceTimersByTime(600); touch('pointerup'); a.click(); });
    } finally {
      vi.useRealTimers();
    }
    expect(useBrowserStore.getState().panels.some(p => p.contentType === 'cluster-detail')).toBe(false);
  });

  it('in the linked split view (no analysis panels drawn) the panel tiles wait', async () => {
    useBrowserStore.setState({ viewMode: 'linkedSplit' } as never);
    try {
      await act(async () => { root.render(<SidebarIconStrip />); });
      const tile = q('[data-testid="panel-rail-cluster-detail"]') as HTMLButtonElement;
      expect(tile.getAttribute('aria-disabled')).toBe('true');
      await act(async () => { tile.click(); });
      expect(useBrowserStore.getState().panels.some(p => p.contentType === 'cluster-detail')).toBe(false);
    } finally {
      useBrowserStore.setState({ viewMode: 'sideBySide' } as never);
    }
  });

  it('the Panels menu hides a launcher', async () => {
    await act(async () => { root.render(<SidebarIconStrip />); });
    await act(async () => { (q('[data-testid="panel-rail-configure"]') as HTMLButtonElement).click(); });
    const menu = document.querySelector('[data-testid="panel-rail-menu"]')!;
    expect(menu.textContent).toContain('Rail panels');
    const box = Array.from(menu.querySelectorAll('label')).find(l => l.textContent?.includes('Rules'))!.querySelector('input')!;
    await act(async () => { box.click(); });
    expect(useBrowserStore.getState().hiddenStripPanels.has('cluster-features')).toBe(true);
    expect(q('[data-testid="panel-rail-cluster-features"]')).toBeNull();
  });

  it('shows the one-time coach mark with data loaded, and remembers its dismissal', async () => {
    usePanelLauncherStore.setState({ coachSeen: false });
    await act(async () => { root.render(<SidebarIconStrip />); });
    const coach = document.querySelector('[data-testid="panel-rail-coach"]');
    expect(coach?.textContent).toContain('Analysis panels');
    await act(async () => { (document.querySelector('[data-testid="panel-rail-coach-dismiss"]') as HTMLButtonElement).click(); });
    expect(document.querySelector('[data-testid="panel-rail-coach"]')).toBeNull();
    expect(localStorage.getItem('fiberbrowser_panel_rail_coach_seen')).toBe('1');
  });

  it('the coach mark never blocks: clicks go through it, it waits while settings are open, and an open panel ends it', async () => {
    usePanelLauncherStore.setState({ coachSeen: false });
    await act(async () => { root.render(<SidebarIconStrip />); });
    const coach = () => document.querySelector('[data-testid="panel-rail-coach"]');
    expect(coach()!.className).toContain('pointer-events-none');
    expect(document.querySelector('[data-testid="panel-rail-coach-dismiss"]')!.className).toContain('pointer-events-auto');
    // Settings open: hidden (it would sit over the sidebar), back when they close.
    await act(async () => { useBrowserStore.setState({ sidebarOpen: true } as never); });
    expect(coach()).toBeNull();
    await act(async () => { useBrowserStore.setState({ sidebarOpen: false } as never); });
    expect(coach()).not.toBeNull();
    // A panel opened another way (palette, toolbar): the panels were found.
    await act(async () => { useBrowserStore.getState().openAnalysisPanel('cluster-detail'); });
    expect(coach()).toBeNull();
    expect(usePanelLauncherStore.getState().coachSeen).toBe(true);
  });

  it('a panel whose tile is hidden (Panels menu) also ends the coach mark (Codex review)', async () => {
    usePanelLauncherStore.setState({ coachSeen: false });
    useBrowserStore.setState({ hiddenStripPanels: new Set(['cluster-detail']) } as never);
    await act(async () => { root.render(<SidebarIconStrip />); });
    expect(document.querySelector('[data-testid="panel-rail-coach"]')).not.toBeNull();
    await act(async () => { useBrowserStore.getState().openAnalysisPanel('cluster-detail'); });
    expect(usePanelLauncherStore.getState().coachSeen).toBe(true);
  });

  it('the rail stays beside the open settings sidebar (its icons switch the page); only rail mode has the launchers', async () => {
    useBrowserStore.setState({ sidebarOpen: true, activeSection: 'view' } as never);
    const props = { onExport: () => {}, onCopyLink: () => {}, linkCopied: false, onAutozoom: () => {} };
    await act(async () => { root.render(<Sidebar {...props} />); });
    expect(q('[data-testid="settings-sidebar"]')).not.toBeNull();
    expect(q('[data-testid="panel-rail"]')).not.toBeNull();
    expect(q('[data-testid="settings-toggle"]')).toBeNull();
    expect(q('[data-testid="settings-rail-view"]')!.getAttribute('aria-pressed')).toBe('true');
    await act(async () => { usePanelLauncherStore.setState({ mode: 'strip' }); });
    expect(q('[data-testid="panel-rail"]')).toBeNull();
    expect(q('[data-testid="settings-rail-view"]')!.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('the Analysis panels setting', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    localStorage.clear();
    usePanelLauncherStore.setState({ mode: 'strip' });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    usePanelLauncherStore.setState({ mode: 'strip' });
  });

  it('switches the mode and saves it for this viewer (not in the session)', async () => {
    await act(async () => { root.render(<PanelLauncherSettings />); });
    expect(container.querySelector('[data-setting-id="view.panel-launcher"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="panel-launcher-strip"]')!.getAttribute('aria-checked')).toBe('true');
    await act(async () => { (container.querySelector('[data-testid="panel-launcher-rail"]') as HTMLButtonElement).click(); });
    expect(usePanelLauncherStore.getState().mode).toBe('rail');
    expect(localStorage.getItem(PANEL_LAUNCHER_STORAGE_KEY)).toBe('rail');
    expect(container.querySelector('[data-testid="panel-launcher-rail"]')!.getAttribute('aria-checked')).toBe('true');
  });

  it('behaves as a radio group: one tab stop, arrows choose', async () => {
    await act(async () => { root.render(<PanelLauncherSettings />); });
    const strip = container.querySelector('[data-testid="panel-launcher-strip"]') as HTMLButtonElement;
    const rail = container.querySelector('[data-testid="panel-launcher-rail"]') as HTMLButtonElement;
    expect([strip.tabIndex, rail.tabIndex]).toEqual([0, -1]);
    await act(async () => { strip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
    expect(usePanelLauncherStore.getState().mode).toBe('rail');
    expect(document.activeElement).toBe(rail);
    expect([strip.tabIndex, rail.tabIndex]).toEqual([-1, 0]);
  });

  it('is findable in the palette and the settings search, with an on/off toggle', () => {
    expect(allSettings()).toContain(PANEL_LAUNCHER_SETTINGS.mode);
    expect(PANEL_LAUNCHER_SETTINGS.mode.toggle!.get()).toBe(false);
    PANEL_LAUNCHER_SETTINGS.mode.toggle!.set(true);
    expect(usePanelLauncherStore.getState().mode).toBe('rail');
    expect(PANEL_LAUNCHER_SETTINGS.mode.toggle!.get()).toBe(true);
  });
});

describe('rail tile colours', () => {
  it('give every panel colour 4.5:1 under the white icon and keep the light ones close to their hue', () => {
    for (const plugin of getAllAnalysisPanels()) {
      expect(whiteContrast(railTileColor(plugin.headerColor)), plugin.contentType).toBeGreaterThanOrEqual(4.5);
    }
    // Already dark enough: unchanged.
    expect(railTileColor('#2563eb')).toBe('#2563eb');
    // Footprints' emerald (2.5:1) is darkened, still green.
    const fp = railTileColor('#10b981');
    expect(fp).not.toBe('#10b981');
    const [r, g, b] = [1, 3, 5].map(i => parseInt(fp.slice(i, i + 2), 16));
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);
  });

  it('give every panel shown on the rail its own colour', () => {
    const shown = getAllAnalysisPanels().filter(p => !HIDDEN_PANELS.has(p.contentType));
    const byColour = new Map<string, string[]>();
    for (const p of shown) {
      const c = railTileColor(p.headerColor).toLowerCase();
      byColour.set(c, [...(byColour.get(c) ?? []), p.contentType]);
    }
    expect([...byColour.values()].filter(types => types.length > 1)).toEqual([]);
  });
});
