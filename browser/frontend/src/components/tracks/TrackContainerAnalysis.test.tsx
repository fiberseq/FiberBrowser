/**
 * Owner (1 Oct): with several side panels in the drawer (tabs), docking them back
 * beside the reads brought out only the one on show, and in a narrow window the
 * header offered "Pin to the side" for a panel already in the drawer, which pushed
 * a different panel out. The dock control now follows where the panel is: in the
 * drawer it docks every tab together, or says why none can come out.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { AnalysisPanelHeader, type DrawerDock } from './TrackContainerAnalysis';
import type { PanelConfig } from '../../types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const side = (type: string, pinned: boolean) => ({
  id: `panel-${type}`, contentType: type, datasetId: null, subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0,
  ...(pinned ? { dock: 'side' } : {}),
}) as unknown as PanelConfig;

describe('the side panel dock control', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    try { localStorage.clear(); } catch { /* jsdom */ }
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useBrowserStore.setState({ exportInProgress: false } as never);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (panel: PanelConfig, drawer: DrawerDock | null) => act(() => root.render(
    <AnalysisPanelHeader panel={panel} panelIndex={1} headerColor="#0891b2" label="Clusters" isFullView={false} narrow={false}
      drawer={drawer} onDragStart={() => {}} onDragEnd={() => {}} onFullView={() => {}} onClose={() => {}} />,
  ));
  const toggle = () => container.querySelector<HTMLButtonElement>('[data-testid="panel-dock-toggle-cluster-detail"]')!;

  it('in a drawer of several: docks them all', () => {
    const dock = vi.fn();
    render(side('cluster-detail', true), { count: 2, stay: 0, dock });
    expect(toggle().getAttribute('aria-label')).toBe('Dock the side panels beside the reads');
    expect(toggle().getAttribute('aria-disabled')).toBeNull();
    act(() => toggle().click());
    expect(dock).toHaveBeenCalledTimes(1);
  });

  it('in the drawer because the window is narrow (not pinned): no "Pin to the side"; says why they stay', () => {
    const dock = vi.fn();
    render(side('cluster-detail', false), { count: 2, stay: 2, dock });
    expect(toggle().getAttribute('aria-label')).not.toBe('Pin to the side');
    expect(toggle().getAttribute('aria-disabled')).toBe('true');
    expect(toggle().title).toBe('2 panels stay in the drawer: widen the window or close one');
    act(() => toggle().click());
    expect(dock).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="panel-dock-notice-cluster-detail"]')!.textContent)
      .toBe('2 panels stay in the drawer: widen the window or close one');
  });

  it('beside the reads: pins this panel to the side', () => {
    useBrowserStore.setState({ panels: [side('cluster-detail', false)] } as never);
    render(side('cluster-detail', false), null);
    expect(toggle().getAttribute('aria-label')).toBe('Pin to the side');
    act(() => toggle().click());
    expect(useBrowserStore.getState().panels[0].dock).toBe('side');
  });
});

describe('dockPanelsBeside', () => {
  it('lifts the pin of the drawer\'s panels, in one undo step; the panels beside the reads are left alone', () => {
    useBrowserStore.setState({
      panels: [side('cluster-detail', true), side('footprint-analysis', true), side('colormap', false)],
    } as never);
    const before = useBrowserStore.getState().panels;
    useBrowserStore.getState().dockPanelsBeside(['panel-cluster-detail', 'panel-footprint-analysis']);
    expect(useBrowserStore.getState().panels.map(p => p.dock ?? null)).toEqual([null, null, null]);
    useBrowserStore.getState().undo();
    expect(useBrowserStore.getState().panels.map(p => p.dock ?? null)).toEqual(before.map(p => p.dock ?? null));
  });
});

// Usability round 3, B1: "Dock beside the reads" on one pinned panel docked every side panel of the row at the tight
// minimums (400/320/320/320, no scrolling). Only the drawer's panels move, and none is marked docked at the tight widths.
describe('docking one pinned panel back', () => {
  it('changes only that panel; the others keep no dock (their comfortable widths)', () => {
    useBrowserStore.setState({ panels: [side('cluster-detail', false), side('footprint-analysis', false), side('colormap', true)] } as never);
    useBrowserStore.getState().dockPanelsBeside(['panel-colormap']);
    expect(useBrowserStore.getState().panels.map(p => p.dock ?? null)).toEqual([null, null, null]);
    // Panels never pinned are not touched (no undo step either).
    const steps = useBrowserStore.getState()._historyStack.length;
    useBrowserStore.getState().dockPanelsBeside(['panel-cluster-detail']);
    expect(useBrowserStore.getState()._historyStack.length).toBe(steps);
  });
});
