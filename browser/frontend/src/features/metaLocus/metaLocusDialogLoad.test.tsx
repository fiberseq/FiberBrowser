/**
 * Loading a BED from the Open dialog in a normal browser tab: a file chosen with the file input is sent as its text
 * (a browser gives contents, not a path), a typed server path is sent as a path, and every failure (bad path, a BED
 * with no regions, no dataset) is shown in the dialog, which stays open.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { openMetaLocusDialog, resetMetaLocusForTests, useMetaLocusStore } from './metaLocusStore';
import { MetaLocusDialog } from './MetaLocusDialog';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const POOL = 'p1';
type Call = { url: string; method: string; body: any };
let calls: Call[] = [];
let poolReply: { status: number; body: unknown } = { status: 200, body: {} };
let statusReplies: unknown[] = [];
let probeReply: unknown = { success: true, cached: false };

const ready = (bedPath: string) => ({
  success: true, pool_id: POOL, name: 'sites', status: 'ready', chrom: `meta:${POOL}`, width: 20000, axis_offset: -10000,
  flank_bp: 10000, label: 'sites · centre ± 10 kb', spec: { anchor: 'centre', flank_bp: 10000, bed_path: bedPath }, progress: { fraction: 1 },
});

beforeEach(() => {
  try { localStorage.clear(); } catch { /* none */ }
  statusReplies = [];
  probeReply = { success: true, cached: false };
  calls = [];
  poolReply = { status: 200, body: ready('/data/sites.bed') };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: String(url), method, body });
    const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
    if (String(url).endsWith('/meta_locus/pools') && method === 'POST') return json(poolReply.status, poolReply.body);
    if (String(url).endsWith('/meta_locus/pools/probe')) return json(200, probeReply);
    if (String(url).includes('/meta_locus/pools/') && method === 'GET' && statusReplies.length) return json(200, statusReplies.shift());
    if (String(url).endsWith('/view')) return json(200, { chrom: `meta:${POOL}`, width: 20000, axis_offset: -10000, seed: 1, count: 2000, cursor: {}, pool_observations: {}, pool_total: 0, extra_entries: [], extra_count: 0, enriched: false, generation: 2 });
    return json(200, ready('/data/sites.bed'));
  }));
  useBrowserStore.setState({ chrom: 'chr19', start: 1000, end: 5000, datasets: [{ id: 'd1', label: 'sample', path: '/x.bam', data_type: 'bam', color: '#000' } as never] });
});

const initial = useBrowserStore.getState();
let box: HTMLDivElement;
let root: Root;
afterEach(() => {
  if (root) act(() => root.unmount());
  box?.remove();
  vi.unstubAllGlobals();
  resetMetaLocusForTests();
  useBrowserStore.setState(initial, true);
});

