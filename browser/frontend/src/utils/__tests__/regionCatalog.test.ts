import { describe, expect, it } from 'vitest';
import { parseRegionBed, regionsToBed } from '../regionBed';
import {
  addCategory, addEntries, emptyCatalog, entriesOf, importBedRegions, mergeCatalogs, moveCategory, moveEntries,
  namesFromBed, normalizeCatalog, orderedCategories, removeCategory, updateEntry,
} from '../regionCatalog';
import { registerSearchProvider, searchProvidersNow } from '../search/providers';
import { textMatchScore as matchScore } from '../search/textMatch';
import { searchRegionCatalog } from '../search/regionProvider';

const entry = (chrom: string, start: number, end: number, label: string) => ({ chrom, start, end, label, source: 'saved' as const });

describe('region catalog (Regions panel)', () => {
  it('keeps categories, subheadings and order; moves regions between categories', () => {
    let c = emptyCatalog('dm6');
    const a = addCategory(c, { name: 'Enhancers' }); c = a.catalog;
    const b = addCategory(c, { name: 'Stripe 2', parent: a.id }); c = b.catalog;
    const x = addCategory(c, { name: 'Promoters' }); c = x.catalog;
    // A subheading of a subheading is not allowed (one level).
    const deep = addCategory(c, { name: 'Too deep', parent: b.id }); c = deep.catalog;
    expect(c.categories.find(cat => cat.id === deep.id)?.parent).toBeUndefined();
    expect(orderedCategories(c).map(o => o.path)).toEqual(['Enhancers', 'Enhancers / Stripe 2', 'Promoters', 'Too deep']);

    const added = addEntries(c, a.id, [entry('chr2R', 100, 200, 'one'), entry('chr2R', 300, 400, 'two'), entry('chr2R', 500, 600, 'three')]);
    c = added.catalog;
    const [one, two, three] = added.ids;
    c = addEntries(c, b.id, [entry('chr2R', 700, 800, 'four')]).catalog;
    expect(entriesOf(c, a.id).map(e => e.label)).toEqual(['one', 'two', 'three']);
    expect(entriesOf(c, a.id, true).map(e => e.label)).toEqual(['one', 'two', 'three', 'four']);

    // Reorder within a category, and move two to another (dragged together).
    c = moveEntries(c, [three], a.id, one);
    expect(entriesOf(c, a.id).map(e => e.label)).toEqual(['three', 'one', 'two']);
    c = moveEntries(c, [one, two], x.id);
    expect(entriesOf(c, x.id).map(e => e.label)).toEqual(['one', 'two']);
    expect(entriesOf(c, a.id).map(e => e.label)).toEqual(['three']);

    // Edit a label and coordinates; an empty label keeps the old one.
    c = updateEntry(c, one, { label: '  eve stripe 2 ', start: 150, end: 260 });
    c = updateEntry(c, two, { label: '   ' });
    expect(c.entries.find(e => e.id === one)).toMatchObject({ label: 'eve stripe 2', start: 150, end: 260 });
    expect(c.entries.find(e => e.id === two)?.label).toBe('two');

    // Move a category under another; removing a category takes its subheadings and regions.
    c = moveCategory(c, x.id, null, a.id);
    expect(orderedCategories(c).map(o => o.path)).toEqual(['Enhancers', 'Enhancers / Stripe 2', 'Enhancers / Promoters', 'Too deep']);
    c = removeCategory(c, a.id);
    expect(c.categories.map(cat => cat.name)).toEqual(['Too deep']);
    expect(c.entries).toEqual([]);
  });

  it('BED export and import round-trip the categories, labels, scores and strands', () => {
    let c = emptyCatalog('dm6');
    const a = addCategory(c, { name: 'Enhancers' }); c = a.catalog;
    const b = addCategory(c, { name: 'Stripe 2', parent: a.id }); c = b.catalog;
    c = addEntries(c, a.id, [{ ...entry('chr2R', 100, 200, 'eve "MSE"'), score: 12.4, strand: '+' }, { ...entry('chr2R', 500, 600, 'enhancer | promoter'), score: 7 }]).catalog;
    c = addEntries(c, b.id, [entry('chr2R', 300, 400, 'tab\there')]).catalog;
    const bed = regionsToBed(c);
    expect(bed).toContain('track name="Enhancers"\nchr2R\t100\t200\teve "MSE"\t12.4\t+\nchr2R\t500\t600\tenhancer | promoter\t7\t.');
    expect(bed).toContain('track name="Enhancers / Stripe 2"\nchr2R\t300\t400\ttab here\t0\t.');

    const parsed = parseRegionBed(bed);
    expect(parsed.skipped).toBe(0);
    const back = importBedRegions(emptyCatalog('dm6'), parsed.regions, 'file');
    expect(orderedCategories(back.catalog).map(o => o.path)).toEqual(['Enhancers', 'Enhancers / Stripe 2']);
    // A label with a pipe stays a label under its track line; a fractional score comes back.
    expect(back.catalog.entries.map(e => [e.label, e.start, e.end, e.score, e.strand])).toEqual([
      ['eve "MSE"', 100, 200, 12.4, '+'],
      ['enhancer | promoter', 500, 600, 7, undefined],
      // No score is written as 0 (BED wants a number) and read back as 0.
      ['tab here', 300, 400, 0, undefined],
    ]);
  });

  it('reads BED made elsewhere: no track lines, "Category | label" names, bad lines counted', () => {
    const text = [
      '# a comment', 'browser position chr1:1-100',
      'chr1\t10\t20',
      'chr1\t30\t40\tPromoters | GAPDH\t500\t-',
      'chr1\t50\t60\tplain',
      'chr1\tx\t60\tbad',
      'chr1\t70\t60\tbackwards',
    ].join('\n');
    const parsed = parseRegionBed(text);
    expect(parsed.skipped).toBe(2);
    expect(parsed.problems).toHaveLength(2);
    const { catalog, imported } = importBedRegions(emptyCatalog('hg38'), parsed.regions, 'my_peaks');
    expect(imported).toBe(3);
    expect(orderedCategories(catalog).map(o => o.path)).toEqual(['my_peaks', 'Promoters']);
    // Grouped by category, file order within each.
    expect(catalog.entries.map(e => e.label)).toEqual(['chr1:10-20', 'plain', 'GAPDH']);
    // Space-separated BED works too.
    expect(parseRegionBed('chr1 5 9 x').regions[0]).toMatchObject({ chrom: 'chr1', start: 5, end: 9, label: 'x' });
  });

  it('merges a session or migration into the saved catalog without losing either', () => {
    let saved = emptyCatalog('dm6');
    const a = addCategory(saved, { id: 'c1', name: 'Saved' }); saved = addEntries(a.catalog, 'c1', [{ ...entry('chr2L', 1, 9, 'old'), id: 'e1' }]).catalog;
    let session = emptyCatalog('dm6');
    session = addCategory(session, { id: 'c1', name: 'Saved' }).catalog;
    session = addEntries(session, 'c1', [{ ...entry('chr2L', 1, 9, 'renamed'), id: 'e1' }, { ...entry('chr2L', 20, 30, 'new'), id: 'e2' }]).catalog;
    const merged = mergeCatalogs(saved, session);
    expect(merged.entries.map(e => e.label)).toEqual(['renamed', 'new']);
    // Adding the same id again (a migration run twice) adds nothing.
    expect(addEntries(merged, 'c1', [{ ...entry('chr2L', 1, 9, 'again'), id: 'e1' }]).ids).toEqual([]);
    // A region without its category gets one.
    const fixed = normalizeCatalog({ categories: [], entries: [{ id: 'z', chrom: 'chr1', start: 1, end: 5, label: 'orphan', category: 'gone' }] }, 'dm6');
    expect(fixed.categories.map(cat => cat.name)).toEqual(['Uncategorized']);
    expect(fixed.entries[0].category).toBe(fixed.categories[0].id);
  });
});

