/**
 * Meta-locus gap fixes: real coordinates in exports, the meta-locus in the address (reload restores it; a BED gone or
 * changed gets a notice), navigation history (Back from an opened site restores the same working set), the contig's
 * ends, the find-more chip, and the window-search tools left out on the meta contig.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import {
  metaBedComment, metaUrlState, resetMetaLocusForTests, restoreMetaLocusFromUrl, useMetaLocusStore,
} from './metaLocusStore';
import { clampMetaSpan, metaExportValues, metaRealSpan, setMetaContigWidth } from './metaChrom';
import { parseMetaUrl, withMetaUrlParams } from './metaUrl';
import { FindMoreChip, MetaLocusProgressStrip } from './MetaLocusBar';
import { openSite, registerMetaLocus } from './register';
import { formatWorkingSetReadsTsv } from '../../utils/analysisExport';
import { ZoomControls } from '../../components/controls/ZoomControls';
import { NavigationSettings } from '../../components/controls/sidebar/view/NavigationSettings';
import { APP_COMMAND_INFO } from '../../utils/appCommands';
import type { MetaLocusStatus, MetaLocusView } from './api';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const POOL = 'gap1';
const CHROM = `meta:${POOL}`;
const VIEW: MetaLocusView = {
  chrom: CHROM, width: 2000, axis_offset: -1000, seed: 3, count: 500, cursor: { d1: 500 }, pool_observations: { d1: 9000 },
  pool_total: 9000, extra_entries: [['d1', 'r9', 4]], extra_count: 1, enriched: true, generation: 7,
};
const status = (s: Partial<MetaLocusStatus> = {}): MetaLocusStatus => ({
  success: true, pool_id: POOL, name: 'sites', status: 'ready', chrom: CHROM, width: 2000, axis_offset: -1000, flank_bp: 1000,
  label: 'sites · centre ± 1 kb', spec: { anchor: 'centre', flank_bp: 1000, regions_sha256: 'aaa' }, progress: { fraction: 1 }, ...s,
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
    const json = url.endsWith('/view') ? { ...VIEW, ...(body ?? {}), generation: 10 + calls.length } : status();
    return new Response(JSON.stringify(json), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
  useBrowserStore.setState({ chrom: 'chr19', start: 1000, end: 5000, viewportHistory: [], historyIndex: -1,
    datasets: [{ id: 'd1', label: 'sample', path: '/x.bam', data_type: 'bam', color: '#000' } as never] });
});

const initial = useBrowserStore.getState();
afterEach(() => {
  vi.unstubAllGlobals();
  resetMetaLocusForTests();
  useBrowserStore.setState(initial, true);
  unmount();
});

let box: HTMLDivElement | undefined;
let root: Root | undefined;
async function mount(node: React.ReactNode) {
  box = document.createElement('div');
  document.body.appendChild(box);
  root = createRoot(box);
  await act(async () => root!.render(node));
}
function unmount() {
  if (root) act(() => root!.unmount());
  box?.remove();
  root = undefined;
  box = undefined;
}
const q = (id: string) => box!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

describe('exports name the real locus of meta-locus reads', () => {
  const plus = { chrom: 'chr2', window: [1000, 3000] as [number, number], strand: '+' as const, site: 4, site_name: 'p4' };
  const minus = { ...plus, strand: '-' as const, site: 5, site_name: 'p5' };

  it('maps virtual spans to the site window, mirrored on minus-strand sites', () => {
    expect(metaRealSpan(plus, 10, 20)).toEqual([1010, 1020]);
    expect(metaRealSpan(minus, 10, 20)).toEqual([2980, 2990]);
    expect(metaExportValues(minus, 0, 2000)).toEqual(['chr2', 1000, 3000, '-', 5, 'p5']);
    expect(metaExportValues(undefined, 0, 1)).toEqual(['', '', '', '', '', '']);
  });

  it('the working-set TSV adds real columns next to the virtual ones (only for meta-locus reads)', () => {
    const tsv = formatWorkingSetReadsTsv({ chrom: CHROM, regionStart: 100, datasets: {
      d1: { reads: [{ id: 'r1', intervals: [[0, 50, 147]], meta: plus }, { id: 'r2', intervals: [[10, 20, 15]], meta: minus }] },
    } });
    const [header, a, b] = tsv.trim().split('\n').map(l => l.split('\t'));
    expect(header.slice(-6)).toEqual(['real_chrom', 'real_start', 'real_end', 'site_strand', 'site', 'site_name']);
    expect(a.slice(7, 9)).toEqual(['100', '150']);  // virtual (the meta contig)
    expect(a.slice(-6)).toEqual(['chr2', '1100', '1150', '+', '4', 'p4']);
    expect(b.slice(-6)).toEqual(['chr2', '2880', '2890', '-', '5', 'p5']);
    const plain = formatWorkingSetReadsTsv({ chrom: 'chr2', regionStart: 0, datasets: { d1: { reads: [{ id: 'r', intervals: [[0, 5, 5]] }] } } });
    expect(plain.split('\n')[0].split('\t').at(-1)).toBe('chrom');
  });

  it('BED exports on the meta contig say what the contig is', () => {
    useMetaLocusStore.setState({ status: status(), spec: { bed_path: '/data/sites.bed', anchor: 'centre', flank_bp: 1000 } });
    expect(metaBedComment(CHROM)).toMatch(/^# meta-locus sites · centre ± 1 kb: meta:gap1 is a virtual contig \[0, 2000\); x - 1000 .*\/data\/sites\.bed\n$/);
    expect(metaBedComment('chr2')).toBe('');
  });
});

describe('the meta-locus in the address', () => {
  const saved = { spec: { bed_path: '/data/sites.bed', anchor: 'start' as const, flank_bp: 1000, dataset_ids: ['d1'] }, sha: 'aaa', seed: 3, count: 500,
    back: { chrom: 'chr2', start: 10, end: 90 } };

  it('round-trips through the query string and leaves other keys alone', () => {
    const params = withMetaUrlParams(new URLSearchParams('chr=meta:x&start=0&end=9&shared=1'), saved);
    expect(parseMetaUrl(params)).toEqual(saved);
    expect(params.get('shared')).toBe('1');
    const cleared = withMetaUrlParams(params, null);
    expect(parseMetaUrl(cleared)).toBeNull();
    expect(cleared.get('chr')).toBe('meta:x');
  });

  it('carries the open pool spec, its BED hash, seed and size', () => {
    useMetaLocusStore.setState({ status: status(), spec: saved.spec, seed: 3, count: 500, lastRealLocus: saved.back });
    expect(metaUrlState()).toEqual(saved);
  });

  it('a reload restores the meta-locus at the link\'s span', async () => {
    const ok = await restoreMetaLocusFromUrl(saved, { start: 200, end: 1200 });
    expect(ok).toBe(true);
    const s = useBrowserStore.getState();
    expect([s.chrom, s.start, s.end]).toEqual([CHROM, 200, 1200]);
    expect(calls.find(c => c.url.endsWith('/view'))!.body).toMatchObject({ seed: 3, count: 500 });
    expect(useMetaLocusStore.getState().lastRealLocus).toEqual(saved.back);
  });

  it('a BED that is gone gets a small notice and the link\'s real locus', async () => {
    replies.push(({ url, method }) => (url.endsWith('/meta_locus/pools') && method === 'POST'
      ? new Response(JSON.stringify({ detail: 'No BED file at /data/sites.bed' }), { status: 404, headers: { 'Content-Type': 'application/json' } }) : undefined));
    expect(await restoreMetaLocusFromUrl(saved, null)).toBe(false);
    expect(useMetaLocusStore.getState().notice).toMatch(/BED of this link is gone \(\/data\/sites\.bed\)/);
    const s = useBrowserStore.getState();
    expect([s.chrom, s.start, s.end]).toEqual(['chr2', 10, 90]);
    await mount(<MetaLocusProgressStrip />);
    expect(q('meta-locus-notice')!.textContent).toContain('gone');
    await act(async () => q('meta-locus-notice-dismiss')!.click());
    expect(useMetaLocusStore.getState().notice).toBeNull();
  });

  it('a BED whose content changed gets a notice too', async () => {
    replies.push(({ url }) => (url.endsWith('/meta_locus/pools') ? status({ spec: { anchor: 'start', flank_bp: 1000, regions_sha256: 'bbb' } }) : undefined));
    expect(await restoreMetaLocusFromUrl(saved, null)).toBe(false);
    expect(useMetaLocusStore.getState().notice).toMatch(/changed since this link was made/);
    expect(useBrowserStore.getState().chrom).toBe('chr2');
  });
});

describe('navigation history', () => {
  it('Open this site pushes the meta-locus; Back restores the same pool, seed, size and added reads', async () => {
    registerMetaLocus();
    useMetaLocusStore.setState({ status: status(), view: VIEW, seed: 3, count: 500, spec: { bed_path: '/b.bed', anchor: 'centre', flank_bp: 1000 } });
    useBrowserStore.getState().setViewport(CHROM, 0, 2000);
    expect(openSite({ chrom: 'chr2', window: [1000, 3000] })).toBe(true);
    expect(useBrowserStore.getState().chrom).toBe('chr2');
    const entry = useBrowserStore.getState().viewportHistory.at(-1)!;
    expect(entry).toMatchObject({ chrom: CHROM, start: 0, end: 2000, meta: { kind: 'meta-locus', pool_id: POOL, seed: 3, count: 500, extra_entries: [['d1', 'r9', 4]] } });
    // Meanwhile the working set changed (e.g. another tab): Back puts the history's one back.
    useMetaLocusStore.setState({ seed: 8, count: 900 });
    await act(async () => { useBrowserStore.getState().goBack(); await Promise.resolve(); });
    expect(useBrowserStore.getState().chrom).toBe(CHROM);
    // "Back to real locus" keeps its meaning: the last real locus the view was on (the site just visited).
    expect(useMetaLocusStore.getState().lastRealLocus).toEqual({ chrom: 'chr2', start: 1000, end: 3000 });
    await vi.waitFor(() => expect(calls.some(c => c.url.endsWith('/view') && c.body?.seed === 3 && c.body?.count === 500)).toBe(true));
    expect(calls.filter(c => c.url.endsWith('/view')).at(-1)!.body.extra_entries).toEqual([['d1', 'r9', 4]]);
  });
});

describe('the meta contig has ends', () => {
  it('pans and zooms stop at 0 and the width', () => {
    setMetaContigWidth(CHROM, 2000);
    expect(clampMetaSpan(CHROM, -300, 700)).toEqual([0, 1000]);
    expect(clampMetaSpan(CHROM, 1500, 2600)).toEqual([900, 2000]);
    expect(clampMetaSpan(CHROM, -50, 9000)).toEqual([0, 2000]);
    expect(clampMetaSpan('chr2', -50, 9000)).toEqual([-50, 9000]);
    const s = useBrowserStore.getState();
    s.setViewport(CHROM, 1800, 2400);
    expect([useBrowserStore.getState().start, useBrowserStore.getState().end]).toEqual([1400, 2000]);
    useBrowserStore.getState().panRight();
    expect(useBrowserStore.getState().end).toBe(2000);
  });
});

describe('the find-more chip', () => {
  it('is one short chip; its popover has the honest frequency, what enriched means, and Clear', async () => {
    await mount(<FindMoreChip summary={{ found: 12, scanned: 900, freq: 12 / 900, wilson: [0.0076, 0.0232] }} enriched />);
    expect(q('meta-locus-enriched')!.textContent).toBe('enriched · 1.3%');
    expect(q('meta-locus-find-more-popover')).toBeNull();
    await act(async () => q('meta-locus-enriched')!.click());
    expect(q('meta-locus-find-more')!.textContent).toBe('found 12 of 900 read-site observations scanned · freq 1.3% (Wilson 95% 0.76%–2.3%)');
    expect(q('meta-locus-enriched-text')).not.toBeNull();
    expect(q('meta-locus-clear-extra')).not.toBeNull();
  });
});

describe('window searches are not offered on the meta contig', () => {
  it('best-covered window, autozoom (button and command) are left out quietly', async () => {
    useBrowserStore.setState({ chrom: CHROM, start: 0, end: 2000 });
    await mount(<><ZoomControls /><NavigationSettings onAutozoom={() => {}} /></>);
    expect(q('random-window-button')).toBeNull();
    expect(box!.textContent).not.toContain('Autozoom\n');
    expect([...box!.querySelectorAll('button')].some(b => b.textContent?.trim() === 'Autozoom')).toBe(false);
    expect(APP_COMMAND_INFO.autozoom?.available?.()).toBe(false);
    unmount();
    useBrowserStore.setState({ chrom: 'chr2', start: 0, end: 2000 });
    await mount(<ZoomControls />);
    expect(q('random-window-button')).not.toBeNull();
    expect(APP_COMMAND_INFO.autozoom?.available?.()).toBe(true);
  });
});
