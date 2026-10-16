import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserApiAllowed, canonicalApiPath, executeBrowserAction } from './browserActions';
import { useBrowserStore } from '../stores/browserStore';
import { registerClusterRunner, registerScanRunner } from '../utils/clusterRunner';
import type { BrowserState } from '../stores/browserStore';

const motifLoaderMock = vi.hoisted(() => ({
  addJasparMotifsByName: vi.fn(async (_names: string[]) => ({ success: true, message: 'Motif added', catalogEntryIds: [] as string[] })),
}));
vi.mock('../utils/motifLoader', () => motifLoaderMock);

vi.mock('../utils/copilotAnchors', () => ({
  highlightForAction: vi.fn(async () => undefined),
  // executeBrowserAction reads COPILOT_ANCHORS[type] to detect actions
  // marked manualOnly. Provide an empty registry so the lookup returns
  // undefined for every type and the executor falls through to its
  // normal dispatch.
  COPILOT_ANCHORS: {} as Record<string, unknown>,
}));

function okResponse(body: unknown = { success: true }): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function resetStore() {
  useBrowserStore.setState(useBrowserStore.getInitialState(), true);
  useBrowserStore.setState({
    chrom: '2R',
    start: 1000,
    end: 2000,
    datasets: [{ id: 'ds1', label: 'Dataset 1', available_layers: { tf: true, nuc: true } }],
    panels: [{
      id: 'panel-ds1',
      contentType: 'dataset',
      datasetId: 'ds1',
      subTracks: [],
      collapsed: false,
      linkGroup: null,
      layoutRow: 0,
    }],
    selectedDatasets: new Set<string>(),
  } as Partial<BrowserState>);
}

