import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readPolicyHiddenText, signalFilterParams, signalFilterUrl, type SignalCounts } from './signalFilters';
import { useBrowserStore } from '../stores/browserStore';
import { DEFAULT_MIN_FOOTPRINTS, MIN_FOOTPRINTS_ALL_READS } from '../stores/uiSlice';
import { getCoverage } from '../api/coverage';
import { fetchReadStats } from '../api/readStats';
import { readStatsHiddenText } from './readStatsScope';
import { fetchFootprintSizes } from '../api/clustering';
import { readsKeptByFilters } from './datasetReadsLocus';
import { coverageRequestKey } from '../components/tracks/read-track/useReadTrackData';

const counts: SignalCounts = { total: 10, kept: 10, hidden: 0, background: 0, detectable: 0, unclassified: 0,
  unscored: 0, unknown: 10, structure_scored: 0 };

function stubFetch(body: unknown = {}) {
  const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(body), {
    status: 200, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const urlOf = (call: unknown[]) => new URL(String(call[0]), 'http://localhost');

describe('Min footprints and uncalled reads: requests and counts', () => {
  beforeEach(() => { useBrowserStore.getState().setMinFootprints(DEFAULT_MIN_FOOTPRINTS); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); useBrowserStore.getState().setMinFootprints(DEFAULT_MIN_FOOTPRINTS); });

  it('says how many reads Min footprints hid, by reason', () => {
    expect(readPolicyHiddenText({ ...counts, uncalled: 312, uncalled_hidden: 312, min_footprints: 5, min_footprints_hidden: 40 }))
      .toBe('312 uncalled · 40 with < 5 footprints hidden');
    expect(readPolicyHiddenText({ ...counts, uncalled: 312, uncalled_hidden: 312, min_footprints: 0, min_footprints_hidden: 0 }))
      .toBe('312 uncalled hidden');
    expect(readPolicyHiddenText({ ...counts, qcfail_hidden: 2, uncalled_hidden: 0, min_footprints: 5, min_footprints_hidden: 4 }))
      .toBe('2 QC-fail reads hidden · 4 with < 5 footprints hidden');
    expect(readPolicyHiddenText({ ...counts, uncalled: 5, uncalled_hidden: 0 })).toBe('');
  });

  it('read stats say which reads Min footprints hid, the same way', () => {
    expect(readStatsHiddenText({ n_hidden_uncalled: 312, min_footprints: 5, n_hidden_min_footprints: 40 }))
      .toBe('312 uncalled · 40 with < 5 footprints hidden');
    expect(readStatsHiddenText({ n_hidden_uncalled: 0, min_footprints: 0, n_hidden_min_footprints: 0 })).toBe('');
  });

  it('every API request says when Min footprints shows uncalled reads (the server hides them by default)', () => {
    expect(signalFilterUrl('/api/cluster/vplot?chrom=chr1')).toBe('/api/cluster/vplot?chrom=chr1');
    useBrowserStore.setState({ minFootprints: 0 });
    expect(signalFilterUrl('/api/cluster/vplot?chrom=chr1')).toBe('/api/cluster/vplot?chrom=chr1');
    expect(signalFilterParams(new URLSearchParams('a=1')).has('hide_uncalled')).toBe(false);
    useBrowserStore.getState().setMinFootprints(MIN_FOOTPRINTS_ALL_READS);
    expect(new URL(signalFilterUrl('/api/scan_peaks?chrom=chr1'), 'http://x').searchParams.get('hide_uncalled')).toBe('false');
    expect(new URL(signalFilterUrl('/api/reads/stats'), 'http://x').searchParams.get('hide_uncalled')).toBe('false');
    expect(signalFilterParams(new URLSearchParams('a=1')).get('hide_uncalled')).toBe('false');
    // An explicit value is kept.
    expect(signalFilterUrl('/api/coverage?hide_uncalled=true')).toBe('/api/coverage?hide_uncalled=true');
    expect(signalFilterUrl('https://example.org/x')).toBe('https://example.org/x');
  });

  it('coverage requests and their keys carry the setting', async () => {
    expect(coverageRequestKey('ds', 'chr1', 0, 100, 10, false, false, true))
      .not.toBe(coverageRequestKey('ds', 'chr1', 0, 100, 10, false, false, false));
    expect(coverageRequestKey('ds', 'chr1', 0, 100, 10)).toBe(coverageRequestKey('ds', 'chr1', 0, 100, 10, false, false, true));
    const fetchMock = stubFetch({ coverage: [], max: 0 });
    await getCoverage('chr1', 0, 1000, 10, 'ds');
    await getCoverage('chr1', 0, 1000, 10, 'ds', undefined, false, false, false);
    expect(urlOf(fetchMock.mock.calls[0]).searchParams.get('hide_uncalled')).toBe('true');
    expect(urlOf(fetchMock.mock.calls[1]).searchParams.get('hide_uncalled')).toBe('false');
  });

  it('read stats send the read filters', async () => {
    const fetchMock = stubFetch({ per_read: [], aggregate: {}, is_bam: true });
    useBrowserStore.setState({ minFootprints: 5 });
    await fetchReadStats('chr1', 0, 100, false, { ds: ['r1'] });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ hide_uncalled: true, min_footprints: 5 });
    useBrowserStore.setState({ minFootprints: 0 });
    await fetchReadStats('chr1', 0, 100, false, { ds: ['r1'] });
    // 0 is every called read: uncalled reads stay hidden.
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({ hide_uncalled: true, min_footprints: 0 });
    useBrowserStore.getState().setMinFootprints(MIN_FOOTPRINTS_ALL_READS);
    await fetchReadStats('chr1', 0, 100, false, { ds: ['r1'] });
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toMatchObject({ hide_uncalled: false, min_footprints: 0 });
  });

  it('footprint sizes and the reads-locus probe send the setting', async () => {
    const fetchMock = stubFetch({ success: true, data: {}, total_overlapping: 3 });
    const options = { sizeBin: 10, posBin: 10, sizeMin: 10, sizeMax: 300, mode: 'midpoint' as const,
      normalization: 'raw' as const, sigmaSizeBp: 0, sigmaPosBp: 0, minFootprints: 20, groupBy: 'all' as const };
    await fetchFootprintSizes('chr1', 0, 1000, options);
    await fetchFootprintSizes('chr1', 0, 1000, { ...options, hideUncalled: false });
    expect(urlOf(fetchMock.mock.calls[0]).searchParams.get('hide_uncalled')).toBe('true');
    expect(urlOf(fetchMock.mock.calls[1]).searchParams.get('hide_uncalled')).toBe('false');
    useBrowserStore.getState().setMinFootprints(MIN_FOOTPRINTS_ALL_READS);
    await readsKeptByFilters({ chrom: 'chr1', start: 0, end: 1000 }, 'ds');
    const probe = fetchMock.mock.calls.map(urlOf).find(url => url.pathname === '/api/reads/compact')!;
    expect(probe.searchParams.get('hide_uncalled')).toBe('false');
  });
});
