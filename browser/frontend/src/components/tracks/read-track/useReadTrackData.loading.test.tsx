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
