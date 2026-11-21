import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { useReadActionsStore } from '../../stores/readActionsStore';
import { getDifferenceReads } from '../liveLift/api';
import { carriesDifference, highlightCarriers } from './differenceActions';

vi.mock('../liveLift/api', async orig => ({ ...(await orig<typeof import('../liveLift/api')>()), getDifferenceReads: vi.fn() }));

const sel = (hap_label: string) => ({ datasetId: 'lift', panelId: 'mat', viewKey: 'main', chrom: 'chr1',
  difference: { id: 'd', hap_label, kind: 'snv', t_start: 10, t_end: 11, ref_bp: 1, alt_bp: 1 } as never });
const rows = [{ id: 'm1', hap_label: 'MAT', allele: 'hg002' }, { id: 'p1', hap_label: 'PAT', allele: 'hg002' }, { id: 'm2', hap_label: 'MAT', allele: 'grch38' }];

describe('highlighting a difference\'s carriers', () => {
  beforeEach(() => {
    vi.mocked(getDifferenceReads).mockReset().mockResolvedValue({ rows } as never);
    useReadActionsStore.getState().reset();
    useBrowserStore.setState({ datasets: [{ id: 'lift', path: '/s.bam', label: 'l', color: '#000', data_type: 'bam_livelift',
      live_lift: { key: 'k', haplotypes: ['h1', 'h2'], haplotype_labels: { h1: 'MAT', h2: 'PAT' } } } as never] });
  });
  it('outlines only that haplotype\'s carriers', async () => {
    await highlightCarriers(sel('MAT'), 10);
    expect(getDifferenceReads).toHaveBeenCalledWith(expect.objectContaining({ liftHap: 'MAT' }), expect.any(AbortSignal));
    expect([...useReadActionsStore.getState().highlight!.ids]).toEqual(['m1']);
  });
  it('sends no haplotype for a read-supported edit (its lane is "Reads")', async () => {
    await highlightCarriers(sel('Reads'), 10);
    expect(vi.mocked(getDifferenceReads).mock.calls[0][0].liftHap).toBeUndefined();
    expect([...useReadActionsStore.getState().highlight!.ids].sort()).toEqual(['m1', 'p1']);
  });
  it('above the auto-load bound it clears the previous carriers and loads nothing', async () => {
    useReadActionsStore.getState().highlightReads(['old']);
    await highlightCarriers(sel('MAT'), 10_000);
    expect(getDifferenceReads).not.toHaveBeenCalled();
    expect(useReadActionsStore.getState().highlight).toBeNull();
  });
  it('outlines the carriers\' own display rows, not every row sharing their QNAME', async () => {
    vi.mocked(getDifferenceReads).mockResolvedValue({ rows: [{ id: 'same-qname', row_id: 'lift|0|same-qname|mat', hap_label: 'MAT', allele: 'hg002' }] } as never);
    await highlightCarriers(sel('MAT'), 10);
    const h = useReadActionsStore.getState().highlight!;
    expect(h.scopedRows).toEqual({ lift: new Set(['lift|0|same-qname|mat']) });
    expect([...h.ids]).toEqual(['same-qname']);
  });
  it('a read-supported mismatch is carried by the rows showing its base, whatever the assembly says', async () => {
    vi.mocked(getDifferenceReads).mockResolvedValue({ rows: [
      { id: 'g1', hap_label: 'MAT', allele: 'other', read_bases: 'G' }, { id: 'a1', hap_label: 'MAT', allele: 'hg002', read_bases: 'A' },
      { id: 'g2', hap_label: 'MAT', allele: 'grch38', read_bases: 'g' }] } as never);
    const edit = { ...sel('MAT'), difference: { id: 'MAT:site:10', hap_label: 'MAT', kind: 'snv', source: 'reads', alt: 'G',
      t_start: 10, t_end: 11, ref_bp: 1, alt_bp: 1 } as never };
    await highlightCarriers(edit, 10);
    expect([...useReadActionsStore.getState().highlight!.ids].sort()).toEqual(['g1', 'g2']);
    expect(carriesDifference({ source: 'reads', kind: 'snv', alt: null }, { allele: 'other' } as never)).toBe(true);
    expect(carriesDifference({ source: 'reads', kind: 'snv', alt: null }, { allele: 'hg002' } as never)).toBe(false);
    expect(carriesDifference({ source: 'reads', kind: 'deletion', alt: null }, { allele: 'deleted' } as never)).toBe(true);
  });
});
