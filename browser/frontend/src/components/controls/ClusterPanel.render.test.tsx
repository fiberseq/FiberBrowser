import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import '../../plugins/builtinPanels';
import { ClusterPanel } from './ClusterPanel';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('ClusterPanel toolbar groups', () => {
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
      chrom: 'chr1',
      start: 100,
      end: 500,
      datasets: [{ id: 'ds1', available_layers: { nuc: true, tf: true, fire: true } }],
      selectedDatasets: new Set(),
      clusterAssignments: {},
      clusterOrder: {},
      clusterPeakRegions: [],
      clusterFeatureRules: [],
      savedClusterFeatureRuleSets: [],
      peakModes: {},
      clusterMethod: 'kmeans',
      clusterPreparationCount: 10000,
      clusterPreparationSamples: {},
      clusterK: 5,
      clusterPeakMode: 'nuc',
      accessibilityThreshold: 0.5,
      subnucleosomalThreshold: 90,
      peaksLocked: false,
      peakDrawMode: false,
      peaksByRule: {},
      peakRules: [],
      panels: [],
      dismissedPanelTypes: new Set(),
      readDisplayMode: 'sample',
      downsampleCount: null,
      readRowHeight: 1,
      spanningOnly: false,
      analysisSampleSeed: 'test-seed',
    } as any);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const renderPanel = async () => {
    await act(async () => {
      root.render(<ClusterPanel onCluster={vi.fn()} onSort={vi.fn()} onFilter={vi.fn()} onClearFilter={vi.fn()} onScanPeaks={vi.fn()} scanning={false} />);
    });
  };
  const byId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const click = async (id: string) => {
    await act(async () => { byId(id)!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  };
  const hover = async (id: string) => {
    await act(async () => { byId(id)!.dispatchEvent(new MouseEvent('pointerover', { bubbles: true, relatedTarget: document.body })); });
  };

  it('lets the user choose a preview with full refinement or a full run only', async () => {
    await renderPanel();
    await click('toolbar-group-toggle-cluster');
    const select = byId('cluster-preparation-select') as HTMLSelectElement;
    expect(select.value).toBe('10000');
    await act(async () => {
      select.value = '';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(useBrowserStore.getState().clusterPreparationCount).toBeNull();
    await act(async () => {
      select.value = '10000';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(useBrowserStore.getState().clusterPreparationCount).toBe(10000);
  });

  it('disables Cluster when peaks are selected but no panel can be clustered', async () => {
    useBrowserStore.setState({
      peaksByRule: { acc: [{ start: 120, end: 160, index: 0, layer: 0 }] },
      peakRules: [{ id: 'acc', enabled: true }],
    } as any);
    const onCluster = vi.fn();
    await act(async () => root.render(<ClusterPanel onCluster={onCluster} onSort={vi.fn()} onFilter={vi.fn()} onClearFilter={vi.fn()} />));
    const button = byId('cluster-run-button') as HTMLButtonElement;
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.title).toContain('no panel to cluster');
    await click('cluster-run-button');
    expect(onCluster).not.toHaveBeenCalled();
    await act(async () => useBrowserStore.setState({
      panels: [{ id: 'p1', datasetId: 'ds1', contentType: 'dataset', collapsed: false, subTracks: [] }],
    } as any));
    expect(button.getAttribute('aria-disabled')).toBeNull();
    await click('cluster-run-button');
    expect(onCluster).toHaveBeenCalledOnce();
  });

  // Owner (1 Oct): the groups had become dropdowns that closed on any click, one at a time
  // (audit M3, fb-fix-chrome). Back to the earlier behaviour: a group opens in the row and
  // stays open, remembered per group across reloads, until the user folds it. (This replaces
  // the test that pinned the dropdowns.)
  it('opens a group in the row and keeps it open (several at once, remembered) until folded', async () => {
    useBrowserStore.setState({ activeColormap: { ...useBrowserStore.getState().activeColormap,
      qualityFilters: [{ layer: 'fire', qualityName: 'aq', minValue: 230, enabled: true }] } } as any);
    await renderPanel();
    expect(byId('quality-controls-toolbar')).toBeNull();
    await click('toolbar-group-toggle-quality');
    const controls = byId('quality-controls-toolbar')!;
    expect(controls).not.toBeNull();
    // In the group, in the row: not a dropdown floating over the reads.
    expect(byId('toolbar-group-quality')!.contains(controls)).toBe(true);
    expect(controls.closest('[data-testid="toolbar-group-controls-quality"]')!.className).not.toContain('absolute');
    expect(byId('toolbar-group-panel-quality')).toBeNull();
    expect(byId('toolbar-group-toggle-quality')!.getAttribute('aria-expanded')).toBe('true');
    // Audit L3: open, the rule is stated once, by its own checkbox, not again in a summary.
    expect(byId('toolbar-group-quality')!.querySelector('[data-testid="quality-summary"]')).toBeNull();
    expect(byId('toolbar-group-peek-quality')).toBeNull();

    // Opening another keeps the first open.
    await click('toolbar-group-toggle-sort');
    expect(byId('quality-controls-toolbar')).not.toBeNull();
    expect(container.querySelector('[data-testid="toolbar-group-sort"] select')).not.toBeNull();

    // A click elsewhere and Escape leave both open; Escape still reaches the app (clear selection).
    await act(async () => { document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); });
    const globalEscape = vi.fn();
    window.addEventListener('keydown', globalEscape);
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    window.removeEventListener('keydown', globalEscape);
    expect(globalEscape).toHaveBeenCalled();
    expect(byId('quality-controls-toolbar')).not.toBeNull();
    expect(container.querySelector('[data-testid="toolbar-group-sort"] select')).not.toBeNull();

    // Remembered across a reload; folding is remembered too.
    await click('toolbar-group-toggle-sort');
    act(() => root.unmount());
    root = createRoot(container);
    await renderPanel();
    expect(byId('toolbar-group-toggle-quality')!.getAttribute('aria-expanded')).toBe('true');
    expect(byId('quality-controls-toolbar')).not.toBeNull();
    expect(byId('toolbar-group-toggle-sort')!.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-testid="toolbar-group-sort"] select')).toBeNull();
    // Layers starts open (its checkboxes in the row) until the user folds it.
    expect(byId('toolbar-group-toggle-layers')!.getAttribute('aria-expanded')).toBe('true');
  });

  // Audit M2: "Cluster [Cluster]", "Sort [Sort]": a group's name showed beside its own button.
  it('shows each group name once: action groups get an icon-only options toggle', async () => {
    // A selected peak that exists (Cluster can run: no "why not" text beside its name).
    useBrowserStore.setState({ panels: [{ id: 'p1', datasetId: 'ds1', contentType: 'dataset', subTracks: [] }], peakRules: [{ id: 'r', enabled: true }], peaksByRule: { r: [{ index: 0, start: 150, end: 250 }] } } as any);
    await renderPanel();
    for (const [id, name] of [['peaks', 'Scan'], ['cluster', 'Cluster'], ['sort', 'Sort'], ['filter', 'Filter']] as const) {
      const toggle = byId(`toolbar-group-toggle-${id}`)!;
      expect(toggle.textContent).toBe('');
      expect(toggle.getAttribute('aria-label')).toMatch(/options$/);
      expect(toggle.getAttribute('data-tour')).toBe(`${id}-controls-expand`);
      expect(byId(`toolbar-group-${id}`)!.firstElementChild!.textContent).toBe(id === 'cluster' ? 'ClusterPanels: all▾' : name);
    }
    expect(byId('toolbar-group-toggle-reads')!.textContent).toBe('Reads');
  });

  // Audit M1: the hover card stayed open after a click (focus-within) and several piled up.
  it('shows one hover card at a time, only while hovered, and closes it on any click or Escape', async () => {
    useBrowserStore.setState({ activeColormap: { ...useBrowserStore.getState().activeColormap,
      qualityFilters: [{ layer: 'fire', qualityName: 'aq', minValue: 230, enabled: true }] } } as any);
    await renderPanel();
    const shown = (id: string) => !byId(`toolbar-group-peek-${id}`)!.className.split(' ').includes('hidden');
    // Folded, the value waits in the (hidden) card, so it is still in the group's text.
    expect(byId('toolbar-group-peek-quality')!.textContent).toContain('FIRE default');
    expect(shown('quality')).toBe(false);
    await hover('toolbar-group-quality');
    expect(shown('quality')).toBe(true);
    await hover('toolbar-group-reads');
    expect(shown('reads')).toBe(true);
    expect(shown('quality')).toBe(false);
    // Clicking anything (here the toolbar's Scan) closes it, and focus left behind doesn't reopen it.
    await act(async () => {
      byId('peak-scan-button')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      byId('peak-scan-button')!.focus();
    });
    expect(shown('reads')).toBe(false);
    expect(shown('peaks')).toBe(false);
    await hover('toolbar-group-quality');
    const globalEscape = vi.fn();
    window.addEventListener('keydown', globalEscape);
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    window.removeEventListener('keydown', globalEscape);
    expect(shown('quality')).toBe(false);
    expect(globalEscape).not.toHaveBeenCalled(); // closing the card doesn't also clear the selection
  });

  // Audit L2: the Peaks group's tier buttons were colour-only numbers.
  it('names the peak strength tiers it selects', async () => {
    useBrowserStore.setState({
      peakRules: [{ id: 'acc', name: 'Accessibility', source: 'accessibility', enabled: true, color: '#3b82f6', opacity: 0.6, useGradient: true, thresholds: [0.5, 0.3, 0.2, 0.1] }],
      peaksByRule: { acc: [{ start: 120, end: 160, index: 0, layer: 0 }, { start: 200, end: 240, index: 1, layer: 2 }] },
    } as any);
    await renderPanel();
    await click('toolbar-group-toggle-peaks');
    expect(byId('peak-select-tier-0')!.textContent).toBe('Strong1');
    expect(byId('peak-select-tier-2')!.textContent).toBe('Weak1');
    expect((byId('peak-select-tier-1') as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps primary actions visible while collapsed, values only in the hover card, controls until expanded', async () => {
    await renderPanel();

    // Folded Reads: its current values (Fit/All, row height) only in the hover card, not the row.
    const readsPeek = byId('toolbar-group-peek-reads')!;
    expect(readsPeek.querySelector('[data-testid="read-display-mode-toggle"]')).not.toBeNull();
    expect(readsPeek.querySelector('[data-testid="read-display-row-height-compact"]')).not.toBeNull();
    expect(byId('toolbar-group-reads')!.firstElementChild!.textContent).toBe('Reads');
    // Folded Peaks: Scan stays, "N of M selected" doesn't.
    const peaksRow = byId('toolbar-group-peaks')!.firstElementChild!;
    expect(peaksRow.textContent).not.toMatch(/selected|none/);
    expect(container.querySelectorAll('[data-testid="read-display-fill-height"]')).toHaveLength(0);
    expect(byId('read-display-sample-count')).toBeNull();
    expect(byId('peak-scan-button')).not.toBeNull();
    expect(byId('peak-lock-toggle')).toBeNull();
    expect(byId('cluster-run-button')).not.toBeNull();
    expect(byId('cluster-k-input')).toBeNull();
    expect(byId('sort-run-button')).not.toBeNull();
    expect(container.querySelector('[data-testid="toolbar-group-sort"] select')).toBeNull();

    // Each opened group shows all its controls (and stays open).
    await click('toolbar-group-toggle-reads');
    expect(byId('read-display-sample-count')).not.toBeNull();
    expect(container.querySelectorAll('[data-testid^="read-display-row-height"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="read-display-fill-height"]')).toHaveLength(1);
    expect(byId('read-display-separator-mode')).not.toBeNull();
    expect(byId('read-display-separator-min-height')).not.toBeNull();
    expect(byId('read-display-reset')).not.toBeNull();
    await click('toolbar-group-toggle-peaks');
    expect(byId('read-display-sample-count')).not.toBeNull();
    expect(byId('peak-lock-toggle')).not.toBeNull();
    await click('toolbar-group-toggle-cluster');
    expect(byId('cluster-k-input')).not.toBeNull();
    expect(byId('cluster-auto-cull-button')).not.toBeNull();
    await click('toolbar-group-toggle-sort');
    expect(container.querySelector('[data-testid="toolbar-group-sort"] select')).not.toBeNull();
  });

  it('enables auto-cull after clustering has assignments and peak regions', async () => {
    useBrowserStore.setState({
      clusterAssignments: { ds1: { r1: 0, r2: 1 } },
      clusterPeakRegions: [{ start: 150, end: 180, mode: 'nuc' }],
    } as any);

    await act(async () => {
      root.render(
        <ClusterPanel
          onCluster={vi.fn()}
          onSort={vi.fn()}
          onFilter={vi.fn()}
          onClearFilter={vi.fn()}
          onScanPeaks={vi.fn()}
          scanning={false}
        />,
      );
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="toolbar-group-toggle-cluster"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.querySelector<HTMLButtonElement>('[data-testid="cluster-auto-cull-button"]')!.disabled).toBe(false);
  });

  it('runs auto-cull from the toolbar and applies returned assignments', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      results: {
        ds1: {
          assignments: { r1: 0, r2: 0 },
          cluster_counts: { 0: 2 },
        },
      },
      dissolved: [{ cluster: 1, count: 1, reason: 'small' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    useBrowserStore.setState({
      clusterAssignments: { ds1: { r1: 0, r2: 1 } },
      clusterOrder: { ds1: [0, 1] },
      clusterPeakRegions: [{ start: 150, end: 180, mode: 'nuc' }],
    } as any);

    await act(async () => {
      root.render(
        <ClusterPanel
          onCluster={vi.fn()}
          onSort={vi.fn()}
          onFilter={vi.fn()}
          onClearFilter={vi.fn()}
          onScanPeaks={vi.fn()}
          scanning={false}
        />,
      );
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="toolbar-group-toggle-cluster"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="cluster-auto-cull-button"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/auto_cull_clusters?'), expect.objectContaining({ method: 'POST' }));
    expect(useBrowserStore.getState().clusterAssignments.ds1).toEqual({ r1: 0, r2: 0 });
    expect(useBrowserStore.getState().clusterOrder.ds1).toEqual([0]);
  });

  // fb-n6-integ (Codex): the toolbar's merge sent the main reference (no
  // panel_genome) for a panel on another assembly at the same coordinates, and
  // skipped a clustered panel at a locus of its own. It sends what the
  // Clusters panel's map previews: that panel's locus, reference and peaks.
  it.each([
    ['on another assembly at the main coordinates', { genome: 'dm6', viewportOverride: { chrom: 'chr1', start: 100, end: 500 } }, 'linked', ['chr1', '100', '500'], 'dm6'],
    ['at a locus of its own', { navOwn: true, viewportOverride: { chrom: 'chr1', start: 2000, end: 2400 } }, 'perPanel', ['chr1', '2000', '2400'], null],
  ])('the toolbar merge sends the panel %s its own locus and reference', async (_what, over, navigationMode, locus, genome) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      results: { ds1: { assignments: { r1: 0, r2: 0 }, cluster_counts: { 0: 2 } } },
      dissolved: [{ cluster: 1, count: 1, reason: 'small' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const peak = { start: Number(locus[1]) + 50, end: Number(locus[1]) + 80, mode: 'nuc', chrom: 'chr1', ...(genome ? { genome } : {}) };
    useBrowserStore.setState({
      navigationMode,
      panels: [{ id: 'p1', contentType: 'dataset', datasetId: 'ds1', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0, ...over }],
      clusterAssignments: { ds1: { r1: 0, r2: 1 } },
      clusterOrder: { ds1: [0, 1] },
      clusterPeakRegions: [peak],
    } as any);
    await renderPanel();
    await click('toolbar-group-toggle-cluster');
    expect(byId('cluster-auto-cull-button')!.hasAttribute('disabled')).toBe(false);
    await click('cluster-auto-cull-button');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const params = new URLSearchParams(url.split('?')[1]);
    expect([params.get('chrom'), params.get('start'), params.get('end')]).toEqual(locus);
    expect(params.get('panel_genome')).toBe(genome);
    expect(JSON.parse(String(init.body)).peak_regions).toEqual([{ start: peak.start, end: peak.end, mode: 'nuc' }]);
    expect(useBrowserStore.getState().clusterAssignments.ds1).toEqual({ r1: 0, r2: 0 });
  });

  it('a merge answering after Clear clusters does not bring the old clusters back', async () => {
    let answer: (value: Response) => void = () => undefined;
    const fetchMock = vi.fn(() => new Promise<Response>(resolve => { answer = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    useBrowserStore.setState({
      clusterAssignments: { ds1: { r1: 0, r2: 1 } },
      clusterOrder: { ds1: [0, 1] },
      clusterPeakRegions: [{ start: 150, end: 180, mode: 'nuc' }],
    } as any);

    await act(async () => {
      root.render(
        <ClusterPanel
          onCluster={vi.fn()}
          onSort={vi.fn()}
          onFilter={vi.fn()}
          onClearFilter={vi.fn()}
          onScanPeaks={vi.fn()}
          scanning={false}
        />,
      );
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="toolbar-group-toggle-cluster"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="cluster-auto-cull-button"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // Clear clusters while the merge is pending.
    act(() => { useBrowserStore.getState().setClusterAssignments('ds1', {}); });
    await act(async () => {
      answer(new Response(JSON.stringify({
        results: { ds1: { assignments: { r1: 0, r2: 0 }, cluster_counts: { 0: 2 } } },
        dissolved: [{ cluster: 1, count: 1, reason: 'small' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    });
    expect(fetchMock).toHaveBeenCalled();
    expect(useBrowserStore.getState().clusterAssignments.ds1 ?? {}).toEqual({});
  });

  it('passes preserveClusterOrder when the sort lock is enabled', async () => {
    const onSort = vi.fn();
    useBrowserStore.setState({
      panels: [{ id: 'p1', datasetId: 'ds1', contentType: 'dataset', collapsed: false, subTracks: [] }],
      clusterAssignments: { ds1: { r1: 0, r2: 1 } },
      clusterOrder: { ds1: [0, 1] },
    } as any);

    await act(async () => {
      root.render(
        <ClusterPanel
          onCluster={vi.fn()}
          onSort={onSort}
          onFilter={vi.fn()}
          onClearFilter={vi.fn()}
          onScanPeaks={vi.fn()}
          scanning={false}
        />,
      );
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="toolbar-group-toggle-sort"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="sort-lock-cluster-order"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="sort-run-button"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onSort).toHaveBeenCalledWith('occupancy@nuc', undefined, undefined, { preserveClusterOrder: true });
  });

  it('adds enabled cluster feature rules to the cluster mode dropdown', async () => {
    useBrowserStore.setState({
      clusterFeatureRules: [{
        id: 'short_tf',
        name: 'Short TF',
        enabled: true,
        terms: [{ id: 't1', source: 'layer', layer: 'tf', sizeMin: 1, sizeMax: 40 }],
      }],
    } as any);

    await act(async () => {
      root.render(
        <ClusterPanel
          onCluster={vi.fn()}
          onSort={vi.fn()}
          onFilter={vi.fn()}
          onClearFilter={vi.fn()}
          onScanPeaks={vi.fn()}
          scanning={false}
        />,
      );
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="toolbar-group-toggle-cluster"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const options = Array.from(container.querySelectorAll('option')).map(option => option.textContent);
    expect(options).toContain('Short TF');
  });

  it('opens cluster feature rules as an analysis panel', async () => {
    await act(async () => {
      root.render(
        <ClusterPanel
          onCluster={vi.fn()}
          onSort={vi.fn()}
          onFilter={vi.fn()}
          onClearFilter={vi.fn()}
          onScanPeaks={vi.fn()}
          scanning={false}
        />,
      );
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="toolbar-group-toggle-cluster"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="cluster-feature-rules-button"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(useBrowserStore.getState().panels.some(panel => panel.contentType === 'cluster-features')).toBe(true);
    expect(sessionStorage.getItem('fiberbrowser_analysis_rules_tab')).toBe('cluster');
  });

  it('keeps legacy TF inference controls out of the main toolbar', async () => {
    await act(async () => {
      root.render(
        <ClusterPanel
          onCluster={vi.fn()}
          onSort={vi.fn()}
          onFilter={vi.fn()}
          onClearFilter={vi.fn()}
        />,
      );
    });

    expect(container.querySelector('[data-testid="toolbar-group-toggle-tf-inference"]')).toBeNull();
    expect(container.querySelector('[data-testid="open-lattice-consensus-button"]')).toBeNull();
    expect(container.querySelector('[data-testid="targeted-tf-refine-button"]')).toBeNull();
    expect(container.querySelector('[data-testid="targeted-family-scan-button"]')).toBeNull();
  });
});
