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

function problem(over: Partial<DatasetGenomeCheck> = {}): DatasetGenomeCheck {
  return {
    dataset_id: 'ds1', label: 'napa_ddda.bam', assembly: assembly('hg38'),
    reference: { label: 'dm6', assembly: 'dm6', kind: 'fasta' },
    status: 'different_assembly', severity: 'error',
    message: 'napa_ddda.bam was aligned to hg38, but dm6 is loaded — reads won\'t line up with the reference.',
    suggestion: { genome_id: 'hg38', name: 'Human (GRCh38/hg38)', confidence: 'high', cached: true, can_load: true },
    known_not_in_registry: false, details, ...over,
  };
}

function response(problems: DatasetGenomeCheck[], over: Partial<GenomeCheckResponse> = {}): GenomeCheckResponse {
  return {
    reference: { kind: 'fasta', label: 'dm6', assembly: 'dm6', name: 'dm6', genome_id: 'dm6', n_contigs: 8, partial: false },
    datasets: problems, problems, suggestion: problems[0]?.suggestion ?? null, can_load_genomes: true, has_gtf: false, ...over,
  };
}

const fixed = response([], { reference: { kind: 'fasta', label: 'hg38', assembly: 'hg38', name: 'hg38', genome_id: 'hg38', n_contigs: 455, partial: false } });

async function flush() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

