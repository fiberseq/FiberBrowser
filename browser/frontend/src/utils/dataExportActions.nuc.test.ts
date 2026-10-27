import { describe, expect, it } from 'vitest';
import { NUC_FOOTPRINT_COLUMNS, READ_TABLE_COLUMNS, formatNucFootprintsTsv } from './dataExportActions';

describe('nucleosome columns in the read table', () => {
  it('has the molecule scalars, with the display order still last', () => {
    for (const col of ['nrl', 'regularity', 'gap_cv', 'lambda_acc', 'n_short', 'n_mono', 'n_multi', 'n_cant_tell', 'reg_fraction',
      'disordered_fraction', 'undetermined_fraction', 'n_missing']) {
      expect(READ_TABLE_COLUMNS).toContain(col);
    }
    expect(READ_TABLE_COLUMNS[READ_TABLE_COLUMNS.length - 1]).toBe('viewer_order');
  });
});

describe('nucleosome footprint export', () => {
  it('one row per nucsz mark, decoded from its bytes', () => {
    const read = {
      id: 'lift-cohort:v1 ["g|q1","q1","r",0,"17"]',
      layers: {
        nuc: { intervals: [[10, 157, 147]] as Array<[number, number, number]> },
        nucsz: {
          intervals: [[10, 157, 147], [200, 230, 30], [300, 420, 120]] as Array<[number, number, number]>,
          quality_names: ['coarse', 'named', 'posterior', 'z'],
          qualities: [
            [2, 1 + 16, 6],   // mono; short + TF; edge-truncated
            [3, 0, 0],        // octasome; none; none
            [255, 128, 0],    // posterior 1, ~0.502, 0
            [128, 88, 255],   // z 0, -2, missing
          ],
        },
      },
    };
    const plain = { id: 'q2', layers: { nuc: { intervals: [[5, 150, 145]] as Array<[number, number, number]> } } };
    const table = formatNucFootprintsTsv([{ datasets: { ds1: { reads: [read, plain] } }, chrom: 'chr1', regionStart: 1000, reference: 'hg38' }]);
    expect(table.rows).toBe(3);
    expect(table.reads).toBe(1);
    const [header, ...rows] = table.tsv.trim().split('\n').map(line => line.split('\t'));
    expect(header).toEqual([...NUC_FOOTPRINT_COLUMNS]);
    expect(rows).toEqual([
      ['ds1', 'q1', 'hg38', 'chr1', '1010', '1157', '147', 'mono', 'octasome', '1', '0', '0'],
      ['ds1', 'q1', 'hg38', 'chr1', '1200', '1230', '30', 'short', '', '0.502', '-2', '1'],
      ['ds1', 'q1', 'hg38', 'chr1', '1300', '1420', '120', 'edge_truncated', '', '0', '', '0'],
    ]);
  });

  it('can\'t-tell marks and older byte names read by position', () => {
    const read = { id: 'q3', layers: { nucsz: { intervals: [[0, 60, 60]] as Array<[number, number, number]>,
      quality_names: ['q0', 'q1', 'q2', 'q3'], qualities: [[0], [0], [51], [168]] } } };
    const [, row] = formatNucFootprintsTsv([{ datasets: { ds2: { reads: [read] } }, chrom: 'chr2', regionStart: 0 }]).tsv.trim().split('\n');
    expect(row.split('\t')).toEqual(['ds2', 'q3', '', 'chr2', '0', '60', '60', 'cant_tell', '', '0.2', '2', '0']);
  });
});
