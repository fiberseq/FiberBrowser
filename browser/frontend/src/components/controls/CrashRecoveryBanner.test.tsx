import { beforeEach, describe, expect, it, vi } from 'vitest';
import { collectFrontendState } from '../../api/session';
import { useBrowserStore } from '../../stores/browserStore';
import type { SerializedState } from '../../stores/historySlice';
import { matchSavedDataset, remapSavedClusters, restoreReference, restoreSnapshot } from './CrashRecoveryBanner';

beforeEach(() => {
  localStorage.clear();
  useBrowserStore.setState({
    chrom: 'chr2R',
    start: 100,
    end: 200,
    datasets: [],
    currentGenome: null,
    fastaPath: null,
    catalog: [],
    compositeTracks: [],
    savedTracks: [],
    selectedPeaks: new Set(),
    selectedDatasets: new Set(),
    selectedReadIds: {},
    clusterFocus: {},
    filteredReadIds: {},
    hiddenStripPanels: new Set(),
    collapsedRows: new Set(),
    analysisStripCollapsed: false,
    clickTargetLayer: null,
    footprintAnalysisLayer: null,
    readScrollOffsets: {},
    showGenomeOverview: true,
    publicMode: false,
    maxRegionForReads: 100_000,
    captureRegions: [],
    capturePadding: 0,
    savedClusters: [],
    primer: {
      ...useBrowserStore.getState().primer,
      configFasta: null,
      configBlastDb: null,
      savedPrimers: [],
      mode: 'standard',
      dafcQuads: [],
      cartTrackDisplay: 'off',
    },
  } as any);
});

describe('CrashRecoveryBanner restoreSnapshot', () => {
  it('restores newer UX and reproducibility fields from autosave snapshots', async () => {
    const captureRegions = [{
      id: 'cap-1',
      name: 'capture_1',
      chrom: 'chr2R',
      start: 120,
      end: 180,
      padding: 25,
      addedAt: 1,
      source: 'viewport',
    }];
    const savedClusters = [{
      id: 'cluster-1',
      name: 'Cluster snapshot',
      createdAt: 1,
      clusterK: 4,
      clusterMethod: 'kmeans',
      assignments: { ds1: { read1: 0 } },
      order: { ds1: [0] },
      peaks: [],
      peakModes: {},
    }];

    useBrowserStore.setState({
      clickTargetLayer: 'tf',
      footprintAnalysisLayer: 'nuc',
      activeColormap: {
        name: 'Legacy labels',
        rules: [{
          id: 'legacy-rule',
          name: 'Legacy rule',
          color: '#22c55e',
          sizeMin: 1,
          sizeMax: null,
          enabled: true,
        }],
      },
      readScrollOffsets: { ds1: 72 },
      showGenomeOverview: false,
      publicMode: true,
      maxRegionForReads: 250_000,
      hiddenStripPanels: new Set(['history', 'read-stats']),
      collapsedRows: new Set([0, 2]),
      analysisStripCollapsed: true,
      captureRegions,
      capturePadding: 25,
      savedClusters,
      primer: {
        ...useBrowserStore.getState().primer,
        configBlastDb: '/tmp/dm6_blast',
        savedPrimers: [{ name: 'primer-a', chrom: 'chr2R', targetStart: 120, targetEnd: 180, addedAt: 1, pair: {} }],
      },
    } as any);

    const snapshot = collectFrontendState() as unknown as SerializedState;
    (snapshot as unknown as Record<string, unknown>).interactionMode = 'read';  // an older snapshot's field
    snapshot.enabledModTypes = {
      ...snapshot.enabledModTypes,
      deam_opportunity: true,
    };

    useBrowserStore.setState({
      clickTargetLayer: null,
      footprintAnalysisLayer: null,
      activeColormap: { name: 'Changed labels', rules: [] },
      readScrollOffsets: {},
      showGenomeOverview: true,
      publicMode: false,
      maxRegionForReads: 100_000,
      hiddenStripPanels: new Set(),
      collapsedRows: new Set(),
      analysisStripCollapsed: false,
      captureRegions: [],
      capturePadding: 0,
      savedClusters: [],
      primer: {
        ...useBrowserStore.getState().primer,
        configFasta: '/tmp/current.fa',
        configBlastDb: null,
        savedPrimers: [],
        mode: 'dafc',
        dafcQuads: [{ max_tm_range: 1 }],
        cartTrackDisplay: 'all',
      },
    } as any);

    await restoreSnapshot(snapshot);

    const state = useBrowserStore.getState();
    expect(state.clickTargetLayer).toBe('tf');
    expect(state.footprintAnalysisLayer).toBe('nuc');
    expect(state.enabledModTypes.deam_opportunity).toBeUndefined();
    expect(state.activeColormap.name).toBe('Legacy labels');
    expect(state.activeColormap.qualityFilters).toEqual(expect.arrayContaining([
      expect.objectContaining({ layer: 'fire', qualityName: 'aq', minValue: 230, enabled: true }),
    ]));
    expect(state.activeColormap.rules[0]).toMatchObject({
      targetLayers: [],
      conditions: [],
      qualityGates: [],
    });
    expect(state.readScrollOffsets).toEqual({});
    expect(state.showGenomeOverview).toBe(false);
    expect(state.publicMode).toBe(true);
    expect(state.maxRegionForReads).toBe(250_000);
    // A snapshot saved while click modes existed restores without one (fb-r4-clicks).
    expect('interactionMode' in state).toBe(false);
    expect(state.hiddenStripPanels).toEqual(new Set(['history', 'read-stats']));
    expect(state.collapsedRows).toEqual(new Set([0, 2]));
    expect(state.analysisStripCollapsed).toBe(true);
    expect(state.captureRegions).toEqual(captureRegions);
    expect(state.capturePadding).toBe(25);
    expect(state.savedClusters).toEqual(savedClusters);
    expect(state.primer.configFasta).toBe('/tmp/current.fa');
    expect(state.primer.configBlastDb).toBe('/tmp/dm6_blast');
    expect(state.primer.savedPrimers).toHaveLength(1);
    expect(state.primer.mode).toBe('dafc');
    expect(state.primer.dafcQuads).toEqual([]);
    expect(state.primer.cartTrackDisplay).toBe('all');
  });
});