describe('GenomeMismatchBanner', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    resetTopLoci();
    try { sessionStorage.clear(); } catch { /* jsdom */ }
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useBrowserStore.setState({ datasets: [{ id: 'ds1', label: 'napa_ddda.bam' }], publicMode: false } as any);
    useGenomeCheckStore.setState({ check: null, dismissed: [], loadingGenome: null });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(node: React.ReactNode = <GenomeMismatchBanner />) {
    await act(async () => { root.render(node); await flush(); });
  }
  const buttons = () => [...container.querySelectorAll('[data-testid="genome-mismatch-actions"] button')].map(b => b.textContent);
  const click = async (testId: string) => {
    // The loaders that replace the genome sit in the "Other reference" menu when "Open … in its own panel" is offered.
    if (!container.querySelector(`[data-testid="${testId}"]`)) {
      await act(async () => {
        (container.querySelector('[data-testid="genome-mismatch-own-reference"]') as HTMLButtonElement).click();
        await flush();
      });
    }
    await act(async () => {
      (container.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement).click();
      await flush();
    });
  };

  // M10: while a session is being reopened the page is half-restored; the
  // banner (and its live buttons) waits until the restore is done.
  it('stays hidden while a session is being reopened, then shows', async () => {
    current = response([problem()]);
    act(() => setLaunchUi({ restoring: true }));
    await render(<><GenomeMismatchBanner /><GenomeMismatchNotice problem={problem()} /></>);
    expect(container.querySelector('[data-testid="genome-mismatch-banner"]')).toBeNull();
    expect(container.querySelector('[data-testid="genome-mismatch-notice-ds1"]')).toBeNull();
    await act(async () => { setLaunchUi({ restoring: false }); await flush(); });
    expect(container.querySelector('[data-testid="genome-mismatch-banner"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="genome-mismatch-notice-ds1"]')).not.toBeNull();
  });

  it('names both assemblies and offers the genome first, then your own files, then Dismiss', async () => {
    current = response([problem()]);
    await render();
    const banner = container.querySelector('[data-testid="genome-mismatch-banner"]')!;
    expect(banner.getAttribute('data-severity')).toBe('error');
    expect(banner.textContent).toContain('napa_ddda.bam was aligned to hg38, but dm6 is loaded');
    // fb-r2-genomes: its own panel first (the main genome stays), then switching every panel, then other references.
    expect(buttons()).toEqual(['Open with hg38 in its own panel', 'Switch to hg38', 'Other reference', 'Dismiss']);
  });

  // M14: one truncated line hid which genome is loaded ("…aligned to dm…") at
  // 1024 px; the message now wraps to two lines before it is cut.
  it('the message wraps to two lines (whole text on hover) and the actions wrap beside it', async () => {
    current = response([problem()]);
    await render();
    const banner = container.querySelector('[data-testid="genome-mismatch-banner"]')!;
    expect(banner.textContent).toContain('Genome mismatch');
    const lead = banner.firstElementChild as HTMLElement;
    expect(lead.title).toContain('napa_ddda.bam was aligned to hg38, but dm6 is loaded');
    const text = lead.querySelector('[data-testid="genome-mismatch-text"]') as HTMLElement;
    expect(text.textContent).toContain('napa_ddda.bam was aligned to hg38, but dm6 is loaded');
    expect(text.className).toContain('line-clamp-2');
    expect(text.className).not.toContain('truncate');
    expect(banner.className).toContain('flex-wrap');
    expect(lead.contains(container.querySelector('[data-testid="genome-mismatch-actions"]'))).toBe(false);
  });

  // fb-r2-genomes: the dataset keeps hg38 in its own panel; dm6 stays the main genome.
  it('opens the dataset with the suggested genome in its own panel, the main genome unchanged', async () => {
    const { attachPanelGenome } = await import('../../api/panelGenomes');
    useBrowserStore.setState({
      currentGenome: 'dm6', chrom: 'chr2L', start: 0, end: 20000,
      panels: [{ id: 'p1', contentType: 'dataset', datasetId: 'ds1', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0 }],
    } as any);
    current = response([problem()]);
    await render();
    current = fixed;
    await click('genome-mismatch-own-genome');
    expect(attachPanelGenome).toHaveBeenCalledWith(expect.objectContaining({ dataset_ids: ['ds1'], genome_id: 'hg38' }));
    expect(loadGenome).not.toHaveBeenCalled();
    const s = useBrowserStore.getState();
    expect(s.currentGenome).toBe('dm6');
    expect([s.chrom, s.start, s.end]).toEqual(['chr2L', 0, 20000]);
    const panel = s.panels.find(p => p.id === 'p1')!;
    expect(panel.genome).toBe('hg38');
    expect(panel.viewportOverride).toEqual({ chrom: 'chr19', start: 47513800, end: 47517900 });
    expect(panel.siteLocked).toBe(false);
  });

  it('loads the suggested genome and clears once it matches', async () => {
    current = response([problem()]);
    await render();
    current = fixed;
    await click('genome-mismatch-load-genome');
    expect(loadGenome).toHaveBeenCalledWith('hg38');
    expect(useBrowserStore.getState().currentGenome).toBe('hg38');
    expect(container.querySelector('[data-testid="genome-mismatch-banner"]')).toBeNull();
  });

  // M15: Load hg38 jumped to the first contig at 0-20,000, not to the data.
  it('after loading the genome, the view goes to the mismatched dataset\'s reads', async () => {
    useBrowserStore.setState({ chrom: 'chr2L', start: 0, end: 20000 } as any);
    current = response([problem()]);
    await render();
    current = fixed;
    await click('genome-mismatch-load-genome');
    const { getTopCoveredWindows } = await import('../../api/coverage');
    await vi.waitFor(() => expect(useBrowserStore.getState().chrom).toBe('chr19'));
    expect(getTopCoveredWindows).toHaveBeenCalledWith(expect.any(Number), 'ds1', 20, expect.objectContaining({ fit: true }));
    const s = useBrowserStore.getState();
    expect([s.chrom, s.start, s.end]).toEqual(['chr19', 47513800, 47517900]);
  });

  it('goes to the reads of the dataset the offered genome is for', async () => {
    useBrowserStore.setState({ datasets: [{ id: 'ds1', label: 'odd.bam' }, { id: 'ds2', label: 'napa_ddda.bam' }] } as any);
    current = response([
      problem({ dataset_id: 'ds1', label: 'odd.bam', suggestion: null, known_not_in_registry: true }),
      problem({ dataset_id: 'ds2' }),
    ]);
    await render();
    current = fixed;
    await click('genome-mismatch-load-genome');
    const { getTopCoveredWindows } = await import('../../api/coverage');
    await vi.waitFor(() => expect(getTopCoveredWindows).toHaveBeenCalled());
    expect((getTopCoveredWindows as any).mock.calls[0][1]).toBe('ds2');
  });

  it('an unrecognised reference offers your own FASTA, GTF and plasmid map (no genome)', async () => {
    current = response([problem({
      assembly: assembly(null, 'plasmid'), status: 'missing_contigs', suggestion: null,
      message: 'None of amplicon.bam\'s contigs (pFiber) are in dm6, so it shows no reads. Load the reference it was aligned to.',
    })], { suggestion: null });
    await render();
    expect(buttons()).toEqual(['Load FASTA…', 'Load GTF…', 'Load plasmid map…', 'Own reference', 'Dismiss']);
  });

  it('a plasmid map goes through the plasmid loader (matched to the BAM by sequence) and clears the banner', async () => {
    current = response([problem({ assembly: assembly(null, 'plasmid'), status: 'missing_contigs', suggestion: null })], { suggestion: null });
    await render();
    current = response([], { reference: { kind: 'fasta', label: 'dm6', assembly: 'dm6', name: 'dm6', genome_id: 'dm6', n_contigs: 9, partial: false } });
    await click('genome-mismatch-load-plasmid');
    expect(pickAnyFile).toHaveBeenCalled();
    expect(loadPlasmidFiles).toHaveBeenCalledWith(['/maps/pFiber.dna']);
    expect(container.querySelector('[data-testid="genome-mismatch-banner"]')).toBeNull();
  });

  it('a FASTA and a GTF use the reference loaders, then re-check', async () => {
    current = response([problem()]);
    await render();
    await click('genome-mismatch-load-gtf');
    expect(pickFile).toHaveBeenCalledWith('gtf');
    expect(loadGtf).toHaveBeenCalledWith('/refs/custom.gtf');
    expect(container.querySelector('[data-testid="genome-mismatch-banner"]')).not.toBeNull();  // still wrong
    current = fixed;
    await click('genome-mismatch-load-fasta');
    await act(async () => { await flush(); });
    expect(pickFile).toHaveBeenCalledWith('fasta');
    expect(loadFasta).toHaveBeenCalledWith('/refs/custom.fa');
    expect(useBrowserStore.getState().fastaPath).toBe('/refs/custom.fa');
    expect(container.querySelector('[data-testid="genome-mismatch-banner"]')).toBeNull();
  });

  it('Load FASTA after Load GTF keeps the annotation just loaded', async () => {
    current = response([problem()], { has_gtf: true });
    await render();
    await click('genome-mismatch-load-gtf');
    await click('genome-mismatch-load-fasta');
    expect(loadFasta).toHaveBeenCalledWith('/refs/custom.fa');
    expect(removeGtf).not.toHaveBeenCalled();
  });

  it('Dismiss hides it until the reference changes', async () => {
    current = response([problem()]);
    await render();
    await click('genome-mismatch-dismiss');
    expect(container.querySelector('[data-testid="genome-mismatch-banner"]')).toBeNull();
    current = response([problem({ reference: { label: 'mm10', assembly: 'mm10', kind: 'fasta' },
      message: 'napa_ddda.bam was aligned to hg38, but mm10 is loaded — reads won\'t line up with the reference.' })]);
    await act(async () => { await useGenomeCheckStore.getState().refresh(); });
    expect(container.textContent).toContain('but mm10 is loaded');
  });

  it('goes away with the last dataset', async () => {
    current = response([problem()]);
    await render();
    expect(container.querySelector('[data-testid="genome-mismatch-banner"]')).not.toBeNull();
    await act(async () => { useBrowserStore.setState({ datasets: [] } as any); await flush(); });
    expect(container.querySelector('[data-testid="genome-mismatch-banner"]')).toBeNull();
  });

  it('on a public server it only reports', async () => {
    useBrowserStore.setState({ publicMode: true } as any);
    current = response([problem({ suggestion: { ...problem().suggestion!, can_load: false } })], { can_load_genomes: false });
    await render();
    expect(container.textContent).toContain('aligned to hg38');
    expect(buttons()).toEqual(['Dismiss']);
  });

  it('a warning (a contig missing, the rest fine) is amber and names the contig', async () => {
    current = response([problem({ status: 'missing_contigs', severity: 'warning', suggestion: null,
      message: 'pFiber is in with_plasmid.bam but not in hg38; reads there won\'t show.' })], { suggestion: null });
    await render();
    expect(container.querySelector('[data-testid="genome-mismatch-banner"]')!.getAttribute('data-severity')).toBe('warning');
    expect(container.textContent).toContain('pFiber is in with_plasmid.bam but not in hg38');
  });

  it('the genome picker suggests the BAM\'s genome', async () => {
    current = response([], {
      reference: { kind: 'none', label: null, assembly: null, name: null, genome_id: null, n_contigs: 0, partial: false },
      suggestion: { genome_id: 'dm6', name: 'D. melanogaster (dm6)', confidence: 'high', cached: false, can_load: true, datasets: ['fly.bam'] },
    });
    await act(async () => { await useGenomeCheckStore.getState().refresh(); });
    await render(<GenomeSuggestionHint />);
    expect(container.textContent).toContain('Suggested from your BAM: dm6');
    await click('genome-suggestion-load');
    expect(loadGenome).toHaveBeenCalledWith('dm6');
  });
});

