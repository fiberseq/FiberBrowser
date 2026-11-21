/**
 * Back / Forward (Alt+← / Alt+→) record the jumps a user makes: the locus box, saved regions (N / P), the Differences
 * arrows, Zoom to read and a table's Go there; not pans and zooms. They work in Linked navigation and in "Each panel
 * navigates" (a panel's own jumps go back on that panel).
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../browserStore';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';
import { goToRegion } from '../../utils/regionNavigation';
import { goToReads, navigatePanelTo } from '../../utils/readLocate';
import { setRegionCatalogPersistence, useRegionCatalogStore } from '../regionCatalogStore';
import { SmartSearchInput } from '../../components/controls/SmartSearchInput';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const panel = (id: string, extra: Record<string, unknown> = {}) => ({
  id, contentType: 'dataset', datasetId: id, subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0, ...extra,
});
const st = () => useBrowserStore.getState();
const view = () => ({ chrom: st().chrom, start: st().start, end: st().end });
const own = (id: string) => st().panels.find(p => p.id === id)?.viewportOverride;
const initial = useBrowserStore.getState();

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ success: true, catalog: { categories: [], entries: [] } }) }) as Response));
  setRegionCatalogPersistence(() => false);
  useRegionCatalogStore.setState({ catalogs: {}, sync: {}, fingerprints: {}, scans: {}, active: null, recent: [] });
  useBrowserStore.setState({
    currentGenome: 'hg38', fastaPath: null, chrom: 'chr3', start: 1_000, end: 2_000,
    chroms: [{ name: 'chr3', size: 198_000_000 }, { name: 'chr19', size: 58_000_000 }], navigationMode: 'linked',
    selectedDatasets: new Set(), panels: [panel('a')], viewportHistory: [], historyIndex: -1, bookmarks: [],
    highlights: [], navigatorRegions: [],
  } as never);
});
afterEach(() => { useBrowserStore.setState(initial, true); vi.unstubAllGlobals(); });

describe('Linked navigation', () => {
  it('a locus-box jump goes back and forward; pans and zooms are not recorded', () => {
    st().setViewport('chr3', 1_100, 2_100);            // a pan: not a jump
    st().setViewport('chr3', 1_000, 3_000);            // a zoom
    expect(st().canGoBack()).toBe(false);
    st().recordJump();                                  // the locus box, before it moves the view
    st().setViewport('chr19', 50_000, 60_000);
    st().setViewport('chr19', 52_000, 62_000);         // a pan after the jump
    st().goBack();
    expect(view()).toEqual({ chrom: 'chr3', start: 1_000, end: 3_000 });
    expect(st().canGoForward()).toBe(true);
    st().goForward();
    expect(view()).toEqual({ chrom: 'chr19', start: 52_000, end: 62_000 });
    expect(st().canGoForward()).toBe(false);
  });

  it('saved regions (N / P): each step is a jump Back undoes in turn', () => {
    goToRegion('hg38', { id: 'r1', chrom: 'chr19', start: 10_000, end: 11_000, label: 'r1', category: 'c', source: 'saved' });
    const first = view();
    goToRegion('hg38', { id: 'r2', chrom: 'chr19', start: 30_000, end: 31_000, label: 'r2', category: 'c', source: 'saved' });
    expect(view()).not.toEqual(first);
    st().goBack();
    expect(view()).toEqual(first);
    st().goBack();
    expect(view()).toEqual({ chrom: 'chr3', start: 1_000, end: 2_000 });
    st().goForward();
    expect(view()).toEqual(first);
  });

  it('Zoom to read (navigatePanelTo) is a jump', () => {
    navigatePanelTo(st().panels[0], 'chr19', 5_000, 6_000);
    expect(view()).toEqual({ chrom: 'chr19', start: 5_000, end: 6_000 });
    st().goBack();
    expect(view()).toEqual({ chrom: 'chr3', start: 1_000, end: 2_000 });
  });

  it('the locus box: a typed locus is a jump Back returns from (main box, and a panel box in Per panel)', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(<SmartSearchInput />));
    const el = host.querySelector('[data-testid="location-search-input"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => { el.focus(); setter.call(el, 'chr19:40,000-41,000'); el.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(view().chrom).toBe('chr19');
    st().goBack();
    expect(view()).toEqual({ chrom: 'chr3', start: 1_000, end: 2_000 });
    act(() => root.unmount());
    host.remove();
  });

  it('a jump after Back drops the undone ones; a jump that did not move adds nothing to undo', () => {
    st().recordJump(); st().setViewport('chr19', 1_000, 2_000);
    st().recordJump(); st().setViewport('chr19', 9_000, 10_000);
    st().goBack();
    expect(view()).toEqual({ chrom: 'chr19', start: 1_000, end: 2_000 });
    st().recordJump(); st().setViewport('chr3', 500_000, 501_000);
    expect(st().canGoForward()).toBe(false);
    st().recordJump();                                  // a Go to that failed: nothing moved
    st().goBack();
    expect(view()).toEqual({ chrom: 'chr19', start: 1_000, end: 2_000 });
  });
});

describe('a jump made like a pan (setPanelViewport: a graph host Go to on its contig, a Differences arrow)', () => {
  it('Back and Forward move the locked panels and the main view with it, as the jump did', () => {
    useBrowserStore.setState({ chrom: 'chr3', start: 1_000, end: 2_000, panels: [
      panel('host', { viewportOverride: { chrom: 'chr3', start: 5_000, end: 6_000 }, siteLocked: true }),
      panel('peer', { viewportOverride: { chrom: 'chr3', start: 10_000, end: 11_000 }, siteLocked: true }),
    ] } as never);
    st().recordJump('host', { likePan: true });
    st().setPanelViewport('host', 5_500, 6_500);
    expect(view()).toEqual({ chrom: 'chr3', start: 1_500, end: 2_500 });
    expect(own('peer')).toEqual({ chrom: 'chr3', start: 10_500, end: 11_500 });
    st().goBack();
    expect(own('host')).toEqual({ chrom: 'chr3', start: 5_000, end: 6_000 });
    expect(own('peer')).toEqual({ chrom: 'chr3', start: 10_000, end: 11_000 });
    expect(view()).toEqual({ chrom: 'chr3', start: 1_000, end: 2_000 });
    st().goForward();
    expect(own('host')).toEqual({ chrom: 'chr3', start: 5_500, end: 6_500 });
    expect(own('peer')).toEqual({ chrom: 'chr3', start: 10_500, end: 11_500 });
    expect(view()).toEqual({ chrom: 'chr3', start: 1_500, end: 2_500 });
  });
});

describe('a pan-like jump that was not a pan (a distant Go to on the host\'s contig)', () => {
  it('Back leaves the locked panels and the main view where the jump left them (Codex stabilize UI r2)', () => {
    useBrowserStore.setState({ chrom: 'chr3', start: 1_000, end: 2_000, panels: [
      panel('host', { viewportOverride: { chrom: 'chr3', start: 5_000, end: 6_000 }, siteLocked: true }),
      panel('peer', { viewportOverride: { chrom: 'chr3', start: 10_000, end: 11_000 }, siteLocked: true }),
    ] } as never);
    st().recordJump('host', { likePan: true });
    st().setPanelViewport('host', 10_000, 15_000);       // not a pan: nothing locked moves
    expect(view()).toEqual({ chrom: 'chr3', start: 1_000, end: 2_000 });
    st().goBack();                                         // back from 10-15 kb to 5-6 kb would read as a zoom
    expect(own('host')).toEqual({ chrom: 'chr3', start: 5_000, end: 6_000 });
    expect(own('peer')).toEqual({ chrom: 'chr3', start: 10_000, end: 11_000 });
    expect(view()).toEqual({ chrom: 'chr3', start: 1_000, end: 2_000 });
    st().goForward();
    expect(own('host')).toEqual({ chrom: 'chr3', start: 10_000, end: 15_000 });
    expect(own('peer')).toEqual({ chrom: 'chr3', start: 10_000, end: 11_000 });
    expect(view()).toEqual({ chrom: 'chr3', start: 1_000, end: 2_000 });
  });
});

describe('Back moves the locked panels the jump moved, decided when the jump was made (agy stabilize, finding 1)', () => {
  const locked = (host: [number, number], peer: [number, number]) => useBrowserStore.setState({ chrom: 'chr3', start: 1_000, end: 2_000, panels: [
    panel('host', { viewportOverride: { chrom: 'chr3', start: host[0], end: host[1] }, siteLocked: true }),
    panel('peer', { viewportOverride: { chrom: 'chr3', start: peer[0], end: peer[1] }, siteLocked: true }),
  ] } as never);

  it('a nearby pan-like jump, then pans past it: Back still brings the locked panel and the main view back', () => {
    locked([5_000, 6_000], [10_000, 11_000]);
    st().recordJump('host', { likePan: true, to: { chrom: 'chr3', start: 5_500, end: 6_500 } });
    st().setPanelViewport('host', 5_500, 6_500);
    for (const x of [6_100, 6_700, 7_300]) st().setPanelViewport('host', x, x + 1_000);   // unrecorded pans
    expect(own('peer')).toEqual({ chrom: 'chr3', start: 12_300, end: 13_300 });
    st().goBack();
    expect(own('host')).toEqual({ chrom: 'chr3', start: 5_000, end: 6_000 });
    expect(own('peer')).toEqual({ chrom: 'chr3', start: 10_000, end: 11_000 });
    expect(view()).toEqual({ chrom: 'chr3', start: 1_000, end: 2_000 });
  });

  it('a distant pan-like jump, then a zoom out over the old view: Back leaves the locked panel where the user put it', () => {
    locked([5_000, 6_000], [10_000, 11_000]);
    st().recordJump('host', { likePan: true, to: { chrom: 'chr3', start: 20_000, end: 21_000 } });
    st().setPanelViewport('host', 20_000, 21_000);
    expect(own('peer')).toEqual({ chrom: 'chr3', start: 10_000, end: 11_000 });
    st().setPanelViewport('host', 4_000, 24_000);                                          // the user's own zoom
    const peerAfterZoom = own('peer');
    st().goBack();
    expect(own('host')).toEqual({ chrom: 'chr3', start: 5_000, end: 6_000 });
    expect(own('peer')).toEqual(peerAfterZoom);
  });

  it('a main-view jump to a wider view nearby that moved no locked panel: Back moves none either', () => {
    useBrowserStore.setState({ chrom: 'chr3', start: 1_000, end: 2_000, panels: [
      panel('peer', { viewportOverride: { chrom: 'chr3', start: 20_000, end: 21_000 }, siteLocked: true }),
    ] } as never);
    st().recordJump(null, { to: { chrom: 'chr3', start: 5_000, end: 10_000 } });
    st().setViewport('chr3', 5_000, 10_000);
    expect(own('peer')).toEqual({ chrom: 'chr3', start: 20_000, end: 21_000 });
    st().goBack();
    expect(view()).toEqual({ chrom: 'chr3', start: 1_000, end: 2_000 });
    expect(own('peer')).toEqual({ chrom: 'chr3', start: 20_000, end: 21_000 });
    st().goForward();
    expect(own('peer')).toEqual({ chrom: 'chr3', start: 20_000, end: 21_000 });
  });

  it('the same for the locus box (it passes where it goes)', async () => {
    useBrowserStore.setState({ panels: [panel('peer', { viewportOverride: { chrom: 'chr3', start: 20_000, end: 21_000 }, siteLocked: true })] } as never);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(<SmartSearchInput />));
    const el = host.querySelector('[data-testid="location-search-input"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => { el.focus(); setter.call(el, 'chr3:5,000-10,000'); el.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    st().goBack();
    expect(view()).toEqual({ chrom: 'chr3', start: 1_000, end: 2_000 });
    expect(own('peer')).toEqual({ chrom: 'chr3', start: 20_000, end: 21_000 });
    act(() => root.unmount());
    host.remove();
  });
});

describe('a read found from a panel\'s own locus box (agy stabilize, finding 2)', () => {
  it('is a jump Back undoes on that panel', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ scope: 'region', complete: true, not_found: [],
        found: [{ name: 'r1', read_id: 'r1', dataset_id: 'a', chrom: 'chr3', start: 50_000, end: 52_000, strand: '+' }] }),
      text: async () => '' }) as unknown as Response));
    useBrowserStore.setState({ navigationMode: 'perPanel', datasets: [{ id: 'a', label: 'A', data_type: 'bam' }] as never,
      panels: [panel('a', { viewportOverride: { chrom: 'chr3', start: 1_000, end: 2_000 } })] } as never);
    const res = await goToReads(['r1'], { viewport: { chrom: 'chr3', start: 1_000, end: 2_000 }, datasetIds: ['a'], target: { panelId: 'a' },
      navigate: (c, s, e) => st().navigatePanel('a', c, s, e) });
    expect(res.ok).toBe(true);
    expect(own('a')!.start).toBeGreaterThan(40_000);
    st().goBack();
    expect(own('a')).toEqual({ chrom: 'chr3', start: 1_000, end: 2_000 });
  });
});

describe('Each panel navigates', () => {
  beforeEach(() => {
    useBrowserStore.setState({
      navigationMode: 'perPanel',
      panels: [panel('a', { viewportOverride: { chrom: 'chr3', start: 1_000, end: 2_000 }, navOwn: true }),
        panel('b', { viewportOverride: { chrom: 'chr19', start: 100, end: 1_100 }, navOwn: true })],
    } as never);
  });

  it("a panel's own jumps go back on that panel, most recent first, and forward again", () => {
    st().recordJump('a'); st().navigatePanel('a', 'chr3', 50_000, 51_000);
    st().recordJump('b'); st().navigatePanel('b', 'chr19', 70_000, 71_000);
    st().goBack();
    expect(own('b')).toEqual({ chrom: 'chr19', start: 100, end: 1_100 });
    expect(own('a')).toEqual({ chrom: 'chr3', start: 50_000, end: 51_000 });
    st().goBack();
    expect(own('a')).toEqual({ chrom: 'chr3', start: 1_000, end: 2_000 });
    st().goForward();
    expect(own('a')).toEqual({ chrom: 'chr3', start: 50_000, end: 51_000 });
    st().goForward();
    expect(own('b')).toEqual({ chrom: 'chr19', start: 70_000, end: 71_000 });
  });

  it("a closed panel's jumps are skipped", () => {
    st().recordJump('a'); st().navigatePanel('a', 'chr3', 50_000, 51_000);
    st().recordJump('b'); st().navigatePanel('b', 'chr19', 70_000, 71_000);
    useBrowserStore.setState({ panels: st().panels.filter(p => p.id !== 'b') } as never);
    st().goBack();
    expect(own('a')).toEqual({ chrom: 'chr3', start: 1_000, end: 2_000 });
  });

  it('a saved region opened in a panel (Per panel) goes back on that panel', () => {
    useBrowserStore.setState({ selectedDatasets: new Set(['a']) } as never);
    goToRegion('hg38', { id: 'r1', chrom: 'chr3', start: 90_000, end: 91_000, label: 'r1', category: 'c', source: 'saved' });
    expect(own('a')?.start).not.toBe(1_000);
    st().goBack();
    expect(own('a')).toEqual({ chrom: 'chr3', start: 1_000, end: 2_000 });
  });

  it('Alt+← / Alt+→ go back and forward in this mode (the pan keys stay off)', () => {
    st().recordJump('a'); st().navigatePanel('a', 'chr3', 50_000, 51_000);
    function Host() { useKeyboardShortcuts(); return null; }
    const root = createRoot(document.createElement('div'));
    act(() => root.render(<Host />));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, bubbles: true }));
    expect(own('a')).toEqual({ chrom: 'chr3', start: 1_000, end: 2_000 });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true }));
    expect(own('a')).toEqual({ chrom: 'chr3', start: 50_000, end: 51_000 });
    const before = view();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(view()).toEqual(before);
    act(() => root.unmount());
  });
});
