import { beforeEach, describe, expect, it } from 'vitest';
import { createTestStore } from './helpers';

let store: ReturnType<typeof createTestStore>;

beforeEach(() => {
  localStorage.clear();
  store = createTestStore();
});

describe('dataset metadata updates', () => {
  it('clears full view when removing the maximized dataset panel', () => {
    store.setState({
      datasets: [
        {
          id: 'ds1',
          label: 'Dataset 1',
          path: '/tmp/ds1.bam',
          color: '#111111',
          data_type: 'bam',
        },
        {
          id: 'ds2',
          label: 'Dataset 2',
          path: '/tmp/ds2.bam',
          color: '#222222',
          data_type: 'bam',
        },
      ],
      panels: [
        {
          id: 'panel-1',
          contentType: 'dataset',
          datasetId: 'ds1',
          subTracks: [],
          collapsed: false,
          linkGroup: null,
          layoutRow: 0,
        },
        {
          id: 'panel-2',
          contentType: 'dataset',
          datasetId: 'ds2',
          subTracks: [],
          collapsed: false,
          linkGroup: null,
          layoutRow: 0,
        },
      ],
      fullViewPanelId: 'panel-1',
      selectedDatasets: new Set(['panel-1']),
      slotOrder: ['ds1', 'ds2'],
    });

    store.getState().removeDataset('ds1');

    expect(store.getState().fullViewPanelId).toBeNull();
    expect(store.getState().panels.map(panel => panel.id)).toEqual(['panel-2']);
    expect(store.getState().selectedDatasets.size).toBe(0);
  });

  it('updates a dataset display label without clearing it on blank input', () => {
    store.setState({
      datasets: [{
        id: 'ds1',
        label: 'Dataset 1',
        path: '/tmp/ds1.bam',
        color: '#111111',
        data_type: 'bam',
      }],
    });

    store.getState().setDatasetLabel('ds1', 'Renamed replicate');
    expect(store.getState().datasets[0].label).toBe('Renamed replicate');

    store.getState().setDatasetLabel('ds1', '   ');
    expect(store.getState().datasets[0].label).toBe('Renamed replicate');
  });

  it('merges detected layers without rebuilding panel layout', () => {
    store.setState({
      datasets: [{
        id: 'ds1',
        label: 'Dataset 1',
        path: '/tmp/ds1.bam',
        color: '#111111',
        data_type: 'bam',
        available_layers: { nuc: true },
      }],
      panels: [{
        id: 'panel-1',
        contentType: 'dataset',
        datasetId: 'ds1',
        subTracks: [],
        collapsed: false,
        linkGroup: null,
        layoutRow: 0,
      }],
      slotOrder: ['ds1', 'panel-extra'],
    });
    const panelsBefore = store.getState().panels;
    const slotOrderBefore = store.getState().slotOrder;

    store.getState().mergeDatasetAvailableLayers('ds1', ['tf', 'fire', 'tf']);

    expect(store.getState().datasets[0].available_layers).toEqual({
      nuc: true,
      tf: true,
      fire: true,
    });
    expect(store.getState().panels).toBe(panelsBefore);
    expect(store.getState().slotOrder).toBe(slotOrderBefore);
  });

  it('skips writes when all detected layers are already stamped', () => {
    store.setState({
      datasets: [{
        id: 'ds1',
        label: 'Dataset 1',
        path: '/tmp/ds1.bam',
        color: '#111111',
        data_type: 'bam',
        available_layers: { nuc: true, tf: true },
      }],
    });
    const datasetsBefore = store.getState().datasets;

    store.getState().mergeDatasetAvailableLayers('ds1', ['nuc', 'tf']);

    expect(store.getState().datasets).toBe(datasetsBefore);
  });
});

describe('orthogonal track viewport data', () => {
  it('keeps track metadata stable when only viewport values change', () => {
    store.getState().setOrthogonalTracks([
      { index: 1, label: 'signal', renderMode: 'signal', values: [1, 2, 3], path: '/a.bw', format: 'bigWig' },
    ]);
    const firstTrack = store.getState().orthogonalTracks[0];
    expect(firstTrack.values).toEqual([]);
    expect(store.getState().orthogonalTrackData[1].values).toEqual([1, 2, 3]);

    store.getState().setOrthogonalTracks([
      { index: 1, label: 'signal', renderMode: 'signal', values: [3, 2, 1], path: '/a.bw', format: 'bigWig' },
    ]);

    expect(store.getState().orthogonalTracks[0]).toBe(firstTrack);
    expect(store.getState().orthogonalTrackData[1].values).toEqual([3, 2, 1]);
  });

  it('prunes stale viewport data when a track is removed', () => {
    store.getState().setOrthogonalTracks([
      { index: 1, label: 'signal', renderMode: 'signal', values: [1], path: '/a.bw', format: 'bigWig' },
      { index: 2, label: 'motif', renderMode: 'annotation', values: [], intervals: [{ start: 1, end: 2 }], path: '/b.bb', format: 'bigBed' },
    ]);

    store.getState().setOrthogonalTracks([
      { index: 2, label: 'motif', renderMode: 'annotation', values: [], intervals: [], path: '/b.bb', format: 'bigBed' },
    ]);

    expect(store.getState().orthogonalTrackData[1]).toBeUndefined();
    expect(store.getState().orthogonalTrackData[2].intervals).toEqual([]);
  });

  it('does not allocate viewport data entries for inactive empty signal tracks', () => {
    store.getState().setOrthogonalTracks(Array.from({ length: 50 }, (_, index) => ({
      index,
      label: `Track ${index}`,
      renderMode: 'signal' as const,
      values: index === 3 ? [1, 2, 3] : [],
      path: `/tracks/${index}.bw`,
      format: 'bigWig',
    })));

    expect(Object.keys(store.getState().orthogonalTrackData)).toEqual(['3']);
    expect(store.getState().orthogonalTracks).toHaveLength(50);
  });
});