describe('a mismatch takes precedence over "go to this dataset\'s reads"', () => {
  it('no find-reads prompt (a jump to the best-covered locus) on the wrong reference', () => {
    const wrong = response([problem()]);
    const blocking = blockingProblemFor(wrong, 'ds1');
    expect(blocking?.status).toBe('different_assembly');
    expect(findReadsPromptAllowed(0, null, blocking)).toBe(false);
  });

  it('unchanged when the dataset fits (or only a contig is missing)', () => {
    expect(findReadsPromptAllowed(0, null, blockingProblemFor(fixed, 'ds1'))).toBe(true);
    const warning = response([problem({ status: 'missing_contigs', severity: 'warning' })]);
    expect(findReadsPromptAllowed(0, null, blockingProblemFor(warning, 'ds1'))).toBe(true);
    expect(findReadsPromptAllowed(0, 'chr2', null)).toBe(false);  // a panel at its own locus, as before
    expect(findReadsPromptAllowed(5, null, null)).toBe(false);
  });

  it('the read track shows the mismatch and its actions instead', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    useBrowserStore.setState({ publicMode: false } as any);
    await act(async () => { root.render(<GenomeMismatchNotice problem={problem()} />); await flush(); });
    expect(container.textContent).toContain('Wrong reference for this dataset');
    expect(container.textContent).toContain('aligned to hg38, but dm6 is loaded');
    // M14: the banner already offers the file loaders; the panel's card keeps the one fix.
    const labels = [...container.querySelectorAll('button')].map(b => b.textContent);
    expect(labels).toEqual(['Open with hg38 in its own panel', 'Switch to hg38']);
    act(() => root.unmount());
    container.remove();
  });
});

