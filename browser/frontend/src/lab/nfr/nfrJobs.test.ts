import '../testSetup';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelJob, clearBadge, getBadges, getJob, getNotices, NOTICE_AFTER_MS, resetJobs, sleep, startJob, useBackgroundView } from './nfrJobs';
import { cardKey, starredSplit, type SavedNfr } from './savedNfrVariants';

describe('Accessibility background jobs (utils/nfrJobs)', () => {
  beforeEach(() => { resetJobs(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); resetJobs(); });

  it('a job runs once per key, independent of any view, and its result is kept by key', async () => {
    const load = vi.fn(async () => { await sleep(10); return 42; });
    startJob('k', load);
    startJob('k', load);                                   // joined, not restarted
    expect(getJob('k')!.status).toBe('loading');
    await vi.advanceTimersByTimeAsync(20);
    expect(load).toHaveBeenCalledTimes(1);
    expect(getJob<number>('k')).toMatchObject({ status: 'done', data: 42 });
    startJob('k', load);                                   // cached
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('a slow job finishing with no view watching marks its tab and entry and raises a notice; a quick one does not', async () => {
    startJob('quick', async () => 1, { tab: 'saved', entry: 'e1', label: 'Quick' });
    await vi.advanceTimersByTimeAsync(5);
    expect(getNotices()).toHaveLength(0);
    startJob('slow', async () => { await sleep(NOTICE_AFTER_MS + 100); return 2; }, { tab: 'saved', entry: 'e2', label: 'Motifs of N5 · N5 saved' });
    await vi.advanceTimersByTimeAsync(NOTICE_AFTER_MS + 200);
    expect(getBadges()).toMatchObject({ 'tab:saved': 1, 'entry:e2': 1 });
    expect(getNotices().map(n => [n.label, n.ok])).toEqual([['Motifs of N5 · N5 saved', true]]);
    clearBadge('entry:e2');
    expect(getBadges()['entry:e2']).toBeUndefined();
  });

  it('cancelling is explicit: it stops following the job and calls its own cancel; an error is kept and retried on demand', async () => {
    const cancel = vi.fn();
    startJob('t', async ctx => { while (!ctx.signal.cancelled) await sleep(100); return 'late'; }, { label: 'Quantify' }, cancel);
    await vi.advanceTimersByTimeAsync(150);
    await cancelJob('t');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(getJob('t')!.status).toBe('cancelled');
    await vi.advanceTimersByTimeAsync(200);
    expect(getJob('t')!.status).toBe('cancelled');          // a late answer does not undo the cancel
    expect(getNotices()).toHaveLength(0);                    // no notice for a cancel
    startJob('e', async () => { throw new Error('boom'); });
    await vi.advanceTimersByTimeAsync(1);
    expect(getJob('e')).toMatchObject({ status: 'error', error: 'boom' });
    startJob('e', async () => 'ok');
    await vi.advanceTimersByTimeAsync(1);
    expect(getJob('e')).toMatchObject({ status: 'done', data: 'ok' });
  });

  it('progress of a polled task is visible while it runs', async () => {
    startJob('chip', async ctx => { ctx.progress({ done: 1, total: 3 }); await sleep(10); ctx.progress({ done: 3, total: 3 }); return 'x'; });
    await vi.advanceTimersByTimeAsync(1);
    expect(getJob('chip')!.progress).toEqual({ done: 1, total: 3 });
    await vi.advanceTimersByTimeAsync(20);
    expect(getJob('chip')!.status).toBe('done');
  });
});

describe('starred NFRs in the one list', () => {
  const entry = (id: string, jobId: string, chrom: string, a: number, b: number) => ({ id, jobId, nfrId: `N${id}`, chrom, nfrStart: a, nfrEnd: b } as SavedNfr);
  it('the shown run\'s starred entries go onto its cards (by card key); every other run\'s are Earlier, in saved order', () => {
    const saved = [entry('a', 'run1', 'chr3L', 100, 200), entry('b', 'old', 'chr3L', 100, 200), entry('c', 'run2', '3L', 150, 250), entry('d', 'run1', 'chr2', 150, 250)];
    const { here, earlier } = starredSplit(saved, 'run1');
    expect([...here.keys()]).toEqual([cardKey('run1', 'Na'), cardKey('run1', 'Nd')]);
    expect(earlier.map(e => e.id)).toEqual(['b', 'c']);       // another run, even over this window
    expect(starredSplit(saved, null).earlier).toHaveLength(4); // no run shown yet: all Earlier
  });
});

describe('a view that survives a reset', () => {
  it('loads again instead of waiting forever (Codex review)', async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    resetJobs();
    const load = vi.fn(async () => 'v');
    const seen: unknown[] = [];
    function View() { const s = useBackgroundView(load, 'view-key'); seen.push(s.loading ? 'loading' : s.data); return null; }
    const el = document.createElement('div');
    const root = createRoot(el);
    await act(async () => { root.render(createElement(View)); });
    await act(async () => { await new Promise(r => setTimeout(r, 5)); });
    expect(seen.at(-1)).toBe('v');
    await act(async () => { resetJobs(); });
    await act(async () => { await new Promise(r => setTimeout(r, 5)); });
    expect(load).toHaveBeenCalledTimes(2);
    expect(seen.at(-1)).toBe('v');
    act(() => root.unmount());
  });
});
