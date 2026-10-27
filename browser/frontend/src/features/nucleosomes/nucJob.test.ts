import { beforeEach, describe, expect, it, vi } from 'vitest';

const submitNucJob = vi.fn();
const getNucJob = vi.fn();
vi.mock('./api', () => ({ submitNucJob: (...a: unknown[]) => submitNucJob(...a), getNucJob: (...a: unknown[]) => getNucJob(...a),
  cancelNucJob: vi.fn() }));
const getDatasets = vi.fn();
vi.mock('../../api/datasets', () => ({ getDatasets: () => getDatasets() }));

import { useBrowserStore } from '../../stores/browserStore';
import { useNucJob } from './nucJob';

const done = (id: string) => ({ job_id: id, status: 'complete', created_at: 1, datasets: [], view: { chrom: 'c', start: 0, end: 1 },
  results: { ds1: { calibration: {}, records: 3, computed: 3, cached: 0, undecodable: {}, datasets: ['ds1'] } } });

describe('nucleosome job store', () => {
  beforeEach(() => {
    submitNucJob.mockReset(); getNucJob.mockReset(); getDatasets.mockReset();
    useBrowserStore.setState({ datasets: [{ id: 'ds1', label: 'DS1', source_identity: 'old', available_layers: {} }] as never });
    getDatasets.mockResolvedValue({ datasets: [{ id: 'ds1', source_identity: 'new', available_layers: { nucsz: true, nucseg: true }, derived_layers: {} }] });
  });

  it('a job already complete in the submit response refreshes the datasets once and moves the revision', async () => {
    submitNucJob.mockResolvedValue(done('j1'));
    const before = useNucJob.getState().revision;
    await useNucJob.getState().submit({ datasets: ['ds1'], chrom: 'c', start: 0, end: 1 }, 'p1');
    expect(getNucJob).not.toHaveBeenCalled();
    expect(useBrowserStore.getState().datasets[0].source_identity).toBe('new');
    expect(useNucJob.getState().revision).toBe(before + 1);
    expect((useBrowserStore.getState().enabledModTypes as Record<string, boolean>).nucsz).toBe(true);
  });
});
