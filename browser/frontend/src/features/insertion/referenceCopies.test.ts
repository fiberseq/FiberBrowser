import '../testSetup';
import { beforeEach, describe, expect, it } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { closeReferenceCopies, openCopyPanels, openReferenceCopies, copiesAnchor } from './referenceCopies';
import { referenceCopies, insertFamilyName, type IdentifyResult, type GenomeLocus } from './identifyModel';
import type { PanelConfig } from '../../types';

const locus = (chrom: string, start: number, over: Partial<GenomeLocus> = {}): GenomeLocus => ({
  chrom, start, end: start + 1900, strand: '+', qstart: 0, qend: 1888, qcov: 0.95, identity: 98, evalue: 0, bitscore: 3000, near_site: null, ...over,
});
const genome = (loci: GenomeLocus[], extra: Partial<IdentifyResult['genome']> = {}) => ({
  assembly: 'dm6', loci, n_loci: loci.length, copies: loci.length, capped: false, genes: [], rmsk: 'ok' as const, rmsk_family: null, ...extra,
});

describe('the insert\'s reference copies', () => {
  it('as the server picked them, or from the loci of an older result (half the insert, away from the site, one per place)', () => {
    const loci = [
      locus('chr2L', 9_471_000, { near_site: 0, bitscore: 3500 }),
      locus('chr3R', 100_000, { bitscore: 3300 }),
      locus('chr3R', 100_400, { bitscore: 1000, qcov: 0.6 }),
      locus('chrX', 5_000, { bitscore: 2900, identity: 96 }),
      locus('chr4', 10, { qcov: 0.2 }),
    ];
    expect(referenceCopies(genome(loci), 4).map(c => `${c.chrom}:${c.start}`)).toEqual(['chr3R:100000', 'chrX:5000']);
    const server = [{ chrom: 'chr2R', start: 1, end: 2, strand: '+' as const, identity: 99, qcov: 1 }];
    expect(referenceCopies(genome(loci, { reference_copies: server }), 4)).toEqual(server);
    expect(insertFamilyName({ te: { calls: [{ family: 'hobo', related: false }] }, genome: genome([]) } as unknown as IdentifyResult)).toBe('hobo');
  });
});

describe('Open the reference copies', () => {
  const base = { contentType: 'dataset' as const, subTracks: [], linkGroup: null, layoutRow: 0 };
  beforeEach(() => {
    useBrowserStore.setState({ panels: [
      { ...base, id: 'src', datasetId: 'numb', collapsed: true, collapsedBySplitGroup: 'split-1' },
      { ...base, id: 'car', datasetId: 'numb', collapsed: false, stateKey: 'numb:split-1:0',
        readSubset: { groupId: 'split-1', label: 'Carriers', colour: '#f00', count: 3, sourcePanelId: 'src', rule: { kind: 'frozen', datasetId: 'numb', groupKeys: ['0'] } } },
      { ...base, id: 'ref', datasetId: 'numb', collapsed: false, stateKey: 'numb:split-1:1',
        readSubset: { groupId: 'split-1', label: 'Reference', colour: '#00f', count: 3, sourcePanelId: 'src', rule: { kind: 'frozen', datasetId: 'numb', groupKeys: ['1'] } } },
    ] as PanelConfig[] } as never);
  });

  it('opens each copy as a panel of the dataset at its own locus, after the Carriers/Reference pair', () => {
    expect(copiesAnchor(useBrowserStore.getState().panels, 'numb')!.id).toBe('car');
    const copies = [
      { chrom: 'chr3R', start: 100_000, end: 101_900, strand: '-' as const, identity: 98, qcov: 0.97 },
      { chrom: 'chrX', start: 5_000, end: 6_900, strand: '+' as const, identity: 96.5, qcov: 0.9 },
    ];
    const res = openReferenceCopies('numb', copies, 'hobo');
    expect('opened' in res && res.opened).toBe(2);
    const panels = useBrowserStore.getState().panels;
    // Round 3, R2b: after the split pair, never between Carriers and Reference.
    expect(panels.map(p => p.id).slice(0, 3)).toEqual(['src', 'car', 'ref']);
    const opened = panels.slice(3, 5);
    expect(opened.map(p => p.viewportOverride)).toEqual([
      { chrom: 'chr3R', start: 99_000, end: 102_900 }, { chrom: 'chrX', start: 4_000, end: 7_900 },
    ]);
    expect(opened.every(p => p.datasetId === 'numb' && !p.readSubset && !p.collapsed && p.ownLocus && !p.collapsedBySplitGroup)).toBe(true);
    expect(opened[0].regionLabel).toBe('hobo copy 1 (−, 98.0%)');
    // Titled in their headers (which copy, where), strand and identity after it.
    expect(opened.map(p => [p.title, p.titleDetail])).toEqual([['hobo copy 1 (chr3R)', '− strand, 98.0% identity'], ['hobo copy 2 (chrX)', '+ strand, 96.5% identity']]);
    expect(new Set(opened.map(p => p.stateKey)).size).toBe(2);
    // Closed again from where they were opened, in one step; the split panels stay.
    expect(openCopyPanels(useBrowserStore.getState().panels, 'numb')).toHaveLength(2);
    expect(closeReferenceCopies('numb')).toBe(2);
    expect(useBrowserStore.getState().panels.map(p => p.id)).toEqual(['src', 'car', 'ref']);
    expect(closeReferenceCopies('numb')).toBe(0);
  });

  it('refuses more than the cap, and says when there is nothing to open', () => {
    expect(openReferenceCopies('numb', [], 'hobo')).toHaveProperty('error');
    const many = Array.from({ length: 17 }, (_, i) => ({ chrom: 'chr3R', start: i * 10_000, end: i * 10_000 + 1000, strand: '+' as const, identity: 99, qcov: 1 }));
    expect(openReferenceCopies('numb', many, 'hobo')).toHaveProperty('error');
  });
});

describe('Open the reference copies from a lens on an insert-expanded panel', () => {
  it('opens the source dataset\'s panels, not the alt dataset\'s', () => {
    const base = { contentType: 'dataset' as const, subTracks: [], linkGroup: null, layoutRow: 0, collapsed: false };
    useBrowserStore.setState({ panels: [
      { ...base, id: 'src', datasetId: 'numb' },
      { ...base, id: 'alt', datasetId: 'alt-1', stateKey: 'alt~alt', altAllele: { cluster: { datasetId: 'numb', chrom: 'chr2L', ref: 1, len: 2 } } },
    ] as unknown as PanelConfig[] } as never);
    const res = openReferenceCopies('alt-1', [{ chrom: 'chr3R', start: 100_000, end: 101_900, strand: '+', identity: 98, qcov: 1 }], 'hobo');
    expect('opened' in res).toBe(true);
    expect(useBrowserStore.getState().panels.filter(p => p.genomeRegionGroupId).map(p => p.datasetId)).toEqual(['numb']);
  });
});