describe('autosave layout refresh',()=>{
  it.each(['sample','all'] as const)('refreshes autosaved %s geometry',async mode=>{
    const before=useBrowserStore.getState().refreshGeneration;
    const snapshot={...collectFrontendState(),datasets:[],currentGenome:null,
      readDisplayMode:mode,readScrollOffsets:{ds1:72},uiScale:2} as unknown as SerializedState;
    await restoreSnapshot(snapshot);
    expect(useBrowserStore.getState().refreshGeneration).toBeGreaterThan(before);
    expect(useBrowserStore.getState().readScrollOffsets).toEqual(mode==='all'?{ds1:72}:{});
  });
});

describe('CrashRecoveryBanner restoreSnapshot: rules and cluster branches', () => {
  it('restores analysis rules, peak mode, cluster branches and selected clusters', async () => {
    const node = {
      id: 'n1', parentId: null, name: 'All reads', createdAt: 1, chrom: 'chr2R', start: 100, end: 200,
      sourceClusterIds: [], clusterMethod: 'kmeans', clusterK: 3, subnucleosomalThreshold: 90,
      accessibilityThreshold: 0.5, peakRegions: [], selectedPeakIndices: [], peakModes: {}, patterns: {},
      dynamicClustering: false, assignments: { ds1: { r1: 0 } }, order: { ds1: [0] }, focus: {},
    };
    const snapshot = {
      chrom: 'chr2R', start: 100, end: 200,
      clusterPeakMode: 'tf',
      clusterFeatureRules: [],
      analysisSortRules: [],
      analysisFilterRules: [],
      clusterTreeNodes: { n1: node },
      clusterTreeRootIds: ['n1'],
      activeClusterTreeNodeId: 'n1',
      selectedClusters: { ds1: [2] },
    } as unknown as SerializedState;
    useBrowserStore.setState({ clusterTreeNodes: {}, clusterTreeRootIds: [], activeClusterTreeNodeId: null, clusterPeakMode: 'accessibility', selectedClusters: {} } as any);
    await restoreSnapshot(snapshot);
    const state = useBrowserStore.getState();
    expect(state.clusterPeakMode).toBe('tf');
    expect(Object.keys(state.clusterTreeNodes)).toEqual(['n1']);
    expect(state.clusterTreeRootIds).toEqual(['n1']);
    expect(state.activeClusterTreeNodeId).toBe('n1');
    expect(state.selectedClusters.ds1).toEqual(new Set([2]));
  });
});

describe('matchSavedDataset', () => {
  it('reuses a loaded dataset only when it holds exactly the saved files', () => {
    const a = { id: 'a', paths: ['/data/A.bam'] };
    const ab = { id: 'ab', paths: ['/data/B.bam', '/data/A.bam'] };
    expect(matchSavedDataset(['/data/A.bam', '/data/B.bam'], [a])).toBeUndefined();
    expect(matchSavedDataset(['/data/A.bam', '/data/B.bam'], [a, ab])).toBe(ab);
    expect(matchSavedDataset(['/data/A.bam'], [ab, a])).toBe(a);
  });
});

