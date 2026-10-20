import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addDataset } from '../../../api/datasets';
import { attachPanelGenome } from '../../../api/panelGenomes';
import { useBrowserStore } from '../../../stores/browserStore';
import { usePanelGenomeStore } from '../../../stores/panelGenomeStore';
import { useLiveLiftStore } from '../store';
import type { PanelConfig } from '../../../types';
import { openLinkedSourceView, registerLiftLinking } from './liftLink';
import { resetNavigation, setNavigationFetcher, type LiftSummary } from './navigation';

vi.mock('../../../api/datasets', () => ({ addDataset: vi.fn() }));
vi.mock('../../../api/panelGenomes', () => ({ attachPanelGenome: vi.fn() }));

const MAT = 'chrS_MATERNAL';
const SUMMARY: LiftSummary = { key: 'k1', tile_bp: 1_000_000, outline_max_drift: 1000, haplotypes: ['H#1'], labels: { 'H#1': 'MAT' },
  sources: { [MAT]: 'H#1' }, targets: { chrT: 20_000 }, selected: [true], chains: [['chrT', 1000, 9000, MAT, 0, 8000, '+', 'H#1', 8000, 8000]] };

describe('opening a linked source view', () => {
  beforeEach(() => {
    resetNavigation();
    registerLiftLinking();
    setNavigationFetcher({
      json: async url => (url.startsWith('/api/lift/summary') ? SUMMARY : { rows: [[1000, 9000, 0, 8000, '+', 0, 0, 'chrT']] }),
      bytes: async () => { throw new Error('no tiles here: the outline (drift 0) maps exactly'); },
    });
    useLiveLiftStore.setState({ enabled: true });
    usePanelGenomeStore.setState({ genomes: {}, assignments: {}, refresh: vi.fn().mockResolvedValue(undefined) });
    useBrowserStore.setState({ chrom: 'chrT', start: 2000, end: 3000, datasets: [{ id: 'lift', path: '/s.bam', label: 'lift', color: '#000', data_type: 'bam_livelift',
      live_lift: { key: 'k1', haplotypes: ['H#1'], haplotype_labels: { 'H#1': 'MAT' } } } as never],
    panels: [{ id: 'mat', contentType: 'dataset', datasetId: 'lift', subTracks: [], collapsed: false, linkGroup: null, liftHap: 'MAT' } as PanelConfig],
    slotOrder: [], pushSnapshot: vi.fn() });
  });
  it('follows a main-view move made while the BAM and its reference opened', async () => {
    vi.mocked(addDataset).mockImplementation(async () => {
      useBrowserStore.getState().setViewport('chrT', 5000, 7000);      // the user pans meanwhile
      return { success: true, dataset: { id: 'native', path: '/s.bam', label: 'n', color: '#000', data_type: 'bam' } };
    });
    vi.mocked(attachPanelGenome).mockImplementation(async () => {
      const genome = { key: 'contigs:native', chroms: [{ name: MAT, size: 10_000 }] } as never;
      usePanelGenomeStore.setState({ genomes: { 'contigs:native': genome }, assignments: { native: 'contigs:native' } });
      return { success: true, genome };
    });
    const id = await openLinkedSourceView('mat');
    for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0));
    const panel = useBrowserStore.getState().panels.find(p => p.id === id)!;
    expect(panel.liftLink).toMatchObject({ liftPanelId: 'mat', hapLabel: 'MAT' });
    expect(panel.viewportOverride).toEqual({ chrom: MAT, start: 4000, end: 6000 });
  });
});
