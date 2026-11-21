import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getCompactReads = vi.fn();
const getCompactReadsAll = vi.fn();
vi.mock('../../../api/readOperations', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../api/readOperations')>()),
  getCompactReads: (...args: unknown[]) => getCompactReads(...args),
  getCompactReadsAll: (...args: unknown[]) => getCompactReadsAll(...args),
}));

import { useReadTrackData } from './useReadTrackData';
import { PanelActiveContext } from '../../../hooks/usePanelDisplayStore';
import { useBrowserStore } from '../../../stores/browserStore';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type Params = Parameters<typeof useReadTrackData>[0];
const params = (overrides: Partial<Params>): Params => ({
  readStrand: null, chrom: 'chr1', start: 1000, end: 2000, datasetId: 'a', spanningOnly: false,
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
} as Params);

const answer = (q: URLSearchParams) => Promise.resolve({ count: 1, total: 1, width: 1000,
  reads: [{ id: `r${q.get('start')}`, intervals: [[0, 100, 100]] }] });

function Probe({ p }: { p: Params }) { useReadTrackData(p); return null; }

describe('a read panel hidden by full view', () => {
  let container: HTMLDivElement, root: Root;
  beforeEach(() => {
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    getCompactReads.mockReset().mockImplementation(answer);
    getCompactReadsAll.mockReset().mockImplementation(answer);
    useBrowserStore.setState({ datasets: [{ id: 'a', data_type: 'bam' }] as never, chrom: 'chr9', start: 0, end: 1,
      fullViewPanelId: null, exportInProgress: false, panels: [] as never });
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  const show = async (active: boolean, start: number) => {
    await act(async () => { root.render(<PanelActiveContext.Provider value={active}><Probe p={params({ start, end: start + 1000 })} /></PanelActiveContext.Provider>); });
  };

  it('starts no read request while hidden, and loads the latest view once when shown again', async () => {
    await show(true, 1000);
    expect(getCompactReads).toHaveBeenCalledTimes(1);
    await show(false, 1000);       // hidden: nothing
    await show(false, 1500);       // a pan while hidden: nothing
    await show(false, 2000);
    expect(getCompactReads).toHaveBeenCalledTimes(1);
    await show(true, 2000);        // shown again: the latest view, once
    expect(getCompactReads).toHaveBeenCalledTimes(2);
    expect(getCompactReads.mock.calls[1][0].get('start')).toBe('2000');
  });

  it('hidden and shown again with nothing changed meanwhile: no request', async () => {
    await show(true, 1000);
    await show(false, 1000);
    await show(true, 1000);
    expect(getCompactReads).toHaveBeenCalledTimes(1);
  });

  it('the maximised panel loads only its own dataset for a new view (no combined request for hidden panels)', async () => {
    useBrowserStore.setState({ datasets: [{ id: 'a', data_type: 'bam' }, { id: 'b', data_type: 'bam' }] as never,
      chrom: 'chr1', start: 1000, end: 2000, panels: [{ id: 'pa' }, { id: 'pb' }] as never });
    const p = (start: number) => params({ start, end: start + 1000 });
    const at = async (start: number) => {
      useBrowserStore.setState({ start, end: start + 1000 });
      await act(async () => { root.render(<Probe p={p(start)} />); });
    };
    await at(1000);
    const combinedBefore = getCompactReadsAll.mock.calls.length;
    expect(combinedBefore).toBe(1);   // at the main view, out of full view: one combined request
    // full view of panel pa: a pan loads dataset a alone
    useBrowserStore.setState({ fullViewPanelId: 'pa' });
    await at(1300);
    expect(getCompactReadsAll.mock.calls.length).toBe(combinedBefore);
    const last = getCompactReads.mock.calls.at(-1)![0] as URLSearchParams;
    expect(last.get('dataset_id')).toBe('a');
    expect(last.get('start')).toBe('1300');
  });
});
