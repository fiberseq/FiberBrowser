import '../testSetup';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// A failed build ("Could not show the insert expanded (...): deadline") offers Retry on the error banner,
// and Retry runs the same call again.
const api = vi.hoisted(() => ({
  openAltAllele: vi.fn(),
  insertionClustersInView: vi.fn(),
  refresh: vi.fn(async () => {}),
}));
vi.mock('./api', () => ({ openAltAllele: api.openAltAllele, insertionClustersInView: api.insertionClustersInView }));
vi.mock('../../stores/panelGenomeStore', async (orig) => {
  const real = await orig<typeof import('../../stores/panelGenomeStore')>();
  real.usePanelGenomeStore.setState({ refresh: api.refresh } as never);
  return real;
});

import { useBrowserStore } from '../../stores/browserStore';
import { openAltAllelePanel, setAltIncludeReference, showPanelOnAltAllele } from './altAllelePanel';
import type { AltAlleleLayout } from './types';
import type { PanelConfig } from '../../types';

const L: AltAlleleLayout = {
  chrom: 'chrT', ref: 15_000, insert_len: 2_000, flank_left: 3_000, flank_right: 3_000,
  name: 'chrT_15000_INS2000', length: 8_000, insert_start: 3_000, insert_end: 5_000,
};
const ALT = {
  id: 'ins_alt_15000_2000', label: 'insertion · carriers of +2,000 bp at chrT:15,000 (27)', path: '/x/carriers.bam', color: '#000',
  data_type: 'bam' as const,
  alt_allele: { source_dataset_id: 'ins', definition: { chrom: 'chrT', ref: 15_000, length: 2_010, pos: null, flank: 3000,
    include_reference: false, max_carriers: 5000, include_duplicates: false }, layout: L },
};
const OK = {
  success: true, dataset: ALT, genome_key: 'fasta:alt_abc', layout: L, locus: { chrom: L.name, start: 2_000, end: 6_000 },
  alt_allele: { ...ALT.alt_allele, meta: { sv: { t: 'I', ref: 15_000, len: 2_010 } } }, built: true,
};
const DEADLINE = { success: false, error: 'deadline' };
const SOURCE = { id: 'ins', label: 'insertion', path: '/x/insertion.bam', color: '#111', data_type: 'bam' as const };
const CLUSTER = { datasetId: 'ins', chrom: 'chrT', ref: 15_000, len: 2_010 };
const panel = (id: string) => useBrowserStore.getState().panels.find(p => p.id === id)!;

beforeEach(() => {
  vi.clearAllMocks();
  api.openAltAllele.mockReset();  // no queued answer left over from another test
  const p: PanelConfig = {
    id: 'panel-src', contentType: 'dataset', datasetId: 'ins', subTracks: [], collapsed: false, linkGroup: 'default', layoutRow: 0,
    stateKey: 'carriers-key', viewportOverride: { chrom: 'chrT', start: 14_000, end: 16_000 },
  };
  useBrowserStore.setState({ datasets: [SOURCE], panels: [p], slotOrder: ['ins'], chrom: 'chrT', start: 14_000, end: 16_000 } as never);
  useBrowserStore.getState().setError(null);
});

describe('Retry on a failed insert-expanded build', () => {
  it('showing a panel expanded: Retry builds it again and switches the panel', async () => {
    api.openAltAllele.mockResolvedValueOnce(DEADLINE).mockResolvedValueOnce(OK);
    expect(await showPanelOnAltAllele('panel-src', CLUSTER)).toBeNull();
    const st = useBrowserStore.getState();
    expect(st.error).toBe('Could not show the insert expanded (+2,010 bp at chrT:15,000): deadline');
    expect(st.errorAction?.label).toBe('Retry');
    expect(panel('panel-src').datasetId).toBe('ins');

    st.errorAction!.run();
    await vi.waitFor(() => expect(panel('panel-src').datasetId).toBe(ALT.id));
    expect(api.openAltAllele).toHaveBeenCalledTimes(2);
    expect(api.openAltAllele.mock.calls[1][0]).toEqual(api.openAltAllele.mock.calls[0][0]);
  });

  it('opening a new panel: Retry opens it', async () => {
    api.openAltAllele.mockResolvedValueOnce(DEADLINE).mockResolvedValueOnce(OK);
    expect(await openAltAllelePanel(CLUSTER, { afterPanelId: 'panel-src' })).toBeNull();
    expect(useBrowserStore.getState().panels).toHaveLength(1);
    useBrowserStore.getState().errorAction!.run();
    await vi.waitFor(() => expect(useBrowserStore.getState().panels).toHaveLength(2));
    expect(useBrowserStore.getState().panels[1].datasetId).toBe(ALT.id);
  });

  it('Include reference reads: Retry runs the whole switch again, not only the build', async () => {
    api.openAltAllele.mockResolvedValueOnce(OK);
    await showPanelOnAltAllele('panel-src', CLUSTER);
    const view = { chrom: L.name, start: 3_100, end: 3_900 };
    useBrowserStore.setState(s => ({ panels: s.panels.map(p => (p.id === 'panel-src' ? { ...p, viewportOverride: view } : p)) }));
    const withReference = { ...OK, dataset: { ...ALT, id: 'with_reference' } };
    api.openAltAllele.mockResolvedValueOnce(DEADLINE).mockResolvedValueOnce(withReference);
    await setAltIncludeReference('panel-src', true);
    expect(panel('panel-src').altAllele?.includeReference).toBeFalsy();
    useBrowserStore.getState().errorAction!.run();
    await vi.waitFor(() => expect(panel('panel-src').datasetId).toBe('with_reference'));
    expect(panel('panel-src').altAllele?.includeReference).toBe(true);
    expect(api.openAltAllele).toHaveBeenLastCalledWith(expect.objectContaining({ include_reference: true }));
    // setAltIncludeReference keeps the panel where it was; a bare rebuild would move it to the insert.
    expect(panel('panel-src').viewportOverride).toEqual(view);
  });
});