// fb-r3-nav: several datasets on the same wrong genome are opened together (one linked
// group); opening one alone among other panels switches the navigation to Per panel.
describe('datasets on the same wrong genome (fb-r3-nav)', () => {
  let container: HTMLDivElement;
  let root: Root;
  const plain = (id: string, datasetId: string) => ({ id, contentType: 'dataset', datasetId, subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0 });
  const two = () => response([problem(), problem({ dataset_id: 'ds2', label: 'napa_hia5.bam',
    message: 'napa_hia5.bam was aligned to hg38, but dm6 is loaded — reads won\'t line up with the reference.' })]);
  const L1 = { chrom: 'chr19', start: 47513800, end: 47517900 };
  const L2 = { chrom: 'chr1', start: 1_000_000, end: 1_004_100 };

  beforeEach(() => {
    vi.clearAllMocks();
    try { sessionStorage.clear(); } catch { /* jsdom */ }
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useBrowserStore.setState({
      datasets: [{ id: 'ds1', label: 'napa_ddda.bam' }, { id: 'ds2', label: 'napa_hia5.bam' }, { id: 'fly', label: 'fly.bam' }],
      publicMode: false, currentGenome: 'dm6', chrom: 'chr2L', start: 0, end: 20000, navigationMode: 'linked', navigationNotice: null,
      panels: [plain('p1', 'ds1'), plain('p2', 'ds2'), plain('p3', 'fly')],
    } as any);
    useGenomeCheckStore.setState({ check: null, dismissed: [], loadingGenome: null });
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  const render = async (node: React.ReactNode = <GenomeMismatchBanner />) => {
    await act(async () => { root.render(node); await flush(); });
  };
  const press = async (testId: string) => {
    await act(async () => {
      (container.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement).click();
      await flush();
    });
  };
  const labels = () => [...container.querySelectorAll('[data-testid$="-actions"] > button, [data-testid$="-actions"] > div > button')].map(b => b.textContent);
  const panelAt = (id: string) => useBrowserStore.getState().panels.find(p => p.id === id)!;

  it('the banner offers one action for all of them, and one dataset at a time beside it', async () => {
    current = two();
    await render();
    expect(labels()).toEqual(['Open all 2 hg38 datasets with hg38', 'One dataset', 'Switch to hg38', 'Other reference', 'Dismiss']);
    await press('genome-mismatch-own-genome-one');
    const items = [...container.querySelectorAll('[data-testid="genome-mismatch-own-genome-one-menu"] button')].map(b => b.textContent);
    expect(items).toEqual(['Open napa_ddda.bam with hg38', 'Open napa_hia5.bam with hg38']);
  });

  it('all of them together: one hg38 link group, the navigation stays Linked', async () => {
    const { attachPanelGenome, getPanelGenomes } = await import('../../api/panelGenomes');
    (attachPanelGenome as any).mockResolvedValueOnce({ success: true, genome: ownGenome, main: false, loci: { ds1: L1, ds2: L2 } });
    (getPanelGenomes as any).mockResolvedValueOnce({ main: { genome_id: 'dm6', fasta_path: null }, genomes: [ownGenome], datasets: { ds1: 'hg38', ds2: 'hg38' } });
    current = two();
    await render();
    current = fixed;
    await press('genome-mismatch-own-genome');
    expect(attachPanelGenome).toHaveBeenCalledWith(expect.objectContaining({ dataset_ids: ['ds1', 'ds2'], genome_id: 'hg38' }));
    expect(useBrowserStore.getState().navigationMode).toBe('linked');
    expect(panelAt('p1').viewportOverride).toEqual(L1);
    expect(panelAt('p2').viewportOverride).toEqual(L1);
    // Moving one moves the other.
    act(() => useBrowserStore.getState().navigatePanel('p2', 'chr7', 100, 4_100));
    expect(panelAt('p1').viewportOverride).toEqual({ chrom: 'chr7', start: 100, end: 4_100 });
  });

  it('one dataset in its own panel among others: Per panel, said briefly, one undo step', async () => {
    current = response([problem()]);
    await render();
    current = fixed;
    await press('genome-mismatch-own-genome');
    const { attachPanelGenome } = await import('../../api/panelGenomes');
    expect(attachPanelGenome).toHaveBeenCalledWith(expect.objectContaining({ dataset_ids: ['ds1'] }));
    const s = useBrowserStore.getState();
    expect(s.navigationMode).toBe('perPanel');
    expect(s.navigationNotice).toMatch(/Switched to Per panel/);
    expect(panelAt('p1').viewportOverride).toEqual(L1);
    expect(panelAt('p3').viewportOverride).toEqual({ chrom: 'chr2L', start: 0, end: 20000 });
    expect(s.getHistoryLabels().at(-1)?.label).toBe('Open napa_ddda.bam with hg38: each panel navigates');
    act(() => useBrowserStore.getState().undo());
    expect(useBrowserStore.getState().navigationMode).toBe('linked');
    expect(panelAt('p1').genome).toBe('hg38');
  });

  it('the panel notice offers all of them first, and only this one beside it', async () => {
    current = two();
    await act(async () => { await useGenomeCheckStore.getState().refresh(); });
    await render(<GenomeMismatchNotice problem={two().problems[1]} />);
    const buttonsShown = [...container.querySelectorAll('button')].map(b => b.textContent);
    expect(buttonsShown).toEqual(['Open all 2 hg38 datasets with hg38', 'Only this one', 'Switch to hg38']);
    current = fixed;
    await press('genome-mismatch-notice-ds2-own-genome-one');
    const { attachPanelGenome } = await import('../../api/panelGenomes');
    expect(attachPanelGenome).toHaveBeenCalledWith(expect.objectContaining({ dataset_ids: ['ds2'] }));
  });
});

describe('the banner menus from the keyboard (Codex, fb-r3-nav)', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useBrowserStore.setState({ datasets: [{ id: 'ds1', label: 'a.bam' }, { id: 'ds2', label: 'b.bam' }], publicMode: false } as any);
    useGenomeCheckStore.setState({ check: null, dismissed: [], loadingGenome: null });
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  it('arrow keys move in the "One dataset" menu (not the view); Escape closes it', async () => {
    current = response([problem(), problem({ dataset_id: 'ds2', label: 'b.bam' })]);
    await act(async () => { root.render(<GenomeMismatchBanner />); await flush(); });
    const seen: string[] = [];
    const onWindow = (e: KeyboardEvent) => seen.push(e.key);
    window.addEventListener('keydown', onWindow);
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="genome-mismatch-own-genome-one"]')!;
    trigger.focus();
    const key = (key: string) => act(() => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); });
    key('ArrowDown');
    const items = [...container.querySelectorAll<HTMLButtonElement>('[data-testid="genome-mismatch-own-genome-one-menu"] [role="menuitem"]')];
    expect(items).toHaveLength(2);
    expect(document.activeElement).toBe(items[0]);
    key('ArrowDown');
    expect(document.activeElement).toBe(items[1]);
    key('ArrowDown');
    expect(document.activeElement).toBe(items[0]);
    key('Escape');
    expect(container.querySelector('[data-testid="genome-mismatch-own-genome-one-menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(seen).toEqual([]);
    window.removeEventListener('keydown', onWindow);
  });
});