async function mountDialog() {
  openMetaLocusDialog();
  box = document.createElement('div');
  document.body.appendChild(box);
  root = createRoot(box);
  await act(async () => root.render(<MetaLocusDialog />));
}
const q = (id: string) => box.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
function type(id: string, value: string) {
  const el = q(id) as HTMLInputElement;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
const submit = () => act(async () => { q('meta-locus-dialog')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
const errorText = () => q('meta-locus-dialog-error')?.textContent ?? '';
const posts = () => calls.filter(c => c.url.endsWith('/meta_locus/pools') && c.method === 'POST');

describe('loading a BED from the dialog', () => {
  it('a file chosen in the browser is sent as its text; the server\'s saved copy becomes the spec path', async () => {
    poolReply = { status: 200, body: ready('/cache/beds/sites.0123.bed') };
    await mountDialog();
    const input = q('meta-locus-file') as HTMLInputElement;
    const file = new File(['track name=x\nchr1\t100\t200\ta\t0\t+\nchr1\t5000\t5100\tb\t0\t-\n'], 'sites.bed', { type: 'text/plain' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    await vi.waitFor(() => expect(q('meta-locus-upload')?.textContent).toContain('2 regions'));
    await submit();
    await flush();
    expect(posts()).toHaveLength(1);
    expect(posts()[0].body).toMatchObject({ bed_name: 'sites.bed', name: 'sites', bed_path: '' });
    expect(posts()[0].body.bed_text).toContain('chr1\t5000\t5100');
    expect(useMetaLocusStore.getState().dialogOpen).toBe(false);
    expect(useMetaLocusStore.getState().spec?.bed_path).toBe('/cache/beds/sites.0123.bed');
    expect(useMetaLocusStore.getState().spec).not.toHaveProperty('bed_text');
  });

  it('a typed or pasted server path is sent as a path', async () => {
    await mountDialog();
    await act(async () => type('meta-locus-bed', '  /data/sites.bed  '));
    await submit();
    await flush();
    expect(posts()[0].body).toMatchObject({ bed_path: '/data/sites.bed', name: 'sites' });
    expect(posts()[0].body.bed_text).toBeUndefined();
    expect(useMetaLocusStore.getState().dialogOpen).toBe(false);
  });

  it('a bad path is answered in the dialog, which stays open', async () => {
    poolReply = { status: 404, body: { detail: 'No BED file at /nope.bed' } };
    await mountDialog();
    await act(async () => type('meta-locus-bed', '/nope.bed'));
    await submit();
    await flush();
    expect(useMetaLocusStore.getState().dialogOpen).toBe(true);
    expect(errorText()).toBe('No BED file at /nope.bed');
    expect((q('meta-locus-open') as HTMLButtonElement).disabled).toBe(false);
  });

  it('a BED the server cannot parse is answered in the dialog', async () => {
    poolReply = { status: 422, body: { detail: 'The BED has no usable regions (each line needs chrom, start, end with start < end)' } };
    await mountDialog();
    await act(async () => type('meta-locus-bed', '/data/broken.bed'));
    await submit();
    await flush();
    expect(useMetaLocusStore.getState().dialogOpen).toBe(true);
    expect(errorText()).toContain('no usable regions');
  });

  it('no BED, no BAM dataset or no dataset ticked: said in the dialog, nothing sent', async () => {
    await mountDialog();
    await submit();
    expect(errorText()).toContain('Choose a BED file');
    await act(async () => type('meta-locus-bed', '/data/sites.bed'));
    const box1 = box.querySelector<HTMLInputElement>('[data-testid="meta-locus-datasets"] input[type="checkbox"]')!;
    await act(async () => { box1.click(); });
    await submit();
    expect(errorText()).toBe('Choose at least one dataset');
    expect(posts()).toHaveLength(0);
  });

  it('with no BAM dataset loaded the dialog says so', async () => {
    useBrowserStore.setState({ datasets: [] as never });
    await mountDialog();
    await act(async () => type('meta-locus-bed', '/data/sites.bed'));
    await submit();
    expect(errorText()).toContain('Load a BAM dataset first');
    expect(posts()).toHaveLength(0);
  });
});


const building = (fraction: number) => ({ ...ready('/data/sites.bed'), status: 'building', progress: { fraction, sites_done: Math.round(fraction * 4000), sites_total: 4000, eta_s: 9 } });

describe('opening: feedback at once', () => {
  it('on Open the view moves to the meta-locus at once; the strip and the panels say it builds; provisional reads at 25%, the final set when ready', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      poolReply = { status: 200, body: building(0) };
      statusReplies = [building(0.1), building(0.3), ready('/data/sites.bed')];
      await mountDialog();
      await act(async () => type('meta-locus-bed', '/data/sites.bed'));
      await submit();
      await flush();
      expect(useMetaLocusStore.getState().dialogOpen).toBe(false);
      expect(useBrowserStore.getState().chrom).toBe(`meta:${POOL}`);  // at once, while building
      const { MetaLocusProgressStrip, MetaReadsPending } = await import('./MetaLocusBar');
      const strip = document.createElement('div');
      document.body.appendChild(strip);
      const stripRoot = createRoot(strip);
      await act(async () => stripRoot.render(<><MetaLocusProgressStrip /><MetaReadsPending chrom={`meta:${POOL}`} /></>));
      expect(strip.querySelector('[data-testid="meta-locus-progress"]')?.textContent).toContain('Building meta-locus');
      expect(strip.querySelector('[data-testid="meta-reads-pending"]')?.textContent).toContain('First reads appear at ~25%');
      expect(calls.some(c => c.url.endsWith('/view'))).toBe(false);
      await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
      await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
      await vi.waitFor(() => expect(calls.filter(c => c.url.endsWith('/view')).length).toBeGreaterThanOrEqual(1));  // provisional at 30%
      await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
      await vi.waitFor(() => expect(calls.filter(c => c.url.endsWith('/view')).length).toBeGreaterThanOrEqual(2));  // final when ready
      expect(strip.querySelector('[data-testid="meta-reads-pending"]')).toBeNull();
      act(() => stripRoot.unmount());
      strip.remove();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a build that fails reopens the dialog with the error and returns to the real locus', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      poolReply = { status: 200, body: building(0) };
      statusReplies = [{ ...building(0.2), status: 'error', error: 'The pool of d1 has more than 20,000,000 entries (max_entries)' }];
      await mountDialog();
      await act(async () => type('meta-locus-bed', '/data/sites.bed'));
      await submit();
      await flush();
      await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
      await vi.waitFor(() => expect(useMetaLocusStore.getState().dialogOpen).toBe(true));
      expect(useBrowserStore.getState().chrom).toBe('chr19');
      await flush();
      expect(errorText()).toContain('max_entries');
    } finally {
      vi.useRealTimers();
    }
  });

  it('defaults the anchor to Start (TSS) and remembers the last-used settings', async () => {
    await mountDialog();
    expect((q('meta-locus-anchor') as HTMLSelectElement).value).toBe('start');
    await act(async () => { type('meta-locus-bed', '/data/sites.bed'); type('meta-locus-flank', '20000'); type('meta-locus-count', '1200'); });
    await submit();
    await flush();
    act(() => root.unmount());
    box.remove();
    resetMetaLocusForTests();
    await mountDialog();
    expect((q('meta-locus-bed') as HTMLInputElement).value).toBe('/data/sites.bed');
    expect((q('meta-locus-flank') as HTMLInputElement).value).toBe('20000');
    expect((q('meta-locus-count') as HTMLInputElement).value).toBe('1200');
  });

  it('says "cached: opens instantly" when the server has this pool', async () => {
    probeReply = { success: true, cached: true, pool_id: POOL, sites: 4000 };
    await mountDialog();
    await act(async () => type('meta-locus-bed', '/data/sites.bed'));
    await vi.waitFor(() => expect(q('meta-locus-cached')?.textContent).toBe('cached: opens instantly'), { timeout: 2000 });
    const probe = calls.find(c => c.url.endsWith('/probe'))!;
    expect(probe.body).toMatchObject({ bed_path: '/data/sites.bed', anchor: 'start', flank_bp: 10000 });
  });
});

describe('a server that no longer accepts this tab', () => {
  it('a 401 anywhere shows the session-expired banner', async () => {
    const { fetchJson } = await import('../../api/sharedFetch');
    const { SessionExpiredBanner } = await import('../../components/controls/SessionExpiredBanner');
    const { useSessionExpiredStore, SESSION_EXPIRED_TEXT } = await import('../../stores/sessionExpiredStore');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: false, detail: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } })));
    box = document.createElement('div');
    document.body.appendChild(box);
    root = createRoot(box);
    await act(async () => root.render(<SessionExpiredBanner />));
    expect(box.querySelector('[data-testid="session-expired-banner"]')).toBeNull();
    await expect(fetchJson('/api/reads/compact?chrom=chr1&start=0&end=10')).rejects.toThrow();
    await flush();
    expect(box.querySelector('[data-testid="session-expired-banner"]')?.textContent).toContain(SESSION_EXPIRED_TEXT);
    useSessionExpiredStore.setState({ expired: false });
  });
});
