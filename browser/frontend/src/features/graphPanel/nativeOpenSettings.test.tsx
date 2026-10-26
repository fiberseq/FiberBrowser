/**
 * Graph follow-ups items 1, 2 and 4: "Open in graph mode" for a native dataset (D3, a display preference on its panel),
 * the Graph mode settings (hand-off thresholds validated to 10–50 kb, out > in), and registering / removing graph
 * packages from Settings › Graph mode.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/datasets', async importOriginal => ({
  ...(await importOriginal<typeof import('../../api/datasets')>()),
  addDataset: vi.fn(),
}));
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { addDataset } from '../../api/datasets';
import { useBrowserStore } from '../../stores/browserStore';
import { useGraphStatusStore } from './statusStore';
import { useGraphBindingsStore } from './bindingsStore';
import { useGraphSettings } from './handoff';
import { nativeGraphOffered, openNativeAsGraph, settlePendingGraphOpens } from './openAsGraph';
import { registerGraphPanel } from './register';
import { openLocalPaths } from '../../utils/openFiles';
import { GraphModeSettings, canManageGraphPackages } from '../../components/controls/sidebar/view/GraphModeSettings';
import type { GraphBinding, GraphReadBinding, GraphRegistration } from './types';
import type { PanelConfig } from '../../types';

registerGraphPanel();

const binding = (key: string, contig: string, sample: string, hap: number): GraphBinding => ({
  key, path: { sample, haplotype: hap, contig } as GraphBinding['path'], assembly: sample, reference: sample,
  size: 200_000_000, size_inferred: false, fragments: [{ origin: 0, end: 200_000_000, indexed: true }], uncovered: [],
});
const REG: GraphRegistration = {
  id: 'gp', label: 'strain-pkg', producer: 'fiberbrowser-graph', build_target: 't',
  revisions: { package: 'p'.repeat(64), graph: 'g'.repeat(64), db: 'd'.repeat(64), maps: 'm'.repeat(64) },
  bindings: [binding('tgt', 'chr2L', 'dm6', 0), binding('alt', 'chr2L_A', 'STRAINA', 1)],
  maps: [{ target: 'tgt', source: 'alt' }],
};
const NATIVE: GraphReadBinding = { dataset_id: 'n', label: 'native', kind: 'native', revision: 'r2', paths: { tgt: 'chr2L' }, problems: [], libraries: 1 };
const panel = (id: string, datasetId: string, extra: Partial<PanelConfig> = {}): PanelConfig => ({
  id, contentType: 'dataset', datasetId, subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0, stateKey: `k-${id}`, ...extra,
});

function seed(bindings: Record<string, { registration: GraphRegistration; binding: GraphReadBinding }[]> = { n: [{ registration: REG, binding: NATIVE }] }) {
  useGraphStatusStore.setState({ status: { helper: { available: true }, registrations: [REG], registration_errors: [] } as never, error: null, loading: false });
  useGraphBindingsStore.setState({ byDataset: bindings, problems: {}, key: 'k', covered: Object.keys(bindings), loading: false });
  useBrowserStore.setState({ panels: [panel('p-n', 'n')], chrom: 'chr2L', start: 1_000_000, end: 1_010_000, currentGenome: 'dm6',
    datasets: [{ id: 'n', label: 'native', data_type: 'bam', color: '#654321' } as never],
    clusterAssignments: {}, clusterOrder: {}, filteredReadIds: {}, selectedReadIds: {}, readSortOrder: {}, fullViewPanelId: null });
}
const get = (id: string) => useBrowserStore.getState().panels.find(p => p.id === id)!;

beforeEach(() => {
  localStorage.clear();
  useGraphSettings.getState().set({ outBp: 50_000, inBp: 40_000, defaultLiftedView: 'graph', complexity: true, nativeOpenView: 'linear' });
});
afterEach(() => { vi.unstubAllGlobals(); vi.mocked(addDataset).mockReset(); });

describe('Open in graph mode (native datasets, D3)', () => {
  it('is offered only with the helper and a package whose target is on the loaded genome', () => {
    seed();
    expect(nativeGraphOffered()).toBe(true);
    useBrowserStore.setState({ currentGenome: 'hg38' });
    expect(nativeGraphOffered()).toBe(false);
    useBrowserStore.setState({ currentGenome: 'dm6' });
    useGraphStatusStore.setState({ status: { helper: { available: false }, registrations: [REG], registration_errors: [] } as never });
    expect(nativeGraphOffered()).toBe(false);
    useGraphStatusStore.setState({ status: { helper: { available: true }, registrations: [], registration_errors: [] } as never });
    expect(nativeGraphOffered()).toBe(false);
  });

  it('records the choice on the panel and opens it as a graph host once its binding is known', async () => {
    seed();
    openNativeAsGraph('n');
    expect(get('p-n').openAs).toBe('graph');
    await Promise.resolve();
    settlePendingGraphOpens();
    const host = get('p-n');
    expect(host.viewMode).toBe('graph');
    expect(host.graphView?.role).toBe('host');
    expect(host.graphView?.targetBinding).toBe('tgt');
    expect(host.graphView?.members?.[0]).toEqual({ panelId: 'p-n', binding: 'tgt' });
  });

  it('an unbound dataset keeps the preference and stays linear', async () => {
    seed({});
    openNativeAsGraph('n');
    await Promise.resolve();
    settlePendingGraphOpens();
    expect(get('p-n').openAs).toBe('graph');
    expect(get('p-n').viewMode).toBeUndefined();
  });

  it('a lifted dataset is left to its own "Open as"', () => {
    seed();
    useBrowserStore.setState({ datasets: [{ id: 'n', label: 'lifted', data_type: 'bam_livelift', color: '#123456' } as never] });
    openNativeAsGraph('n');
    expect(get('p-n').openAs).toBeUndefined();
  });

  it('opening a BAM by path follows the checkbox, else the browser setting', async () => {
    seed({});
    useBrowserStore.setState({ panels: [], datasets: [] });
    let n = 0;
    vi.mocked(addDataset).mockImplementation(async () => ({ success: true, dataset: { id: `b${++n}`, label: `b${n}`, data_type: 'bam', color: '#111111' } }) as never);
    const panelOf = (id: string) => useBrowserStore.getState().panels.find(p => p.datasetId === id);
    await openLocalPaths(['/data/one.bam'], { openAsGraph: true });
    expect(panelOf('b1')?.openAs).toBe('graph');
    await openLocalPaths(['/data/two.bam'], { openAsGraph: false });
    expect(panelOf('b2')?.openAs).toBeUndefined();
    await openLocalPaths(['/data/three.bam']);
    expect(panelOf('b3')?.openAs).toBeUndefined();
    useGraphSettings.getState().set({ nativeOpenView: 'graph' });
    await openLocalPaths(['/data/four.bam']);
    expect(panelOf('b4')?.openAs).toBe('graph');
  });
});

describe('Graph mode settings', () => {
  it('keeps the hand-off thresholds in 10–50 kb with back-in never above out', () => {
    const s = () => useGraphSettings.getState();
    s().set({ outBp: 5_000 });
    // Back-in stays strictly below zoom-out (the hysteresis): 10,000 <= in < out <= 50,000.
    expect([s().outBp, s().inBp]).toEqual([10_001, 10_000]);
    s().set({ outBp: 40_000, inBp: 40_000 });
    expect([s().outBp, s().inBp]).toEqual([40_000, 39_999]);
    s().set({ outBp: 40_000.4, inBp: 40_000.3 });
    expect(s().inBp).toBeLessThan(s().outBp);
    s().set({ outBp: 90_000, inBp: 30_000 });
    expect([s().outBp, s().inBp]).toEqual([50_000, 30_000]);
    s().set({ inBp: Number.NaN });
    expect(s().inBp).toBe(30_000);
    s().set({ nativeOpenView: 'graph', complexity: false });
    expect(JSON.parse(localStorage.getItem('fiberbrowser_graph_mode_settings_v1')!)).toMatchObject({ outBp: 50_000, inBp: 30_000,
      nativeOpenView: 'graph', complexity: false });
  });

  it('a stored pair that breaks the hysteresis loads as the defaults', async () => {
    for (const stored of [{ outBp: 40_000, inBp: 40_000 }, { outBp: 30_000, inBp: 35_000 }, { outBp: 60_000, inBp: 40_000 }, { outBp: 40_000.5, inBp: 30_000 }]) {
      localStorage.setItem('fiberbrowser_graph_mode_settings_v1', JSON.stringify(stored));
      vi.resetModules();
      const fresh = await import('./handoff');
      expect([fresh.useGraphSettings.getState().outBp, fresh.useGraphSettings.getState().inBp], JSON.stringify(stored)).toEqual([50_000, 40_000]);
    }
    localStorage.setItem('fiberbrowser_graph_mode_settings_v1', JSON.stringify({ outBp: 30_000, inBp: 20_000 }));
    vi.resetModules();
    const kept = await import('./handoff');
    expect([kept.useGraphSettings.getState().outBp, kept.useGraphSettings.getState().inBp]).toEqual([30_000, 20_000]);
    expect(kept.validHandoffPair(10_000, 9_999)).toBe(false);
  });

  function mount() {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const box = document.createElement('div');
    document.body.appendChild(box);
    const root = createRoot(box);
    act(() => root.render(<GraphModeSettings />));
    // The subsection starts closed: open it.
    const header = box.querySelector<HTMLButtonElement>('#sidebar-subsection-view\\.graph-header');
    if (header && !box.querySelector('[data-testid="graph-mode-settings"]')) act(() => header.click());
    const q = (id: string) => box.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    return { box, root, q };
  }
  const type = (el: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => { setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); });
  };

  it('refuses a back-in threshold at or above zoom-out and saves valid ones', () => {
    seed();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ helper: { available: true }, registrations: [REG], registration_errors: [] }))));
    const { root, q } = mount();
    try {
      const out = q('graph-settings-out-kb') as HTMLInputElement, back = q('graph-settings-in-kb') as HTMLInputElement;
      expect([out.value, back.value]).toEqual(['50', '40']);
      type(back, '50');
      act(() => back.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
      expect(q('graph-settings-handoff-error')?.textContent).toMatch(/below/);
      expect(useGraphSettings.getState().inBp).toBe(40_000);
      type(out, '60');
      expect(q('graph-settings-handoff-error')?.textContent).toMatch(/10–50 kb/);
      // Equal once rounded to whole bp (40,000 / 40,000): refused, nothing saved.
      type(out, '40.0004'); type(back, '40.0003');
      act(() => back.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
      expect(q('graph-settings-handoff-error')?.textContent).toMatch(/below/);
      expect([useGraphSettings.getState().outBp, useGraphSettings.getState().inBp]).toEqual([50_000, 40_000]);
      type(out, '30'); type(back, '20');
      act(() => back.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
      expect(q('graph-settings-handoff-error')).toBeNull();
      expect([useGraphSettings.getState().outBp, useGraphSettings.getState().inBp]).toEqual([30_000, 20_000]);
      const native = q('graph-settings-native-open')!.querySelector('input')!;
      act(() => native.click());
      expect(useGraphSettings.getState().nativeOpenView).toBe('graph');
      const lifted = q('graph-settings-lifted-view') as HTMLSelectElement;
      act(() => { lifted.value = 'split'; lifted.dispatchEvent(new Event('change', { bubbles: true })); });
      expect(useGraphSettings.getState().defaultLiftedView).toBe('split');
    } finally { act(() => root.unmount()); }
  });

  it('lists registered packages, registers one by path and removes one', async () => {
    seed();
    const OTHER: GraphRegistration = { ...REG, id: 'g2', label: 'other-pkg' };
    let regs = [REG];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/graph/registrations' && init?.method === 'POST') { regs = [...regs, OTHER]; return new Response(JSON.stringify({ registration: OTHER })); }
      if (url.startsWith('/api/graph/registrations/') && init?.method === 'DELETE') {
        regs = regs.filter(r => r.id !== decodeURIComponent(url.split('/').pop()!));
        return new Response(JSON.stringify({ registration_id: 'gp', removed: true }));
      }
      if (url === '/api/graph/status') return new Response(JSON.stringify({ helper: { available: true }, registrations: regs, registration_errors: [] }));
      if (url.startsWith('/api/graph/read_bindings')) return new Response(JSON.stringify({ bindings: [] }));
      return new Response('{}');
    });
    vi.stubGlobal('fetch', fetchMock);
    const { root, q, box } = mount();
    try {
      expect([...box.querySelectorAll('[data-testid="graph-package-row"]')].map(r => r.textContent)).toEqual(['strain-pkgRemove']);
      type(q('graph-package-path') as HTMLInputElement, '/packages/other-pkg');
      await act(async () => { q('graph-package-register')!.click(); });
      await act(async () => { await Promise.resolve(); });
      expect(fetchMock).toHaveBeenCalledWith('/api/graph/registrations', expect.objectContaining({ method: 'POST', body: JSON.stringify({ package: '/packages/other-pkg' }) }));
      expect(q('graph-package-message')?.textContent).toMatch(/Registered other-pkg/);
      expect(useGraphStatusStore.getState().status?.registrations.map(r => r.id)).toEqual(['gp', 'g2']);
      await act(async () => { q('graph-package-remove-gp')!.click(); });
      await act(async () => { await Promise.resolve(); });
      expect(fetchMock).toHaveBeenCalledWith('/api/graph/registrations/gp', expect.objectContaining({ method: 'DELETE' }));
      expect(useGraphStatusStore.getState().status?.registrations.map(r => r.id)).toEqual(['g2']);
      expect([...box.querySelectorAll('[data-testid="graph-package-row"]')].map(r => r.getAttribute('data-registration-id'))).toEqual(['g2']);
    } finally { act(() => root.unmount()); }
  });

  it('on a lab server only admins get Register and Remove, and nobody gets the server-side folder dialog', () => {
    seed();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ helper: { available: true }, registrations: [REG], registration_errors: [] }))));
    const win = window as unknown as { __FIBERBROWSER_LAB__?: unknown };
    try {
      win.__FIBERBROWSER_LAB__ = { user: 'alice', role: 'member', auth: 'accounts', anonymous: false, jobs: false };
      expect(canManageGraphPackages()).toBe(false);
      let m = mount();
      expect(m.box.querySelectorAll('[data-testid="graph-package-row"]')).toHaveLength(1);
      expect(m.q('graph-package-remove-gp')).toBeNull();
      expect(m.q('graph-package-register')).toBeNull();
      expect(m.q('graph-package-path')).toBeNull();
      expect(m.q('graph-packages-admin-only')).not.toBeNull();
      act(() => m.root.unmount());
      win.__FIBERBROWSER_LAB__ = { user: 'boss', role: 'admin', auth: 'accounts', anonymous: false, jobs: false };
      expect(canManageGraphPackages()).toBe(true);
      m = mount();
      expect(m.q('graph-package-remove-gp')).not.toBeNull();
      expect(m.q('graph-package-register')).not.toBeNull();
      expect(m.q('graph-package-browse')).toBeNull();
      act(() => m.root.unmount());
    } finally { delete win.__FIBERBROWSER_LAB__; }
    expect(canManageGraphPackages()).toBe(true);
  });

  it('is hidden on a public server', () => {
    seed();
    useBrowserStore.setState({ publicMode: true });
    try {
      const { root, box } = mount();
      expect(box.querySelector('[data-testid="graph-mode-settings"]')).toBeNull();
      act(() => root.unmount());
    } finally { useBrowserStore.setState({ publicMode: false }); }
  });
});
