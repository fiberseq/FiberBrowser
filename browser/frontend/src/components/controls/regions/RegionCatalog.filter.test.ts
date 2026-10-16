import { afterEach, describe, expect, it, vi } from 'vitest';
import { catalogRows } from './RegionCatalog';
import type { RegionCatalog, RegionEntry } from '../../../types/regions';

function catalog(n: number): RegionCatalog {
  const entries: RegionEntry[] = Array.from({ length: n }, (_, i) => ({
    id: `e${i}`, chrom: i % 2 ? 'chr2R' : 'chr3L', start: 1_000_000 + i * 1_000, end: 1_000_500 + i * 1_000,
    label: `region ${i}`, category: 'bed', source: 'bed',
  }));
  return { version: 1, genome: 'dm6', categories: [{ id: 'bed', name: 'Imported', source: 'bed' }], entries };
}

const entryIds = (rows: ReturnType<typeof catalogRows>) =>
  rows.flatMap(row => (row.type === 'entry' ? [row.entry.id] : []));

describe('Regions filter', () => {
  afterEach(() => vi.restoreAllMocks());

  it('matches coordinates typed with or without thousands separators', () => {
    const cat = catalog(5);
    for (const q of ['chr2R:1001000', 'chr2r:1,001,000', '1,001,000-1,001,500', '1001000']) {
      expect(entryIds(catalogRows(cat, {}, q))).toEqual(['e1']);
    }
    expect(entryIds(catalogRows(cat, {}, 'region 3'))).toEqual(['e3']);
  });

  it('does not format numbers per entry while filtering (50,000 entries: ~600 ms per keystroke)', () => {
    const cat = catalog(2_000);
    const toLocale = vi.spyOn(Number.prototype, 'toLocaleString');
    catalogRows(cat, {}, 'chr2r:1,5');
    expect(toLocale).not.toHaveBeenCalled();
  });
});