describe('executeBrowserAction', () => {
  beforeEach(() => {
    resetStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('adds remote tracks using the backend query-param contract', async () => {
    const fetchMock = vi.fn(async () => okResponse({ success: true, track_index: 0, label: 'Example signal', render_mode: 'signal' }));
    vi.stubGlobal('fetch', fetchMock);
    useBrowserStore.setState({ catalog: [], compositeTracks: [] } as Partial<BrowserState>);

    const message = await executeBrowserAction({
      type: 'add_track_from_url',
      path: 'https://example.org/signal.bigWig',
      track_label: 'Example signal',
      render_mode: 'signal',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/^\/api\/add_track\?/);
    const params = new URLSearchParams(String(url).split('?')[1]);
    expect(params.get('path')).toBe('https://example.org/signal.bigWig');
    expect(params.get('label')).toBe('Example signal');
    expect(params.get('render_mode')).toBe('signal');
    expect(init).toMatchObject({ method: 'POST', credentials: 'include' });
    expect((init as RequestInit).body).toBeUndefined();
    // Registered like the track browser does: a catalog entry and a cart row.
    expect(message).toBe('Added track https://example.org/signal.bigWig.');
    const st = useBrowserStore.getState();
    expect(st.catalog.map(e => [e.url, e.trackIndex])).toEqual([['https://example.org/signal.bigWig', 0]]);
    expect(st.compositeTracks).toHaveLength(1);
  });

  it('blocks local file paths in high-level add-track actions', async () => {
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal('fetch', fetchMock);

    const message = await executeBrowserAction({
      type: 'add_track_from_url',
      path: '/Users/me/private.bigWig',
    });

    expect(message).toContain('blocked');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('removes tracks through DELETE /api/tracks/{track_idx}', async () => {
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal('fetch', fetchMock);

    await executeBrowserAction({ type: 'remove_track', track_index: 5 });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/tracks/5',
      expect.objectContaining({ method: 'DELETE', credentials: 'include' }),
    );
  });

  it('removing a track shifts filters and drops its catalog entry', async () => {
    const fetchMock = vi.fn(async (url: string) => (String(url) === '/api/tracks'
      ? okResponse({ tracks: [{ path: 'https://x/a.bb' }, { path: 'https://x/b.bb' }] })
      : okResponse()));
    vi.stubGlobal('fetch', fetchMock);
    useBrowserStore.setState({
      trackFilters: { 0: ['CTCF'], 1: ['REST'] },
      catalog: [{ id: 'a', source: 'online', kind: 'bigbed', label: 'A', url: 'https://x/a.bb', loaded: true, trackIndex: 0, addedAt: 0 }],
      compositeTracks: [],
    } as unknown as Partial<BrowserState>);

    await executeBrowserAction({ type: 'remove_track', track_index: 0 });

    const st = useBrowserStore.getState();
    expect(st.trackFilters).toEqual({ 0: ['REST'] });
    expect(st.catalog.find(e => e.id === 'a')?.trackIndex).toBeUndefined();
  });

  it('a Copilot track filter lands in the browser\'s filters too', async () => {
    const fetchMock = vi.fn(async () => okResponse({ success: true, filter_names: ['CTCF'] }));
    vi.stubGlobal('fetch', fetchMock);
    useBrowserStore.setState({ trackFilters: {} } as Partial<BrowserState>);

    await executeBrowserAction({ type: 'set_track_filter', track_index: 2, filter_names: ['CTCF'] });

    expect(useBrowserStore.getState().trackFilters).toEqual({ 2: ['CTCF'] });
    expect(fetchMock).toHaveBeenCalledWith('/api/tracks/2/filter', expect.objectContaining({ method: 'POST' }));
  });

  it('selects reads in a cluster through the real selection slice API', async () => {
    useBrowserStore.setState({
      clusterAssignments: { ds1: { read_a: 1, read_b: 2, read_c: 1 } },
    } as Partial<BrowserState>);

    await executeBrowserAction({
      type: 'select_cluster_reads',
      dataset_id: 'ds1',
      cluster_id: 1,
    });

    expect(Array.from(useBrowserStore.getState().selectedReadIds.ds1).sort()).toEqual(['read_a', 'read_c']);
  });

  it('selects the nearest peak with the cluster mode shown in the toolbar', async () => {
    const ruleId = useBrowserStore.getState().peakRules[0].id;
    useBrowserStore.getState().setPeaksByRule(ruleId, [
      { start: 1200, end: 1300, index: 0, layer: 0 },
    ]);
    useBrowserStore.setState({
      clusterPeakMode: 'tf',
      selectedPeaks: new Set([99]),
      peakModes: { 99: 'nuc' },
    } as Partial<BrowserState>);

    await executeBrowserAction({
      type: 'select_peak_at',
      chrom: '2R',
      position: 1250,
      tolerance_bp: 100,
    });

    expect([...useBrowserStore.getState().selectedPeaks]).toEqual([0]);
    expect(useBrowserStore.getState().peakModes).toEqual({ 0: 'tf' });
  });

  it('clears peak modes together with selected peaks', async () => {
    useBrowserStore.setState({
      selectedPeaks: new Set([0]),
      peakModes: { 0: 'tf' },
      clusterAssignments: { ds1: { read_a: 0 } },
    } as Partial<BrowserState>);

    await executeBrowserAction({ type: 'clear_selected_peaks' });

    expect(useBrowserStore.getState().selectedPeaks.size).toBe(0);
    expect(useBrowserStore.getState().peakModes).toEqual({});
    expect(useBrowserStore.getState().clusterAssignments).toEqual({});
  });

  it('dissolves clusters through the same endpoint contract as the cluster panel', async () => {
    const fetchMock = vi.fn(async () => okResponse({
      results: {
        ds1: { assignments: { read_a: 2, read_b: 2 } },
      },
    }));
    vi.stubGlobal('fetch', fetchMock);
    useBrowserStore.setState({
      clusterAssignments: { ds1: { read_a: 1, read_b: 2 } },
      clusterPeakRegions: [{ start: 1100, end: 1200, mode: 'tf' }],
      clusterOrder: { ds1: [1, 2] },
      clusterFocus: { ds1: new Set([1]) },
      dynamicClustering: true,
    } as Partial<BrowserState>);

    await executeBrowserAction({ type: 'dissolve_cluster', cluster_id: 1 });
    // The reassignment model still had cluster 1: left on, a pan would bring it back.
    expect(useBrowserStore.getState().dynamicClustering).toBe(false);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/dissolve_cluster?');
    const params = new URLSearchParams(String(url).split('?')[1]);
    expect(params.get('chrom')).toBe('2R');
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.current_assignments).toEqual({ ds1: { read_a: 1, read_b: 2 } });
    expect(body.peak_regions).toEqual([{ start: 1100, end: 1200, mode: 'tf' }]);
    expect(useBrowserStore.getState().clusterAssignments.ds1).toEqual({ read_a: 2, read_b: 2 });
    expect(useBrowserStore.getState().clusterOrder.ds1).toEqual([2]);
    expect(useBrowserStore.getState().clusterFocus.ds1).toBeNull();
  });

  it('auto-culls clusters and writes returned assignments back to state', async () => {
    const fetchMock = vi.fn(async () => okResponse({
      results: {
        ds1: { assignments: { read_a: 2, read_b: 2 } },
      },
      dissolved: [{ cluster: 1, count: 1, reason: 'small' }],
    }));
    vi.stubGlobal('fetch', fetchMock);
    useBrowserStore.setState({
      clusterAssignments: { ds1: { read_a: 1, read_b: 2 } },
      clusterPeakRegions: [{ start: 1100, end: 1200, mode: 'tf' }],
      clusterOrder: { ds1: [1, 2] },
      clusterFocus: { ds1: new Set([1]) },
      dynamicClustering: true,
    } as Partial<BrowserState>);

    await executeBrowserAction({ type: 'auto_cull_clusters', min_fraction: 0.1, max_cosine_similarity: 0.9 });
    expect(useBrowserStore.getState().dynamicClustering).toBe(false);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/auto_cull_clusters?');
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.min_fraction).toBe(0.1);
    expect(body.max_cosine_similarity).toBe(0.9);
    expect(body.peak_regions).toEqual([{ start: 1100, end: 1200, mode: 'tf' }]);
    expect(useBrowserStore.getState().clusterAssignments.ds1).toEqual({ read_a: 2, read_b: 2 });
    expect(useBrowserStore.getState().clusterOrder.ds1).toEqual([2]);
  });

  it('applies sort rules with scope windows and term payloads', async () => {
    const fetchMock = vi.fn(async () => okResponse({
      results: {
        ds1: { cluster_order: [1, 0], read_sort_order: ['read_c', 'read_a'] },
      },
    }));
    vi.stubGlobal('fetch', fetchMock);
    useBrowserStore.setState({
      analysisSortRules: [{
        id: 'sort1',
        name: 'TF count',
        enabled: true,
        scope: { kind: 'currentWindow' },
        terms: [{ id: 'term1', source: 'layer', layer: 'tf', sizeMin: 20, sizeMax: 80 }],
        metric: 'count',
        descending: true,
      }],
    } as Partial<BrowserState>);

    await executeBrowserAction({ type: 'apply_sort_rule', rule_name: 'TF count' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/sort_reads?');
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.sort_by).toBe('rule');
    expect(body.rule).toMatchObject({ size_min: 20, size_max: 80 });
    expect(body.selected_peak_windows).toEqual([[1000, 2000]]);
    expect(body.layer).toBe('tf');
    expect(useBrowserStore.getState().clusterOrder.ds1).toEqual([1, 0]);
    expect(useBrowserStore.getState().readSortOrder.ds1).toEqual(['read_c', 'read_a']);
  });

  it('applies and pins analysis filter rules through the filter endpoint', async () => {
    const fetchMock = vi.fn(async () => okResponse({
      results: {
        ds1: { read_ids: ['read_a', 'read_c'], total: 3, filtered: 2 },
      },
    }));
    vi.stubGlobal('fetch', fetchMock);
    useBrowserStore.setState({
      analysisFilterRules: [{
        id: 'filter1',
        name: 'TF present',
        enabled: true,
        scope: { kind: 'currentWindow' },
        terms: [{ id: 'term1', source: 'layer', layer: 'tf', sizeMin: 20, sizeMax: 80 }],
        metric: 'count',
        operator: 'gte',
        threshold: 1,
      }],
    } as Partial<BrowserState>);

    await executeBrowserAction({ type: 'apply_filter_rule', rule_name: 'TF present' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/filter_by_analysis_rule?');
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.metric).toBe('count');
    expect(body.rule).toMatchObject({ size_min: 20, size_max: 80 });
    expect(body.scope_windows).toEqual([[1000, 2000]]);
    expect(body.layer).toBe('tf');
    expect(Array.from(useBrowserStore.getState().filteredReadIds.ds1 ?? []).sort()).toEqual(['read_a', 'read_c']);
    expect(useBrowserStore.getState().readFilterSources.ds1?.label).toBe('Rules > TF present');
  });
});

describe('rule sort/filter results go only where they apply', () => {
  beforeEach(() => {
    resetStore();
    useBrowserStore.setState({
      analysisFilterRules: [{
        id: 'filter1', name: 'TF present', enabled: true, scope: { kind: 'currentWindow' },
        terms: [{ id: 'term1', source: 'layer', layer: 'tf', sizeMin: 20, sizeMax: 80 }],
        metric: 'count', operator: 'gte', threshold: 1,
      }],
    } as Partial<BrowserState>);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a copy at another locus keeps its own filter (the request covered the main view)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ results: { ds1: { read_ids: ['read_a'] } } })));
    useBrowserStore.setState({
      panels: [
        ...useBrowserStore.getState().panels,
        { id: 'copy', contentType: 'dataset', datasetId: 'ds1', stateKey: 'copy', subTracks: [], collapsed: false,
          linkGroup: null, layoutRow: 0, viewportOverride: { chrom: '3L', start: 5000, end: 6000 } },
      ],
    } as Partial<BrowserState>);
    await executeBrowserAction({ type: 'apply_filter_rule', rule_name: 'TF present' });
    expect(Array.from(useBrowserStore.getState().filteredReadIds.ds1 ?? [])).toEqual(['read_a']);
    expect(useBrowserStore.getState().filteredReadIds.copy).toBeUndefined();
  });

  it('a result that arrives after the view moved is not applied', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      useBrowserStore.setState({ chrom: '3R', start: 1, end: 500 } as Partial<BrowserState>);  // navigated meanwhile
      return okResponse({ results: { ds1: { read_ids: ['read_a'] } } });
    }));
    const message = await executeBrowserAction({ type: 'apply_filter_rule', rule_name: 'TF present' });
    expect(message).toMatch(/view moved/);
    expect(useBrowserStore.getState().filteredReadIds.ds1).toBeUndefined();
  });

  it('a copy navigated elsewhere while the request ran does not take the result', async () => {
    useBrowserStore.setState({
      panels: [
        ...useBrowserStore.getState().panels,
        { id: 'copy', contentType: 'dataset', datasetId: 'ds1', stateKey: 'copy', subTracks: [], collapsed: false,
          linkGroup: null, layoutRow: 0 },
      ],
    } as Partial<BrowserState>);
    vi.stubGlobal('fetch', vi.fn(async () => {
      useBrowserStore.setState(s => ({
        panels: s.panels.map(p => p.id === 'copy' ? { ...p, viewportOverride: { chrom: '3L', start: 5000, end: 6000 } } : p),
      }));
      return okResponse({ results: { ds1: { read_ids: ['read_a'] } } });
    }));
    await executeBrowserAction({ type: 'apply_filter_rule', rule_name: 'TF present' });
    expect(Array.from(useBrowserStore.getState().filteredReadIds.ds1 ?? [])).toEqual(['read_a']);
    expect(useBrowserStore.getState().filteredReadIds.copy).toBeUndefined();
  });
});

