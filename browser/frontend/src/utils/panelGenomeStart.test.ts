import { beforeEach, describe, expect, it, vi } from 'vitest';

const genomeApi = vi.hoisted(() => ({
  attachPanelGenome: vi.fn(),
  getPanelGenomes: vi.fn(),
  detachPanelGenome: vi.fn(),
}));
vi.mock('../api/panelGenomes', () => genomeApi);
vi.mock('../api/genomeCheck', () => ({ getGenomeCheck: vi.fn(async () => ({ datasets: [], reference: null })) }));

import { useBrowserStore } from '../stores/browserStore';
import { usePanelGenomeStore } from '../stores/panelGenomeStore';
import { startLociForPanels } from './panelGenomeStart';
import type { PanelConfig } from '../types';

const HUMAN = { id: 'human', label: 'napa_ddda', path: '/d/napa_ddda.bam', color: '#3b82f6', data_type: 'bam' };
const FLY = { id: 'fly', label: 'FlyAmp', path: '/d/flyamp.bam', color: '#ef4444', data_type: 'bam' };
const dm6 = { key: 'dm6', label: 'dm6', kind: 'registry', genome_id: 'dm6', assembly: 'dm6', fasta_path: '/g/dm6.fa',
  gtf_path: null, has_fasta: true, has_gtf: true, gene_count: 10, n_chroms: 2,
  chroms: [{ name: 'chr2L', size: 23_513_712 }, { name: 'chr3R', size: 32_079_331 }] };
const READS = { chrom: 'chr3R', start: 6_356_793, end: 6_357_648 };

const flyPanel = () => useBrowserStore.getState().panels.find(p => p.datasetId === 'fly')!;

describe('a later window starts own-reference panels at their reads (audit L12)', () => {
  beforeEach(() => {
    genomeApi.getPanelGenomes.mockReset().mockImplementation(async () => ({
      main: { genome_id: 'hg38', fasta_path: null }, genomes: [dm6], datasets: { fly: 'dm6' }, loci: { fly: READS },
    }));
    // A fresh window: the datasets arrive, the panels have no reference yet.
    useBrowserStore.setState({ datasets: [], panels: [], chrom: 'chr19', start: 47_515_640, end: 47_517_640 } as never);
    usePanelGenomeStore.setState({ genomes: {}, assignments: {}, ready: false });
    useBrowserStore.getState().setDatasets([HUMAN, FLY] as never);
  });

  it('the dm6 panel opens at the dataset\'s reads, not chr2L:0-10,000', async () => {
    await usePanelGenomeStore.getState().refresh();
    expect(flyPanel().genome).toBe('dm6');
    expect(flyPanel().viewportOverride).toEqual(READS);
    // The hg38 panel stays on the main view.
    expect(useBrowserStore.getState().panels.find(p => p.datasetId === 'human')?.genome ?? null).toBeNull();
  });

  it('a panel already on its reference is never moved by a later refresh', async () => {
    await usePanelGenomeStore.getState().refresh();
    const elsewhere = { chrom: 'chr2L', start: 100_000, end: 110_000 };
    useBrowserStore.setState({ panels: useBrowserStore.getState().panels.map(p => (p.datasetId === 'fly'
      ? { ...p, viewportOverride: elsewhere } : p)) });
    await usePanelGenomeStore.getState().refresh();
    expect(flyPanel().viewportOverride).toEqual(elsewhere);
  });

  it('only panels not yet on their reference get a start', () => {
    const has = (_g: string, chrom: string) => dm6.chroms.some(c => c.name === chrom);
    const panel = (over: Partial<PanelConfig>) => ({ id: 'p', datasetId: 'fly', ...over }) as PanelConfig;
    expect(startLociForPanels([panel({})], { fly: 'dm6' }, { fly: READS }, has)).toEqual({ fly: READS });
    expect(startLociForPanels([panel({ genome: 'dm6', viewportOverride: { chrom: 'chr2L', start: 0, end: 5 } })],
      { fly: 'dm6' }, { fly: READS }, has)).toEqual({});
    // On a chromosome the reference doesn't have (stale), or not assigned any more: none.
    expect(startLociForPanels([panel({})], { fly: 'dm6' }, { fly: { chrom: 'chr19', start: 0, end: 5 } }, has)).toEqual({});
    expect(startLociForPanels([panel({})], {}, { fly: READS }, has)).toEqual({});
  });
});
