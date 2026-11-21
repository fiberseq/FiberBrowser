import { describe, expect, it } from 'vitest';
import { compactReadStatus, formatReadStatus, readFilterCounts, userReadFilterSet } from './readCounts';
import { DEFAULT_MIN_FOOTPRINTS } from '../../../stores/uiSlice';

describe('readFilterCounts', () => {
  const sampling = { level: 6, fraction: 1 / 64, total: 105_368, kept: 1625,
    total_spanning: 100_000, kept_spanning: 1500, loaded: 1031, loaded_spanning: 1000 };

  it('does not mistake the dense display sample for a filter hiding 99% of reads', () => {
    const counts = readFilterCounts(105_368, 1031, sampling, false);
    expect(counts).toEqual({ total: 1625, hidden: 594, fraction: 594 / 1625, sampled: true });
    expect(counts.fraction).toBeLessThan(0.5);
  });

  it('still warns when filters actually remove most of the sampled cohort', () => {
    const counts = readFilterCounts(105_368, 200, { ...sampling, loaded: 200 }, false);
    expect(counts.hidden).toBe(1425);
    expect(counts.fraction).toBeGreaterThan(0.5);
  });

  it('uses the spanning sample on both sides of the comparison', () => {
    expect(readFilterCounts(100_000, 1000, sampling, true)).toEqual({
      total: 1500, hidden: 500, fraction: 1 / 3, sampled: true,
    });
  });

  it('keeps the full-cohort warning after Load all', () => {
    expect(readFilterCounts(1000, 200, null, false)).toEqual({ total: 1000, hidden: 800, fraction: 0.8, sampled: false });
  });

  it('a full load counts what the filters hide from the alignments in scope before them, as a sampled load does', () => {
    // A full load reports its in-scope total after the read filters (24 of 24); the server's signal counts carry
    // the 4,264 alignments in scope before them.
    const full = readFilterCounts(24, 24, null, false, false, 4264);
    expect(full).toEqual({ total: 4264, hidden: 4240, fraction: 4240 / 4264, sampled: false });
    const sampled = readFilterCounts(4452, 7, { ...sampling, kept: 2212, loaded: 7 }, false);
    expect(full.fraction > 0.5).toBe(sampled.fraction > 0.5);
    // A cohort request still counts nothing as hidden; no signal counts falls back to the in-scope total.
    expect(readFilterCounts(24, 24, null, false, true, 4264).hidden).toBe(0);
    expect(readFilterCounts(24, 24, null, false, false, null).hidden).toBe(0);
    // Never below the in-scope total (signal counts of another scope).
    expect(readFilterCounts(100, 50, null, false, false, 10).total).toBe(100);
  });

  it('uses the working count for older sampling payloads without a loaded count', () => {
    expect(readFilterCounts(105_368, 1031, { ...sampling, loaded: undefined }, false).hidden).toBe(594);
  });

  it('does not infer filtering from an empty cohort or a smaller rendered/clustered subset', () => {
    expect(readFilterCounts(105_368, 0, { ...sampling, kept: 0, loaded: 0 }, false).fraction).toBe(0);
    expect(readFilterCounts(105_368, 100, { ...sampling, loaded: 1625 }, false).hidden).toBe(0);
  });

  it('never counts the reads outside a requested cohort as hidden (a clustered panel: 288 of 4,640 in view)', () => {
    // A cluster cohort is asked for by name (filter_ids): the server counts the whole view in scope.
    expect(readFilterCounts(4640, 288, null, false)).toMatchObject({ hidden: 4352, sampled: false });
    expect(readFilterCounts(4640, 288, null, false, true)).toEqual({ total: 4640, hidden: 0, fraction: 0, sampled: false });
    expect(readFilterCounts(105_368, 200, { ...sampling, loaded: 200 }, false, true).fraction).toBe(0);
  });
});

describe('userReadFilterSet', () => {
  it('counts filters the user set, not the untouched Min footprints default', () => {
    expect(userReadFilterSet(DEFAULT_MIN_FOOTPRINTS, true, 0)).toBe(false);
    expect(userReadFilterSet(DEFAULT_MIN_FOOTPRINTS, false, 0)).toBe(true);
    expect(userReadFilterSet(DEFAULT_MIN_FOOTPRINTS + 3, true, 0)).toBe(true);
    expect(userReadFilterSet(0, false, 0)).toBe(false);
    expect(userReadFilterSet(0, true, 20)).toBe(true);
  });
});

