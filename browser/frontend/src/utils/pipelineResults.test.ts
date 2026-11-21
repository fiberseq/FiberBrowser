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
vi.mock('../api/pipeline', () => ({ markJobOpened: vi.fn(async () => ({ claimed: true, opened_at: 1, reason: null })) }));
vi.mock('../api/genomeCheck', () => ({ getGenomeCheck: vi.fn(async () => ({ datasets: [] })) }));
vi.mock('../stores/panelGenomeStore', () => {
  const attach = vi.fn(async () => ({ success: true, genome: null }));
  return { usePanelGenomeStore: { getState: () => ({ attach }) } };
});
vi.mock('./referenceNavigation', () => ({ showLoadedReference: vi.fn(async () => undefined) }));
vi.mock('./plasmidLoader', () => ({
  openPlasmidDatasetFiles: vi.fn(async () => ({ success: true, links: [], problems: [], datasets: [] })),
  loadPlasmidFiles: vi.fn(async () => ({ success: true })),
}));

import type { PipelineJob } from '../api/pipeline';
import { addDataset } from '../api/datasets';
import { getGenomeCheck } from '../api/genomeCheck';
import { markJobOpened } from '../api/pipeline';
import { loadFasta, loadGenome } from '../api/reference';
import { useBrowserStore } from '../stores/browserStore';
import { usePanelGenomeStore } from '../stores/panelGenomeStore';
import { openPlasmidDatasetFiles } from './plasmidLoader';
import { autoOpenCandidate, openJobResult, pageOpenerId, parseRegion } from './pipelineResults';

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
    useBrowserStore.setState({ datasets: [], currentGenome: null, fastaPath: null, hasFasta: false } as any);
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
    // Open in browser records the opening on the server (no page opens it by itself afterwards).
    expect(markJobOpened).toHaveBeenCalledWith(job().id);
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

  it('never replaces an open genome: a result on another genome opens in its own panel with that genome', async () => {
    useBrowserStore.setState({ currentGenome: 'hg38', hasFasta: true, fastaPath: null, chrom: 'chr1', start: 100, end: 200 } as any);
    const result = await openJobResult(job(), { claimed: true });
    expect(result.success).toBe(true);
    expect(result.ownPanel).toBe(true);
    expect(loadGenome).not.toHaveBeenCalled();
    expect(loadFasta).not.toHaveBeenCalled();
    expect(markJobOpened).not.toHaveBeenCalled();  // claimed already (the automatic opening)
    const attach = usePanelGenomeStore.getState().attach;
    expect(attach).toHaveBeenCalledWith({ dataset_ids: ['ds-undefined'], genome_id: 'dm6' }, { perPanel: true });
    const state = useBrowserStore.getState();
    expect(state.currentGenome).toBe('hg38');  // the open genome stays, and so does the main view
    expect([state.chrom, state.start, state.end]).toEqual(['chr1', 100, 200]);
  });

  it('a FASTA run on another reference gets that FASTA in its own panel; the open FASTA stays', async () => {
    useBrowserStore.setState({ currentGenome: null, hasFasta: true, fastaPath: '/ref/other.fa' } as any);
    vi.mocked(getGenomeCheck).mockResolvedValueOnce({ datasets: [{ dataset_id: 'ds-undefined', status: 'different_assembly' }] } as any);
    const fastaJob = job({ reference: { path: '/o/genome.fa', kind: 'fasta', label: 'genome.fa' },
      outputs: { called_bam: '/o/s.bam', reference_fasta: '/o/genome.fa', plasmid_map: null,
        open: { fasta: '/o/genome.fa', datasets: ['/o/s.bam'], plasmid_maps: [], region: null } } });
    const result = await openJobResult(fastaJob);
    expect(result.ownPanel).toBe(true);
    expect(loadFasta).not.toHaveBeenCalled();
    expect(usePanelGenomeStore.getState().attach).toHaveBeenCalledWith({ dataset_ids: ['ds-undefined'], fasta_path: '/o/genome.fa' }, { perPanel: true });
    expect(useBrowserStore.getState().fastaPath).toBe('/ref/other.fa');
  });

  it('a result that fits the open genome (e.g. the run copy of the same FASTA) stays on it and goes to the region', async () => {
    useBrowserStore.setState({ currentGenome: 'dm6', hasFasta: true, fastaPath: '/ref/dm6.fa' } as any);
    vi.mocked(getGenomeCheck).mockResolvedValueOnce({ datasets: [{ dataset_id: 'ds-undefined', status: 'match' }] } as any);
    const copy = job({ reference: { path: '/ref/dm6.fa', kind: 'fasta', label: 'dm6.fa' },
      outputs: { called_bam: '/o/s.bam', reference_fasta: '/o/dm6.fa', plasmid_map: null,
        open: { fasta: '/o/dm6.fa', datasets: ['/o/s.bam'], plasmid_maps: [], region: 'chr2L:1001-2000' } } });
    const result = await openJobResult(copy);
    expect(result.success && !result.ownPanel).toBe(true);
    expect(loadFasta).not.toHaveBeenCalled();
    expect(usePanelGenomeStore.getState().attach).not.toHaveBeenCalled();
    const state = useBrowserStore.getState();
    expect([state.fastaPath, state.chrom, state.start, state.end]).toEqual(['/ref/dm6.fa', 'chr2L', 1000, 2000]);
  });

  it('the same genome open: only the BAM is added', async () => {
    useBrowserStore.setState({ currentGenome: 'dm6', hasFasta: true } as any);
    await openJobResult(job());
    expect(loadGenome).not.toHaveBeenCalled();
    expect(usePanelGenomeStore.getState().attach).not.toHaveBeenCalled();
    expect(useBrowserStore.getState().datasets.map(d => d.path)).toEqual(['/o/ind.fiberhmm.bam']);
  });
});

describe('automatic opening', () => {
  beforeEach(() => { window.sessionStorage.clear(); });

  it('gives each page one opener token, kept for the tab', () => {
    const id = pageOpenerId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(pageOpenerId()).toBe(id);
    expect(window.sessionStorage.getItem('fiberbrowser.dafRun.opener')).toBe(id);
  });

  it('opens only a finished run this page started, that asked for it and was never opened', () => {
    const mine = 'tab-aaaaaaaaaaaa';
    const done = (changes: Partial<PipelineJob>) => job({ opener: mine, opened_at: null, ...changes });
    expect(autoOpenCandidate([done({})], mine, new Set())?.id).toBe(job().id);
    expect(autoOpenCandidate([done({ opener: 'tab-bbbbbbbbbbbb' })], mine, new Set())).toBeNull();  // another window, profile or origin
    expect(autoOpenCandidate([done({ opener: null })], mine, new Set())).toBeNull();  // from before the server kept it
    expect(autoOpenCandidate([done({ opened_at: 123 })], mine, new Set())).toBeNull();  // opened already, anywhere
    expect(autoOpenCandidate([done({ auto_open: false })], mine, new Set())).toBeNull();
    expect(autoOpenCandidate([done({ status: 'running' })], mine, new Set())).toBeNull();
    expect(autoOpenCandidate([done({ outputs: null })], mine, new Set())).toBeNull();
    expect(autoOpenCandidate([done({})], mine, new Set([job().id]))).toBeNull();  // asked once already
  });
});
