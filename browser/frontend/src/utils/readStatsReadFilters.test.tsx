// Read Stats applies the read track's filters (3.1.0): the request carries the duplicate and QC-fail
// toggles and the footprint-quality gate, and the summary says which filter removed what.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { useBrowserStore } from '../stores/browserStore';
import { fetchReadStats } from '../api/readStats';
import { readStatsFilterParts, readStatsMissingCount, readStatsQualityText } from './readStatsScope';
import { SummaryTab } from '../components/controls/read-stats/SummaryTab';

afterEach(() => {
  vi.unstubAllGlobals();
  useBrowserStore.setState({ showDuplicateReads: false, showQcFailReads: false, minFpQuality: 0 });
});

describe('Read Stats read filters', () => {
  it('sends the duplicate and QC-fail toggles and min_fp_quality', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(
      JSON.stringify({ per_read: [], aggregate: {}, is_bam: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await fetchReadStats('chr1', 0, 100, false, { ds: ['r1'] });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject(
      { include_duplicates: false, include_qcfail: false, min_fp_quality: 0 });
    useBrowserStore.setState({ showDuplicateReads: true, showQcFailReads: true, minFpQuality: 120 });
    await fetchReadStats('chr1', 0, 100, false, { ds: ['r1'] });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject(
      { include_duplicates: true, include_qcfail: true, min_fp_quality: 120 });
  });

  it('counts as not found only the reads the server reports missing, never those a filter hid', () => {
    // Owner, 20 Nov 2026: reads failing Min footprints are not listed; they are hidden (summary), not "not found".
    expect(readStatsMissingCount({})).toBe(0);
    expect(readStatsMissingCount(undefined)).toBe(0);
    expect(readStatsMissingCount({ a: ['r1', 'r2', 'r1'], b: ['r9'] })).toBe(3);
    expect(readStatsFilterParts({ n_hidden_uncalled: 0, min_footprints: 5, n_hidden_min_footprints: 4 }).join(' '))
      .toContain('4');
  });

  it('names each filter and what it hid', () => {
    expect(readStatsFilterParts({ n_hidden_duplicate: 12, n_hidden_qcfail: 3, n_hidden_uncalled: 1200,
      min_footprints: 5, n_hidden_min_footprints: 40, n_hidden_quality: 2 })).toEqual([
      'Duplicates: 12 hidden', 'QC-fail: 3 hidden', 'Min footprints: 1,200 uncalled · 40 with < 5 footprints hidden',
      'Quality filters: 2 reads with no calls left hidden']);
    expect(readStatsFilterParts({})).toEqual([]);
    expect(readStatsQualityText({ min_fp_quality: 50, quality_filters: [
      { layer: 'nuc', quality_name: 'nq', min_value: 100, label: 'nq ≥ 100 (nuc)', calls: 40, removed: 12 }] }))
      .toBe('nq ≥ 100 (nuc): 12 of 40 calls removed · footprint quality ≥ 50');
    expect(readStatsQualityText({ quality_filters: [] })).toBe('');
  });

  it('the summary shows the hidden reads by filter and the quality gates', () => {
    const html = renderToStaticMarkup(<SummaryTab aggregate={{ n_reads: 2, n_datasets: 1, strand_counts: {}, n_hidden_duplicate: 4,
      quality_filters: [{ layer: 'nuc', quality_name: 'nq', min_value: 100, label: 'nq ≥ 100 (nuc)', calls: 10, removed: 3 }] }}
      isBam perRead={[]} chrom="chr1" containerWidth={400} />);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.querySelector('[data-testid="read-stats-hidden"]')?.textContent).toBe('Duplicates: 4 hidden');
    expect(doc.querySelector('[data-testid="read-stats-quality"]')?.textContent).toBe('Quality filters applied: nq ≥ 100 (nuc): 3 of 10 calls removed');
  });
});
