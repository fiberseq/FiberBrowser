/**
 * Opening a source view registers its BAM as a native dataset. After a page reload without a saved session, that
 * dataset used to come back as an empty panel of its own ("… · PAT source" on its first contig). It is now marked
 * (lift_source_of) when the source view opens it, and the page shows it only in a source view.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addDataset } from '../../../api/datasets';
import { attachPanelGenome } from '../../../api/panelGenomes';
import { useBrowserStore } from '../../../stores/browserStore';
import { usePanelGenomeStore } from '../../../stores/panelGenomeStore';
import { useLiveLiftStore } from '../store';
import type { Dataset, PanelConfig } from '../../../types';
import { openLinkedSourceView, registerLiftLinking } from './liftLink';
import { resetNavigation, setNavigationFetcher, type LiftSummary } from './navigation';

vi.mock('../../../api/datasets', () => ({ addDataset: vi.fn() }));
vi.mock('../../../api/panelGenomes', () => ({ attachPanelGenome: vi.fn() }));

const MAT = 'chrS_MATERNAL';
const SUMMARY: LiftSummary = { key: 'k1', tile_bp: 1_000_000, outline_max_drift: 1000, haplotypes: ['H#1'], labels: { 'H#1': 'MAT' },
  sources: { [MAT]: 'H#1' }, targets: { chrT: 20_000 }, selected: [true], chains: [['chrT', 1000, 9000, MAT, 0, 8000, '+', 'H#1', 8000, 8000]] };
const LIFTED = { id: 'lift', path: '/s.bam', label: 'lift', color: '#000', data_type: 'bam_livelift',
  live_lift: { key: 'k1', haplotypes: ['H#1'], haplotype_labels: { 'H#1': 'MAT' } } } as unknown as Dataset;
const SOURCE = { id: 'native', path: '/s.bam', label: 'lift · MAT source', color: '#000', data_type: 'bam', lift_source_of: 'lift' } as unknown as Dataset;

describe('a source view dataset after a reload', () => {
  beforeEach(() => {
    resetNavigation();
    registerLiftLinking();
    setNavigationFetcher({
      json: async url => (url.startsWith('/api/lift/summary') ? SUMMARY : { rows: [[1000, 9000, 0, 8000, '+', 0, 0, 'chrT']] }),
      bytes: async () => { throw new Error('no tiles here'); },
    });
    useLiveLiftStore.setState({ enabled: true });
    usePanelGenomeStore.setState({ genomes: {}, assignments: {}, refresh: vi.fn().mockResolvedValue(undefined) });
    useBrowserStore.setState({ chrom: 'chrT', start: 2000, end: 3000, datasets: [LIFTED],
      panels: [{ id: 'mat', contentType: 'dataset', datasetId: 'lift', subTracks: [], collapsed: false, linkGroup: null, liftHap: 'MAT' } as PanelConfig],
      slotOrder: [], pushSnapshot: vi.fn() } as never);
  });

  it('Open source view registers the BAM marked as that live-lift dataset\'s source', async () => {
    vi.mocked(addDataset).mockResolvedValue({ success: true, dataset: SOURCE });
    vi.mocked(attachPanelGenome).mockImplementation(async () => {
      const genome = { key: 'contigs:native', chroms: [{ name: MAT, size: 10_000 }] } as never;
      usePanelGenomeStore.setState({ genomes: { 'contigs:native': genome }, assignments: { native: 'contigs:native' } });
      return { success: true, genome };
    });
    await openLinkedSourceView('mat');
    expect(vi.mocked(addDataset)).toHaveBeenCalledWith('/s.bam', 'lift · MAT source', { liftSourceOf: 'lift' });
  });

  it('a reload (the server lists both datasets, no session) opens no panel for the source BAM', () => {
    useBrowserStore.setState({ panels: [] } as never);
    useBrowserStore.getState().setDatasets([LIFTED, SOURCE]);
    const panels = useBrowserStore.getState().panels.filter(p => p.contentType === 'dataset');
    expect(panels.map(p => p.datasetId)).toEqual(['lift']);
    // The migration path (initPanelsFromDatasets) leaves it out too.
    useBrowserStore.setState({ panels: [] } as never);
    useBrowserStore.getState().initPanelsFromDatasets();
    expect(useBrowserStore.getState().panels.filter(p => p.contentType === 'dataset').map(p => p.datasetId)).toEqual(['lift']);
  });

  it('an ordinary native BAM still opens its own panel; an open source view keeps its panel', () => {
    useBrowserStore.setState({ panels: [{ id: 'src', contentType: 'dataset', datasetId: 'native', subTracks: [], collapsed: false, linkGroup: null } as PanelConfig] } as never);
    const plain = { ...SOURCE, id: 'plain', lift_source_of: undefined } as Dataset;
    useBrowserStore.getState().setDatasets([LIFTED, SOURCE, plain]);
    const ids = useBrowserStore.getState().panels.filter(p => p.contentType === 'dataset').map(p => p.datasetId).sort();
    expect(ids).toEqual(['lift', 'native', 'plain']);
  });
});
