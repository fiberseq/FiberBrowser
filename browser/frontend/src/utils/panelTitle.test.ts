import { describe, expect, it } from 'vitest';
import { panelTitle, splitGroupName } from './panelTitle';
import type { PanelConfig } from '../types';

const subset = (label: string, locusLabel?: string): NonNullable<PanelConfig['readSubset']> => ({
  groupId: 'split-1', label, colour: '#f00', count: 3, sourcePanelId: 'src',
  rule: { kind: 'frozen', datasetId: 'numb', groupKeys: ['0'] },
  ...(locusLabel ? { locus: { chrom: 'chr2L', start: 9_462_000, end: 9_492_000, label: locusLabel } } : {}),
});

describe('panel titles: the group first, the dataset last (audit Top 1)', () => {
  it('an SV split panel leads with its group; the SV and the dataset follow', () => {
    const t = panelTitle({ readSubset: subset('INS 9.2 kb @ chr2L:9,467,039 · Reference', 'INS 9.2 kb @ chr2L:9,467,039') }, 'pooled_rep.R1R2R3');
    expect(t).toEqual({ primary: 'Reference', secondary: 'INS 9.2 kb @ chr2L:9,467,039 · pooled_rep.R1R2R3', sep: ' · ',
      full: 'Reference · INS 9.2 kb @ chr2L:9,467,039 · pooled_rep.R1R2R3' });
  });

  it('a combined-SV genotype panel: its genotype, without the read count', () => {
    expect(splitGroupName(subset('roo+ · INS5k+ (741)', 'roo + INS 5k')).group).toBe('roo+ · INS5k+');
    // Evidence tier counts are part of the group's name, not a read count to drop.
    expect(splitGroupName(subset('Confirmed (9) + putative (0)')).group).toBe('Confirmed (9) + putative (0)');
    expect(panelTitle({ readSubset: subset('roo+ · INS5k+ (741)', 'roo + INS 5k') }, 'numb').primary).toBe('roo+ · INS5k+');
  });

  it('an NFR split keeps its whole group label (no coordinates to drop)', () => {
    expect(panelTitle({ readSubset: subset('N2 · V2', 'N2') }, 'amp_DddB.full').primary).toBe('N2 · V2');
  });

  it('an insert-expanded Carriers panel of a split names its source dataset', () => {
    const t = panelTitle({ readSubset: subset('INS 9.2 kb @ chr2L:9,467,039 · Carriers', 'INS 9.2 kb @ chr2L:9,467,039'),
      altAllele: { cluster: { datasetId: 'numb' } } as never }, 'Carriers of +9,185 bp at chr2L:9,467,038 (3,141) · numb', 'numb');
    expect(t.primary).toBe('Carriers');
    expect(t.secondary).toBe('INS 9.2 kb @ chr2L:9,467,039 · numb · insert expanded');
  });

  it('an insert-expanded panel on its own: "Carriers" first, the rest of its name after', () => {
    const t = panelTitle({ altAllele: { cluster: { datasetId: 'numb' } } as never }, 'Carriers of +2,000 bp at chrT:15,000 (27) · demo');
    expect([t.primary, t.sep, t.secondary]).toEqual(['Carriers', ' ', 'of +2,000 bp at chrT:15,000 (27) · demo']);
  });

  it('a panel with a title of its own (a reference copy); a plain panel is its dataset', () => {
    expect(panelTitle({ title: 'roo copy 2 (chr3L)', titleDetail: '+ strand, 98.9% identity' }, 'numb'))
      .toMatchObject({ primary: 'roo copy 2 (chr3L)', secondary: '+ strand, 98.9% identity · numb' });
    expect(panelTitle({}, 'numb')).toEqual({ primary: 'numb', secondary: '', sep: '', full: 'numb' });
  });
});
