import { beforeEach, describe, expect, it, vi } from 'vitest';
import { shouldAdoptServerDatasets, useServerDatasetsStore } from './serverDatasetsStore';
import { useBrowserStore } from './browserStore';

vi.mock('../api/datasets', () => ({ getDatasets: vi.fn(async () => ({ datasets: [{ id: 'late', label: 'Late', paths: ['/x.bam'], data_type: 'bam' }] })) }));

describe('server datasets key', () => {
  beforeEach(() => useServerDatasetsStore.setState({ key: null, steady: 0 }));

  it('counts heartbeats that report the same key', () => {
    const { setKey } = useServerDatasetsStore.getState();
    setKey('a'); setKey('a');
    expect(useServerDatasetsStore.getState()).toMatchObject({ key: 'a', steady: 2 });
    setKey('b');
    expect(useServerDatasetsStore.getState()).toMatchObject({ key: 'b', steady: 1 });
    setKey(undefined);
    expect(useServerDatasetsStore.getState()).toMatchObject({ key: 'b', steady: 1 });
  });

  it('an empty page takes the server datasets only once their key held and nothing is under way', () => {
    expect(shouldAdoptServerDatasets({ pageDatasets: 0, busy: false, steady: 2 })).toBe(true);
    expect(shouldAdoptServerDatasets({ pageDatasets: 0, busy: false, steady: 1 })).toBe(false);
    expect(shouldAdoptServerDatasets({ pageDatasets: 0, busy: true, steady: 3 })).toBe(false);
    expect(shouldAdoptServerDatasets({ pageDatasets: 1, busy: false, steady: 3 })).toBe(false);
  });

  it('adopts into an empty page; the page never lists a dataset twice', async () => {
    const { adoptServerDatasetsIfEmpty } = await import('../utils/adoptServerDatasets');
    const { useLaunchUiStore } = await import('../utils/launchSession');
    useLaunchUiStore.setState({ deciding: false, restoring: false });
    useBrowserStore.setState({ datasets: [] } as never);
    useServerDatasetsStore.setState({ key: 'k', steady: 2 });
    expect(await adoptServerDatasetsIfEmpty()).toBe(true);
    expect(useBrowserStore.getState().datasets.map(d => d.id)).toEqual(['late']);
    useBrowserStore.getState().addDataset({ id: 'late', label: 'Late again', paths: ['/x.bam'], data_type: 'bam' } as never);
    expect(useBrowserStore.getState().datasets.map(d => d.label)).toEqual(['Late again']);
    expect(await adoptServerDatasetsIfEmpty()).toBe(false);   // not empty any more
  });
});