describe('panel actions: strands, copies, top loci', () => {
  beforeEach(() => {
    resetStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const daf = () => useBrowserStore.setState({
    datasets: [{ id: 'ds1', label: 'DAF', available_layers: { deam: true } }],
  } as Partial<BrowserState>);

  it('shows one strand, both again, and splits into CT | GA', async () => {
    daf();
    expect(await executeBrowserAction({ type: 'set_panel_strand', strand: 'GA' })).toMatch(/GA-strand/);
    expect(useBrowserStore.getState().panels[0].strand).toBe('GA');
    await executeBrowserAction({ type: 'set_panel_strand', strand: 'both' });
    expect(useBrowserStore.getState().panels[0].strand).toBeUndefined();
    await executeBrowserAction({ type: 'split_panel_by_strand' });
    expect(useBrowserStore.getState().panels.map(p => p.strand)).toEqual(['CT', 'GA']);
  });

  it('strand actions need a DAF-seq panel', async () => {
    expect(await executeBrowserAction({ type: 'set_panel_strand', strand: 'CT' })).toMatch(/No DAF-seq panel/);
    expect(useBrowserStore.getState().panels[0].strand).toBeUndefined();
  });

  it('opens a linked copy, or an unlinked one at a location, and unlinks copies', async () => {
    await executeBrowserAction({ type: 'open_panel_copy' });
    let panels = useBrowserStore.getState().panels;
    expect(panels).toHaveLength(2);
    expect(panels[1].siteLocked).toBe(true);
    expect(panels[1].viewportOverride).toEqual({ chrom: '2R', start: 1000, end: 2000 });

    await executeBrowserAction({ type: 'open_panel_copy', chrom: '3L', start: 5000, end: 9000 });
    panels = useBrowserStore.getState().panels;
    const placed = panels.find(p => p.viewportOverride?.chrom === '3L')!;
    expect(placed.siteLocked).toBe(false);
    expect(placed.viewportOverride).toEqual({ chrom: '3L', start: 5000, end: 9000 });

    // "Unlink it" means the copy just opened, not every copy.
    await executeBrowserAction({ type: 'set_panel_linked', linked: true });
    panels = useBrowserStore.getState().panels;
    expect(panels.find(p => p.viewportOverride?.chrom === '3L')!.siteLocked).toBe(true);
    const before = new Set(useBrowserStore.getState().panels.map(p => p.id));
    await executeBrowserAction({ type: 'open_panel_copy' });
    const newest = useBrowserStore.getState().panels.find(p => !before.has(p.id))!;
    await executeBrowserAction({ type: 'set_panel_linked', linked: false });
    panels = useBrowserStore.getState().panels;
    expect(panels.find(p => p.id === newest.id)!.siteLocked).toBe(false);
    expect(panels.filter(p => p.viewportOverride && p.id !== newest.id).every(p => p.siteLocked)).toBe(true);
  });

  it('"unlink it" after copying a selected copy means the new copy, until the selection changes', async () => {
    await executeBrowserAction({ type: 'open_panel_copy' });
    const first = useBrowserStore.getState().panels.find(p => p.viewportOverride)!;
    useBrowserStore.setState({ selectedDatasets: new Set([first.id]) });
    const before = new Set(useBrowserStore.getState().panels.map(p => p.id));
    await executeBrowserAction({ type: 'open_panel_copy' });
    const second = useBrowserStore.getState().panels.find(p => !before.has(p.id))!;
    await executeBrowserAction({ type: 'set_panel_linked', linked: false });
    let panels = useBrowserStore.getState().panels;
    expect(panels.find(p => p.id === second.id)!.siteLocked).toBe(false);
    expect(panels.find(p => p.id === first.id)!.siteLocked).toBe(true);
    useBrowserStore.setState({ selectedDatasets: new Set([first.id]) });  // the user picks the first again
    await executeBrowserAction({ type: 'set_panel_linked', linked: false });
    panels = useBrowserStore.getState().panels;
    expect(panels.find(p => p.id === first.id)!.siteLocked).toBe(false);
  });

  it('link/unlink without copies says how to make one', async () => {
    expect(await executeBrowserAction({ type: 'set_panel_linked', linked: false })).toMatch(/add one with \+/);
  });

  it('goes to the next best-covered locus', async () => {
    const fetchMock = vi.fn(async () => okResponse({ success: true, windows: [
      { chrom: '2L', start: 100, end: 1100, depth: 400 },
      { chrom: '3R', start: 200, end: 1200, depth: 50 },
    ] }));
    vi.stubGlobal('fetch', fetchMock);
    const message = await executeBrowserAction({ type: 'go_to_top_locus' });
    expect(message).toMatch(/Locus 1 of 2/);
    const st = useBrowserStore.getState();
    expect([st.chrom, st.start, st.end]).toEqual(['2L', 100, 1100]);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/api\/reads\/top_windows\?span=1000/);
  });
});

describe('Copilot api_call guard (parity with the backend)', () => {
  it('refuses paths fetch or the server could rewrite', () => {
    for (const path of ['/api/x/../quit', '/api/./diagnose_bam', '/api/%2e%2e/quit', '/api/quit#x', '/api//quit', '/api\\quit']) {
      expect(canonicalApiPath(path)).toBeNull();
      expect(browserApiAllowed('POST', path).allowed).toBe(false);
    }
    expect(canonicalApiPath('/api/genes?chrom=chr2L')).toBe('/api/genes');
  });

  it('blocks file routes and path-like keys, allows plain calls', () => {
    expect(browserApiAllowed('GET', '/api/files/list').allowed).toBe(false);
    expect(browserApiAllowed('POST', '/api/dafc/load?cool_file=a.cool').allowed).toBe(false);
    expect(browserApiAllowed('POST', '/api/primer_config?blast_db_path=/db').allowed).toBe(false);
    expect(browserApiAllowed('POST', '/api/footprint/analyze', { session_dir: 'x' }).allowed).toBe(false);
    expect(browserApiAllowed('POST', '/api/primer_config', { target_tm: 60 }).allowed).toBe(true);
    expect(browserApiAllowed('GET', '/api/jupyter/region').allowed).toBe(true);
    expect(browserApiAllowed('POST', '/api/reference_pairs', [{ fasta: '/etc/shadow' }]).allowed).toBe(false);
    expect(browserApiAllowed('GET', '/api/reference_pairs').allowed).toBe(true);
    expect(browserApiAllowed('POST', '/api/datasets/add_grouped').allowed).toBe(false);
  });
});

describe('actions the review found missing or wrong', () => {
  beforeEach(() => resetStore());
  afterEach(() => vi.unstubAllGlobals());

  it('sets the accessibility (percent → fraction) and subnucleosomal thresholds', async () => {
    await executeBrowserAction({ type: 'set_accessibility_threshold', value: 60 });
    await executeBrowserAction({ type: 'set_subnucleosomal_threshold', value: 110 });
    const st = useBrowserStore.getState();
    expect(st.accessibilityThreshold).toBeCloseTo(0.6);
    expect(st.subnucleosomalThreshold).toBe(110);
  });

  it('navigates to a gene from an agent tool call', async () => {
    const fetchMock = vi.fn(async () => okResponse({ found: true, chrom: '3R', start: 10_000, end: 12_000, gene_name: 'ftz' }));
    vi.stubGlobal('fetch', fetchMock);
    const message = await executeBrowserAction({ type: 'navigate_gene', gene: 'ftz' });
    const st = useBrowserStore.getState();
    expect([st.chrom, st.start, st.end]).toEqual(['3R', 5_000, 17_000]);
    expect(message).toMatch(/ftz/);
  });

  it('designs 4C primers at the 4C endpoint and says when none were found', async () => {
    const fetchMock = vi.fn(async () => okResponse({ success: false, message: 'no viewpoint' }));
    vi.stubGlobal('fetch', fetchMock);
    const message = await executeBrowserAction({ type: 'design_primers_for_region', mode: '4c', chrom: '2R', start: 100, end: 200 });
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/design_4c_primers/);
    expect(message).toMatch(/no primers/);
    const manual = await executeBrowserAction({ type: 'design_primers_for_region', mode: 'dafc', chrom: '2R', start: 100, end: 200 });
    expect(manual).toMatch(/Manual step/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('puts designed primer pairs into the Primers panel', async () => {
    const pair = { fwd_seq: 'ACGT', rev_seq: 'TTGA', fwd_start: 90, rev_end: 210 };
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ success: true, pairs: [pair, { ...pair, fwd_seq: 'GGCC' }] })));
    const message = await executeBrowserAction({ type: 'design_primers_for_region', chrom: '2R', start: 100, end: 200 });
    const primer = useBrowserStore.getState().primer;
    expect(primer.designResults.map(p => p.fwd_seq)).toEqual(['ACGT', 'GGCC']);
    expect(primer.pair).toMatchObject({ fwd_seq: 'ACGT', designChrom: '2R', designTargetStart: 100, designTargetEnd: 200 });
    expect(message).toMatch(/Designed 2 standard primer pairs/);
  });

  it('adds a capture region named and padded like one from the Capture panel', async () => {
    useBrowserStore.setState({ captureRegions: [], capturePadding: 250 } as Partial<BrowserState>);
    await executeBrowserAction({ type: 'add_capture_region', chrom: '2R', start: 100, end: 900, region_label: 'eve_enhancer' });
    await executeBrowserAction({ type: 'add_capture_region', chrom: '2R', start: 1000, end: 1900 });
    const regions = useBrowserStore.getState().captureRegions;
    expect(regions.map(r => [r.name, r.padding, r.source])).toEqual([
      ['eve_enhancer', 250, 'custom'],
      ['region_2', 250, 'custom'],
    ]);
  });

  it('merges clusters per panel, leaving an independently clustered copy alone', async () => {
    const st = useBrowserStore.getState();
    const base = st.panels[0];
    useBrowserStore.setState({
      panels: [base, { ...base, id: 'copy', stateKey: 'copy' }],
      clusterAssignments: { [base.stateKey ?? base.datasetId!]: { r1: 0, r2: 1 }, copy: { r1: 5, r2: 5 } },
      clusterPeakRegions: [{ start: 1100, end: 1200 }],
    } as Partial<BrowserState>);
    const bodies: unknown[] = [];
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      bodies.push(body);
      const [dsId] = Object.keys(body.current_assignments ?? {});
      const merged = Object.fromEntries(Object.keys(body.current_assignments[dsId]).map(k => [k, 9]));
      return okResponse({ results: { [dsId]: { assignments: merged } }, dissolved: [{ cluster: 1, count: 1, reason: 'x' }] });
    });
    vi.stubGlobal('fetch', fetchMock);
    await executeBrowserAction({ type: 'auto_cull_clusters' });
    const after = useBrowserStore.getState().clusterAssignments;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Each panel got back what it sent, not the other's result.
    expect(Object.values(after.copy ?? {})).toEqual([9, 9]);
    expect(bodies.map(b => Object.values((b as { current_assignments: Record<string, Record<string, number>> }).current_assignments)[0])).toEqual(
      [{ r1: 0, r2: 1 }, { r1: 5, r2: 5 }]);
  });

  // fb-n6-integ (Codex): Copilot's merge and delete sent the main reference for
  // a panel on another assembly at the same coordinates (no panel_genome), and
  // every clustering peak. They send what the Clusters panel's buttons send.
  it.each(['auto_cull_clusters', 'dissolve_cluster'])('%s sends a panel on another assembly its reference and peaks', async (type) => {
    const base = useBrowserStore.getState().panels[0];
    useBrowserStore.setState({
      panels: [{ ...base, genome: 'dm6', viewportOverride: { chrom: '2R', start: 1000, end: 2000 } }],
      clusterAssignments: { ds1: { r1: 0, r2: 1 } },
      clusterOrder: { ds1: [0, 1] },
      clusterPeakRegions: [
        { start: 1100, end: 1200, mode: 'nuc', chrom: '2R', genome: 'dm6' },
        // Another run's peak on the main reference: not this panel's.
        { start: 1300, end: 1400, mode: 'nuc', chrom: '2R', genome: 'hg38' },
      ],
    } as Partial<BrowserState>);
    const fetchMock = vi.fn(async () => okResponse({
      results: { ds1: { assignments: { r1: 0, r2: 0 } } },
      dissolved: [{ cluster: 1, count: 1, reason: 'x' }],
    }));
    vi.stubGlobal('fetch', fetchMock);
    await executeBrowserAction({ type, cluster_id: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const params = new URLSearchParams(String(url).split('?')[1]);
    expect(params.get('panel_genome')).toBe('dm6');
    expect([params.get('chrom'), params.get('start'), params.get('end')]).toEqual(['2R', '1000', '2000']);
    expect(JSON.parse(String(init.body)).peak_regions).toEqual([{ start: 1100, end: 1200, mode: 'nuc' }]);
    expect(useBrowserStore.getState().clusterAssignments.ds1).toEqual({ r1: 0, r2: 0 });
  });

  it('auto_cull_clusters merges a clustered panel at a locus of its own there', async () => {
    const base = useBrowserStore.getState().panels[0];
    useBrowserStore.setState({
      navigationMode: 'perPanel',
      panels: [{ ...base, navOwn: true, viewportOverride: { chrom: '2R', start: 5000, end: 6000 } }],
      clusterAssignments: { ds1: { r1: 0, r2: 1 } },
      clusterPeakRegions: [{ start: 5100, end: 5200, mode: 'nuc', chrom: '2R' }],
    } as Partial<BrowserState>);
    const fetchMock = vi.fn(async () => okResponse({
      results: { ds1: { assignments: { r1: 0, r2: 0 } } },
      dissolved: [{ cluster: 1, count: 1, reason: 'x' }],
    }));
    vi.stubGlobal('fetch', fetchMock);
    await executeBrowserAction({ type: 'auto_cull_clusters' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const params = new URLSearchParams(String((fetchMock.mock.calls[0] as unknown as [string])[0]).split('?')[1]);
    expect([params.get('chrom'), params.get('start'), params.get('end')]).toEqual(['2R', '5000', '6000']);
    expect(useBrowserStore.getState().clusterAssignments.ds1).toEqual({ r1: 0, r2: 0 });
  });

  it('clearing filters includes panel copies (their own state keys)', async () => {
    const base = useBrowserStore.getState().panels[0];
    const baseKey = base.stateKey ?? base.datasetId!;
    useBrowserStore.setState({
      panels: [base, { ...base, id: 'copy', stateKey: 'copy' }],
      filteredReadIds: { [baseKey]: new Set(['a']), copy: new Set(['b']) },
    } as Partial<BrowserState>);
    const message = await executeBrowserAction({ type: 'clear_filter', dataset_id: base.datasetId! });
    const filters = useBrowserStore.getState().filteredReadIds;
    expect(filters[baseKey] ?? null).toBeNull();
    expect(filters.copy ?? null).toBeNull();
    expect(message).toMatch(/2 panels/);
  });

  it('loading motifs completes before the next action, and a failure fails the step', async () => {
    let resolveLoad: (() => void) | null = null;
    motifLoaderMock.addJasparMotifsByName.mockImplementationOnce(() => new Promise(resolve => {
      resolveLoad = () => {
        useBrowserStore.setState({ orthogonalTracks: [{ index: 3, label: 'CTCF', category: 'motif' }] } as never);
        resolve({ success: true, message: 'Motif added', catalogEntryIds: [] });
      };
    }));
    let done = false;
    const pending = executeBrowserAction({ type: 'load_jaspar_motifs', names: ['CTCF'] }).then(() => { done = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(done).toBe(false);
    resolveLoad!();
    await pending;
    expect(done).toBe(true);

    motifLoaderMock.addJasparMotifsByName.mockResolvedValueOnce({ success: false, message: 'No JASPAR motif named XYZ', catalogEntryIds: [] });
    await expect(executeBrowserAction({ type: 'load_jaspar_motifs', names: ['XYZ'] })).rejects.toThrow(/XYZ/);
  });
});

describe('cluster actions act on the panels they mean', () => {
  beforeEach(() => {
    resetStore();
    const base = useBrowserStore.getState().panels[0];
    useBrowserStore.setState({
      panels: [base, { ...base, id: 'copy', stateKey: 'copy' }],
      clusterAssignments: { ds1: { r1: 0, r2: 1 }, copy: { r1: 2, r2: 2, r3: 1 } },
      clusterOrder: { ds1: [0, 1], copy: [1, 2] },
    } as Partial<BrowserState>);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    registerClusterRunner(null);
  });

  it('focus, hide, select reads and select clusters go to the selected copy', async () => {
    useBrowserStore.setState({ selectedDatasets: new Set(['copy']) } as Partial<BrowserState>);
    await executeBrowserAction({ type: 'focus_cluster', cluster_id: 2 });
    await executeBrowserAction({ type: 'hide_cluster', cluster_id: 1 });
    await executeBrowserAction({ type: 'select_cluster_reads', cluster_id: 2 });
    await executeBrowserAction({ type: 'set_cluster_selection', cluster_ids: [2] });
    const st = useBrowserStore.getState();
    expect(Array.from(st.clusterFocus.copy ?? [])).toEqual([2]);
    expect(st.clusterFocus.ds1 ?? null).toBeNull();
    // Hiding leaves the order alone (cluster 1 was already hidden by the focus).
    expect(st.clusterOrder.copy).toEqual([1, 2]);
    expect(st.clusterOrder.ds1).toEqual([0, 1]);
    expect(Array.from(st.selectedReadIds.copy ?? []).sort()).toEqual(['r1', 'r2']);
    expect(st.selectedReadIds.ds1).toBeUndefined();
    expect(Array.from(st.selectedClusters.copy ?? [])).toEqual([2]);
    expect(st.selectedClusters.ds1).toBeUndefined();
  });

  it('without a selection, the dataset named (or the first) is used as before', async () => {
    await executeBrowserAction({ type: 'focus_cluster', cluster_id: 1, dataset_id: 'ds1' });
    expect(Array.from(useBrowserStore.getState().clusterFocus.ds1 ?? [])).toEqual([1]);
    expect(useBrowserStore.getState().clusterFocus.copy ?? null).toBeNull();
  });

  it('applying a cluster rule and subclustering finish only when clustering has', async () => {
    useBrowserStore.setState({
      clusterFeatureRules: [{ id: 'r1', name: 'Promoter', enabled: true, scope: { kind: 'currentWindow' }, terms: [] }],
    } as unknown as Partial<BrowserState>);
    let runs = 0;
    registerClusterRunner(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      runs += 1;
      useBrowserStore.getState().setClusterAssignments('ds1', { r1: 7 });
    });
    await executeBrowserAction({ type: 'apply_cluster_rule', rule_name: 'Promoter' });
    expect(runs).toBe(1);
    expect(useBrowserStore.getState().clusterAssignments.ds1).toEqual({ r1: 7 });
    await executeBrowserAction({ type: 'subcluster_clusters', cluster_ids: [7] });
    expect(runs).toBe(2);
    expect(Array.from(useBrowserStore.getState().selectedClusters.ds1 ?? [])).toEqual([7]);
  });

  it('clustering by saved footprints leaves a copy at another locus alone', async () => {
    const base = useBrowserStore.getState().panels[0];
    useBrowserStore.setState({
      panels: [base, { ...base, id: 'copy', stateKey: 'copy', viewportOverride: { chrom: '3L', start: 5000, end: 6000 } }],
      footprintGroups: [{
        id: 'g1', name: 'A', color: '#f00', enabled: true, sourceIndex: -1,
        referenceAbsStart: 1100, referenceAbsEnd: 1150, referenceChrom: '2R', sizeMin: 10, sizeMax: 60,
      }],
    } as unknown as Partial<BrowserState>);
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({
      co_occupancy: { ds1: { per_group: [{ ids_with: ['r1'], ids_without: ['r2'] }] } },
    })));
    const message = await executeBrowserAction({ type: 'cluster_by_saved_footprints' });
    expect(message).toMatch(/Clustered 2 reads/);
    const after = useBrowserStore.getState().clusterAssignments;
    expect(Object.keys(after.ds1 ?? {}).sort()).toEqual(['r1', 'r2']);
    expect(after.copy).toEqual({ r1: 2, r2: 2, r3: 1 });
  });

  it('subclustering a named dataset runs on its panel, then restores the selection', async () => {
    useBrowserStore.setState({ selectedDatasets: new Set(['copy']) } as Partial<BrowserState>);
    const ranOn: string[][] = [];
    registerClusterRunner(async () => { ranOn.push([...useBrowserStore.getState().selectedDatasets]); });
    const ds1Panel = useBrowserStore.getState().panels[0].id;
    await executeBrowserAction({ type: 'subcluster_clusters', cluster_ids: [1], dataset_id: 'ds1' });
    // 'copy' shows ds1 too but is its own state; the named dataset's selected panel is the copy.
    expect(ranOn).toEqual([['copy']]);
    useBrowserStore.setState({ selectedDatasets: new Set<string>() } as Partial<BrowserState>);
    ranOn.length = 0;
    await executeBrowserAction({ type: 'subcluster_clusters', cluster_ids: [1], dataset_id: 'ds1' });
    expect(ranOn).toEqual([[ds1Panel]]);
    expect(useBrowserStore.getState().selectedDatasets.size).toBe(0);
  });

  it('hide_cluster hides a cluster the way the Clusters panel does, keeping the last one', async () => {
    await executeBrowserAction({ type: 'hide_cluster', cluster_id: 1, dataset_id: 'ds1' });
    let st = useBrowserStore.getState();
    expect(Array.from(st.clusterFocus.ds1 ?? [])).toEqual([0]);
    expect(st.clusterOrder.ds1).toEqual([0, 1]);
    const message = await executeBrowserAction({ type: 'hide_cluster', cluster_id: 0, dataset_id: 'ds1' });
    st = useBrowserStore.getState();
    expect(message).toMatch(/last visible cluster stays/);
    expect(Array.from(st.clusterFocus.ds1 ?? [])).toEqual([0]);
  });

  it('merge_clusters on a named dataset merges in its selected copy, and says when nothing merged', async () => {
    useBrowserStore.setState({ selectedDatasets: new Set(['copy']) } as Partial<BrowserState>);
    const none = await executeBrowserAction({ type: 'merge_clusters', dataset_ids: ['ds1'] });
    expect(none).toMatch(/nothing merged/);
    useBrowserStore.getState().setClusterSelection('copy', [1, 2]);
    const message = await executeBrowserAction({ type: 'merge_clusters', dataset_ids: ['ds1'] });
    expect(message).toMatch(/Merged the selected clusters in 1 panel/);
    const st = useBrowserStore.getState();
    expect(new Set(Object.values(st.clusterAssignments.copy)).size).toBe(1);
    expect(st.clusterAssignments.ds1).toEqual({ r1: 0, r2: 1 });
  });

  it('clustering by saved footprints stores absolute regions and resets the old focus', async () => {
    useBrowserStore.setState({
      clusterFocus: { ds1: new Set([5]) },
      footprintGroups: [{
        id: 'g1', name: 'A', color: '#f00', enabled: true, sourceIndex: -1,
        referenceAbsStart: 1100, referenceAbsEnd: 1150, referenceChrom: '2R', sizeMin: 10, sizeMax: 60,
      }],
    } as unknown as Partial<BrowserState>);
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({
      co_occupancy: { ds1: { per_group: [{ ids_with: ['r1'], ids_without: ['r2'] }] } },
    })));
    await executeBrowserAction({ type: 'cluster_by_saved_footprints', dataset_id: 'ds1' });
    const st = useBrowserStore.getState();
    expect(st.clusterPeakRegions.map(r => [r.start, r.end])).toEqual([[1100, 1150]]);
    expect(st.clusterFocus.ds1 ?? null).toBeNull();
  });

  it('clustering by saved footprints is dropped when the clustering changes meanwhile', async () => {
    useBrowserStore.setState({
      footprintGroups: [{
        id: 'g1', name: 'A', color: '#f00', enabled: true, sourceIndex: -1,
        referenceAbsStart: 1100, referenceAbsEnd: 1150, referenceChrom: '2R', sizeMin: 10, sizeMax: 60,
      }],
    } as unknown as Partial<BrowserState>);
    vi.stubGlobal('fetch', vi.fn(async () => {
      // Another clustering (e.g. a branch switch) lands while the analysis runs.
      useBrowserStore.getState().setClusterAssignments('ds1', { r1: 3, r2: 3 });
      return okResponse({ co_occupancy: { ds1: { per_group: [{ ids_with: ['r1'], ids_without: ['r2'] }] } } });
    }));
    const message = await executeBrowserAction({ type: 'cluster_by_saved_footprints' });
    expect(message).toMatch(/clustering changed/);
    expect(useBrowserStore.getState().clusterAssignments.ds1).toEqual({ r1: 3, r2: 3 });
  });

  it('clustering by saved footprints is dropped when the view moves meanwhile', async () => {
    useBrowserStore.setState({
      footprintGroups: [{
        id: 'g1', name: 'A', color: '#f00', enabled: true, sourceIndex: -1,
        referenceAbsStart: 1100, referenceAbsEnd: 1150, referenceChrom: '2R', sizeMin: 10, sizeMax: 60,
      }],
    } as unknown as Partial<BrowserState>);
    vi.stubGlobal('fetch', vi.fn(async () => {
      useBrowserStore.setState({ start: useBrowserStore.getState().start + 5000, end: useBrowserStore.getState().end + 5000 });
      return okResponse({ co_occupancy: { ds1: { per_group: [{ ids_with: ['r1'], ids_without: ['r2'] }] } } });
    }));
    const message = await executeBrowserAction({ type: 'cluster_by_saved_footprints' });
    expect(message).toMatch(/view moved/);
    expect(useBrowserStore.getState().clusterAssignments.ds1).toEqual({ r1: 0, r2: 1 });
  });
});

