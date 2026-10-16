import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useBrowserStore } from '../browserStore';
import { clearLoadedReadRegions, lookupExactReadResponse, readRegionGeneration, rememberExactReadResponse } from '../../api/loadedReadRegion';
import type { Dataset } from '../../types';

const dataset: Dataset = { id: 'one', label: 'Input', path: '/tmp/input.bam', color: '#123456', data_type: 'bam' };
const key = '/api/reads/compact?dataset_id=one&start=0&end=100';
const response = { reads: [{ id: 'molecule', intervals: [[0, 100, 100]] }], width: 100, count: 1 };

describe('navigation cache and dataset metadata', () => {
  beforeEach(() => {
    useBrowserStore.setState({ datasets: [dataset, { ...dataset, id: 'two', path: '/tmp/other.bam' }] });
    clearLoadedReadRegions();
  });
  afterEach(() => { useBrowserStore.setState({ datasets: [] }); });

  it('keeps cached reads and pending fills when a response discovers layers or the view changes', () => {
    const generation = readRegionGeneration();
    rememberExactReadResponse(key, response, generation);
    const store = useBrowserStore.getState();
    store.mergeDatasetAvailableLayers('one', ['nuc', 'tf']);
    store.setDatasetLabel('one', 'Renamed');
    useBrowserStore.setState(state => ({ datasets: [...state.datasets].reverse() }));
    store.setViewport('chr1', 100, 200);
    expect(readRegionGeneration()).toBe(generation);
    expect(lookupExactReadResponse(key)).toMatchObject(response);
    // A fill started before layer discovery must still be accepted afterward.
    rememberExactReadResponse(`${key}&neighbor=1`, response, generation);
    expect(lookupExactReadResponse(`${key}&neighbor=1`)).toMatchObject(response);
  });

  it.each([
    { path: '/tmp/replacement.bam' },
    { paths: ['/tmp/replacement.bam'] },
    { source_identity: 'replacement' },
    { companion_layers: { tf: ['/tmp/tf.bed'] } },
    { data_type: 'bigbed' as const },
  ])('discards cached and pending reads after a source change: %j', change => {
    const generation = readRegionGeneration();
    rememberExactReadResponse(key, response, generation);
    useBrowserStore.setState(state => ({ datasets: state.datasets.map(d => d.id === 'one' ? { ...d, ...change } : d) }));
    expect(readRegionGeneration()).toBeGreaterThan(generation);
    expect(lookupExactReadResponse(key)).toBeUndefined();
    rememberExactReadResponse(key, response, generation);
    expect(lookupExactReadResponse(key)).toBeUndefined();
  });
});
