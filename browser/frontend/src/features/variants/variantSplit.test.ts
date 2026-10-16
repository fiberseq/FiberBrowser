import '../testSetup';
import { describe, expect, it } from 'vitest';
import type { AlleleGrouping } from './api';
import type { PanelConfig } from '../../types';
import { useBrowserStore } from '../../stores/browserStore';
import { openSplitPanels } from '../../utils/splitPanels';
import { snp } from './variantsTestData';
import {
  groupingSnps, SPLIT_HARD_LIMIT, SPLIT_SOFT_LIMIT, expectedPanels, groupingTitle, readsByGroup, selectionTitle, splitVerdict,
  variantSplitGrouping, variantSplitRows,
} from './variantSplit';

function grouping(counts: number[], other = 0, ni = 0): AlleleGrouping {
  const groups = counts.map((n, i) => ({ id: i, key: `C${i}`, label: `A-${i}`, alleles: ['A', String(i)], count: n, kind: 'combo' as const }));
  groups.push({ id: counts.length, key: 'other', label: 'Other (2 rare)', alleles: [], count: other, kind: 'other' as any });
  groups.push({ id: counts.length + 1, key: 'not-informative', label: 'Not informative', alleles: [], count: ni, kind: 'not-informative' as any });
  const assignments: Record<string, number> = {};
  groups.forEach(g => { for (let r = 0; r < g.count; r++) assignments[`${g.key}-${r}`] = g.id; });
  return { groups, assignments, n_reads: Object.keys(assignments).length, covering: 0, threshold: 3, distinct: counts.length,
    snps: ['10:snv:A/G', '20:snv:C/T'], phase: null, tags: null, scan_key: 'k', dataset_id: 'ds', region: { chrom: 'c', start: 0, end: 100 }, mode: 'basecall' };
}

describe('variant split: groups, rows, panel count and limits', () => {
  it('turns an allele grouping into a frozen split with the read names per group', () => {
    const g = grouping([14, 10, 8], 0, 3);
    expect(readsByGroup(g).get(1)).toHaveLength(10);
    const split = variantSplitGrouping(g, 'ds', '11/21');
    // The rule names the SNPs it was split by (from the ids: no scan given, so which allele is the reference is unknown).
    expect(split.rule).toEqual({ kind: 'frozen', splitSnps: [
      { datasetId: 'ds', chrom: 'c', id: '10:snv:A/G', pos: 10, kind: 'snv', ref: null, alt: 'G', label: 'c:11 A/G' },
      { datasetId: 'ds', chrom: 'c', id: '20:snv:C/T', pos: 20, kind: 'snv', ref: null, alt: 'T', label: 'c:21 C/T' }] });
    // Empty groups (no "Other" here) are left out; the bins keep their kinds.
    expect(split.groups.map(x => [x.label, x.count, x.kind])).toEqual([
      ['A-0', 14, 'group'], ['A-1', 10, 'group'], ['A-2', 8, 'group'], ['Not informative', 3, 'na']]);
    expect(split.groups[1].ids.ds).toHaveLength(10);
  });

  it('ticks the top N groups by reads; the rest and the rare ones go in Other (not ticked), Not informative unticked', () => {
    const split = variantSplitGrouping(grouping([5, 30, 12, 9, 7, 6], 4, 2), 'ds', 'x');
    const rows = variantSplitRows(split, 4);
    expect(rows.map(r => [r.label, r.count, r.checked, r.kind])).toEqual([
      ['A-1', 30, true, 'group'], ['A-2', 12, true, 'group'], ['A-3', 9, true, 'group'], ['A-4', 7, true, 'group'],
      ['Other (3 combinations)', 6 + 5 + 4, false, 'other'], ['Not informative', 2, false, 'na']]);
    expect(rows[4].groupKeys.sort()).toEqual(['0', '5', '6'].sort());
    expect(expectedPanels(rows, 1)).toBe(4);
    expect(expectedPanels(rows, 2)).toBe(8);
    expect(variantSplitRows(split, 1).filter(r => r.checked)).toHaveLength(1);
  });

  it('asks before more than the soft limit, refuses more than the hard limit, never silently opens dozens', () => {
    expect(SPLIT_SOFT_LIMIT).toBe(8);
    expect(SPLIT_HARD_LIMIT).toBe(16);
    expect(splitVerdict(0).kind).toBe('none');
    expect(splitVerdict(3).kind).toBe('ok');
    expect(splitVerdict(8).kind).toBe('ok');
    expect(splitVerdict(9)).toMatchObject({ kind: 'confirm', count: 9 });
    expect(splitVerdict(9).message).toContain('9 panels');
    expect(splitVerdict(16).kind).toBe('confirm');
    expect(splitVerdict(17).kind).toBe('refuse');
    expect(splitVerdict(100).kind).toBe('refuse');
    // An adjusted soft limit (and one past the hard limit is held at it).
    expect(splitVerdict(3, 2).kind).toBe('confirm');
    expect(splitVerdict(16, 40).kind).toBe('ok');
  });

  it('titles a split by its SNPs', () => {
    const describe = (id: string) => `SNP ${id}`;
    expect(selectionTitle(['9:snv:A/G'], describe)).toBe('SNP 9:snv:A/G');
    expect(selectionTitle(['8000:snv:T/G', '9000:snv:A/G'], describe)).toBe('8,001/9,001');
    expect(selectionTitle(['1:snv:A/G', '2:snv:A/G', '3:snv:A/G', '4:snv:A/G'], describe)).toBe('4 SNPs');
    expect(groupingTitle({ snps: [], tags: null }, 'hp', describe)).toBe('HP tags');
    expect(groupingTitle({ snps: ['1:snv:A/G', '5:snv:C/T'], tags: [] }, 'informative', describe)).toBe('2 SNP tags (informative SNPs)');
  });
});