describe('round-5 action fixes', () => {
  beforeEach(() => {
    resetStore();
    useBrowserStore.setState({
      clusterAssignments: { ds1: { r1: 0, r2: 1, r3: 1 } },
      clusterOrder: { ds1: [0, 1] },
      clusterPeakRegions: [{ start: 1100, end: 1200 }],
    } as Partial<BrowserState>);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    registerScanRunner(null);
  });

  it('a dissolve response is dropped when the clustering changed while it ran', async () => {
    const newer = { r1: 5, r2: 5, r3: 6 };
    vi.stubGlobal('fetch', vi.fn(async () => {
      useBrowserStore.getState().setClusterAssignments('ds1', newer);
      return okResponse({ results: { ds1: { assignments: { r1: 1, r2: 1, r3: 1 } } } });
    }));
    const message = await executeBrowserAction({ type: 'dissolve_cluster', cluster_id: 0 });
    expect(message).toMatch(/changed while it ran/);
    expect(useBrowserStore.getState().clusterAssignments.ds1).toEqual(newer);
  });

  it('a merge response is dropped when another branch is shown meanwhile', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      useBrowserStore.setState({ activeClusterTreeNodeId: 'branch-b' } as Partial<BrowserState>);
      return okResponse({ results: { ds1: { assignments: { r1: 1, r2: 1, r3: 1 } } }, dissolved: [{ cluster: 0 }] });
    }));
    const message = await executeBrowserAction({ type: 'auto_cull_clusters' });
    expect(message).toMatch(/changed while it ran/);
    expect(useBrowserStore.getState().clusterAssignments.ds1).toEqual({ r1: 0, r2: 1, r3: 1 });
  });

  it('scan_peaks finishes only when the scan has', async () => {
    let scanned = false;
    registerScanRunner(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      scanned = true;
    });
    await executeBrowserAction({ type: 'scan_peaks' });
    expect(scanned).toBe(true);
  });

  it('a failed motif query never reports the view\'s cached hits for another region', async () => {
    useBrowserStore.setState({
      orthogonalTracks: [{ index: 3, label: 'CTCF', category: 'motif' }],
      orthogonalTrackData: { 3: { intervals: [{ start: 1200, end: 1300, name: 'm' }] } },
    } as never);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    await expect(executeBrowserAction({ type: 'query_motif_overlaps', chrom: '3', start: 1000, end: 2000 }))
      .rejects.toThrow(/Motif query failed/);
    // Inside the view, the cached intervals still answer.
    const message = await executeBrowserAction({ type: 'query_motif_overlaps', chrom: '2R', start: 1000, end: 2000 });
    expect(message).toMatch(/CTCF:m 2R:1200-1300/);
  });
});
