import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatasetGenomeCheck, GenomeCheckResponse } from '../../api/genomeCheck';

// The server's answer; each test sets what it says before and after a load.
let current: GenomeCheckResponse;
vi.mock('../../api/genomeCheck', () => ({
  getGenomeCheck: vi.fn(async () => current),
}));
vi.mock('../../api/reference', () => ({
  loadGenome: vi.fn(async (id: string) => ({ success: true, genome_id: id, name: id, fasta_loaded: true })),
  loadFasta: vi.fn(async (path: string) => ({ success: true, path, sequences: 3, inferred_genome: null })),
  loadGtf: vi.fn(async () => ({ success: true, gene_count: 10 })),
  removeGtf: vi.fn(async () => ({ success: true })),
  getChromosomes: vi.fn(async () => ({ chroms: [{ name: 'chr1', size: 248956422 }] })),
}));
vi.mock('../../api/status', () => ({ getStatus: vi.fn(async () => ({ initial_position: null })) }));
vi.mock('../../api/files', () => ({
  pickFile: vi.fn(async (type: string) => ({ success: true, path: type === 'fasta' ? '/refs/custom.fa' : '/refs/custom.gtf' })),
  pickAnyFile: vi.fn(async () => ({ success: true, paths: ['/maps/pFiber.dna'] })),
}));
vi.mock('../../utils/plasmidLoader', async () => {
  const actual = await vi.importActual<typeof import('../../utils/plasmidLoader')>('../../utils/plasmidLoader');
  return { ...actual, loadPlasmidFiles: vi.fn(async (paths: string[]) => ({ success: true, count: paths.length, loaded: [], failed: 0 })) };
});
vi.mock('../../hooks/useAutoSave', () => ({ autoSaveNow: vi.fn(async () => undefined) }));
// fb-r2-genomes: a dataset given a reference of its own (services/panel_genomes.py).
const ownGenome = { key: 'hg38', label: 'hg38', kind: 'registry', genome_id: 'hg38', assembly: 'hg38', fasta_path: '/g/hg38.fa',
  gtf_path: null, has_fasta: true, has_gtf: true, gene_count: 10, n_chroms: 1, chroms: [{ name: 'chr19', size: 58617616 }] };
vi.mock('../../api/panelGenomes', () => ({
  attachPanelGenome: vi.fn(async () => ({ success: true, genome: ownGenome, main: false,
    loci: { ds1: { chrom: 'chr19', start: 47513800, end: 47517900 } } })),
  getPanelGenomes: vi.fn(async () => ({ main: { genome_id: 'dm6', fasta_path: null }, genomes: [ownGenome], datasets: { ds1: 'hg38' } })),
  detachPanelGenome: vi.fn(async () => ({ success: true })),
}));
// The best-covered loci of the dataset the genome was loaded for (M15).
vi.mock('../../api/coverage', () => ({
  getTopCoveredWindows: vi.fn(async () => ({ success: true, windows: [{ chrom: 'chr19', start: 47513800, end: 47517900, depth: 3200 }] })),
}));

import { loadGenome, loadFasta, loadGtf, removeGtf } from '../../api/reference';
import { pickAnyFile, pickFile } from '../../api/files';
import { loadPlasmidFiles } from '../../utils/plasmidLoader';
import { useBrowserStore } from '../../stores/browserStore';
import { blockingProblemFor, findReadsPromptAllowed, useGenomeCheckStore } from '../../stores/genomeCheckStore';
import { GenomeMismatchBanner, GenomeMismatchNotice } from './GenomeMismatchBanner';
import { resetTopLoci } from '../../utils/topLoci';
import { GenomeSuggestionHint } from './sidebar/genome/GenomeSuggestionHint';
import { setLaunchUi } from '../../utils/launchSession';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const assembly = (id: string | null, kind: 'genome' | 'plasmid' = 'genome') => ({
  assembly: id, name: id, short: id, confidence: id ? 'high' as const : 'none' as const, kind,
  naming: id ? 'ucsc' as const : null, in_registry: Boolean(id), declared: null, conflicts: [],
});




const details = { missing: [], length_differs: [], renamed: [], sequence_differs: [], ignored: [], notes: [] };

/** A synthetic genome: contigs no known assembly has. */
function synthetic(id = 'ds1'): DatasetGenomeCheck {
  return {
    dataset_id: id, label: 'synthetic_A', assembly: { ...assembly(null), kind: 'unknown' as const },
    reference: { label: 'hg38', assembly: 'hg38', kind: 'registry' },
    status: 'different_assembly', severity: 'error',
    message: "None of synthetic_A's contigs (synth1, synth2) are in hg38, so it shows no reads.",
    suggestion: null, known_not_in_registry: false,
    details: { ...details, missing: [{ contig: 'synth1', length: 7040000 }, { contig: 'synth2', length: 7040000 }] },
  };
}
function response(problems: DatasetGenomeCheck[]): GenomeCheckResponse {
  return {
    reference: { kind: 'registry', label: 'hg38', assembly: 'hg38', name: 'hg38', genome_id: 'hg38', n_contigs: 455, partial: false },
    datasets: problems, problems, suggestion: null, can_load_genomes: true, has_gtf: false,
  } as GenomeCheckResponse;
}
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

describe('a custom or synthetic genome (contigs in no known assembly)', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    try { sessionStorage.clear(); localStorage.clear(); } catch { /* jsdom */ }
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useBrowserStore.setState({ datasets: [{ id: 'ds1', label: 'synthetic_A' }], publicMode: false } as any);
    useGenomeCheckStore.setState({ check: null, dismissed: [], customGenomes: [], loadingGenome: null });
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  it('offers "Use as a custom genome (no reference)"; once chosen it is remembered and never flagged again', async () => {
    current = response([synthetic()]);
    await act(async () => { root.render(<GenomeMismatchBanner />); await flush(); });
    const use = container.querySelector<HTMLButtonElement>('[data-testid="genome-use-custom"]');
    expect(use?.textContent).toBe('Use as a custom genome (no reference)');
    expect(blockingProblemFor(current, 'ds1')).not.toBeNull();
    await act(async () => { use!.click(); await flush(); });
    expect(container.querySelector('[data-testid="genome-mismatch-banner"]')).toBeNull();
    expect(blockingProblemFor(current, 'ds1')).toBeNull();  // the read panel no longer says "wrong reference" either
    expect(JSON.parse(localStorage.getItem('fiberhmm_custom_genome_datasets') || '[]')).toEqual(['ds1|synth1:7040000,synth2:7040000']);
    // A new page (the store re-read from storage), even with another reference loaded: still not flagged.
    useGenomeCheckStore.setState({ customGenomes: JSON.parse(localStorage.getItem('fiberhmm_custom_genome_datasets')!) });
    current = { ...response([{ ...synthetic(), reference: { label: 'dm6', assembly: 'dm6', kind: 'registry' } }]) };
    await act(async () => { await useGenomeCheckStore.getState().refresh(); await flush(); });
    expect(container.querySelector('[data-testid="genome-mismatch-banner"]')).toBeNull();
  });

  it('is not offered when a known assembly fits (the usual suggestion stays)', async () => {
    current = response([{ ...synthetic(), assembly: assembly('dm6'), suggestion: { genome_id: 'dm6', name: 'dm6', confidence: 'high', cached: true, can_load: true } } as DatasetGenomeCheck]);
    await act(async () => { root.render(<GenomeMismatchBanner />); await flush(); });
    expect(container.querySelector('[data-testid="genome-mismatch-banner"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="genome-use-custom"]')).toBeNull();
  });
});