describe('formatReadStatus', () => {
  it('reports loading state', () => {
    expect(formatReadStatus({
      loading: true,
      displayed: 0,
      serverReturned: 0,
      working: 0,
      inScope: 0,
      spanning: 0,
    })).toEqual({ text: 'Loading...', title: 'Loading read data' });
  });

  it('distinguishes client-visible filters from server-returned reads', () => {
    const status = formatReadStatus({
      loading: false,
      displayed: 25,
      serverReturned: 100,
      working: 100,
      inScope: 500,
      spanning: 450,
    });

    expect(status.text).toBe('25 of 100 rows drawn');
    expect(status.title).toContain('Rows drawn: 25 reads');
    expect(status.title).toContain('Browser sampled/payload: 100 reads');
    expect(status.title).toContain('Viewport total: 500 reads in request scope');
    expect(status.title).toContain('500 overlapping reads');
  });

  it('surfaces overlapping and spanning counts separately for Span mode', () => {
    const status = formatReadStatus({
      loading: false,
      displayed: 0,
      serverReturned: 0,
      working: 0,
      inScope: 0,
      overlapping: 125,
      spanning: 0,
    });

    expect(status.text).toBe('0 spanning / 125 overlapping');
    expect(status.title).toContain('125 overlapping reads');
    expect(status.title).toContain('0 fully spanning reads');
  });

  it('distinguishes render sampling from the backend working set', () => {
    const status = formatReadStatus({
      loading: false,
      displayed: 100,
      serverReturned: 100,
      working: 1_000,
      inScope: 5_000,
      spanning: 4_000,
    });

    expect(status.text).toBe('100 of 1,000 rows drawn');
    expect(status.title).toContain('Eligible total: 1,000 reads after active read filters');
  });

  it('shows both filtering and sampling when both affect the displayed reads', () => {
    const status = formatReadStatus({
      loading: false,
      displayed: 25,
      serverReturned: 100,
      working: 1_000,
      inScope: 5_000,
      spanning: 4_000,
    });

    expect(status.text).toBe('25 of 1,000 rows drawn');
    expect(status.title).toContain('Rows drawn: 25 reads');
    expect(status.title).toContain('Browser sampled/payload: 100 reads');
    expect(status.title).toContain('Eligible total: 1,000 reads after active read filters');
  });

  // Round 3, R10: one shape in every header (split headers mixed "332/697" with "80 reads").
  it('uses the same shape when every read is drawn', () => {
    expect(formatReadStatus({
      loading: false,
      displayed: 42,
      serverReturned: 42,
      working: 42,
      inScope: 42,
      spanning: 42,
    }).text).toBe('42 of 42 rows drawn');
  });

  // Audit L6: the panel header said "1 reads".
  it('says "1 row", not "1 rows"', () => {
    const one = formatReadStatus({ loading: false, displayed: 1, serverReturned: 1, working: 1, inScope: 1, spanning: 1 });
    expect(one.text).toBe('1 of 1 row drawn');
    expect(one.title).toContain('Rows drawn: 1 read;');
    expect(one.title).toContain('1 fully spanning read');
    expect(one.title).not.toMatch(/\b1 [a-z ]*reads\b/);
  });
});

// Audit M14: a narrow header shows the count without its words.
describe('compactReadStatus', () => {
  it('drops the words, keeps the numbers', () => {
    expect(compactReadStatus('586 of 3,170 rows drawn')).toBe('586/3,170');
    expect(compactReadStatus('80 of 80 rows drawn')).toBe('80/80');
    expect(compactReadStatus('586/3,170 visible')).toBe('586/3,170');
    expect(compactReadStatus('42 reads')).toBe('42');
    expect(compactReadStatus('1 read')).toBe('1');
    expect(compactReadStatus('0 spanning / 125 overlapping')).toBe('0/125');
    expect(compactReadStatus('Loading...')).toBe('Loading...');
  });

  it('keeps the count when Min footprints or QC-fail hid reads (the suffix stays in the full text)', () => {
    expect(compactReadStatus('8 of 60 rows drawn · 3 uncalled · 49 with < 5 footprints hidden')).toBe('8/60');
    expect(compactReadStatus('42 reads · 2 QC-fail reads hidden')).toBe('42');
  });
});

describe('formatReadStatus during a first paint', () => {
  it('marks the totals as estimates, and the compact form keeps the mark', () => {
    const status = formatReadStatus({ loading: false, partial: true, displayed: 653, serverReturned: 1000,
      working: 4838, inScope: 4838, overlapping: 4838, spanning: 281 });
    expect(status.text).toBe(`653 of ~${(4838).toLocaleString()} rows drawn`);
    expect(status.title).toContain('estimates');
    expect(compactReadStatus(status.text)).toBe(`653/~${(4838).toLocaleString()}`);
    const settled = formatReadStatus({ loading: false, displayed: 653, serverReturned: 1000, working: 4639,
      inScope: 4639, overlapping: 4639, spanning: 262 });
    expect(settled.text).toBe(`653 of ${(4639).toLocaleString()} rows drawn`);
  });
});
