import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ getScanJob: vi.fn(), cancelScanJob: vi.fn() }));
const data = vi.hoisted(() => ({ adoptScans: vi.fn(async () => {}), refreshDatasetLayers: vi.fn(async () => {}), hubGeneration: vi.fn(() => 3) }));
vi.mock('./api', () => api);
vi.mock('./hubData', () => data);

import { useHubJob } from './hubJob';
import type { ScanJob } from './api';

const job = (status: string, scans: string[] = []) => ({ job_id: `j-${status}-${scans.join('')}`, status, scans }) as unknown as ScanJob;

describe('hub scan job completion (3.1.0 audit)', () => {
  beforeEach(() => { vi.useFakeTimers(); data.adoptScans.mockClear(); api.getScanJob.mockReset(); api.cancelScanJob.mockReset(); });
  afterEach(() => { useHubJob.getState().clear(); vi.useRealTimers(); });

  it('adopts the scans when the submission already answers complete', async () => {
    useHubJob.getState().track(job('complete', ['s1']));
    await vi.advanceTimersByTimeAsync(2000);
    expect(data.adoptScans).toHaveBeenCalledTimes(1);
    expect(data.adoptScans).toHaveBeenCalledWith(['s1'], 3);
    expect(api.getScanJob).not.toHaveBeenCalled();
  });

  it('adopts the scans when Cancel races completion and answers complete, once', async () => {
    const running = { ...job('running', ['s2']), job_id: 'race' } as ScanJob;
    const done = { ...job('complete', ['s2']), job_id: 'race' } as ScanJob;
    api.cancelScanJob.mockResolvedValue(done);
    api.getScanJob.mockResolvedValue(done);
    useHubJob.getState().track(running);
    await useHubJob.getState().cancel();
    expect(data.adoptScans).toHaveBeenCalledTimes(1);
    expect(data.adoptScans).toHaveBeenCalledWith(['s2'], 3);
    await vi.advanceTimersByTimeAsync(2000);
    expect(data.adoptScans).toHaveBeenCalledTimes(1);
  });

  it('still adopts once when polling sees the end', async () => {
    const running = { ...job('running', ['s3']), job_id: 'poll' } as ScanJob;
    api.getScanJob.mockResolvedValue({ ...job('complete', ['s3']), job_id: 'poll' });
    useHubJob.getState().track(running);
    await vi.advanceTimersByTimeAsync(2000);
    expect(data.adoptScans).toHaveBeenCalledTimes(1);
    expect(data.adoptScans).toHaveBeenCalledWith(['s3'], 3);
  });
});
