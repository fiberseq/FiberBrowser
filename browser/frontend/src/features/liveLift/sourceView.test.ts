import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addDataset } from '../../api/datasets';
import { attachPanelGenome } from '../../api/panelGenomes';
import { useBrowserStore } from '../../stores/browserStore';
import { usePanelGenomeStore } from '../../stores/panelGenomeStore';
import { linkedPanelView, mainViewForPanel } from '../../utils/panelExtensions';
import { openSourceView } from './sourceView';
import { useLiveLiftStore } from './store';
import type { DifferenceSelection } from './inspectionStore';
import { openAltAllelePanel } from '../altAllele/altAllelePanel';
vi.mock('../../api/datasets', () => ({ addDataset: vi.fn() }));
vi.mock('../../api/panelGenomes', () => ({ attachPanelGenome: vi.fn() }));
vi.mock('../altAllele/altAllelePanel', () => ({ openAltAllelePanel: vi.fn() }));
const selection: DifferenceSelection = { panelId: 'mat', datasetId: 'lift', chrom: 'chr1', viewKey: 'main',
  difference: { id: 'MAT:src:1000-1100:insertion', hap: 'h1', hap_label: 'MAT', kind: 'insertion', reason: 'source_insertion', source: 'assembly',
    t_start: 500, t_end: 500, ref_bp: 0, alt_bp: 100, chain: 1, strand: '+', src: { contig: 'src', start: 1000, end: 1100 }, grch38: '', alt: null } };
beforeEach(() => {
  vi.mocked(addDataset).mockReset(); vi.mocked(attachPanelGenome).mockReset(); vi.mocked(openAltAllelePanel).mockReset();
  useLiveLiftStore.setState({ enabled: true });
  useBrowserStore.setState({ chrom: 'chr1', start: 0, end: 1000, datasets: [{ id: 'lift', path: '/source.bam', label: 'lift', color: '#000', data_type: 'bam_livelift' }], panels: [], slotOrder: [], pushSnapshot: vi.fn() });
  usePanelGenomeStore.setState({ genomes: {}, assignments: {}, refresh: vi.fn().mockResolvedValue(undefined) });
});
describe('HG002 source view', () => {
  it.each([0, 1, 100])('links both spans of a replacement/deletion with %i source bases', async alt => {
    vi.mocked(addDataset).mockResolvedValue({ success: true, dataset: { id: 'src', path: '/source.bam', label: 'source', color: '#000', data_type: 'bam' } });
    vi.mocked(attachPanelGenome).mockResolvedValue({ success: true, genome: { key: 'contigs:src', chroms: [{ name: 'src', size: 10000 }] } as never });
    await openSourceView({ ...selection, difference: { ...selection.difference, kind: alt ? 'replacement' : 'deletion',
      t_end: 2000, ref_bp: 1500, alt_bp: alt, src: { contig: 'src', start: 1000, end: 1000 + alt } } });
    const panel = useBrowserStore.getState().panels[0];
    expect(linkedPanelView(panel, { chrom: 'chr1', start: 450, end: 2050 })).toEqual({ chrom: 'src', start: 950, end: 1050 + alt });
    expect(mainViewForPanel(panel, { chrom: 'src', start: 950, end: 1050 + alt })).toEqual({ chrom: 'chr1', start: 450, end: 2050 });
    expect(linkedPanelView(panel, { chrom: 'chr1', start: 1000, end: 1200 })).toEqual({ chrom: 'src', start: 1000, end: 1000 + alt });
  });
  it('opens the source BAM on its own header-contig reference without a FASTA and links locally', async () => {
    vi.mocked(addDataset).mockResolvedValue({ success: true, dataset: { id: 'src', path: '/source.bam', label: 'source', color: '#000', data_type: 'bam' } });
    vi.mocked(attachPanelGenome).mockResolvedValue({ success: true, genome: { key: 'contigs:src', chroms: [{ name: 'src', size: 10000 }] } as never });
    await openSourceView(selection);
    expect(addDataset).toHaveBeenCalledWith('/source.bam', 'lift · HG002 source');
    expect(attachPanelGenome).toHaveBeenCalledWith({ dataset_ids: ['src'], contigs: true, span: 0 });
    const p = useBrowserStore.getState().panels[0];
    expect(p).toMatchObject({ datasetId: 'src', genome: 'contigs:src', viewportOverride: { chrom: 'src', start: 0, end: 2100 } });
    expect(linkedPanelView(p, { chrom: 'chr1', start: 400, end: 600 })).toEqual({ chrom: 'src', start: 900, end: 1200 });
    expect(mainViewForPanel(p, { chrom: 'src', start: 950, end: 1150 })).toEqual({ chrom: 'chr1', start: 450, end: 550 });
    expect(linkedPanelView(p, { chrom: 'chr1', start: 2000, end: 3000 })).toBeNull();
    useLiveLiftStore.setState({ enabled: false });
    expect(linkedPanelView(p, { chrom: 'chr1', start: 400, end: 600 })).toBeUndefined();
  });
  it('falls back to the existing native alt-allele expansion when source registration fails and native evidence matches', async () => {
    useBrowserStore.setState(s => ({ datasets: [...s.datasets, { id: 'native', path: '/native.bam', label: 'native', color: '#000', data_type: 'bam' }] }));
    vi.mocked(addDataset).mockResolvedValue({ success: false, error: 'no header reference' });
    await openSourceView({ ...selection, difference: { ...selection.difference, read_support: { carriers: 4, cluster: 0 } } });
    expect(openAltAllelePanel).toHaveBeenCalledWith({ datasetId: 'native', chrom: 'chr1', ref: 500, len: 100 }, { afterPanelId: 'mat' });
  });
});
