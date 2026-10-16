/**
 * H4 (UI audit): short-read DAF data (DddB amplicon data, ~650 bp) looked
 * empty: the default "Min footprints: 5" hid all 4,873 reads, nothing said a
 * filter was responsible, and "Go to reads" looped back to the same empty view.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getCompactReads = vi.fn();
vi.mock('../../../api/readOperations', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../api/readOperations')>()),
  getCompactReads: (...args: unknown[]) => getCompactReads(...args),
  getCompactReadsAll: (...args: unknown[]) => getCompactReads(...args),
}));
const getTopCoveredWindows = vi.fn();
vi.mock('../../../api/coverage', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../api/coverage')>()),
  getTopCoveredWindows: (...args: unknown[]) => getTopCoveredWindows(...args),
}));

import { useReadTrackData } from './useReadTrackData';
import { useBrowserStore } from '../../../stores/browserStore';
import { DEFAULT_MIN_FOOTPRINTS } from '../../../stores/uiSlice';
import { findDatasetReadsLocus, PROBE_TIMEOUT_MS } from '../../../utils/datasetReadsLocus';
import { isTopLocusStep, resetTopLoci } from '../../../utils/topLoci';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type Params = Parameters<typeof useReadTrackData>[0];
const params = (overrides: Partial<Params> = {}): Params => ({
  readStrand: null, chrom: 'chr2L', start: 6346981, end: 6366981, datasetId: 'flyamp', spanningOnly: false,
  width: 800, height: 300, isBAM: true,
  needsMethylation: false, needsLayers: false, requestedLayers: [], needsLayerQualities: false,
  useServerMetaprofile: false, serverMetaprofileLayers: [],
  needsCigar: false, fillSmallGaps: false, fillGapSize: 0, hideTerminalGaps: true, terminalGapThreshold: 500,
  minFpQuality: 0, minFootprints: 5, showDuplicateReads: false, downsampleCount: null,
  readDisplayMode: 'fit', allReadsDisplayCap: 5000, backgroundReadCap: null, readRowHeight: 3,
  readSeparatorMode: 'off', readSeparatorMinHeight: 3, readSeparatorWidth: 1,
  exportMatchedReadCount: null, exportMatchedReadFetchCount: null,
  legacyLayerInference: true, legacyNucMinSize: 90,
  hasPushedReads: false, jupyterPushedReads: null,
  hasClusterFocus: false, myClusterFocus: null, hasFilter: false, myFilteredReadIds: null,
  myClusterAssignments: {}, myClusterOrder: [], myReadSortOrder: [], hasCluster: false,
  myJupyterOrder: [], hasJupyterFilter: false, jupyterFilterSet: null,
  ...overrides,
} as Params);

let hidden: number | null = null;
function Probe({ p }: { p: Params }) {
  hidden = useReadTrackData(p).hiddenByMinFootprints;
  return null;
}

const empty = (extra: object = {}) => ({ count: 0, total: 0, total_in_scope: 0, total_overlapping: 0, width: 20000, reads: [], dataset_id: 'flyamp', ...extra });

describe('reads hidden by Min footprints', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    getCompactReads.mockReset();
    getTopCoveredWindows.mockReset();
    resetTopLoci();
    hidden = null;
    useBrowserStore.setState({ minFootprints: DEFAULT_MIN_FOOTPRINTS, minFootprintsAuto: true, minFootprintsNotice: null } as any);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('the read track learns how many reads the filter hid', async () => {
    getCompactReads.mockResolvedValue(empty({ hidden_by_min_footprints: 4873 }));
    await act(async () => { root.render(<Probe p={params()} />); });
    expect(hidden).toBe(4873);
    getCompactReads.mockResolvedValue(empty());
    await act(async () => { root.render(<Probe p={params({ start: 6346000 })} />); });
    expect(hidden).toBe(0);
  });

  it('the untouched default turns itself off once, with a notice; a user-set value never does', () => {
    const notice = { datasetId: 'flyamp', label: 'FlyAmp', hidden: 4873 };
    expect(useBrowserStore.getState().relaxDefaultMinFootprints(notice)).toBe(true);
    let s = useBrowserStore.getState();
    expect([s.minFootprints, s.minFootprintsAuto, s.minFootprintsNotice]).toEqual([0, false, notice]);
    // "Turn it back on" is the user's choice: it stays.
    s.setMinFootprints(DEFAULT_MIN_FOOTPRINTS);
    expect(useBrowserStore.getState().relaxDefaultMinFootprints(notice)).toBe(false);
    s = useBrowserStore.getState();
    expect([s.minFootprints, s.minFootprintsNotice]).toEqual([DEFAULT_MIN_FOOTPRINTS, null]);
    // A value the user chose (even the default's) is never relaxed.
    useBrowserStore.setState({ minFootprintsAuto: true } as any);
    useBrowserStore.getState().setMinFootprints(8);
    expect(useBrowserStore.getState().relaxDefaultMinFootprints(notice)).toBe(false);
    expect(useBrowserStore.getState().minFootprints).toBe(8);
  });

  it('"Go to reads" skips loci whose reads a filter the user set hides', async () => {
    useBrowserStore.setState({ minFootprints: 5, minFootprintsAuto: false } as any);
    getTopCoveredWindows.mockResolvedValue({ success: true, windows: [
      { chrom: 'chr2L', start: 6356793, end: 6357648, depth: 4965 },
      { chrom: 'chr3R', start: 100, end: 900, depth: 40 },
    ] });
    // The amplicon's reads all have < 5 footprints; the second locus keeps some.
    getCompactReads.mockImplementation(async (p: URLSearchParams) => (p.get('chrom') === 'chr2L'
      ? empty({ hidden_by_min_footprints: 4873 }) : { ...empty(), total_overlapping: 12 }));
    const result = await findDatasetReadsLocus('flyamp', 20000);
    expect(isTopLocusStep(result) && result.window.chrom).toBe('chr3R');
    expect(getTopCoveredWindows).toHaveBeenCalledWith(20000, 'flyamp', 20, expect.objectContaining({ fit: true }));
    const probe = getCompactReads.mock.calls[0][0] as URLSearchParams;
    expect([probe.get('min_footprints'), probe.get('max_reads')]).toEqual(['5', '1']);
  });

  it('with every locus hidden it settles on the best one (the track then says why), never loops', async () => {
    useBrowserStore.setState({ minFootprints: 5, minFootprintsAuto: false } as any);
    getTopCoveredWindows.mockResolvedValue({ success: true, windows: [
      { chrom: 'chr2L', start: 6356793, end: 6357648, depth: 4965 },
      { chrom: 'chr2L', start: 9463702, end: 9467352, depth: 2833 },
    ] });
    getCompactReads.mockResolvedValue(empty({ hidden_by_min_footprints: 100 }));
    const result = await findDatasetReadsLocus('flyamp', 20000);
    expect(isTopLocusStep(result) && [result.window.chrom, result.window.start]).toEqual(['chr2L', 6356793]);
    expect(getCompactReads).toHaveBeenCalledTimes(2);
  });

  it('the untouched default goes to the best locus (where it turns itself off if it hides every read)', async () => {
    useBrowserStore.setState({ minFootprints: DEFAULT_MIN_FOOTPRINTS, minFootprintsAuto: true } as any);
    getTopCoveredWindows.mockResolvedValue({ success: true, windows: [{ chrom: 'chr2L', start: 6356793, end: 6357648, depth: 4965 }] });
    const result = await findDatasetReadsLocus('flyamp', 20000);
    expect(isTopLocusStep(result) && result.window.start).toBe(6356793);
    expect(getCompactReads).not.toHaveBeenCalled();
  });

  it('a probe that never answers counts as unknown after its time limit (the search ends)', async () => {
    vi.useFakeTimers();
    try {
      useBrowserStore.setState({ minFootprints: 5, minFootprintsAuto: false } as any);
      getTopCoveredWindows.mockResolvedValue({ success: true, windows: [{ chrom: 'chr2L', start: 1, end: 900, depth: 9 }] });
      getCompactReads.mockImplementation((_p: URLSearchParams, init?: RequestInit) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }));
      const pending = findDatasetReadsLocus('flyamp', 20000);
      await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS + 10);
      const result = await pending;
      expect(isTopLocusStep(result) && result.window.start).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('without a read filter there is nothing to probe', async () => {
    useBrowserStore.setState({ minFootprints: 0 } as any);
    getTopCoveredWindows.mockResolvedValue({ success: true, windows: [{ chrom: 'chr2L', start: 1, end: 2, depth: 3 }] });
    await findDatasetReadsLocus('flyamp', 20000);
    expect(getCompactReads).not.toHaveBeenCalled();
  });
});
