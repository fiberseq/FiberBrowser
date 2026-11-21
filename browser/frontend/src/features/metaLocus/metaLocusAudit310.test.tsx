/**
 * Meta-locus release-audit regressions (3.1.0): seed 0 survives a session / link, a clean session's empty added-reads
 * list is sent, a session whose BED is gone says so and falls back to the real locus, and Cancel follows the pool to
 * its terminal status.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { cancelMetaLocus, resetMetaLocusForTests, restoreMetaLocusSession, useMetaLocusStore } from './metaLocusStore';
import { parseMetaUrl, withMetaUrlParams } from './metaUrl';
import { metaRealSpan } from './metaChrom';
import type { MetaLocusStatus, MetaLocusView } from './api';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const POOL = 'abc123';
const CHROM = `meta:${POOL}`;
const VIEW: MetaLocusView = {
  chrom: CHROM, width: 20000, axis_offset: -10000, seed: 1, count: 2000, cursor: { d1: 2000 }, pool_observations: { d1: 50000 },
  pool_total: 50000, extra_entries: [], extra_count: 0, enriched: false, generation: 1,
};
const status = (s: Partial<MetaLocusStatus> = {}): MetaLocusStatus => ({
  success: true, pool_id: POOL, name: 'sites', status: 'ready', chrom: CHROM, width: 20000, axis_offset: -10000,
  flank_bp: 10000, label: 'sites · TSS ± 10 kb', spec: { anchor: 'start', flank_bp: 10000 }, progress: { fraction: 1 }, ...s,
});

type Call = { url: string; method: string; body: any };
let calls: Call[] = [];
let replies: Array<(call: Call) => unknown> = [];

beforeEach(() => {
  calls = [];
  replies = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const call = { url: String(url), method, body };
    calls.push(call);
    for (const r of replies) {
      const out = r(call);
      if (out instanceof Response) return out;
      if (out !== undefined) return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    let json: unknown = { success: true };
    if (call.url.endsWith('/view')) json = { ...VIEW, ...(body ?? {}), generation: calls.length };
    else if (call.url.endsWith('/meta_locus/pools') && method === 'POST') json = status();
    else if (call.url.includes('/meta_locus/pools/') && method === 'GET') json = status();
    return new Response(JSON.stringify(json), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
  useBrowserStore.setState({ chrom: 'chr19', start: 1000, end: 5000, datasets: [{ id: 'd1', label: 'sample', path: '/x.bam', data_type: 'bam', color: '#000' } as never] });
});

const initial = useBrowserStore.getState();
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetMetaLocusForTests();
  useBrowserStore.setState(initial, true);
});

const saved = (extra: Partial<Record<string, unknown>> = {}) => ({
  bed_path: '/data/sites.bed', name: 'sites', anchor: 'start', flank_bp: 10000, seed: 7, count: 300, extra_entries: [],
  lastRealLocus: { chrom: 'chr2', start: 100, end: 900 }, ...extra,
});

describe('seed 0', () => {
  it('a session with seed 0 restores seed 0', async () => {
    await restoreMetaLocusSession(saved({ seed: 0 }), false);
    expect(calls.find(c => c.url.endsWith('/view'))!.body).toMatchObject({ seed: 0 });
    expect(useMetaLocusStore.getState().seed).toBe(0);
  });

  it('an address with seed 0 keeps it; a missing seed is 1', () => {
    const spec = { bed_path: '/data/sites.bed', anchor: 'start' as const, flank_bp: 1000 };
    const params = withMetaUrlParams(new URLSearchParams(), { spec, seed: 0, count: 10, back: null });
    expect(parseMetaUrl(params)!.seed).toBe(0);
    params.delete('ml_seed');
    expect(parseMetaUrl(params)!.seed).toBe(1);
  });
});

describe('a clean session', () => {
  it('sends its empty added-reads list, so reads refilled since are not kept', async () => {
    await restoreMetaLocusSession(saved({ extra_entries: [] }), false);
    const view = calls.find(c => c.url.endsWith('/view'))!;
    expect(view.body).toEqual({ seed: 7, count: 300, extra_entries: [] });
  });

  it('an older session without the list restores a clean view too', async () => {
    const s = saved();
    delete (s as Record<string, unknown>).extra_entries;
    await restoreMetaLocusSession(s, false);
    expect(calls.find(c => c.url.endsWith('/view'))!.body).toEqual({ seed: 7, count: 300, extra_entries: [] });
  });
});

describe('a session whose BED is gone', () => {
  it('shows a notice and returns to the real locus the session saved', async () => {
    replies.push(({ url, method }) => (url.endsWith('/meta_locus/pools') && method === 'POST'
      ? new Response(JSON.stringify({ detail: 'No BED file at /data/sites.bed' }), { status: 404, headers: { 'Content-Type': 'application/json' } }) : undefined));
    // The session's viewport was on the meta contig.
    useBrowserStore.setState({ chrom: CHROM, start: 0, end: 20000 });
    await restoreMetaLocusSession(saved(), true);
    const m = useMetaLocusStore.getState();
    expect(m.notice).toMatch(/BED of this session is gone \(\/data\/sites\.bed\)/);
    expect(m.dialogOpen).toBe(false);
    expect(m.error).toBeNull();
    expect(m.spec).toBeNull();
    const s = useBrowserStore.getState();
    expect([s.chrom, s.start, s.end]).toEqual(['chr2', 100, 900]);
  });

  it('a session not on the meta contig keeps its locus and still says so', async () => {
    replies.push(({ url, method }) => (url.endsWith('/meta_locus/pools') && method === 'POST'
      ? new Response(JSON.stringify({ detail: 'No BED file at /data/sites.bed' }), { status: 404, headers: { 'Content-Type': 'application/json' } }) : undefined));
    await restoreMetaLocusSession(saved(), false);
    expect(useMetaLocusStore.getState().notice).toMatch(/gone/);
    expect(useMetaLocusStore.getState().dialogOpen).toBe(false);
    expect(useBrowserStore.getState().chrom).toBe('chr19');
  });
});

describe('Cancel', () => {
  it('keeps polling until the pool reaches a terminal status, then clears the building view', async () => {
    vi.useFakeTimers();
    let polls = 0;
    replies.push(({ url, method }) => {
      if (url.endsWith('/cancel')) return status({ status: 'building', progress: { fraction: 0.5 } });
      if (url.endsWith(`/pools/${POOL}`) && method === 'GET') {
        polls += 1;
        return polls < 3 ? status({ status: 'building', progress: { fraction: 0.5 } }) : status({ status: 'cancelled' });
      }
      return undefined;
    });
    useBrowserStore.setState({ chrom: CHROM, start: 0, end: 20000 });
    useMetaLocusStore.setState({ status: status({ status: 'building', progress: { fraction: 0.5 } }), view: { ...VIEW, provisional: true } as MetaLocusView,
      lastRealLocus: { chrom: 'chr2', start: 100, end: 900 } });
    await act(async () => { await cancelMetaLocus(); });
    expect(useMetaLocusStore.getState().status?.status).toBe('building');
    for (let i = 0; i < 6 && useMetaLocusStore.getState().status?.status === 'building'; i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    }
    expect(polls).toBeGreaterThanOrEqual(3);
    const m = useMetaLocusStore.getState();
    expect(m.status?.status).toBe('cancelled');
    expect(m.view).toBeNull();
    expect(useBrowserStore.getState().chrom).toBe('chr2');
  });
});

describe('Cancel answered with a terminal status', () => {
  it('shows the working set when the build finished before Cancel reached the server (ready)', async () => {
    replies.push(({ url }) => (url.endsWith('/cancel') ? status({ status: 'ready' }) : undefined));
    useBrowserStore.setState({ chrom: CHROM, start: 0, end: 20000 });
    useMetaLocusStore.setState({ status: status({ status: 'building', progress: { fraction: 0.9 } }), view: null, seed: 3, count: 500,
      lastRealLocus: { chrom: 'chr2', start: 100, end: 900 } });
    await act(async () => { await cancelMetaLocus(); });
    const m = useMetaLocusStore.getState();
    expect(m.status?.status).toBe('ready');
    const views = calls.filter(c => c.url.endsWith('/view'));
    expect(views).toHaveLength(1);
    expect(views[0].body).toMatchObject({ seed: 3, count: 500 });
    expect(m.view).not.toBeNull();
  });

  it('cleans up as a failed build when Cancel is answered with an error', async () => {
    replies.push(({ url }) => (url.endsWith('/cancel') ? status({ status: 'error', error: 'BED unreadable' }) : undefined));
    useBrowserStore.setState({ chrom: CHROM, start: 0, end: 20000 });
    useMetaLocusStore.setState({ status: status({ status: 'building', progress: { fraction: 0.5 } }), view: { ...VIEW, provisional: true } as MetaLocusView,
      lastRealLocus: { chrom: 'chr2', start: 100, end: 900 } });
    await act(async () => { await cancelMetaLocus(); });
    const m = useMetaLocusStore.getState();
    expect(m.status?.status).toBe('error');
    expect(m.error).toBe('BED unreadable');
    expect(m.dialogOpen).toBe(true);
    expect(useBrowserStore.getState().chrom).toBe('chr2');
    expect(calls.some(c => c.url.endsWith('/view'))).toBe(false);
  });
});

describe('sites near a contig start', () => {
  it('export columns map plus-strand spans from the unclamped window origin', () => {
    // BED [100, 101), Start anchor, flank 1000: the window's start is clamped to 0, its logical origin is -900.
    const plus = { chrom: 'c', window: [0, 1100] as [number, number], strand: '+' as const, origin: -900 };
    expect(metaRealSpan(plus, 1000, 1001)).toEqual([100, 101]);
    // Without an origin (older payloads), the window start as before.
    expect(metaRealSpan({ chrom: 'c', window: [500, 2500], strand: '+' }, 1000, 1001)).toEqual([1500, 1501]);
  });
});

describe('Cancel that fails', () => {
  it('keeps following the build when the cancel request itself fails', async () => {
    vi.useFakeTimers();
    let polls = 0;
    replies.push(({ url, method }) => {
      if (url.endsWith('/cancel')) return new Response(JSON.stringify({ detail: 'busy' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      if (url.endsWith(`/pools/${POOL}`) && method === 'GET') {
        polls += 1;
        return polls < 2 ? status({ status: 'building', progress: { fraction: 0.5 } }) : status({ status: 'ready' });
      }
      return undefined;
    });
    useMetaLocusStore.setState({ status: status({ status: 'building', progress: { fraction: 0.5 } }) });
    await act(async () => { await cancelMetaLocus(); });
    for (let i = 0; i < 6 && useMetaLocusStore.getState().status?.status === 'building'; i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    }
    expect(useMetaLocusStore.getState().status?.status).toBe('ready');
    expect(calls.some(c => c.url.endsWith('/view'))).toBe(true);
  });
});