describe('amplicon names from a BED file', () => {
  it('each amplicon takes the name of the BED region overlapping it most (at least half of either)', () => {
    const amplicons = [
      { id: 'a', chrom: 'chr2L', start: 1_000, end: 1_650, label: 'CG9500', category: 'c', source: 'auto' as const },
      { id: 'b', chrom: 'chr2L', start: 9_000, end: 12_000, label: 'numb', category: 'c', source: 'auto' as const },
      { id: 'c', chrom: 'chr2L', start: 20_000, end: 21_000, label: 'near Gdi', category: 'c', source: 'auto' as const },
    ];
    const bed = parseRegionBed([
      'chr2L\t990\t1660\tamp_1',            // a: the same amplicon
      'chr2L\t8000\t9100\tbarely',          // b: 100 bp of 3 kb, and of 1.1 kb: neither half
      'chr2L\t9500\t11000\tnumb_enh',       // b: all of this BED region
      'chr2L\t9050\t9300\tsmaller',         // b: also all of it, but less overlap
      'chr3R\t20000\t21000\tother_chrom',   // c: another chromosome
    ].join('\n')).regions;
    expect([...namesFromBed(amplicons, bed)]).toEqual([['a', 'amp_1'], ['b', 'numb_enh']]);
  });
});

describe('region search (locus boxes, command palette)', () => {
  it('ranks exact, prefix, word and fuzzy matches', () => {
    expect(matchScore('eve', 'eve')).toBe(100);
    expect(matchScore('even-skipped', 'eve')).toBe(80);
    expect(matchScore('near eve (1.2 kb)', 'eve')).toBe(60);
    expect(matchScore('sleeve', 'eve')).toBe(40);
    expect(matchScore('enhancer region', 'ehr')).toBeGreaterThan(0);
    expect(matchScore('abc', 'xyz')).toBe(0);
  });

  it('offers regions by label, gene and category; hides a closed dataset’s amplicons; recent first', () => {
    let c = emptyCatalog('dm6');
    const saved = addCategory(c, { name: 'Enhancers' }); c = saved.catalog;
    const auto = addCategory(c, { name: 'Amplicons · flyamp', source: 'auto', fingerprint: 'fp1' }); c = auto.catalog;
    const e1 = addEntries(c, saved.id, [entry('chr2R', 100, 200, 'eve stripe 2'), entry('chr2R', 300, 400, 'eve late')]); c = e1.catalog;
    c = addEntries(c, auto.id, [{ ...entry('chr2L', 1000, 1650, 'my amplicon'), gene: 'ftz', autoLabel: 'ftz', source: 'auto' }]).catalog;

    const open = searchRegionCatalog(c, 'ftz', { fingerprints: { flyamp: 'fp1' } });
    expect(open.map(s => [s.kind, s.label])).toEqual([['region', 'my amplicon']]);
    expect(searchRegionCatalog(c, 'ftz', { fingerprints: {} })).toEqual([]);

    const ranked = searchRegionCatalog(c, 'eve', { recent: [e1.ids[1]] });
    expect(ranked.slice(0, 2).map(s => s.label)).toEqual(['eve late', 'eve stripe 2']);
    expect(ranked[0].detail).toContain('Enhancers · chr2R:300-400');

    const byCategory = searchRegionCatalog(c, 'enhancers');
    expect(byCategory.some(s => s.kind === 'category' && s.label === 'Enhancers')).toBe(true);
  });

  it('collects every provider, best first', () => {
    const ctx = { source: 'locus' as const, signal: new AbortController().signal };
    const off = registerSearchProvider({ id: 'test', kind: 'gene', label: 'Genes', search: q => [{ id: 't', kind: 'gene', label: q, score: 50, run: () => null }] });
    try {
      const out = searchProvidersNow('zz-unlikely', ctx).flatMap(g => g.suggestions);
      expect(out.find(s => s.id === 't')?.label).toBe('zz-unlikely');
    } finally { off(); }
    expect(searchProvidersNow('zz-unlikely', ctx).flatMap(g => g.suggestions).find(s => s.id === 't')).toBeUndefined();
  });
});
