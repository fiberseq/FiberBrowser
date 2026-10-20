import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { useReadActionsStore } from '../../stores/readActionsStore';
import { getDifferenceReads } from '../liveLift/api';
import { highlightCarriers } from './differenceActions';

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
});
