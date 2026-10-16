import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { matchedReadCount, waitForReadTracks } from './readExport';

describe('matched read export', () => {
  it('matches visible samples to the smallest read count', () => {
    expect(matchedReadCount([1_700, 1_000], 2_000)).toBe(1_000);
  });

  it('respects the configured display safety cap', () => {
    expect(matchedReadCount([7_000, 8_000], 2_000)).toBe(2_000);
  });

  it('returns null when no visible read tracks are available', () => {
    expect(matchedReadCount([], 2_000)).toBeNull();
  });
});

describe('read export readiness', () => {
  let root: HTMLDivElement;
  const track = (loading = false, ready = true, count = 12) => {
    root.innerHTML = `<div data-read-track-dataset-id="reads" data-read-track-loading="${loading}"
      data-read-track-render-count="${count}" data-read-track-fetch-count="100">
      <canvas data-copilot-track="reads" data-read-track-ready="${ready}"></canvas></div>`;
    return root.firstElementChild as HTMLElement;
  };
  beforeEach(() => {
    vi.useFakeTimers();
    root = document.createElement('div');
    document.body.appendChild(root);
  });
  afterEach(() => {
    root.remove();
    vi.useRealTimers();
  });

  it('waits through partial streamed rows and the final canvas draw', async () => {
    const el = track(true, false);
    let done = false;
    const pending = waitForReadTracks(undefined, undefined, { root }).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(100);
    expect(done).toBe(false);
    el.dataset.readTrackLoading = 'false';
    await vi.advanceTimersByTimeAsync(100);
    expect(done).toBe(false);
    el.querySelector('canvas')!.dataset.readTrackReady = 'true';
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    expect(done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for replacement tracks when export removes a scrolling or split layout', async () => {
    const original = track();
    let done = false;
    const pending = waitForReadTracks(undefined, undefined, { root }).then(tracks => { done = true; return tracks; });
    await vi.advanceTimersByTimeAsync(32);
    expect(done).toBe(false);
    const replacement = track(true, false);
    await vi.advanceTimersByTimeAsync(100);
    expect(done).toBe(false);
    replacement.dataset.readTrackLoading = 'false';
    replacement.querySelector('canvas')!.dataset.readTrackReady = 'true';
    await vi.advanceTimersByTimeAsync(100);
    expect((await pending)[0].element).toBe(replacement);
    expect(replacement).not.toBe(original);
  });

  it('accepts a drawn empty view and figures with no read tracks', async () => {
    track(false, true, 0);
    const empty = waitForReadTracks(undefined, undefined, { root });
    await vi.advanceTimersByTimeAsync(100);
    expect((await empty)[0].renderCount).toBe(0);
    root.replaceChildren();
    const noTracks = waitForReadTracks(undefined, undefined, { root });
    await vi.advanceTimersByTimeAsync(100);
    expect(await noTracks).toEqual([]);
  });

  it('rejects failed requests even when they left a populated canvas', async () => {
    const el = track();
    el.dataset.readTrackError = 'Could not load reads. Reload the region, then export again.';
    const rejected = expect(waitForReadTracks(undefined, undefined, { root })).rejects.toThrow('Could not load reads');
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out without accepting a loading frame, and cancels its polling', async () => {
    track(true, false);
    const rejected = expect(waitForReadTracks(undefined, 'Reads are still loading.', { root, timeoutMs: 1000 }))
      .rejects.toThrow('Reads are still loading.');
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
});
