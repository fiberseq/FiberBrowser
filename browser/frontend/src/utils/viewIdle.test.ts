import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../api/sharedFetch', () => ({
  apiIdleToken: vi.fn((): number | undefined => 1),
  readIdleToken: vi.fn((): number | undefined => 1),
}));

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });

it('requires a completed paint and a quiet interval, and wakes on cancellation', async () => {
  const { apiIdleToken } = await import('../api/sharedFetch');
  const { markReadViewDrawn, waitForViewIdle } = await import('./viewIdle');
  vi.useFakeTimers();
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  const controller = new AbortController();
  const ready = vi.fn();
  const waiting = waitForViewIdle(controller.signal).then(ready);
  await vi.advanceTimersByTimeAsync(3000);
  expect(ready).not.toHaveBeenCalled();
  markReadViewDrawn();
  frames.shift()!(0);
  await vi.advanceTimersByTimeAsync(1000);
  expect(ready).not.toHaveBeenCalled();
  frames.shift()!(0);
  vi.mocked(apiIdleToken).mockReturnValue(undefined);
  await vi.advanceTimersByTimeAsync(1500);
  expect(ready).not.toHaveBeenCalled();
  vi.mocked(apiIdleToken).mockReturnValue(2);
  await vi.advanceTimersByTimeAsync(1500);
  await waiting;
  expect(ready).toHaveBeenCalledOnce();
  vi.mocked(apiIdleToken).mockReturnValue(undefined);
  const stopped = waitForViewIdle(controller.signal);
  controller.abort();
  await stopped;
  expect(vi.getTimerCount()).toBe(0);
});

it('lets nearby fills proceed after read paint while unrelated polling stays active', async () => {
  const { apiIdleToken, readIdleToken } = await import('../api/sharedFetch');
  const { markReadViewDrawn, waitForViewIdle } = await import('./viewIdle');
  vi.useFakeTimers();
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  vi.mocked(apiIdleToken).mockReturnValue(undefined);
  vi.mocked(readIdleToken).mockReturnValue(undefined);
  const ready = vi.fn();
  const waiting = waitForViewIdle(new AbortController().signal, true).then(ready);
  markReadViewDrawn();
  while (frames.length) frames.shift()!(0);
  await vi.advanceTimersByTimeAsync(1500);
  expect(ready).not.toHaveBeenCalled();
  vi.mocked(readIdleToken).mockReturnValue(2);
  await vi.advanceTimersByTimeAsync(1500);
  await waiting;
  expect(ready).toHaveBeenCalledOnce();
});
