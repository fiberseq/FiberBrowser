/**
 * The meta-locus (owner: "everything identical to the standard browser, just diff coordinates"): the store and its
 * server calls, the Open dialog, the locus words and Back, the build strip, the working-set control, the read
 * inspector's provenance and Open this site, Keep workspace full, Find more like this, the hiding rules and sessions.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import {
  backToRealLocus, effectiveReadLimit, enterMetaLocus, findMoreLikeThis, metaLocusSessionPayload, moreReads, openMetaLocus,
  openMetaLocusDialog, refillWorkspace, resample, resetMetaLocusForTests, restoreMetaLocusSession, useMetaLocusStore,
} from './metaLocusStore';
import { META_HIDDEN_PANELS, flankWords, isMetaChrom, maxFlankFor, metaHiddenTrack, metaLabel, metaReadLimit, metaViewWords } from './metaChrom';
import { MetaLocusDialog } from './MetaLocusDialog';
import { MetaLocusControls, MetaLocusProgressStrip, findMoreWords, ENRICHED_TEXT } from './MetaLocusBar';
import { KeepWorkspaceFull } from './KeepWorkspaceFull';
import { metaReadLines } from './MetaReadLines';
import { openSite, registerMetaLocus } from './register';
import { buildReadMenu } from '../../components/tracks/read-track/readMenuModel';
import type { MetaLocusStatus, MetaLocusView } from './api';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const POOL = 'abc123';
const CHROM = `meta:${POOL}`;
const VIEW: MetaLocusView = {
  chrom: CHROM, width: 20000, axis_offset: -10000, seed: 1, count: 2000, cursor: { d1: 2000 }, pool_observations: { d1: 50000 },
  pool_total: 50000, extra_entries: [], extra_count: 0, enriched: false, generation: 1,
};
const status = (s: Partial<MetaLocusStatus> = {}): MetaLocusStatus => ({
  success: true, pool_id: POOL, name: 'promoters_tss', status: 'ready', chrom: CHROM, width: 20000, axis_offset: -10000,
  flank_bp: 10000, label: 'promoters_tss · TSS ± 10 kb', spec: { anchor: 'start', flank_bp: 10000 }, progress: { fraction: 1 }, ...s,
});

type Call = { url: string; method: string; body: any };
let calls: Call[] = [];
let replies: Array<(call: Call) => unknown> = [];

function reply(url: string, method: string, body: any): unknown {
  for (const r of replies) {
    const out = r({ url, method, body });
    if (out !== undefined) return out;
  }
  if (url.endsWith('/view')) return { ...VIEW, ...(body ?? {}), generation: (calls.filter(c => c.url.endsWith('/view')).length) + 1 };
  if (url.endsWith('/meta_locus/pools') && method === 'POST') return status();
  if (url.includes('/meta_locus/pools/') && method === 'GET') return status();
  return { success: true };
}

beforeEach(() => {
  calls = [];
  replies = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: String(url), method, body });
    return new Response(JSON.stringify(reply(String(url), method, body)), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
  useBrowserStore.setState({ chrom: 'chr19', start: 1000, end: 5000, datasets: [{ id: 'd1', label: 'sample', path: '/x.bam', data_type: 'bam', color: '#000' } as never] });
});

const initial = useBrowserStore.getState();
afterEach(() => {
  vi.unstubAllGlobals();
  resetMetaLocusForTests();
  useBrowserStore.setState(initial, true);
});

let box: HTMLDivElement;
let root: Root;
async function mount(node: React.ReactNode) {
  box = document.createElement('div');
  document.body.appendChild(box);
  root = createRoot(box);
  await act(async () => root.render(node));
}
function unmount() {
  if (root) act(() => root.unmount());
  box?.remove();
}
const q = (testId: string) => box.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });

describe('meta contig helpers', () => {
  it('names the meta-locus and its views', () => {
    expect(isMetaChrom(CHROM)).toBe(true);
    expect(isMetaChrom('chr1')).toBe(false);
    expect(metaLabel({ name: 'promoters_tss', flank_bp: 10000, spec: { anchor: 'start' } })).toBe('promoters_tss · TSS ± 10 kb');
    expect(metaLabel(status())).toBe('promoters_tss · TSS ± 10 kb');
    expect(flankWords(12500)).toBe('12.5 kb');
    expect(metaViewWords(status(), 0, 20000)).toBe('promoters_tss · TSS ± 10 kb');
    expect(metaViewWords(status(), 8000, 13000)).toBe('promoters_tss · -2,000 to +3,000');
  });

  it('hides rows and panels that need a real genome position, keeps metaprofiles and reads', () => {
    for (const t of ['sequence', 'gene', 'primer', 'microc', 'sv', 'capture', 'ortho-0']) expect(metaHiddenTrack(t)).toBe(true);
    expect(metaHiddenTrack('composite-motifs', false)).toBe(true);
    expect(metaHiddenTrack('composite-metaprofile', true)).toBe(false);
    for (const t of ['reads', 'coverage', 'axis', 'fire', 'meta']) expect(metaHiddenTrack(t)).toBe(false);
    for (const p of ['primer-design', 'graph-view', 'variants', 'contact-map', 'track-browser', 'feature-hub', 'insertion-lens']) expect(META_HIDDEN_PANELS.has(p)).toBe(true);
    expect(META_HIDDEN_PANELS.has('cluster-detail')).toBe(false);
  });

  it('raises the read-view limit to the pool window, except on low-power clients (whose dialog caps the flank)', () => {
    expect(metaReadLimit(CHROM, 100_000, 100_000, false)).toBe(100_000);
    expect(metaReadLimit(CHROM, 50_000, 100_000, false)).toBe(100_000);
    expect(metaReadLimit(CHROM, 50_000, 100_000, true)).toBe(50_000);
    expect(metaReadLimit('chr1', 50_000, 100_000, false)).toBe(50_000);
    expect(maxFlankFor(true, 50_000)).toBe(25_000);
    expect(maxFlankFor(false, 50_000)).toBe(50_000);
    useMetaLocusStore.setState({ status: status({ width: 100_000 }) });
    expect(effectiveReadLimit(CHROM, 50_000)).toBeGreaterThanOrEqual(50_000);
    expect(effectiveReadLimit('chr1', 50_000)).toBe(50_000);
  });
});

describe('the store', () => {
  it('opens a BED as a meta-locus: builds, sets the working set, shows it; Back returns to the real locus', async () => {
    let polls = 0;
    replies.push(({ url, method }) => {
      if (url.endsWith('/meta_locus/pools') && method === 'POST') return status({ status: 'building', progress: { fraction: 0.2 } });
      if (url.endsWith(`/pools/${POOL}`) && method === 'GET') return status(++polls < 2 ? { status: 'building', progress: { fraction: 0.6 } } : {});
      return undefined;
    });
    await openMetaLocus({ bed_path: '/tmp/promoters_tss.bed', name: 'promoters_tss', anchor: 'start', flank_bp: 10000 }, { count: 2000, seed: 3 });
    await vi.waitFor(() => expect(useBrowserStore.getState().chrom).toBe(CHROM), { timeout: 3000 });
    const s = useBrowserStore.getState();
    expect([s.start, s.end]).toEqual([0, 20000]);
    const post = calls.find(c => c.url.endsWith('/meta_locus/pools'))!;
    expect(post.body).toMatchObject({ bed_path: '/tmp/promoters_tss.bed', anchor: 'start', flank_bp: 10000 });
    expect(calls.find(c => c.url.endsWith('/view'))!.body).toMatchObject({ seed: 3, count: 2000 });
    expect(useMetaLocusStore.getState().lastRealLocus).toEqual({ chrom: 'chr19', start: 1000, end: 5000 });
    expect(backToRealLocus()).toBe(true);
    expect(useBrowserStore.getState().chrom).toBe('chr19');
  });

  it('More reads and Resample ask the server for the next working set and re-fetch the reads', async () => {
    useMetaLocusStore.setState({ status: status(), view: VIEW, seed: 1 });
    const before = useBrowserStore.getState().refreshGeneration;
    await moreReads(1000);
    expect(calls.at(-1)!.body).toEqual({ more: 1000 });
    await resample();
    expect(calls.at(-1)!.body).toEqual({ resample: true, seed: 2 });
    expect(useBrowserStore.getState().refreshGeneration).toBeGreaterThan(before);
  });

  it('Find more like this reports matches / read-site observations scanned with a Wilson interval; the view is enriched', async () => {
    useMetaLocusStore.setState({ status: status(), view: VIEW });
    replies.push(({ url }) => (url.endsWith('/find_more')
      ? { success: true, found: 12, scanned: 900, freq: 12 / 900, wilson: [0.0076, 0.0232], added: 12, unit: 'read-site observations', enriched: true, view: { ...VIEW, enriched: true, extra_count: 12, generation: 5 } }
      : undefined));
    const result = await findMoreLikeThis({ d1: ['r1#site3', 'r2'] });
    expect(calls.at(-1)!.body).toMatchObject({ read_ids: { d1: ['r1#site3', 'r2'] } });
    expect(result!.requested).toBe(2);
    expect(useMetaLocusStore.getState().view!.enriched).toBe(true);
    expect(findMoreWords(result!)).toBe('found 12 of 900 read-site observations scanned · freq 1.3% (Wilson 95% 0.76%–2.3%)');
  });

  it('Keep workspace full sends the clusters and merges the clusters of the reads it adds', async () => {
    useMetaLocusStore.setState({ status: status(), view: VIEW });
    useBrowserStore.setState({ clusterAssignments: { d1: { a: 0, b: 1 } } } as never);
    replies.push(({ url }) => (url.endsWith('/refill')
      ? { success: true, per_cluster: [{ cluster: 0, found: 10, scanned: 100, freq: 0.1, wilson: [0.05, 0.17] }], scanned: 100, enriched: true,
          view: { ...VIEW, enriched: true, generation: 9 }, assignments: { d1: { c: 1 } } }
      : undefined));
    await refillWorkspace();
    expect(calls.at(-1)!.body.assignments).toEqual({ d1: { a: 0, b: 1 } });
    expect(useBrowserStore.getState().clusterAssignments.d1).toEqual({ a: 0, b: 1, c: 1 });
    expect(useMetaLocusStore.getState().refill!.per_cluster[0].freq).toBe(0.1);
  });

  it('saves and restores a session: the pool spec, seed, working-set size and refilled reads', async () => {
    useMetaLocusStore.setState({
      spec: { bed_path: '/tmp/p.bed', name: 'p', anchor: 'centre', flank_bp: 15000 }, seed: 7, count: 3000, status: status(),
      view: { ...VIEW, extra_entries: [['d1', 'r9', 4]] }, lastRealLocus: { chrom: 'chr2', start: 1, end: 9 },
    });
    const saved = metaLocusSessionPayload()!;
    expect(saved).toMatchObject({ bed_path: '/tmp/p.bed', anchor: 'centre', flank_bp: 15000, seed: 7, count: 3000, extra_entries: [['d1', 'r9', 4]] });
    resetMetaLocusForTests();
    useBrowserStore.setState({ chrom: CHROM, start: 5000, end: 9000 });
    await restoreMetaLocusSession(JSON.parse(JSON.stringify(saved)), true);
    expect(calls.find(c => c.url.endsWith('/meta_locus/pools'))!.body).toMatchObject({ bed_path: '/tmp/p.bed', flank_bp: 15000 });
    expect(calls.find(c => c.url.endsWith('/view'))!.body).toEqual({ seed: 7, count: 3000, extra_entries: [['d1', 'r9', 4]] });
    // Already on the pool's contig: the zoom stays.
    expect([useBrowserStore.getState().start, useBrowserStore.getState().end]).toEqual([5000, 9000]);
    expect(useMetaLocusStore.getState().lastRealLocus).toEqual({ chrom: 'chr2', start: 1, end: 9 });
    await restoreMetaLocusSession(null, false);
    expect(useMetaLocusStore.getState().spec).toBeNull();
  });
});

describe('the controls', () => {
  afterEach(unmount);

  it('the dialog opens a BED with anchor, flank, datasets, working set and seed', async () => {
    openMetaLocusDialog();
    await mount(<MetaLocusDialog />);
    const set = (id: string, value: string) => {
      const el = q(id) as HTMLInputElement | HTMLSelectElement;
      const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
      el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    };
    expect((q('meta-locus-flank') as HTMLInputElement).value).toBe('10000');
    await act(async () => { set('meta-locus-bed', '/data/promoters_tss.bed.gz'); set('meta-locus-anchor', 'start'); set('meta-locus-flank', '20000'); set('meta-locus-count', '1500'); set('meta-locus-seed', '4'); });
    await act(async () => { q('meta-locus-dialog')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await flush();
    expect(q('meta-locus-dialog-error')?.textContent ?? '').toBe('');
    const post = calls.find(c => c.url.endsWith('/meta_locus/pools'))!;
    expect(post.body).toMatchObject({ bed_path: '/data/promoters_tss.bed.gz', name: 'promoters_tss', anchor: 'start', flank_bp: 20000 });
    expect(useMetaLocusStore.getState().dialogOpen).toBe(false);
    await vi.waitFor(() => expect(calls.some(c => c.url.endsWith('/view'))).toBe(true));
    expect(calls.find(c => c.url.endsWith('/view'))!.body).toMatchObject({ count: 1500, seed: 4 });
  });

  it('the build strip shows progress and cancels; it is gone once ready', async () => {
    useMetaLocusStore.setState({ status: status({ status: 'building', progress: { fraction: 0.42, sites_done: 4200, sites_total: 10000, eta_s: 12 } }) });
    await mount(<MetaLocusProgressStrip />);
    expect(q('meta-locus-progress')!.textContent).toContain('42%');
    expect(q('meta-locus-progress')!.textContent).toContain('4,200 of 10,000 sites');
    expect(q('meta-locus-progress')!.textContent).toContain('12 s left');
    replies.push(({ url }) => (url.endsWith('/cancel') ? status({ status: 'cancelled' }) : undefined));
    await act(async () => q('meta-locus-cancel')!.click());
    await flush();
    expect(calls.at(-1)!.url).toContain(`/pools/${POOL}/cancel`);
    expect(q('meta-locus-progress')).toBeNull();
  });

  it('the working-set control: N of pool, More reads, Resample, seed, Back, enriched badge and clear', async () => {
    useMetaLocusStore.setState({ status: status(), view: { ...VIEW, enriched: true, extra_count: 30 }, seed: 1, lastRealLocus: { chrom: 'chr19', start: 1, end: 2 } });
    useBrowserStore.setState({ chrom: CHROM, start: 0, end: 20000 });
    await mount(<MetaLocusControls />);
    expect(q('meta-locus-count')!.textContent).toBe('2,030 of 50,000');
    // The enriched state is a compact chip; its popover says what it means and clears it.
    expect(q('meta-locus-enriched')!.textContent).toBe('enriched');
    await act(async () => q('meta-locus-enriched')!.click());
    expect(q('meta-locus-enriched-text')!.textContent).toBe(ENRICHED_TEXT);
    await act(async () => q('meta-locus-clear-extra')!.click());
    expect(calls.at(-1)!.body).toEqual({ clear_extra: true });
    await act(async () => q('meta-locus-more')!.click());
    expect(calls.at(-1)!.body).toEqual({ more: 1000 });
    await act(async () => q('meta-locus-resample')!.click());
    expect(calls.at(-1)!.body).toEqual({ resample: true, seed: 2 });
    await act(async () => q('meta-locus-back')!.click());
    expect(useBrowserStore.getState().chrom).toBe('chr19');
    // Off the meta contig: one way back in.
    expect(q('meta-locus-return')).not.toBeNull();
    await act(async () => q('meta-locus-return')!.click());
    expect(useBrowserStore.getState().chrom).toBe(CHROM);
  });

  it('Keep workspace full shows only on the meta contig, after clustering, and refills when checked', async () => {
    useMetaLocusStore.setState({ status: status(), view: VIEW });
    await mount(<KeepWorkspaceFull hasClusters />);
    expect(q('meta-locus-keep-full')).toBeNull();
    unmount();
    useBrowserStore.setState({ chrom: CHROM, start: 0, end: 20000, clusterAssignments: { d1: { a: 0 } } } as never);
    replies.push(({ url }) => (url.endsWith('/refill') ? { success: true, per_cluster: [{ cluster: 0, found: 5, scanned: 50, freq: 0.1, wilson: [0.04, 0.21] }], scanned: 50, enriched: true, view: { ...VIEW, enriched: true, generation: 3 } } : undefined));
    await mount(<KeepWorkspaceFull hasClusters />);
    await act(async () => q('meta-locus-keep-full-checkbox')!.click());
    await flush();
    expect(calls.some(c => c.url.endsWith('/refill'))).toBe(true);
    expect(q('meta-locus-cluster-estimate')!.textContent).toContain('10.0%');
    expect(q('meta-locus-keep-full-enriched')).not.toBeNull();
  });
});

describe('the read inspector and menu', () => {
  it('shows a read\'s site, its real place and the shared flag; Open this site goes there', () => {
    const meta = { site: 3, site_name: 'geneA', chrom: 'chr2', window: [100, 20100] as [number, number], strand: '-' as const, shared: true,
      real: { chrom: 'chr2', reference_start: 5000, reference_end: 15000 } };
    const lines = metaReadLines(meta);
    expect(lines[0]).toBe('Site: geneA · chr2:100-20,100 (-)');
    expect(lines[1]).toContain('chr2:5,000-15,000');
    expect(lines[1]).toContain('flipped');
    expect(lines[2]).toMatch(/^Shared with other sites/);
    useBrowserStore.setState({ chrom: CHROM, start: 0, end: 20000 });
    expect(openSite(meta)).toBe(true);
    expect(useBrowserStore.getState().chrom).toBe('chr2');
    expect([useBrowserStore.getState().start, useBrowserStore.getState().end]).toEqual([100, 20100]);
  });

  it('adds Open this site and Find more like this to the read menu on the meta contig only', () => {
    registerMetaLocus();
    const ctx = { readId: 'r1', footprint: null, readSelected: false, selectedCount: 3, hasReadFilter: false, excludedCount: 0, readHighlighted: false, anyHighlight: false, isMac: true };
    const labels = () => buildReadMenu(ctx).filter(e => e.kind === 'item').map(e => (e as { label: string }).label);
    useBrowserStore.setState({ chrom: 'chr1' });
    expect(labels().some(l => l.startsWith('Find more like this'))).toBe(false);
    useBrowserStore.setState({ chrom: CHROM });
    expect(labels()).toContain('Open this site');
    expect(labels()).toContain('Find more like this (3 selected)');
  });
});

describe('entering', () => {
  it('remembers the real locus once and keeps it while moving inside the meta-locus', () => {
    useMetaLocusStore.setState({ status: status() });
    enterMetaLocus();
    expect(useBrowserStore.getState().chrom).toBe(CHROM);
    useBrowserStore.getState().setViewport(CHROM, 100, 900);
    enterMetaLocus();
    expect(useMetaLocusStore.getState().lastRealLocus).toEqual({ chrom: 'chr19', start: 1000, end: 5000 });
  });
});
