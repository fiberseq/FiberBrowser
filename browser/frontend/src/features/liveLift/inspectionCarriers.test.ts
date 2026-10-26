import { expect, it } from 'vitest';
import { carrierHighlight, inspectionModel } from './differencesModel';
import type { Difference, DifferenceInspection } from './differenceTypes';

// B5: the inspector outlines only carriers of the inspected haplotype's difference, scoped to its dataset.
const diff = { id: 'del-mat', source: 'assembly', kind: 'deletion', hap: 'H#1', hap_label: 'MAT', t_start: 4000, t_end: 4010,
  ref_bp: 10, alt_bp: 0, reason: 'target_insertion', src: { contig: 'chrS_MATERNAL', start: 3000, end: 3000 } } as unknown as Difference;
const rows = [
  { id: 'mol_mat', row_id: 'lift|0|mol_mat|mat', hap_label: 'MAT', allele: 'deleted', carries_deletion: true, read_bases: '' },
  { id: 'mol_mat2', row_id: 'lift|0|mol_mat2|mat', hap_label: 'MAT', allele: 'hg002', read_bases: '' },
  { id: 'mol_pat', row_id: 'lift|0|mol_pat|pat', hap_label: 'PAT', allele: 'hg002', carries_deletion: false, read_bases: 'AAAAAGAAAA' },
] as DifferenceInspection[];

it('does not outline other-haplotype reads that match their own allele', () => {
  const model = inspectionModel(rows, 'MAT', diff);
  expect(model.carriers).toEqual(['mol_mat', 'mol_mat2']);
  expect(carrierHighlight(model.carrierRows, 'lift').scopedRows?.lift).toEqual(new Set(['lift|0|mol_mat|mat', 'lift|0|mol_mat2|mat']));
});

it('keeps a folded carrier without a display row scoped to its dataset', () => {
  const folded = [rows[0], { id: 'mol_fold', row_id: null, hap_label: 'MAT', allele: 'deleted', carries_deletion: true, read_bases: '' }] as DifferenceInspection[];
  const hl = carrierHighlight(folded, 'lift');
  expect(Object.keys(hl.scopedRows ?? {})).toEqual(['lift']);
  expect(hl.scopedRows!.lift).toEqual(new Set(['lift|0|mol_mat|mat', 'name:mol_fold']));
});

it('does not outline another parent\'s read that carries some other insertion at its boundary (agy probe)', () => {
  const insertion = { ...diff, id: 'ins-mat', kind: 'insertion', alt_bp: 100, ref_bp: 0 } as unknown as Difference;
  const r = [
    { id: 'mat', row_id: 'a', hap_label: 'MAT', allele: 'unknown', carries_insertion: true, read_bases: 'A'.repeat(100) },
    { id: 'pat', row_id: 'b', hap_label: 'PAT', allele: 'other', carries_insertion: true, read_bases: 'AA' },
  ] as DifferenceInspection[];
  expect(inspectionModel(r, 'MAT', insertion).carriers).toEqual(['mat']);
});
