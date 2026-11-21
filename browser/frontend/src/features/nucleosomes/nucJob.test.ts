import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const submitNucJob = vi.fn();
const getNucJob = vi.fn();
const listNucJobs = vi.fn();
vi.mock('./api', () => ({ submitNucJob: (...a: unknown[]) => submitNucJob(...a), getNucJob: (...a: unknown[]) => getNucJob(...a),
  listNucJobs: () => listNucJobs(), cancelNucJob: vi.fn() }));
const getDatasets = vi.fn();
vi.mock('../../api/datasets', () => ({ getDatasets: () => getDatasets() }));

import { useBrowserStore } from '../../stores/browserStore';
import { useNucJob } from './nucJob';
import type { NucJob } from './types';

const done = (id: string) => ({ job_id: id, status: 'complete', created_at: 1, datasets: [], view: { chrom: 'c', start: 0, end: 1 },
  results: { ds1: { calibration: {}, records: 3, computed: 3, cached: 0, undecodable: {}, datasets: ['ds1'] } } });

describe('nucleosome job store', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useNucJob.getState().clear();
    submitNucJob.mockReset(); getNucJob.mockReset(); getDatasets.mockReset(); listNucJobs.mockReset();
    useBrowserStore.setState({ datasets: [{ id: 'ds1', label: 'DS1', source_identity: 'old', available_layers: {} }] as never });
    getDatasets.mockResolvedValue({ datasets: [{ id: 'ds1', source_identity: 'new', available_layers: { nucsz: true, nucseg: true }, derived_layers: {} }] });
  });
  afterEach(() => { useNucJob.getState().clear(); vi.useRealTimers(); });

  it('a job already complete in the submit response refreshes the datasets once and moves the revision', async () => {
    submitNucJob.mockResolvedValue(done('j1'));
    const before = useNucJob.getState().revision;
    await useNucJob.getState().submit({ datasets: ['ds1'], chrom: 'c', start: 0, end: 1 }, 'p1');
    expect(getNucJob).not.toHaveBeenCalled();
    expect(useBrowserStore.getState().datasets[0].source_identity).toBe('new');
    expect(useNucJob.getState().revision).toBe(before + 1);
    expect((useBrowserStore.getState().enabledModTypes as Record<string, boolean>).nucsz).toBe(true);
  });

  it('a second submit while a job runs is refused (one Analyse at a time), and a replaced job stops quietly', async () => {
    const running = { ...done('reused'), status: 'running', results: {} } as NucJob;
    submitNucJob.mockResolvedValue(running);
    const request = { datasets: ['ds1'], chrom: 'c', start: 0, end: 1 };
    await useNucJob.getState().submit(request, 'p1');
    await useNucJob.getState().submit(request, 'p2');
    expect(submitNucJob).toHaveBeenCalledTimes(1);
    getNucJob.mockResolvedValue({ ...running, status: 'cancelled', message: 'Replaced by a newer run' });
    await vi.advanceTimersByTimeAsync(300);
    expect(getNucJob).toHaveBeenCalledExactlyOnceWith('reused');
    expect(useNucJob.getState()).toMatchObject({ panelId: 'p1', error: '', job: { job_id: 'reused', status: 'cancelled' } });
    await vi.advanceTimersByTimeAsync(3000);
    expect(getNucJob).toHaveBeenCalledTimes(1);
  });

  it('follows the newest live job from the mount list, regardless of response order', async () => {
    listNucJobs.mockResolvedValue({ jobs: [
      { ...done('newest'), status: 'queued', created_at: 3 },
      { ...done('finished'), status: 'complete', created_at: 4 },
      { ...done('old'), status: 'cancelling', created_at: 1 },
    ] });
    await useNucJob.getState().followLatest('p1');
    expect(useNucJob.getState().job?.job_id).toBe('newest');
    getNucJob.mockResolvedValue(done('newest'));
    await vi.advanceTimersByTimeAsync(300);
    expect(getNucJob).toHaveBeenCalledExactlyOnceWith('newest');
    expect(submitNucJob).not.toHaveBeenCalled();
  });

  it('a submission awaiting its response holds the store busy: a concurrent submit sends nothing', async () => {
    let resolveFirst!: (value: NucJob) => void;
    submitNucJob.mockReturnValueOnce(new Promise(resolve => { resolveFirst = resolve; }));
    const { isNucBusy, analyseUnlessBusy } = await import('./nucJob');
    const first = useNucJob.getState().submit({ datasets: ['ds1'], sites: { observations: [] } } as never, 'panel');
    expect(isNucBusy()).toBe(true);
    // a cluster view's missing-calls start, and the panel's own button, both before the first POST is answered
    expect(await analyseUnlessBusy({ datasets: ['ds1'] }, 'cluster-views')).toBe('waiting');
    await useNucJob.getState().submit({ datasets: ['ds1'] }, 'other');
    expect(submitNucJob).toHaveBeenCalledTimes(1);
    resolveFirst({ ...done('first'), status: 'running', results: {} } as NucJob);
    await first;
    expect(useNucJob.getState()).toMatchObject({ panelId: 'panel', submitting: false, job: { job_id: 'first' } });
    expect(isNucBusy()).toBe(true);   // now the live job holds it
  });

  it('a failed submission releases the reservation', async () => {
    submitNucJob.mockRejectedValueOnce(new Error('boom'));
    const { isNucBusy } = await import('./nucJob');
    await useNucJob.getState().submit({ datasets: ['ds1'] }, 'panel');
    expect(isNucBusy()).toBe(false);
    expect(useNucJob.getState().error).toContain('boom');
  });

  it('ignores a stale mount list after a submit', async () => {
    let resolveList!: (value: { jobs: NucJob[] }) => void;
    listNucJobs.mockReturnValue(new Promise(resolve => { resolveList = resolve; }));
    const mount = useNucJob.getState().followLatest('mounted');
    submitNucJob.mockResolvedValue({ ...done('latest'), status: 'queued', results: {}, created_at: 200 });
    await useNucJob.getState().submit({ datasets: ['ds1'] }, 'latest');
    resolveList({ jobs: [{ ...done('from-list'), status: 'running', created_at: 100 } as NucJob] });
    await mount;
    expect(useNucJob.getState()).toMatchObject({ panelId: 'latest', job: { job_id: 'latest' } });
  });
});
