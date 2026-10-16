import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../../api/footprints';
import * as reference from '../../../api/reference';
import { useBrowserStore } from '../../../stores/browserStore';
import { CartEntryInspect } from './CartEntryInspect';
import type { FootprintGroup } from '../../../types';

vi.mock('../../../api/footprints', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../api/footprints')>()),
  analyzeFootprints: vi.fn(),
}));
vi.mock('../../../api/reference', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../api/reference')>()),
  declareGenome: vi.fn(),
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const wait = (ms: number) => act(async () => { await new Promise(r => setTimeout(r, ms)); });
const q = (c: HTMLElement, id: string) => c.querySelector<HTMLElement>(`[data-testid="${id}"]`);

const CONTIG = 'chr1_ins7471_alt';
const group = { id: 'g1', name: 'class 7', color: '#10b981', layer: null, referenceChrom: CONTIG, referenceAbsStart: 5772, referenceAbsEnd: 5805 } as unknown as FootprintGroup;
const FALLBACK_NOTE = 'No genome is declared for this sequence: JASPAR CORE vertebrates are scanned. Declare the genome it comes from for that species\' motifs.';

function result(species: NonNullable<api.FootprintAnalysisResult['jaspar_species']>, warnings: string[] = []) {
  return {
    success: true, warnings,
    footprints: [{ absStart: 5772, absEnd: 5805, size: 33, sequence: 'GGGGCCACCTGGTGGTCAG', seq_start: 5765,
      motif_hits: [{ motif_id: 'MA0139.2', motif_name: 'CTCF', start: 3, end: 18, strand: '-', rel_score: 0.95, matched_seq: 'ACCACCAGGTGGCCC', p: 3e-7 }] }],
    jaspar_species: species,
    motif_scoring: { mode: 'p', p: 1e-4, relative: 0.85, background: 'genome', pinned: [] },
  } as unknown as api.FootprintAnalysisResult;
}

describe('Class card motifs on an expanded insert or a custom FASTA', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    localStorage.clear();
    useBrowserStore.setState({ chrom: CONTIG, start: 5300, end: 6300, hasFasta: true, currentGenome: null, motifScoreMode: 'p',
      motifPValue: 1e-4, motifThreshold: 0.85, pinnedMotifs: {}, customMotifs: [], orthogonalTracks: [] } as never);
    vi.mocked(reference.declareGenome).mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  it('an expanded insert scans its source genome\'s species, with nothing to declare', async () => {
    vi.mocked(api.analyzeFootprints).mockReset().mockResolvedValue(
      result({ genome: 'hg38', taxid: 9606, name: 'human', inferred: false, inherited: true }));
    await act(async () => root.render(<CartEntryInspect group={group} targetDatasetIds={['alt']} width={500} />));
    await wait(30);
    expect(q(container, 'entry-motif-controls')!.textContent).toContain('Motifs: JASPAR human (hg38, the genome it was built from)');
    expect(q(container, 'entry-motif-declare')).toBeNull();
    expect(container.textContent).toContain('CTCF');
    expect(container.textContent).not.toContain('No genome selected');
  });

  it('a custom FASTA falls back to vertebrates with a note, and declaring hg38 rescans with human', async () => {
    vi.mocked(api.analyzeFootprints).mockReset().mockResolvedValue(
      result({ genome: null, taxid: null, name: 'vertebrates', inferred: false, fallback: true, tax_group: 'vertebrates' }, [FALLBACK_NOTE]));
    await act(async () => root.render(<CartEntryInspect group={group} targetDatasetIds={['alt']} width={500} />));
    await wait(30);
    expect(q(container, 'entry-motif-controls')!.textContent).toContain('Motifs: JASPAR vertebrates (no genome declared)');
    expect(container.textContent).toContain(FALLBACK_NOTE);
    const select = q(container, 'entry-motif-declare') as HTMLSelectElement;
    expect(select.value).toBe('');
    expect([...select.options].map(o => o.value)).toContain('hg38');

    const calls = vi.mocked(api.analyzeFootprints).mock.calls.length;
    // As the real declareGenome: success bumps the shared reference revision.
    vi.mocked(reference.declareGenome).mockImplementation(async () => {
      useBrowserStore.getState().bumpReferenceRevision();
      return { success: true, genome: 'hg38' };
    });
    vi.mocked(api.analyzeFootprints).mockResolvedValue(
      result({ genome: 'hg38', taxid: 9606, name: 'human', inferred: false, declared: true }));
    await act(async () => {
      select.value = 'hg38';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await wait(30);
    expect(vi.mocked(reference.declareGenome)).toHaveBeenCalledWith('hg38', null);
    expect(vi.mocked(api.analyzeFootprints).mock.calls.length).toBeGreaterThan(calls);
    expect(q(container, 'entry-motif-controls')!.textContent).toContain('Motifs: JASPAR human (hg38, declared)');
    expect((q(container, 'entry-motif-declare') as HTMLSelectElement).value).toBe('hg38');
    expect(container.textContent).not.toContain(FALLBACK_NOTE);
  });

  it('a failed declaration says why', async () => {
    vi.mocked(api.analyzeFootprints).mockReset().mockResolvedValue(
      result({ genome: null, taxid: null, name: 'vertebrates', inferred: false, fallback: true }, [FALLBACK_NOTE]));
    vi.mocked(reference.declareGenome).mockResolvedValue({ success: false, error: 'Load a FASTA first' });
    await act(async () => root.render(<CartEntryInspect group={group} targetDatasetIds={['alt']} width={500} />));
    await wait(30);
    const select = q(container, 'entry-motif-declare') as HTMLSelectElement;
    await act(async () => { select.value = 'mm10'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await wait(30);
    expect(container.querySelector('[role="alert"]')!.textContent).toBe('Load a FASTA first');
  });
});

describe('A declaration reaches every class card', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    localStorage.clear();
    useBrowserStore.setState({ chrom: CONTIG, start: 5300, end: 6300, hasFasta: true, currentGenome: null, motifScoreMode: 'p',
      motifPValue: 1e-4, motifThreshold: 0.85, pinnedMotifs: {}, customMotifs: [], orthogonalTracks: [] } as never);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  it('declaring in one card rescans the other cards too (declare, redeclare, clear)', async () => {
    const other = { ...group, id: 'g2', name: 'class 3', referenceAbsStart: 5400, referenceAbsEnd: 5417 } as unknown as FootprintGroup;
    let species: NonNullable<api.FootprintAnalysisResult['jaspar_species']> =
      { genome: null, taxid: null, name: 'vertebrates', inferred: false, fallback: true };
    vi.mocked(api.analyzeFootprints).mockReset().mockImplementation(async () => result(species, species.fallback ? [FALLBACK_NOTE] : []));
    // The real declareGenome bumps the shared revision on success (api/reference.test.ts); the mock does the same.
    vi.mocked(reference.declareGenome).mockReset().mockImplementation(async (declared) => {
      species = declared ? { genome: declared, taxid: declared === 'dm6' ? 7227 : 9606, name: declared === 'dm6' ? 'fly' : 'human', inferred: false, declared: true }
        : { genome: null, taxid: null, name: 'vertebrates', inferred: false, fallback: true };
      useBrowserStore.getState().bumpReferenceRevision();
      return { success: true, genome: declared };
    });
    await act(async () => root.render(<>
      <div data-testid="card-a"><CartEntryInspect group={group} targetDatasetIds={['alt']} width={500} /></div>
      <div data-testid="card-b"><CartEntryInspect group={other} targetDatasetIds={['alt']} width={500} /></div>
    </>));
    await wait(30);
    const line = (id: string) => q(q(container, id)!, 'entry-motif-controls')!.textContent;
    const choose = async (value: string) => {
      const select = q(q(container, 'card-a')!, 'entry-motif-declare') as HTMLSelectElement;
      await act(async () => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); });
      await wait(30);
    };
    await choose('hg38');
    expect(line('card-b')).toContain('JASPAR human (hg38, declared)');
    await choose('dm6');
    expect(line('card-a')).toContain('JASPAR fly (dm6, declared)');
    expect(line('card-b')).toContain('JASPAR fly (dm6, declared)');
    await choose('');
    expect(line('card-b')).toContain('JASPAR vertebrates (no genome declared)');
  });
});
