import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import '../../plugins/builtinPanels';
import { ClusterPanel } from './ClusterPanel';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** t-SNE as a first-class projection (fb-r3-tsne): the Sort and Cluster options. */
describe('ClusterPanel projection options', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useBrowserStore.setState({
      selectedPeaks: new Set([0]),
      sortSelection: null,
      filteredReadIds: {},
      chrom: 'chr1', start: 100, end: 500,
      datasets: [{ id: 'ds1', available_layers: { nuc: true, tf: true } }],
      selectedDatasets: new Set(),
      clusterAssignments: { ds1: { r1: 0, r2: 1 } },
      clusterOrder: { ds1: [0, 1] },
      clusterPeakRegions: [],
      clusterFeatureRules: [],
      savedClusterFeatureRuleSets: [],
      peakModes: {},
      clusterMethod: 'kmeans',
      clusterK: 5,
      clusterResolution: 1,
      clusterPeakMode: 'nuc',
      accessibilityThreshold: 0.5,
      subnucleosomalThreshold: 90,
      peaksLocked: false,
      peakDrawMode: false,
      peaksByRule: {},
      peakRules: [],
      panels: [{ id: 'p1', datasetId: 'ds1', contentType: 'dataset', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0 }],
      dismissedPanelTypes: new Set(),
      spanningOnly: false,
      analysisSampleSeed: 'test-seed',
    } as any);
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    vi.restoreAllMocks();
  });

  const render = async (onSort = vi.fn()) => {
    await act(async () => {
      root.render(<ClusterPanel onCluster={vi.fn()} onSort={onSort} onFilter={vi.fn()} onClearFilter={vi.fn()} onScanPeaks={vi.fn()} scanning={false} />);
    });
  };
  const click = async (testId: string) => {
    await act(async () => {
      container.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  };
  const selectWithOption = (label: string) => Array.from(container.querySelectorAll('select'))
    .find(select => Array.from(select.options).some(option => option.textContent === label))!;
  const choose = async (select: HTMLSelectElement, value: string) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
      setter.call(select, value);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  };

  it('offers Sort "By projection (t-SNE)" once there are clusters and sorts with it', async () => {
    const onSort = vi.fn();
    await render(onSort);
    await click('toolbar-group-toggle-sort');
    const select = selectWithOption('By projection (t-SNE)');
    expect(select).toBeTruthy();
    await choose(select, 'projection');
    expect(select.title).toMatch(/neighbours on the\s+map sit next to each other/);
    await click('sort-run-button');
    expect(onSort).toHaveBeenCalledWith('projection', undefined, undefined, { preserveClusterOrder: false });
  });

  it('has no projection sort without clusters', async () => {
    useBrowserStore.setState({ clusterAssignments: {}, clusterOrder: {} } as any);
    await render();
    await click('toolbar-group-toggle-sort');
    const labels = Array.from(container.querySelectorAll('option')).map(option => option.textContent);
    expect(labels).not.toContain('By projection (t-SNE)');
  });

  it('keeps a valid default while dataset metadata loads', async () => {
    useBrowserStore.setState({ datasets: [] });
    await render();
    await act(async () => useBrowserStore.setState({ datasets: [{ id: 'ds1', available_layers: { nuc: true } }] } as any));
    expect(container.querySelector('[data-testid="sort-run-button"]')?.getAttribute('aria-disabled')).not.toBe('true');
    await click('toolbar-group-toggle-sort');
    expect(Array.from(container.querySelectorAll('select')).some(s => s.value === 'occupancy@nuc')).toBe(true);
  });

  it('explains why similarity cannot move a locked cluster order', async () => {
    await render();
    await click('toolbar-group-toggle-sort');
    await choose(selectWithOption('Similarity'), 'similarity');
    await click('sort-lock-cluster-order');
    expect(container.querySelector('[data-testid="sort-run-button"]')?.getAttribute('title')).toContain('Unlock it');
  });

  it('explains a stale projection choice after clusters are cleared', async () => {
    useBrowserStore.setState({ sortSelection: 'projection', clusterAssignments: {}, clusterOrder: {} });
    const onSort = vi.fn();
    await render(onSort);
    const button = container.querySelector('[data-testid="sort-run-button"]')!;
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('title')).toContain('Cluster the target panels first');
    await click('sort-run-button');
    expect(onSort).not.toHaveBeenCalled();
  });

  it('explains empty filters and missing targets', async () => {
    useBrowserStore.setState({ filteredReadIds: { ds1: new Set() } });
    await render();
    expect(container.querySelector('[data-testid="sort-run-button"]')?.getAttribute('title')).toContain('No reads pass');
    await act(async () => useBrowserStore.setState({ selectedDatasets: new Set(['gone']), filteredReadIds: {} }));
    expect(container.querySelector('[data-testid="sort-run-button"]')?.getAttribute('title')).toContain('choose a read panel');
  });

  it('does not sort a collapsed source panel', async () => {
    useBrowserStore.setState(s => ({ panels: s.panels.map(p => ({ ...p, collapsed: true })) }));
    await render();
    expect(container.querySelector('[data-testid="sort-run-button"]')?.getAttribute('title')).toContain('choose a read panel');
  });

  it('chooses a layer that exists and refuses a deleted rule', async () => {
    useBrowserStore.setState({ datasets: [{ id: 'ds1', available_layers: { tf: true } }] } as any);
    await render();
    await click('toolbar-group-toggle-sort');
    expect(selectWithOption('% TF').value).toBe('occupancy@tf');
    await act(async () => useBrowserStore.setState({ sortSelection: 'analysis_sort_rule:removed' }));
    expect(container.querySelector('[data-testid="sort-run-button"]')?.getAttribute('title')).toContain('no longer available');
  });

  it('offers the neighbourhood-graph cluster method with a resolution instead of K', async () => {
    await render();
    await click('toolbar-group-toggle-cluster');
    const select = selectWithOption('Neighbourhoods (t-SNE graph)');
    expect(container.querySelector('[data-testid="cluster-resolution-input"]')).toBeNull();
    await choose(select, 'graph');
    expect(useBrowserStore.getState().clusterMethod).toBe('graph');
    expect(container.querySelector('[data-testid="cluster-k-input"]')).toBeNull();
    const input = container.querySelector<HTMLInputElement>('[data-testid="cluster-resolution-input"]')!;
    expect(input.value).toBe('1');
    expect(select.title).toMatch(/same nearest-neighbour graph/);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, '2.5');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(useBrowserStore.getState().clusterResolution).toBe(2.5);
  });
});