/** GM12878 at chr6:122,471,928 C>A: the reads split ref C (60) / alt A (73), as /api/variants/alleles returns one SNP. */
function oneSnpGrouping(): AlleleGrouping {
  const assignments: Record<string, number> = {};
  for (let r = 0; r < 60; r++) assignments[`ref-${r}`] = 0;
  for (let r = 0; r < 73; r++) assignments[`alt-${r}`] = 1;
  for (let r = 0; r < 4; r++) assignments[`ni-${r}`] = 3;
  return {
    groups: [
      { id: 0, key: 'C', label: 'ref C', alleles: ['C'], count: 60, kind: 'combo' },
      { id: 1, key: 'A', label: 'alt A', alleles: ['A'], count: 73, kind: 'combo' },
      { id: 2, key: 'other', label: 'Other allele', alleles: [], count: 0, kind: 'other' },
      { id: 3, key: 'not-informative', label: 'Not informative', alleles: [], count: 4, kind: 'not-informative' },
    ],
    assignments, n_reads: 137, covering: 133, threshold: 0, distinct: 2, snps: ['122471927:snv:A/C'], phase: null, tags: null,
    scan_key: 'k', dataset_id: 'gm', region: { chrom: 'chr6', start: 122_471_678, end: 122_472_178 }, mode: 'basecall',
  };
}

describe('a split by SNP keeps the SNP and each panel\'s allele on its rule', () => {
  const call = snp(122_471_927, { id: '122471927:snv:A/C', ref: 'C', alleles: ['A', 'C'], alt: 'A', counts: { C: 60, A: 73 } });

  it('names the SNP (its reference from the scan) and each group\'s allele', () => {
    const split = variantSplitGrouping(oneSnpGrouping(), 'gm', 'chr6:122,471,928 C>A', [call]);
    expect(split.rule.splitSnps).toEqual([{ datasetId: 'gm', chrom: 'chr6', id: '122471927:snv:A/C', pos: 122_471_927, kind: 'snv',
      ref: 'C', alt: 'A', label: 'chr6:122,471,928 C>A' }]);
    expect(split.groups.map(g => [g.label, g.ruleExtras?.splitAlleles])).toEqual([
      ['ref C', ['C']], ['alt A', ['A']], ['Not informative', undefined]]);
    // A combination's columns: its alleles index-aligned with the SNPs (null where a partial combination has none).
    const cols = groupingSnps({ snps: ['5:snv:A/G', '9:snv:C/T'], region: { chrom: 'c', start: 0, end: 20 } }, 'ds');
    expect(cols.map(c => [c.snp.pos, c.index])).toEqual([[5, 0], [9, 1]]);
    // SNPs and SVs: only the SNP columns.
    expect(groupingSnps({ snps: ['5:snv:A/G'], region: { chrom: 'c', start: 0, end: 20 },
      columns: [{ id: '5:snv:A/G', name: '6', kind: 'snv' }, { id: 'I:9:300', name: 'roo', kind: 'sv' }] }, 'ds').map(c => c.index)).toEqual([0]);
    expect(groupingSnps({ snps: [], region: { chrom: 'c', start: 0, end: 1 } }, 'ds')).toEqual([]);
  });

  it('the split panels carry it, and it survives a session (old rules without it are unchanged)', () => {
    const source: PanelConfig = { id: 'p1', contentType: 'dataset', datasetId: 'gm', subTracks: [{ type: 'reads', visible: true }], collapsed: false, linkGroup: null, layoutRow: 0 };
    useBrowserStore.setState({ panels: [source], chrom: 'chr6', start: 122_471_678, end: 122_472_178, datasets: [] } as never);
    const split = variantSplitGrouping(oneSnpGrouping(), 'gm', 'chr6:122,471,928 C>A', [call]);
    const rows = variantSplitRows(split, 2);
    expect('error' in openSplitPanels(split, rows, [source])).toBe(false);
    const made = useBrowserStore.getState().panels.filter(p => p.readSubset);
    expect(made.map(p => [p.readSubset!.count, p.readSubset!.rule.splitAlleles, p.readSubset!.rule.splitSnps?.[0].label])).toEqual([
      [73, ['A'], 'chr6:122,471,928 C>A'], [60, ['C'], 'chr6:122,471,928 C>A']]);
    const saved = JSON.parse(JSON.stringify(made)) as PanelConfig[];
    expect(saved.map(p => p.readSubset!.rule)).toEqual(made.map(p => p.readSubset!.rule));
    // An SV-only split (no SNP columns) gets no SNP fields.
    const sv = variantSplitGrouping({ ...oneSnpGrouping(), snps: [], columns: [{ id: 'I:9:300', name: 'roo', kind: 'sv' }] }, 'gm', 'roo');
    expect(sv.rule.splitSnps).toBeUndefined();
    expect(sv.groups.some(g => g.ruleExtras?.splitAlleles)).toBe(false);
  });
});
