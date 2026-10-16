import { describe, it, expect, vi, beforeEach } from 'vitest';

// The server's answers, released by each test when it wants.
const pending: Array<(value: unknown) => void> = [];
const dm6 = { key: 'dm6', label: 'dm6', kind: 'registry', genome_id: 'dm6', assembly: 'dm6', fasta_path: null, gtf_path: null,
  has_fasta: true, has_gtf: true, gene_count: 1, n_chroms: 1, chroms: [{ name: 'chr2L', size: 23_513_712 }] };
let afterAttach = false;
vi.mock('../../api/panelGenomes', () => ({
  getPanelGenomes: vi.fn(() => (afterAttach
    ? Promise.resolve({ main: { genome_id: 'hg38', fasta_path: null }, genomes: [dm6], datasets: { fly: 'dm6' } })
    : new Promise(resolve => pending.push(resolve)))),
  attachPanelGenome: vi.fn(async () => {
    afterAttach = true;
    return { success: true, genome: dm6, loci: { fly: { chrom: 'chr2L', start: 5_000, end: 9_000 } } };
  }),
  detachPanelGenome: vi.fn(async () => ({ success: true })),
}));
vi.mock('../genomeCheckStore', () => ({ useGenomeCheckStore: { getState: () => ({ refresh: async () => undefined }) } }));

import { usePanelGenomeStore } from '../panelGenomeStore';
import { useBrowserStore } from '../browserStore';

describe('a refresh answered after a reference was given (Codex, fb-r3-nav)', () => {
  beforeEach(() => {
    useBrowserStore.setState({ chrom: 'chr19', start: 0, end: 4_000, navigationMode: 'linked',
      panels: [{ id: 'p', contentType: 'dataset', datasetId: 'fly', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0 }] } as any);
  });

  it('does not take the reference away again', async () => {
    const refreshing = usePanelGenomeStore.getState().refresh();  // asked before the attach
    await usePanelGenomeStore.getState().attach({ dataset_ids: ['fly'], genome_id: 'dm6' });
    expect(useBrowserStore.getState().panels[0].genome).toBe('dm6');
    // The older answer (no assignments) arrives now.
    pending.shift()!({ main: { genome_id: 'hg38', fasta_path: null }, genomes: [], datasets: {} });
    await refreshing;
    expect(usePanelGenomeStore.getState().assignments).toEqual({ fly: 'dm6' });
    const p = useBrowserStore.getState().panels[0];
    expect(p.genome).toBe('dm6');
    expect(p.viewportOverride).toEqual({ chrom: 'chr2L', start: 5_000, end: 9_000 });
  });
});
