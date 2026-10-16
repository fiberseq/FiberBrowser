import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/datasets', () => ({
  addDataset: vi.fn(async (path: string, label?: string) => {
    await new Promise(r => setTimeout(r, 20));
    return { success: true, dataset: { id: `ds-${label}`, label, path, color: '#000' } };
  }),
}));
vi.mock('../api/reference', () => ({
  loadGenome: vi.fn(async () => ({ success: true, fasta_loaded: true })),
  loadFasta: vi.fn(async (path: string) => ({ success: true, path })),
}));
vi.mock('../api/status', () => ({ getStatus: vi.fn(async () => ({})) }));
vi.mock('./referenceNavigation', () => ({ showLoadedReference: vi.fn(async () => undefined) }));
vi.mock('./plasmidLoader', () => ({
  openPlasmidDatasetFiles: vi.fn(async () => ({ success: true, links: [], problems: [], datasets: [] })),
  loadPlasmidFiles: vi.fn(async () => ({ success: true })),
}));

import type { PipelineJob } from '../api/pipeline';
import { addDataset } from '../api/datasets';
import { loadFasta, loadGenome } from '../api/reference';
import { useBrowserStore } from '../stores/browserStore';
import { openPlasmidDatasetFiles } from './plasmidLoader';
import { openJobResult, openedJobs, parseRegion } from './pipelineResults';

function job(changes: Partial<PipelineJob> = {}): PipelineJob {
  return {
    id: '20260929-120000-abcdef', sample: 'ind', enzyme: 'dddb', outdir: '/o', cores: 4, reads: [], regions: [],
    options: {}, option_labels: [], group: null, command: null, auto_open: true, status: 'done',
    reference: { path: '/g/dm6.fa', kind: 'fasta', label: 'dm6', genome_id: 'dm6' },
    progress: { version: null, steps: [], current_step: null, fraction: 1, eta_s: null, logs: [], warnings: [], settings: null, started: true, done: null },
    outputs: {
      called_bam: '/o/ind.fiberhmm.bam', reference_fasta: '/g/dm6.fa', plasmid_map: null,
      open: { fasta: '/g/dm6.fa', datasets: ['/o/ind.fiberhmm.bam'], plasmid_maps: [], region: 'chr3L:15,038,001-15,052,000' },
    },
    ...changes,
  };
}

describe('opening a finished run', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    useBrowserStore.setState({ datasets: [], currentGenome: null, fastaPath: null } as any);
  });

  it('parses the region', () => {
    // One-based inclusive (the pipeline's format_region) -> zero-based viewport.
    expect(parseRegion('chr3L:15,038,001-15,052,000')).toEqual({ chrom: 'chr3L', start: 15038000, end: 15052000 });
    expect(parseRegion('chrT:1000-2000')).toEqual({ chrom: 'chrT', start: 999, end: 2000 });
    expect(parseRegion('chrT:1-1')).toEqual({ chrom: 'chrT', start: 0, end: 1 });
    expect(parseRegion('chrT:0-10')).toBeNull();
    expect(parseRegion('chrT:20-10')).toBeNull();
    expect(parseRegion('nope')).toBeNull();
  });

  it('loads the catalog genome, the BAM once and goes to the region, even when opened twice at once', async () => {
    const [a, b] = await Promise.all([openJobResult(job()), openJobResult(job())]);
    expect(a.success && b.success).toBe(true);
    expect(loadGenome).toHaveBeenCalledTimes(1);
    expect(loadFasta).not.toHaveBeenCalled();
    expect(addDataset).toHaveBeenCalledTimes(1);
    const state = useBrowserStore.getState();
    expect(state.datasets.map(d => d.path)).toEqual(['/o/ind.fiberhmm.bam']);
    expect([state.chrom, state.start, state.end]).toEqual(['chr3L', 15038000, 15052000]);  // one-based region, zero-based viewport
    expect(openedJobs().has(job().id)).toBe(true);
    // Opening again later: already loaded, nothing added.
    await openJobResult(job());
    expect(addDataset).toHaveBeenCalledTimes(1);
  });

  it('opens a plasmid run through Open plasmid dataset (map + BAM, linked)', async () => {
    await openJobResult(job({
      reference: { path: '/m/pX.dna', kind: 'plasmid_map', label: 'pX.dna' },
      outputs: { called_bam: '/o/p.bam', reference_fasta: '/o/pX.fa', plasmid_map: '/m/pX.dna',
        open: { fasta: null, datasets: ['/o/p.bam'], plasmid_maps: ['/m/pX.dna'], region: null } },
    }));
    expect(openPlasmidDatasetFiles).toHaveBeenCalledWith('/m/pX.dna', ['/o/p.bam'], '/o/pX.fa');
    expect(addDataset).not.toHaveBeenCalled();
  });
});
