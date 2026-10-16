import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../plugins/builtinPanels';
import { useBrowserStore } from '../../stores/browserStore';
import { getGroupedAnalysisPanels } from '../../plugins/registry';
import { AnalysisStrip, buildStripItems } from './AnalysisStrip';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('AnalysisStrip settings shortcuts', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useBrowserStore.setState({
      panels: [{
        id: 'cluster-detail-panel',
        contentType: 'cluster-detail',
        datasetId: null,
        subTracks: [],
        collapsed: false,
        linkGroup: null,
        layoutRow: 0,
      }],
      hiddenStripPanels: new Set(),
      analysisStripCollapsed: false,
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('configure menu lists strip panels by their one name', async () => {
    await act(async () => {
      root.render(<AnalysisStrip />);
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="analysis-strip-configure"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const menu = container.querySelector('[data-testid="analysis-strip-menu"]');
    expect(menu).not.toBeNull();
    expect(menu?.textContent).not.toContain('Related settings');
    expect(menu?.textContent).toContain('Clusters');
  });

  it('keeps compatibility-only panels out of the release strip and its menu', async () => {
    await act(async () => {
      root.render(<AnalysisStrip />);
    });

    expect(container.textContent).toContain('Rules');
    expect(container.textContent).toContain('Footprints');
    expect(container.textContent).toContain('Primers');
    expect(container.textContent).toContain('Tutorial');
    expect(container.textContent).not.toContain('Annotations');
    expect(container.querySelector('[data-testid="analysis-strip-button-peak-detection"]')).toBeNull();
    expect(container.querySelector('[data-testid="analysis-strip-button-transcription-state"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="analysis-strip-button-capture"]')).toBeNull();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="analysis-strip-configure"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const menu = container.querySelector('[data-testid="analysis-strip-menu"]');
    expect(menu?.textContent).toContain('Tutorial');
    expect(menu?.textContent).not.toContain('Annotations');
  });

  // Audit L20: every row carried a "Settings: …" line, and "Show all panels" sat there greyed out.
  it('panel options: one line per panel; "Show all panels" only when some are hidden; Escape closes it', async () => {
    await act(async () => { root.render(<AnalysisStrip />); });
    const open = async () => act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="analysis-strip-configure"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await open();
    const menu = () => container.querySelector('[data-testid="analysis-strip-menu"]');
    expect(menu()!.textContent).not.toContain('Settings:');
    expect(container.querySelector('[data-testid="analysis-strip-show-all"]')).toBeNull();
    await act(async () => { useBrowserStore.setState({ hiddenStripPanels: new Set(['history']) } as any); });
    expect(container.querySelector('[data-testid="analysis-strip-show-all"]')).not.toBeNull();
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(menu()).toBeNull();
  });

  // Audit L23: folded, the strip was an 8-px line with a 9-px label, the only way back to the panels.
  it('folded, it keeps every panel as an icon toggle in its colour', async () => {
    useBrowserStore.setState({ analysisStripCollapsed: true } as any);
    await act(async () => { root.render(<AnalysisStrip />); });
    const icon = container.querySelector<HTMLButtonElement>('[data-testid="analysis-strip-collapsed-footprint-analysis"]')!;
    expect(icon).not.toBeNull();
    expect(icon.getAttribute('aria-label')).toBe('Footprints');
    expect(container.querySelector('[data-testid="analysis-strip-collapsed-cluster-detail"]')!.getAttribute('aria-pressed')).toBe('true');
    await act(async () => { icon.click(); });
    expect(useBrowserStore.getState().panels.some(p => p.contentType === 'footprint-analysis')).toBe(true);
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="analysis-strip-expand"]')!.click(); });
    expect(useBrowserStore.getState().analysisStripCollapsed).toBe(false);
  });

  // Owner, 1 Oct: the Library is reachable from the panels strip, open or folded; it opens the Library window.
  it('has a Library entry that opens the Library window (local only)', async () => {
    const opened: unknown[] = [];
    const onOpen = (e: Event) => opened.push((e as CustomEvent).detail);
    window.addEventListener('fiberbrowser:open-library', onOpen);
    try {
      useBrowserStore.setState({ publicMode: false } as any);
      await act(async () => { root.render(<AnalysisStrip />); });
      const chip = container.querySelector<HTMLButtonElement>('[data-testid="analysis-strip-library"]')!;
      expect(chip).not.toBeNull();
      expect(chip.textContent).toContain('Library');
      expect(chip.querySelector('svg')).not.toBeNull();
      await act(async () => { chip.click(); });
      expect(opened).toHaveLength(1);
      // Not a panel: nothing was added to the layout.
      expect(useBrowserStore.getState().panels.map(p => p.contentType)).toEqual(['cluster-detail']);

      await act(async () => { useBrowserStore.setState({ analysisStripCollapsed: true } as any); });
      const icon = container.querySelector<HTMLButtonElement>('[data-testid="analysis-strip-collapsed-library"]')!;
      expect(icon).not.toBeNull();
      expect(icon.getAttribute('aria-label')).toBe('Library');
      await act(async () => { icon.click(); });
      expect(opened).toHaveLength(2);

      await act(async () => { useBrowserStore.setState({ publicMode: true, analysisStripCollapsed: false } as any); });
      expect(container.querySelector('[data-testid="analysis-strip-library"]')).toBeNull();
    } finally {
      window.removeEventListener('fiberbrowser:open-library', onOpen);
      act(() => { useBrowserStore.setState({ publicMode: false } as any); });
    }
  });
  // Owner, 2 Oct: "i would maybe put it next to tracks?" Library · Tracks, open or folded.
  it('the Library sits right before Tracks, open and folded', async () => {
    useBrowserStore.setState({ publicMode: false } as any);
    await act(async () => { root.render(<AnalysisStrip />); });
    const ids = (selector: string) => Array.from(container.querySelectorAll(selector)).map(el => el.getAttribute('data-testid'));
    const open = ids('[data-testid="analysis-strip-chips"] > div > button');
    expect(open[open.indexOf('analysis-strip-library') + 1]).toBe('analysis-strip-button-track-browser');
    // Not after the chips any more (where the minimized panels are).
    expect(container.querySelector('[data-testid="analysis-strip-chips"] [data-testid="analysis-strip-library"]')).not.toBeNull();

    await act(async () => { useBrowserStore.setState({ analysisStripCollapsed: true } as any); });
    const folded = ids('[data-testid="analysis-strip-collapsed-chips"] > button');
    expect(folded[folded.indexOf('analysis-strip-collapsed-library') + 1]).toBe('analysis-strip-collapsed-track-browser');
  });

  it('strip order: Library heads the View group (with its divider); without View it follows Analyze', () => {
    const groups = getGroupedAnalysisPanels();
    const keys = (items: ReturnType<typeof buildStripItems>) => items.map(item => item.key);
    const items = buildStripItems(groups, true);
    const at = keys(items).indexOf('library');
    expect(keys(items)[at + 1]).toBe('track-browser');
    expect(items[at].separator).toBe(true);
    expect(items[at + 1].separator).toBe(false);
    expect(items.filter(item => item.separator)).toHaveLength(groups.length - 1);
    // Unavailable (public server, tour tab): no entry at all, so the overflow indices stay right.
    expect(keys(buildStripItems(groups, false))).not.toContain('library');
    // Tracks hidden from the strip: still the head of View.
    const noTracks = groups.map(g => ({ ...g, plugins: g.plugins.filter(p => p.contentType !== 'track-browser') }));
    const withoutTracks = buildStripItems(noTracks, true);
    expect(withoutTracks[keys(withoutTracks).indexOf('library') + 1].group).toBe('view');
    // View hidden: after the last Analyze panel, a group of its own before Tools.
    const noView = groups.filter(g => g.group !== 'view');
    const withoutView = buildStripItems(noView, true);
    const analyzeCount = noView.find(g => g.group === 'analysis')!.plugins.length;
    expect(keys(withoutView).indexOf('library')).toBe(analyzeCount);
    expect(withoutView[analyzeCount].separator).toBe(true);
    expect(withoutView[analyzeCount + 1].separator).toBe(true);
  });

  it('short of room, the Library goes to More like the panels and opens the Library from there', async () => {
    // A 300 px row and 80 px chips: three chips and More fit; the Library (in View) does not.
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(300);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 80 } as DOMRect);
    const opened: unknown[] = [];
    const onOpen = (e: Event) => opened.push((e as CustomEvent).detail);
    window.addEventListener('fiberbrowser:open-library', onOpen);
    try {
      useBrowserStore.setState({ publicMode: false } as any);
      await act(async () => { root.render(<AnalysisStrip />); });
      const more = container.querySelector<HTMLButtonElement>('[data-testid="analysis-strip-more"]')!;
      expect(more).not.toBeNull();
      expect(more.title).toContain('Library');
      // No visible chip; its 2-px stand-in keeps the test id (for the tour and tests).
      const proxy = container.querySelector<HTMLButtonElement>('[data-testid="analysis-strip-library"]')!;
      expect(proxy.tabIndex).toBe(-1);
      expect(proxy.textContent).toBe('');
      await act(async () => { more.click(); });
      const item = container.querySelector<HTMLButtonElement>('[data-testid="analysis-strip-more-menu"] [data-testid="analysis-strip-more-library"]')!;
      expect(item.textContent).toContain('Library');
      expect(item.getAttribute('role')).toBe('menuitem');
      await act(async () => { item.click(); });
      expect(opened).toHaveLength(1);
      expect(container.querySelector('[data-testid="analysis-strip-more-menu"]')).toBeNull();
      await act(async () => { proxy.click(); });
      expect(opened).toHaveLength(2);
      expect(useBrowserStore.getState().panels.map(p => p.contentType)).toEqual(['cluster-detail']);

      // The Library going away (a public server) shortens the row: the last
      // measurement must not name entries that are gone (it threw here).
      await act(async () => { useBrowserStore.setState({ publicMode: true } as any); });
      expect(container.querySelector('[data-testid="analysis-strip-library"]')).toBeNull();
      expect(container.querySelector<HTMLButtonElement>('[data-testid="analysis-strip-more"]')!.title).not.toContain('Library');
    } finally {
      window.removeEventListener('fiberbrowser:open-library', onOpen);
      act(() => { useBrowserStore.setState({ publicMode: false } as any); });
    }
  });
});