describe('restoreReference', () => {
  const pairs = [{ fasta: '/ref/hap1.fa', annotation: '/ref/hap1.gtf' }, { fasta: '/ref/hap2.fa', annotation: null }];
  const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

  it('reloads a saved collection of reference pairs whole', async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body as string | undefined });
      if (init?.method === 'POST') return jsonResponse({ success: true });
      return jsonResponse({ pairs: [{ fasta: '/ref/other.fa', annotation: null }] });
    }));
    await restoreReference({ fastaPath: '/ref/hap1.fa', referencePairs: pairs });
    const post = calls.find(c => c.method === 'POST');
    expect(post?.url).toContain('/api/reference_pairs');
    expect(JSON.parse(post!.body!)).toEqual(pairs);
    expect(calls.some(c => c.url.includes('load_fasta'))).toBe(false);
    expect((useBrowserStore.getState() as any).referencePairs).toEqual(pairs);
    vi.unstubAllGlobals();
  });

  it('leaves the server alone when it still has the saved collection', async () => {
    const methods: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      methods.push(init?.method ?? 'GET');
      return jsonResponse({ pairs });
    }));
    await restoreReference({ fastaPath: '/ref/hap1.fa', referencePairs: pairs });
    expect(methods).toEqual(['GET']);
    vi.unstubAllGlobals();
  });

  it('reloads a single saved pair with its annotation, even when the FASTA alone is loaded', async () => {
    const single = [{ fasta: '/ref/hap1.fa', annotation: '/ref/hap1.gtf' }];
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body as string | undefined });
      if (init?.method === 'POST') return jsonResponse({ success: true });
      return jsonResponse({ pairs: [{ fasta: '/ref/hap1.fa', annotation: null }] });
    }));
    await restoreReference({ fastaPath: '/ref/hap1.fa', referencePairs: single });
    const post = calls.find(c => c.method === 'POST');
    expect(post?.url).toContain('/api/reference_pairs');
    expect(JSON.parse(post!.body!)).toEqual(single);
    expect(calls.some(c => c.url.includes('load_fasta'))).toBe(false);
    vi.unstubAllGlobals();
  });
});

describe('round 11: recovered saved clusterings and legacy layer settings', () => {
  it('remaps saved clusterings to the recovered datasets', () => {
    const saved = [{
      id: 's1', name: 'A', addedAt: 1, chrom: 'chr1', start: 0, end: 100,
      clusterMethod: 'kmeans', clusterK: 2, subnucleosomalThreshold: 90, accessibilityThreshold: 0.5,
      peakRegions: [], customPeaks: [], selectedPeakIndices: [], peakModes: {}, patterns: {},
      assignments: { old: { r1: 0 } }, order: { old: [0] },
      panelResults: [{ stateKey: 'old', datasetId: 'old', assignments: { r1: 0 } }],
    }];
    const [out] = remapSavedClusters(saved, { old: 'new' });
    expect(Object.keys(out.assignments)).toEqual(['new']);
    expect(Object.keys(out.order)).toEqual(['new']);
    expect(out.panelResults?.[0]).toMatchObject({ stateKey: 'new', datasetId: 'new' });
  });

  it('restores legacy layer inference settings', async () => {
    useBrowserStore.setState({ legacyLayerInference: true, legacyNucMinSize: 90 } as never);
    const snapshot = { ...collectFrontendState(), datasets: [], currentGenome: null,
      legacyLayerInference: false, legacyNucMinSize: 150 } as unknown as SerializedState;
    await restoreSnapshot(snapshot);
    expect(useBrowserStore.getState().legacyLayerInference).toBe(false);
    expect(useBrowserStore.getState().legacyNucMinSize).toBe(150);
  });
});

describe('crash recovery saved by a build with a plugin pack this one lacks', () => {
  it('leaves the pack\'s panels and the datasets only they showed out before reopening anything', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { calls.push(String(url)); return new Response('{}', { status: 500 }); }));
    const packs = { extras: { label: 'Extra features', panels: ['extra-panel'], tracks: [], features: [], panelFields: ['extraOwner'], panelOwners: ['extraOwner'], stateKeys: [] } };
    const snapshot = {
      ...collectFrontendState(), currentGenome: null, packs,
      datasets: [{ id: 'ds_owned', label: 'o', paths: ['/o.bam'] }],
      panels: [
        { id: 'p', contentType: 'extra-panel', datasetId: null, subTracks: [] },
        { id: 'owned', contentType: 'dataset', datasetId: 'ds_owned', subTracks: [], extraOwner: {} },
      ],
      fullViewPanelId: 'p',
    } as unknown as SerializedState;
    try {
      await restoreSnapshot(snapshot);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(calls.filter(u => u.includes('/api/datasets'))).toEqual([]);
    expect(useBrowserStore.getState().panels.map(p => p.id)).toEqual([]);
    expect(useBrowserStore.getState().fullViewPanelId).toBeNull();
  });
});
