// The duplicate and QC-fail toggles reach the paths that read BAM records themselves (3.1.0): meta profiles
// (dense loader), autozoom, DAF-C selections and linked reads, lift difference reads. Nothing is added at the
// default (both hidden), so those URLs are unchanged.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../stores/browserStore';
import { readPolicyParams, readPolicyUrl } from './readPolicyParams';
import { autozoom, getMeta, getMetaAll, linkedCompactReadsQueryKey } from '../api/readOperations';
import { getLinkedReadsCompact, getLinkedReadsData, getLinkedReadsImageUrl, selectDafcRegion, sendToLinkedSession } from '../api/dafc';
import { getDifferenceReads } from '../features/liveLift/api';
import { detectRegions } from '../api/regions';
import { queryReads } from '../features/graphPanel/api';
import { getRandomCoveredWindow, getTopCoveredWindows } from '../api/coverage';

function stubFetch(body: unknown = {}) {
  const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(body), {
    status: 200, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const params = (url: unknown) => new URL(String(url), 'http://x').searchParams;

afterEach(() => {
  vi.unstubAllGlobals();
  useBrowserStore.setState({ showDuplicateReads: false, showQcFailReads: false });
});

async function callEveryPath() {
  await getMeta('chr1', 0, 100, 'ds');
  await getMetaAll('chr1', 0, 100);
  await autozoom('chr1', 0, 100, false, ['ds']);
  await selectDafcRegion('chr1', 0, 10, 20, 30);
  await sendToLinkedSession('s1', { chrom: 'chr1', x_start: 0, x_end: 10, y_start: 20, y_end: 30 } as never, []);
  await getLinkedReadsData('s1');
  await getLinkedReadsCompact('s1', 'x', { maxReads: 10, sampleSeed: 'unique-seed-' + Math.random() });
  await getDifferenceReads({ datasetId: 'ds', liftKey: 'k', chrom: 'chr1', end: 2, pos: 1 });
  await detectRegions('ds', { chrom: 'chr1', start: 0, end: 100 });
  await queryReads({ registrationId: 'g', revisions: {}, requestId: 'r', panelId: 'p', generation: 1, datasets: [], paths: [] } as never);
  await getRandomCoveredWindow(400, 1);
  await getTopCoveredWindows(400, 'ds');
}

describe('read policy parameters', () => {
  it('adds nothing at the default and keeps explicit values', () => {
    expect(readPolicyParams(new URLSearchParams('a=1')).toString()).toBe('a=1');
    expect(readPolicyUrl('/api/x')).toBe('/api/x');
    useBrowserStore.setState({ showDuplicateReads: true, showQcFailReads: true });
    expect(readPolicyUrl('/api/x?a=1')).toBe('/api/x?a=1&include_duplicates=true&include_qcfail=true');
    expect(readPolicyParams(new URLSearchParams('include_duplicates=false')).get('include_duplicates')).toBe('false');
  });

  it('every self-reading path sends the toggles', async () => {
    const fetchMock = stubFetch({ reads: [], profiles: {}, rows: [] });
    await callEveryPath();
    const defaults = fetchMock.mock.calls.map(([url]) => params(url));
    expect(defaults.every(p => !p.has('include_duplicates') && !p.has('include_qcfail'))).toBe(true);
    fetchMock.mockClear();
    useBrowserStore.setState({ showDuplicateReads: true, showQcFailReads: true });
    await callEveryPath();
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls).toHaveLength(12);
    for (const url of urls) {
      expect(params(url).get('include_duplicates'), url).toBe('true');
      expect(params(url).get('include_qcfail'), url).toBe('true');
    }
    expect(params(getLinkedReadsImageUrl('s1', 'x')).get('include_qcfail')).toBe('true');
    expect(linkedCompactReadsQueryKey(new URLSearchParams({ session_id: 's1' }))).toContain('include_duplicates=true');
  });
});
