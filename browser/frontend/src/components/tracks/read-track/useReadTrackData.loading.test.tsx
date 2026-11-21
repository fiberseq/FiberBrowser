import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getCompactReads = vi.fn();
vi.mock('../../../api/readOperations', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../api/readOperations')>()),
  getCompactReads: (...args: unknown[]) => getCompactReads(...args),
  getCompactReadsAll: (...args: unknown[]) => getCompactReads(...args),
}));

import { useReadTrackData } from './useReadTrackData';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type Params = Parameters<typeof useReadTrackData>[0];

function params(overrides: Partial<Params>): Params {
  return {
    readStrand: null, chrom: 'chr1', start: 1000, end: 2000, datasetId: 'ds', spanningOnly: false,
    width: 800, height: 300, isBAM: true,
    needsMethylation: false, needsLayers: false, requestedLayers: [], needsLayerQualities: false,
    useServerMetaprofile: false, serverMetaprofileLayers: [],
    needsCigar: false, fillSmallGaps: false, fillGapSize: 0, hideTerminalGaps: true, terminalGapThreshold: 500,
    minFpQuality: 0, minFootprints: 0, showDuplicateReads: false, downsampleCount: null,
    readDisplayMode: 'fit', allReadsDisplayCap: 5000, backgroundReadCap: null, readRowHeight: 3,
    readSeparatorMode: 'off', readSeparatorMinHeight: 3, readSeparatorWidth: 1,
    exportMatchedReadCount: null, exportMatchedReadFetchCount: null,
    legacyLayerInference: true, legacyNucMinSize: 90,
    hasPushedReads: false, jupyterPushedReads: null,
    hasClusterFocus: false, myClusterFocus: null, hasFilter: false, myFilteredReadIds: null,
    myClusterAssignments: {}, myClusterOrder: [], myReadSortOrder: [], hasCluster: false,
    myJupyterOrder: [], hasJupyterFilter: false, jupyterFilterSet: null,
    ...overrides,
  } as Params;
}

let loading: boolean | null = null;
let snapshot: ReturnType<typeof useReadTrackData>;
function Probe(props: { p: Params }) {
  snapshot = useReadTrackData(props.p);
  loading = snapshot.loading;
  return null;
}

