import '../testSetup';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { useAccessibilityStore } from './accessibilityStore';
import { runRegionBatch, cancelRegionBatch } from './regionBatch';
import * as api from './api';
import { COMPLETE_JOB } from './accessibility/fixture';
vi.mock('./api', async original => ({ ...await original<object>(), startAccessibility: vi.fn(), getAccessibilityJob: vi.fn(), cancelAccessibility: vi.fn() }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const request = { dataset_ids: ['d'], chrom: 'chr1', start: 100, end: 200, parameters: {} };
const pending = (id: string) => ({ ...COMPLETE_JOB, job_id: id, status: 'running' as const, result: undefined });
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); useAccessibilityStore.getState().reset(); });
afterEach(() => vi.useRealTimers());
function Controls() {
  const s = useAccessibilityStore();
  return <><span>{s.regionJobs.length}/{s.batchTotal}:{s.job?.job_id}</span><button onClick={cancelRegionBatch}>Cancel</button></>;
}
it('keeps the queue and completed comparisons connected to controls across remounts', async () => {
  vi.mocked(api.startAccessibility).mockResolvedValueOnce({ ...COMPLETE_JOB, job_id: 'first' }).mockResolvedValueOnce(pending('second'));
  vi.mocked(api.getAccessibilityJob).mockResolvedValue({ ...COMPLETE_JOB, job_id: 'second' });
  const node = document.createElement('div'); let root = createRoot(node);
  let batch!: Promise<void>;
  await act(async () => { root.render(<Controls />); batch = runRegionBatch([request, request]); });
  expect(node.textContent).toContain('1/2:second');
  act(() => root.unmount()); root = createRoot(node);
  act(() => root.render(<Controls />));
  expect(node.textContent).toContain('1/2:second');
  await act(async () => { await vi.advanceTimersByTimeAsync(800); await batch; });
  expect(node.textContent).toContain('2/2:second');
  act(() => root.unmount()); root = createRoot(node);
  act(() => root.render(<Controls />));
  expect(node.textContent).toContain('2/2:second');
  act(() => root.unmount());
});
it('cancels from remounted controls without submitting queued windows', async () => {
  vi.mocked(api.startAccessibility).mockResolvedValue(pending('first'));
  vi.mocked(api.cancelAccessibility).mockResolvedValue({ ...pending('first'), status: 'cancelled' });
  vi.mocked(api.getAccessibilityJob).mockResolvedValue({ ...pending('first'), status: 'cancelled' });
  const node = document.createElement('div'); let root = createRoot(node); let batch!: Promise<void>;
  await act(async () => { root.render(<Controls />); batch = runRegionBatch([request, request]); });
  act(() => root.unmount()); root = createRoot(node); act(() => root.render(<Controls />));
  await act(async () => node.querySelector('button')!.click());
  await act(async () => { await vi.advanceTimersByTimeAsync(800); await batch; });
  expect(api.startAccessibility).toHaveBeenCalledTimes(1);
  expect(useAccessibilityStore.getState().batchRunning).toBe(false);
  act(() => root.unmount());
});
it('honours cancellation while the submission has not returned its job id', async () => {
  let resolve!: (job: api.AccessibilityJob) => void;
  vi.mocked(api.startAccessibility).mockReturnValue(new Promise(r => { resolve = r; }));
  vi.mocked(api.cancelAccessibility).mockResolvedValue({ ...pending('first'), status: 'cancelled' });
  const batch = runRegionBatch([request, request]);
  await cancelRegionBatch(); resolve(pending('first')); await batch;
  expect(api.cancelAccessibility).toHaveBeenCalledWith('first');
  expect(api.startAccessibility).toHaveBeenCalledTimes(1);
});

it.each([null, 'alt'])('stops queued matched windows when their reference changes from %s', async genome => {
  const { usePanelGenomeStore } = await import('../../stores/panelGenomeStore');
  usePanelGenomeStore.setState({ assignments: genome ? { d: genome } : {}, attaching: [] });
  vi.mocked(api.startAccessibility).mockResolvedValue(pending('first'));
  vi.mocked(api.getAccessibilityJob).mockResolvedValue({ ...COMPLETE_JOB, job_id: 'first' });
  const batch = runRegionBatch([{ ...request, genome }, { ...request, genome }]);
  await Promise.resolve();
  usePanelGenomeStore.setState({ assignments: { d: 'other' } });
  await vi.advanceTimersByTimeAsync(800);
  await batch;
  expect(api.startAccessibility).toHaveBeenCalledTimes(1);
  expect(api.startAccessibility).toHaveBeenCalledWith(request);
  expect(useAccessibilityStore.getState().batchError).toContain('reference changed');
  expect(useAccessibilityStore.getState().batchRunning).toBe(false);
});
