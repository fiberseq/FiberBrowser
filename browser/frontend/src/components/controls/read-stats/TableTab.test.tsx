import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TableTab, hasNucleosomeColumns } from './TableTab';
import type { ReadStatsDisplayRow } from './types';

const row = (extra: Partial<ReadStatsDisplayRow> = {}): ReadStatsDisplayRow => ({
  read_id: 'q1', dataset_id: 'ds1', mapq: 60, strand: '+', read_length: 5000, aligned_span: 4800, nm: null,
  footprint_count: 20, nucleosome_count: 18, subnuc_count: 2, avg_footprint_size: 140, median_footprint_size: 147,
  accessibility_pct: 20, methyl_count: null, methyl_pct: null, cigar_string: null, cigar_ops: null, ref_start: null,
  ref_end: null, fp_intervals: null, methyl_pos: null, ...extra,
});

const render = (rows: ReadStatsDisplayRow[]) => renderToStaticMarkup(
  <TableTab rows={rows} total={rows.length} sortCol="viewer_order" sortAsc onSort={() => {}} isBam />,
);

describe('Read Stats nucleosome columns', () => {
  it('hidden when no row has a nucleosome scalar', () => {
    expect(hasNucleosomeColumns([row(), row({ nrl: null })])).toBe(false);
    const html = render([row()]);
    expect(html).not.toContain('Nucleosomes');
    expect(html).not.toContain('NRL');
  });

  it('a Nucleosomes group when any row has one, with decimals for fractions', () => {
    const html = render([row({ nrl: 188, regularity: 0.42, reg_fraction: 0.756, n_mono: 12 }), row({ read_id: 'q2' })]);
    expect(html).toContain('Nucleosomes');
    expect(html).toContain('NRL');
    expect(html).toContain('>188<');
    expect(html).toContain('>0.42<');
    expect(html).toContain('>0.76<');
    expect(html).toContain('>12<');
  });
});