describe('useReadTrackData loading flag', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    loading = null;
    getCompactReads.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('starts native, MAT and PAT together on a pan and publishes each response independently', async () => {
    const { useBrowserStore } = await import('../../../stores/browserStore');
    const before = useBrowserStore.getState();
    const states = new Map<string, ReturnType<typeof useReadTrackData>>();
    const pending: Array<{ q: URLSearchParams; answer: (value: unknown) => void }> = [];
    getCompactReads.mockImplementation((q: URLSearchParams) => new Promise(answer => {
      pending.push({ q: new URLSearchParams(q), answer });
    }));
    function Panel({ id, start }: { id: string; start: number }) {
      const p = params({ datasetId: id === 'native' ? 'native' : 'lift', stateKey: id,
        liftHap: id === 'native' ? null : id, start, end: start + 1000 });
      const data = useReadTrackData(p);
      states.set(id, data);
      return <div data-panel={id} data-loading={data.loading}>{data.reads.map(r => r.id).join(',')}</div>;
    }
    const panels = (start: number) => <>{['native', 'MAT', 'PAT'].map(id => <Panel key={id} id={id} start={start} />)}</>;
    try {
      useBrowserStore.setState({ datasets: [{ id: 'native', data_type: 'bam' }, { id: 'lift', data_type: 'bam_livelift' }] as any });
      await act(async () => { root.render(panels(1000)); });
      expect(pending).toHaveLength(3);
      const old = pending.splice(0);
      await act(async () => { root.render(panels(1250)); });
      expect(pending).toHaveLength(3);
      expect(pending.map(({ q }) => [q.get('dataset_id'), q.get('lift_hap'), q.get('start')]))
        .toEqual([['native', null, '1250'], ['lift', 'MAT', '1250'], ['lift', 'PAT', '1250']]);
      const response = (id: string) => ({ count: 1, total: 1, width: 1000, reads: [{ id, intervals: [[0, 100, 100]] }] });
      await act(async () => { pending[2].answer(response('pat-row')); });
      expect(states.get('PAT')!.loading).toBe(false);
      expect(container.querySelector('[data-panel="PAT"]')!.textContent).toBe('pat-row');
      expect(states.get('native')!.loading).toBe(true);
      expect(states.get('MAT')!.loading).toBe(true);
      await act(async () => { old[2].answer(response('stale')); });
      expect(container.querySelector('[data-panel="PAT"]')!.textContent).toBe('pat-row');
      await act(async () => { pending[1].answer(response('mat-row')); pending[0].answer(response('native-row')); });
      expect([...states.values()].every(s => !s.loading)).toBe(true);
    } finally {
      await act(async () => { root.unmount(); });
      root = createRoot(container);
      useBrowserStore.setState({ datasets: before.datasets });
    }
  });

  it('draws a first paint, says it is partial, then takes the full set without redrawing the same rows', async () => {
    const { useBrowserStore } = await import('../../../stores/browserStore');
    const before = useBrowserStore.getState();
    const pending: Array<{ q: URLSearchParams; answer: (value: unknown) => void }> = [];
    getCompactReads.mockImplementation((q: URLSearchParams) => new Promise(answer => {
      pending.push({ q: new URLSearchParams(q), answer });
    }));
    const rows = [{ id: 'r1', intervals: [[0, 100, 100]] }, { id: 'r2', intervals: [[0, 90, 90]] }];
    const batch = (extra: object) => ({ width: 1000, datasets: { ds: { count: 2, width: 1000, reads: rows, ...extra } } });
    try {
      await act(async () => {
        useBrowserStore.setState({ datasets: [{ id: 'ds', data_type: 'bam' }, { id: 'other', data_type: 'bam' }] as any,
          chrom: 'chr1', start: 1000, end: 2000 } as any);
        root.render(<Probe p={params({})} />);
      });
      expect(pending).toHaveLength(1);
      expect(pending[0].q.get('first_paint')).toBe('true');
      expect(pending[0].q.get('dataset_ids')).toBe('ds,other');
      await act(async () => { pending[0].answer(batch({ total: 4838, working_count: 4838,
        first_paint: { partial: true, shown: 2, total_estimate: 4838 } })); });
      expect(snapshot.firstPaint).toEqual({ partial: true, shown: 2, total_estimate: 4838 });
      expect(snapshot.loading).toBe(false);
      expect(snapshot.reads.map(r => r.id)).toEqual(['r1', 'r2']);
      const partialRows = snapshot.reads;
      // The full set: the same view on the background pool.
      expect(pending).toHaveLength(2);
      expect(pending[1].q.get('background')).toBe('true');
      expect(pending[1].q.has('first_paint')).toBe(false);
      await act(async () => { pending[1].answer(batch({ total: 4639, working_count: 4639, sv_summary: { clusters: [] } })); });
      expect(snapshot.firstPaint).toBeNull();
      expect(snapshot.workingReads).toBe(4639);
      expect(snapshot.svSummary).toEqual({ clusters: [] });
      expect(snapshot.reads).toBe(partialRows);
      // A resize while a first paint is shown asks for the full set only (no second first paint).
      pending.length = 0;
      await act(async () => { root.render(<Probe p={params({ height: 400, start: 1100, end: 2100 })} />); });
      await act(async () => {
        useBrowserStore.setState({ start: 1100, end: 2100 } as any);
      });
      const firstOfNew = pending.find(p => p.q.get('start') === '1100' && p.q.get('first_paint') === 'true');
      expect(firstOfNew).toBeTruthy();
      await act(async () => { firstOfNew!.answer(batch({ total: 4838, first_paint: { partial: true, shown: 2, total_estimate: 4838 } })); });
      pending.length = 0;
      await act(async () => { root.render(<Probe p={params({ height: 500, start: 1100, end: 2100 })} />); });
      expect(pending.length).toBeGreaterThan(0);
      expect(pending.every(p => p.q.get('first_paint') !== 'true')).toBe(true);
      expect(pending.some(p => p.q.get('background') === 'true' && p.q.get('start') === '1100')).toBe(true);
      expect(snapshot.firstPaint).not.toBeNull();
      expect(snapshot.loading).toBe(false);
    } finally {
      await act(async () => { root.unmount(); });
      root = createRoot(container);
      useBrowserStore.setState({ datasets: before.datasets, chrom: before.chrom, start: before.start, end: before.end } as any);
    }
  });

  it('a first paint left by a zoom-out is loaded again on coming back, never resumed over an empty panel', async () => {
    const { useBrowserStore } = await import('../../../stores/browserStore');
    const before = useBrowserStore.getState();
    const pending: Array<{ q: URLSearchParams; answer: (value: unknown) => void }> = [];
    getCompactReads.mockImplementation((q: URLSearchParams) => new Promise(answer => {
      pending.push({ q: new URLSearchParams(q), answer });
    }));
    const rows = [{ id: 'r1', intervals: [[0, 100, 100]] }];
    try {
      await act(async () => {
        useBrowserStore.setState({ datasets: [{ id: 'ds', data_type: 'bam' }, { id: 'other', data_type: 'bam' }] as any,
          chrom: 'chr1', start: 1000, end: 2000, maxRegionForReads: 50_000 } as any);
        root.render(<Probe p={params({})} />);
      });
      await act(async () => { pending[0].answer({ width: 1000, datasets: { ds: { count: 1, width: 1000, reads: rows, total: 900,
        first_paint: { partial: true, shown: 1, total_estimate: 900 } } } }); });
      expect(snapshot.reads.map(r => r.id)).toEqual(['r1']);
      // Zoomed out past the read window before the full set lands: the rows go.
      await act(async () => { root.render(<Probe p={params({ start: 0, end: 200_000 })} />); });
      expect(snapshot.reads).toEqual([]);
      pending.length = 0;
      await act(async () => { root.render(<Probe p={params({})} />); });
      // Back: a first paint again (loading), not "resume the full set" over no rows.
      expect(pending.some(p => p.q.get('first_paint') === 'true')).toBe(true);
      expect(snapshot.loading).toBe(true);
    } finally {
      await act(async () => { root.unmount(); });
      root = createRoot(container);
      useBrowserStore.setState({ datasets: before.datasets, chrom: before.chrom, start: before.start, end: before.end,
        maxRegionForReads: before.maxRegionForReads } as any);
    }
  });

  it('a clustered panel that would batch loads every read on its own, never a deep-view sample', async () => {
    const { useBrowserStore } = await import('../../../stores/browserStore');
    const before = useBrowserStore.getState();
    const pending: Array<{ q: URLSearchParams }> = [];
    getCompactReads.mockImplementation((q: URLSearchParams) => { pending.push({ q: new URLSearchParams(q) }); return new Promise(() => {}); });
    try {
      await act(async () => {
        useBrowserStore.setState({ datasets: [{ id: 'ds', data_type: 'bam' }, { id: 'other', data_type: 'bam' }] as any,
          chrom: 'chr1', start: 1000, end: 2000 } as any);
        root.render(<Probe p={params({})} />);
      });
      expect(pending[0].q.get('dataset_ids')).toBe('ds,other');
      pending.length = 0;
      await act(async () => { root.render(<Probe p={params({ clusteredReadIds: new Set(['r1', 'r2']), hasCluster: true })} />); });
      const single = pending.find(p => p.q.get('dataset_id') === 'ds');
      expect(single).toBeTruthy();
      expect(single!.q.get('full_working_set')).toBe('true');
    } finally {
      await act(async () => { root.unmount(); });
      root = createRoot(container);
      useBrowserStore.setState({ datasets: before.datasets, chrom: before.chrom, start: before.start, end: before.end } as any);
    }
  });

  it('a layer added on the same view keeps the rows drawn and asks for the full set, never a first paint', async () => {
    const { useBrowserStore } = await import('../../../stores/browserStore');
    const before = useBrowserStore.getState();
    const pending: Array<{ q: URLSearchParams; answer: (value: unknown) => void }> = [];
    getCompactReads.mockImplementation((q: URLSearchParams) => new Promise(answer => {
      pending.push({ q: new URLSearchParams(q), answer });
    }));
    const rows = [{ id: 'r1', intervals: [[0, 100, 100]] }, { id: 'r2', intervals: [[0, 90, 90]] }];
    const batch = (extra: object, reads: object[] = rows) => ({ width: 1000, datasets: { ds: { count: reads.length, width: 1000, reads, ...extra } } });
    try {
      await act(async () => {
        useBrowserStore.setState({ datasets: [{ id: 'ds', data_type: 'bam' }, { id: 'other', data_type: 'bam' }] as any,
          chrom: 'chr1', start: 1000, end: 2000 } as any);
        root.render(<Probe p={params({})} />);
      });
      expect(pending[0].q.get('first_paint')).toBe('true');
      await act(async () => { pending[0].answer(batch({ total: 2, working_count: 2 })); });
      expect(snapshot.reads.map(r => r.id)).toEqual(['r1', 'r2']);
      const drawn = snapshot.reads;
      pending.length = 0;
      // A cluster view asks for the regularity layer: the same locus, another request.
      await act(async () => { root.render(<Probe p={params({ needsLayers: true, requestedLayers: ['nucreg'], batchRequestedLayers: ['nucreg'] })} />); });
      expect(pending).toHaveLength(1);
      expect(pending[0].q.get('layer_names')).toBe('nucreg');
      expect(pending[0].q.has('first_paint')).toBe(false);
      expect(pending[0].q.has('background')).toBe(false);
      // Meanwhile the rows drawn stay.
      expect(snapshot.reads).toBe(drawn);
      expect(snapshot.firstPaint).toBeNull();
      const withLayer = rows.map(r => ({ ...r, layers: { nucreg: [] } }));
      await act(async () => { pending[0].answer(batch({ total: 2, working_count: 2 }, withLayer)); });
      expect(snapshot.reads.map(r => r.id)).toEqual(['r1', 'r2']);
      expect(snapshot.loading).toBe(false);
      // Another locus is a new view: a first paint again.
      pending.length = 0;
      await act(async () => {
        useBrowserStore.setState({ start: 5000, end: 6000 } as any);
        root.render(<Probe p={params({ needsLayers: true, requestedLayers: ['nucreg'], batchRequestedLayers: ['nucreg'], start: 5000, end: 6000 })} />);
      });
      expect(pending.some(p => p.q.get('start') === '5000' && p.q.get('first_paint') === 'true')).toBe(true);
    } finally {
      await act(async () => { root.unmount(); });
      root = createRoot(container);
      useBrowserStore.setState({ datasets: before.datasets, chrom: before.chrom, start: before.start, end: before.end } as any);
    }
  });

  it('sends visible bounds and refetches insertion alleles on expansion and collapse', async () => {
    const { useBrowserStore } = await import('../../../stores/browserStore');
    const before = useBrowserStore.getState();
    getCompactReads.mockImplementation(() => new Promise(() => {}));
    try {
      await act(async () => {
        useBrowserStore.setState({ datasets: [{ id: 'ds', data_type: 'bam_livelift', live_lift: { key: 'k' } } as any],
          panels: [{ id: 'pat', datasetId: 'ds', liftHap: 'PAT' } as any], liveLiftExpansions: {} });
        root.render(<Probe p={params({ liftHap: 'PAT' })} />);
      });
      const queries = () => getCompactReads.mock.calls.map(([q]) => new URLSearchParams(q));
      expect(queries()[0].get('viewport_start')).toBe('1000');
      expect(queries()[0].get('viewport_end')).toBe('2000');
      expect(queries()[0].has('insertion_ids')).toBe(false);
      await act(async () => useBrowserStore.getState().expandLiveLift('main', { chrom: 'chr1', pos: 1500, ins_id: 'mat', hap_label: 'MAT', length: 100,
        label: 'shared', datasetId: 'ds', alleles: [{ ins_id: 'mat', hap_label: 'MAT', length: 100 }, { ins_id: 'pat', hap_label: 'PAT', length: 99 }] }));
      expect(queries().at(-1)?.get('insertion_ids')).toBe('mat,pat');
      expect(queries().at(-1)?.get('lift_hap')).toBe('PAT');
      const expandedRequests = queries().length;
      await act(async () => useBrowserStore.getState().collapseLiveLift('main', 'mat'));
      expect(queries()).toHaveLength(expandedRequests + 1);
      expect(queries().at(-1)?.has('insertion_ids')).toBe(false);
      expect(queries().at(-1)?.get('lift_hap')).toBe('PAT');
    } finally {
      await act(async () => useBrowserStore.setState({ datasets: before.datasets, panels: before.panels, liveLiftExpansions: before.liveLiftExpansions }));
    }
  });

  it('shares batch identity across panels and refreshes it when any source changes', async () => {
    const { useBrowserStore } = await import('../../../stores/browserStore');
    const before = useBrowserStore.getState();
    const original = before.datasets;
    const sources = [
      { id: 'a', source_identity: 'a-v1', data_type: 'bigbed' },
      { id: 'b', source_identity: 'b-v1', data_type: 'bam' },
    ] as typeof original;
    getCompactReads.mockImplementation(() => new Promise(() => {}));
    try {
      await act(async () => {
        useBrowserStore.setState({ datasets: sources, chrom: 'chr1', start: 1000, end: 2000, svDisplayEnabled: true });
        root.render(<><Probe p={params({ datasetId: 'a', isBAM: false, svSummaryEnabled: false })} />
          <Probe p={params({ datasetId: 'b', isBAM: true, svSummaryEnabled: true })} /></>);
      });
      const requests = () => getCompactReads.mock.calls.map(([query]) => new URLSearchParams(query));
      expect(requests()).toHaveLength(2);
      expect(requests().every(q => q.get('dataset_ids') === 'a,b')).toBe(true);
      const identity = requests()[0].get('source_identity');
      expect(requests()[1].toString()).toBe(requests()[0].toString());
      expect(requests().every(q => q.get('include_sv_summary') === 'true')).toBe(true);
      expect(JSON.parse(identity!)).toEqual([['a', 'a-v1'], ['b', 'b-v1']]);
      await act(async () => {
        useBrowserStore.setState({ datasets: [sources[0], { ...sources[1], source_identity: 'b-v2' }] });
      });
      expect(requests()).toHaveLength(4);
      expect(requests()[2].get('source_identity')).toBe(requests()[3].get('source_identity'));
      expect(requests()[2].get('source_identity')).not.toBe(identity);
      await act(async () => { useBrowserStore.setState({ svDisplayEnabled: false }); });
      expect(requests()).toHaveLength(6);
      expect(requests().slice(4).every(q => q.get('include_sv_summary') === 'false')).toBe(true);
    } finally {
      await act(async () => { useBrowserStore.setState({ datasets: original, chrom: before.chrom, start: before.start, end: before.end, svDisplayEnabled: before.svDisplayEnabled }); });
    }
  });

  it('regularity computed for a view reloads only rows carrying the regularity or patch layer', async () => {
    const { useBrowserStore } = await import('../../../stores/browserStore');
    const before = useBrowserStore.getState();
    const original = before.datasets;
    const sources = [
      { id: 'a', source_identity: 'a-v1', regularity_identity: 'r1', data_type: 'bam' },
      { id: 'b', source_identity: 'b-v1', regularity_identity: 'r1', data_type: 'bam' },
    ] as typeof original;
    getCompactReads.mockImplementation(() => new Promise(() => {}));
    try {
      await act(async () => {
        useBrowserStore.setState({ datasets: sources, chrom: 'chr1', start: 1000, end: 2000 });
        root.render(<Probe p={params({ datasetId: 'a', requestedLayers: ['nucseg', 'nucsz'], needsLayers: true })} />);
      });
      const requests = () => getCompactReads.mock.calls.map(([query]) => new URLSearchParams(query));
      expect(requests()).toHaveLength(1);
      expect(JSON.parse(requests()[0].get('source_identity')!)).toEqual([['a', 'a-v1'], ['b', 'b-v1']]);
      // Tiles computed (the Regularity view, a cluster view): rows without nucreg or nucpatch are not asked again.
      await act(async () => { useBrowserStore.setState({ datasets: sources.map(d => ({ ...d, regularity_identity: 'r2' })) }); });
      expect(requests()).toHaveLength(1);
      // With the regularity lane, the rows depend on the tiles: they are.
      await act(async () => { root.render(<Probe p={params({ datasetId: 'a', requestedLayers: ['nucreg', 'nucseg'], needsLayers: true })} />); });
      expect(requests()).toHaveLength(2);
      expect(JSON.parse(requests()[1].get('source_identity')!)).toEqual([['a', ['a-v1', 'r2']], ['b', ['b-v1', 'r2']]]);
      await act(async () => { useBrowserStore.setState({ datasets: sources.map(d => ({ ...d, regularity_identity: 'r3' })) }); });
      expect(requests()).toHaveLength(3);
      expect(JSON.parse(requests()[2].get('source_identity')!)).toEqual([['a', ['a-v1', 'r3']], ['b', ['b-v1', 'r3']]]);
    } finally {
      await act(async () => { useBrowserStore.setState({ datasets: original, chrom: before.chrom, start: before.start, end: before.end }); });
    }
  });

  it('settles when a pending fetch is superseded by a view with nothing to fetch', async () => {
    // The first request never answers; the view then becomes empty (no chromosome).
    getCompactReads.mockImplementation(() => new Promise(() => {}));
    await act(async () => { root.render(<Probe p={params({})} />); });
    expect(loading).toBe(true);
    await act(async () => { root.render(<Probe p={params({ chrom: '' })} />); });
    expect(loading).toBe(false);
  });

  it('settles when the superseding request answers', async () => {
    let answer: (value: unknown) => void = () => {};
    getCompactReads
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    await act(async () => { root.render(<Probe p={params({})} />); });
    await act(async () => { root.render(<Probe p={params({ start: 1100 })} />); });
    expect(loading).toBe(true);
    await act(async () => { answer({ count: 0, total: 0, width: 900, reads: [], dataset_id: 'ds' }); });
    expect(loading).toBe(false);
  });

  it('keeps the alignments in scope before the read filters from an unsampled load (signal counts), never from a sampled one', async () => {
    const answers: Array<(value: unknown) => void> = [];
    getCompactReads.mockImplementation(() => new Promise(resolve => { answers.push(resolve); }));
    await act(async () => { root.render(<Probe p={params({})} />); });
    const signal = { total: 4300, kept: 4264, hidden: 36, background: 0, detectable: 0, unclassified: 0, unscored: 0, unknown: 4264, structure_scored: 0 };
    await act(async () => { answers.at(-1)!({ count: 1, total: 24, total_in_scope: 24, working_count: 24, width: 1000,
      reads: [{ id: 'r', intervals: [[0, 100, 100]] }], dataset_id: 'ds', signal_counts: signal }); });
    expect(snapshot.inScopeBeforeFilters).toBe(4264);
    await act(async () => { root.render(<Probe p={params({ start: 1100 })} />); });
    await act(async () => { answers.at(-1)!({ count: 1, total: 4452, working_count: 7, width: 900, dataset_id: 'ds',
      reads: [{ id: 'r', intervals: [[0, 100, 100]] }], signal_counts: signal,
      working_sampling: { level: 1, fraction: 0.5, kept: 2212, total: 4452, kept_spanning: 0, total_spanning: 0, loaded: 7 } }); });
    expect(snapshot.inScopeBeforeFilters).toBeNull();
  });

  it('draws partial rows while analyses and export still see a loading track', async () => {
    let answer!: (value: unknown) => void;
    getCompactReads.mockImplementation(() => new Promise(resolve => { answer = resolve; }));
    await act(async () => { root.render(<Probe p={params({})} />); });
    const progress = getCompactReads.mock.calls.at(-1)![1].onReadProgress;
    const partial = { count: 1, total: 0, width: 1000, reads: [{ id: 'first', intervals: [[0, 100, 100]] }] };
    await act(async () => { progress(partial); });
    expect(snapshot.reads).toHaveLength(1);
    expect(snapshot.loading).toBe(true);
    expect(snapshot.fulfilledReadFetchCount).toBe(0);
    await act(async () => { answer({ ...partial, total: 1, working_count: 1 }); });
    expect(snapshot.loading).toBe(false);
  });

  it('discards partial rows if the stream fails', async () => {
    let fail!: (reason: unknown) => void;
    getCompactReads.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
    await act(async () => { root.render(<Probe p={params({})} />); });
    await act(async () => { getCompactReads.mock.calls.at(-1)![1].onReadProgress({ reads: [{ id: 'first', intervals: [] }] }); });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => { fail(new Error('Incomplete read stream')); });
    expect(snapshot.reads).toHaveLength(0);
    expect(snapshot.fetchFailed).toBe(true);
    error.mockRestore();
  });

  it('asks again under the read-end footprint setting the server confirmed', async () => {
    const { useBrowserStore } = await import('../../../stores/browserStore');
    getCompactReads.mockImplementation(() => new Promise(() => {}));
    await act(async () => { root.render(<Probe p={params({})} />); });
    const first = String((getCompactReads.mock.calls.at(-1) as unknown[])[0]);
    expect(first).toContain('read_end_footprints=hide');
    await act(async () => { useBrowserStore.getState().setAppliedHideShortEndFootprints(false); });
    const second = String((getCompactReads.mock.calls.at(-1) as unknown[])[0]);
    expect(second).toContain('read_end_footprints=show');
    await act(async () => { useBrowserStore.getState().setAppliedHideShortEndFootprints(true); });
  });
});
