import { describe, expect, it } from 'vitest';
import type { FootprintAnalysisResult } from '../api/footprints';
import type { FootprintGroup } from '../types';
import type { Dataset } from '../types/dataset';
import { buildFootprintCooccurrenceRows, formatFootprintCooccurrenceTsv } from './cooccurrenceExport';

const groups: FootprintGroup[] = [
  { id: 'g1', name: 'TF', color: '#111111', sizeMin: 1, sizeMax: 80, sourceIndex: -1, overlapFraction: 0, enabled: true },
  { id: 'g2', name: 'Nuc', color: '#222222', sizeMin: 80, sizeMax: 300, sourceIndex: -1, overlapFraction: 0, enabled: true },
];

const datasets: Dataset[] = [{
  id: 'ds1',
  label: 'Sample 1',
  path: '/tmp/sample.bam',
  color: '#123456',
  data_type: 'bam',
}];

describe('cooccurrence export', () => {
  it('exports per-group and pairwise occupancy rows with read ids', () => {
    const result = {
      success: true,
      footprints: [],
      overlap_stats: {},
      profiles: {},
      vplot: {},
      motif_pwms: {},
      co_occupancy: {
        ds1: {
          total_reads: 4,
          per_group: [
            { n_with: 2, n_without: 2, ids_with: ['r1', 'r2'], ids_without: ['r3', 'r4'] },
            { n_with: 1, n_without: 3, ids_with: ['r1'], ids_without: ['r2', 'r3', 'r4'] },
          ],
          pairs: [{
            group_i: 0,
            group_j: 1,
            table: [[1, 1], [0, 2]],
            odds_ratio: Infinity,
            p_value: 0.25,
            q_value: 0.5,
            n_both: 1,
            n_i_only: 1,
            n_j_only: 0,
            n_neither: 2,
            ids_both: ['r1'],
            ids_i_only: ['r2'],
            ids_j_only: [],
            ids_neither: ['r3', 'r4'],
          }],
        },
      },
    } satisfies FootprintAnalysisResult;

    const rows = buildFootprintCooccurrenceRows(result, groups, datasets);

    expect(rows).toHaveLength(9);
    expect(rows[1]).toEqual(['single', 'ds1', 'Sample 1', 4, 0, 'TF', '', '', 'with', 2, '', '', '', 'r1,r2']);
    expect(rows[5]).toEqual(['pair', 'ds1', 'Sample 1', 4, 0, 'TF', 1, 'Nuc', 'both', 1, 'inf', 0.25, 0.5, 'r1']);
    expect(formatFootprintCooccurrenceTsv(result, groups, datasets)).toContain('scope\tdataset_id\tdataset_label');
  });
});
