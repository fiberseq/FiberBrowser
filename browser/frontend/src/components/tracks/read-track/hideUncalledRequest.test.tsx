/** The read track's request hides uncalled reads at every Min footprints but "All reads, including uncalled" (-1). */
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
import { useBrowserStore } from '../../../stores/browserStore';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type Params = Parameters<typeof useReadTrackData>[0];
const params = (overrides: Partial<Params> = {}): Params => ({
  readStrand: null, chrom: 'chr1', start: 1000, end: 3000, datasetId: 'ds', spanningOnly: false,
  width: 800, height: 300, isBAM: true, stateKey: 'ds',
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

function Probe({ p }: { p: Params }) {
  useReadTrackData(p);
  return null;
}

const counts = { total: 5, kept: 5, hidden: 0, background: 0, detectable: 0, unclassified: 0, unscored: 0, unknown: 5,
  structure_scored: 0, uncalled: 2 };

describe('read track request: uncalled reads and Min footprints', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    getCompactReads.mockReset();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('sends hide_uncalled and shows the hidden count', async () => {
    getCompactReads.mockResolvedValue({ count: 0, total: 0, total_in_scope: 0, total_overlapping: 0, width: 2000,
      reads: [], dataset_id: 'ds', signal_counts: { ...counts, uncalled_hidden: 2 } });
    await act(async () => { root.render(<Probe p={params()} />); });
    const first = getCompactReads.mock.calls.at(-1)![0] as URLSearchParams;
    expect(first.get('hide_uncalled')).toBe('true');
    expect(useBrowserStore.getState().signalCounts.ds?.counts.uncalled_hidden).toBe(2);

    getCompactReads.mockResolvedValue({ count: 0, total: 0, total_in_scope: 0, total_overlapping: 0, width: 2000,
      reads: [], dataset_id: 'ds', signal_counts: { ...counts, uncalled_hidden: 0 } });
    await act(async () => { root.render(<Probe p={params({ minFootprints: -1 })} />); });
    const second = getCompactReads.mock.calls.at(-1)![0] as URLSearchParams;
    expect(second.get('hide_uncalled')).toBe('false');
    expect(second.has('min_footprints')).toBe(false);
  });
});
