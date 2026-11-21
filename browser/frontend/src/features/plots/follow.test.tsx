/**
 * Follow / Pin: the debounce (FollowController with fake time, and the hook the workspace uses) and the stale-state
 * guard (a plot is current only for the target it wants now; a late answer for a left view is never current).
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FollowController, plotFreshness, useFollowedTarget, type FollowTimer } from './follow';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function fakeTimer() {
  let now = 0;
  let next = 1;
  const jobs = new Map<number, { at: number; fn: () => void }>();
  const timer: FollowTimer = {
    set: (fn, ms) => { const id = next++; jobs.set(id, { at: now + ms, fn }); return id; },
    clear: h => { jobs.delete(h as number); },
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [id, job] of [...jobs].sort((a, b) => a[1].at - b[1].at)) {
      if (job.at <= now && jobs.has(id)) { jobs.delete(id); job.fn(); }
    }
  };
  return { timer, advance, pending: () => jobs.size };
}

type L = { chrom: string; start: number };
const key = (l: L) => `${l.chrom}:${l.start}`;

describe('FollowController', () => {
  it('commits delayMs after the last change, restarting the wait on every move', () => {
    const t = fakeTimer();
    const commits: string[] = [];
    const c = new FollowController<L>({ chrom: 'c', start: 0 }, key, l => commits.push(key(l)), 300, t.timer);
    c.update({ chrom: 'c', start: 100 });
    expect(c.pending).toBe(true);
    t.advance(299);
    expect(commits).toEqual([]);
    c.update({ chrom: 'c', start: 200 });
    t.advance(299);
    expect(commits).toEqual([]);
    t.advance(1);
    expect(commits).toEqual(['c:200']);
    expect(c.pending).toBe(false);
    expect(key(c.current)).toBe('c:200');
  });

  it('moving back to the committed target cancels the wait (no recompute)', () => {
    const t = fakeTimer();
    const commits: string[] = [];
    const c = new FollowController<L>({ chrom: 'c', start: 0 }, key, l => commits.push(key(l)), 300, t.timer);
    c.update({ chrom: 'c', start: 100 });
    c.update({ chrom: 'c', start: 0 });
    expect(c.pending).toBe(false);
    t.advance(1000);
    expect(commits).toEqual([]);
  });

  it('the delay is a parameter (0 commits at once); flush and jump commit now; dispose drops the wait', () => {
    const t = fakeTimer();
    const commits: string[] = [];
    const c = new FollowController<L>({ chrom: 'c', start: 0 }, key, l => commits.push(key(l)), 300, t.timer);
    c.setDelay(1000);
    c.update({ chrom: 'c', start: 1 });
    t.advance(999);
    expect(commits).toEqual([]);
    c.flush();
    expect(commits).toEqual(['c:1']);
    c.setDelay(0);
    c.update({ chrom: 'c', start: 2 });
    expect(commits).toEqual(['c:1', 'c:2']);
    c.setDelay(300);
    c.update({ chrom: 'c', start: 3 });
    c.jump({ chrom: 'd', start: 9 });
    expect(commits).toEqual(['c:1', 'c:2', 'd:9']);
    t.advance(1000);
    expect(commits).toEqual(['c:1', 'c:2', 'd:9']);
    c.update({ chrom: 'c', start: 4 });
    c.dispose();
    t.advance(1000);
    expect(commits.length).toBe(3);
    expect(t.pending()).toBe(0);
  });
});

describe('useFollowedTarget (Follow / Pin)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let seen: { target: L; pending: boolean };
  function Probe({ live, pinned, delay }: { live: L; pinned: L | null; delay: number }) {
    seen = useFollowedTarget(live, pinned, key, delay);
    return null;
  }
  const render = (live: L, pinned: L | null = null, delay = 300) => act(() => { root.render(<Probe live={live} pinned={pinned} delay={delay} />); });

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); });

  it('follows the view ~300 ms after it stops moving, updating meanwhile', async () => {
    render({ chrom: 'c', start: 0 });
    expect(seen).toEqual({ target: { chrom: 'c', start: 0 }, pending: false });
    render({ chrom: 'c', start: 100 });
    expect(seen.pending).toBe(true);
    expect(key(seen.target)).toBe('c:0');
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    render({ chrom: 'c', start: 200 });
    await act(async () => { await vi.advanceTimersByTimeAsync(299); });
    expect(seen.pending).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(seen).toEqual({ target: { chrom: 'c', start: 200 }, pending: false });
  });

  it('a pinned plot keeps its locus while the view moves, and computes for a new pin at once', async () => {
    const pin = { chrom: 'c', start: 50 };
    render({ chrom: 'c', start: 0 }, pin);
    expect(key(seen.target)).toBe('c:50');
    expect(seen.pending).toBe(false);
    render({ chrom: 'c', start: 900 }, pin);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(seen).toEqual({ target: pin, pending: false });
    // Back to Follow: the view now, after the delay.
    render({ chrom: 'c', start: 900 }, null);
    expect(seen.pending).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(seen).toEqual({ target: { chrom: 'c', start: 900 }, pending: false });
  });

  it('pinning mid-update pins the view being moved to, computed at once', async () => {
    render({ chrom: 'c', start: 0 });
    render({ chrom: 'c', start: 400 });
    expect(seen.pending).toBe(true);
    // The workspace pins the live view (what "Updating… →" names).
    render({ chrom: 'c', start: 400 }, { chrom: 'c', start: 400 });
    expect(seen).toEqual({ target: { chrom: 'c', start: 400 }, pending: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(key(seen.target)).toBe('c:400');
  });
});

describe('plotFreshness (stale-state guard)', () => {
  it('current only when the result answers the request wanted now and nothing waits', () => {
    expect(plotFreshness({ resultKey: 'A', wantKey: 'A', pending: false, loading: false, error: null }))
      .toEqual({ state: 'current', showResult: true, stale: false });
  });

  it('the view moved (waiting for it to settle): the old result is stale, never current', () => {
    expect(plotFreshness({ resultKey: 'A', wantKey: 'A', pending: true, loading: false, error: null }))
      .toEqual({ state: 'updating', showResult: true, stale: true });
  });

  it('recomputing for B with A on screen: A is shown greyed as stale', () => {
    expect(plotFreshness({ resultKey: 'A', wantKey: 'B', pending: false, loading: true, error: null }))
      .toEqual({ state: 'updating', showResult: true, stale: true });
  });

  it('a late answer for A after the plot moved on to B stays stale (its key is A)', () => {
    expect(plotFreshness({ resultKey: 'A', wantKey: 'B', pending: false, loading: false, error: null }).state).toBe('updating');
  });

  it('nothing yet: updating with nothing shown; an error for the wanted request shows the error', () => {
    expect(plotFreshness({ resultKey: null, wantKey: 'A', pending: false, loading: true, error: null }))
      .toEqual({ state: 'updating', showResult: false, stale: false });
    expect(plotFreshness({ resultKey: 'A', wantKey: 'B', pending: false, loading: false, error: 'boom' }).state).toBe('error');
  });
});
