import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../../api/footprints';
import { useBrowserStore } from '../../../stores/browserStore';
import { CartEntryInspect } from './CartEntryInspect';
import type { FootprintGroup } from '../../../types';

vi.mock('../../../api/footprints', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../api/footprints')>()),
  analyzeFootprints: vi.fn(),
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const wait = (ms: number) => act(async () => { await new Promise(r => setTimeout(r, ms)); });
const q = (c: HTMLElement, id: string) => c.querySelector<HTMLElement>(`[data-testid="${id}"]`);

const group = { id: 'g1', name: 'class 7', color: '#10b981', layer: null, referenceChrom: 'chr3L', referenceAbsStart: 15039600, referenceAbsEnd: 15039630 } as unknown as FootprintGroup;

describe('Footprints panel motifs use the shared scorer', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    localStorage.clear();
    useBrowserStore.setState({ chrom: 'chr3L', start: 15039000, end: 15040000, hasFasta: true, currentGenome: 'dm6', motifScoreMode: 'p',
      motifPValue: 1e-4, motifThreshold: 0.85, pinnedMotifs: {}, customMotifs: [], orthogonalTracks: [] } as never);
    vi.mocked(api.analyzeFootprints).mockReset().mockResolvedValue({
      success: true, footprints: [{ absStart: 15039600, absEnd: 15039630, size: 30, sequence: 'ACGTCAGGTAGACGT', seq_start: 15039580,
        motif_hits: [{ motif_id: 'MA1462.2', motif_name: 'vfl', start: 4, end: 11, strand: '+', rel_score: 1, matched_seq: 'CAGGTAG', p: 2e-5, family: ['Kah'] }] }],
      jaspar_species: { genome: 'dm6', taxid: 7227, name: 'fly', inferred: false },
      motif_scoring: { mode: 'p', p: 1e-4, relative: 0.85, background: 'genome', pinned: ['vfl', 'Trl'] },
    } as unknown as api.FootprintAnalysisResult);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  it('sends the p-value mode and the species defaults, shows p and the family, and the pinned list it reported', async () => {
    await act(async () => root.render(<CartEntryInspect group={group} targetDatasetIds={['ds1']} width={500} />));
    await wait(30);
    const opts = vi.mocked(api.analyzeFootprints).mock.calls.at(-1)![6]!;
    expect(opts).toMatchObject({ motifMode: 'p', motifP: 1e-4, pinnedDefaults: true });
    expect(opts).not.toHaveProperty('customMotifNames');
    expect(container.textContent).toContain('p 2e−5');
    expect(container.textContent).toContain('+Kah');
    // the shared motif parameters: the pinned list it reported, behind "Pinned (2)"; the threshold inline
    expect(q(container, 'entry-motif-pinned-toggle')!.textContent).toContain('Pinned (2)');
    await act(async () => { q(container, 'entry-motif-pinned-toggle')!.click(); });
    expect([...container.querySelectorAll<HTMLElement>('[data-testid="entry-motif-chip"]')].map(c => c.dataset.name)).toEqual(['vfl', 'Trl']);
    expect(q(container, 'entry-motif-threshold')!.textContent).toContain('p ≤ 1.0e−4');
    expect(q(container, 'entry-motif-scoring')).not.toBeNull();
    // relative mode keeps its own threshold
    await act(async () => { useBrowserStore.getState().setMotifScoreMode('relative'); });
    await wait(30);
    expect(vi.mocked(api.analyzeFootprints).mock.calls.at(-1)![6]).toMatchObject({ motifMode: 'relative', motifThreshold: 0.85 });
  });

  it('search + Enter pins a motif; one with no hit here says so once, with Relax threshold; hit bars work from the keyboard', async () => {
    await act(async () => root.render(<CartEntryInspect group={group} targetDatasetIds={['ds1']} width={500} />));
    await wait(30);
    const box = q(container, 'entry-motif-search') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(box, 'dl'); box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // the rescan reports dl pinned, with no hit of it here
    vi.mocked(api.analyzeFootprints).mockResolvedValue({ ...(await vi.mocked(api.analyzeFootprints).mock.results[0].value),
      motif_scoring: { mode: 'p', p: 1e-4, relative: 0.85, background: 'genome', pinned: ['vfl', 'Trl', 'dl'] } });
    await act(async () => { box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    await wait(30);
    expect(useBrowserStore.getState().pinnedMotifs.fly).toEqual(['vfl', 'Trl', 'dl']);
    const zero = q(container, 'entry-motif-zero')!;
    expect(zero.textContent).toContain('dl: no site at p ≤ 1.0e−4');
    expect(q(container, 'entry-motif-notice')).toBeNull();                   // one message
    await act(async () => { q(container, 'entry-motif-relax')!.click(); });
    expect(useBrowserStore.getState().motifPValue).toBe(1e-3);
    // a motif hit bar is a focusable button: Enter highlights its motif
    const bar = q(container, 'motif-hit-bar')!;
    expect(bar.getAttribute('tabindex')).toBe('0');
    expect(bar.getAttribute('aria-pressed')).toBe('false');
    await act(async () => { bar.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(q(container, 'motif-hit-bar')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('moves an older per-browser pinned list to the species, once', async () => {
    localStorage.setItem('fiberbrowser-pinned-motifs', 'NRF1, Clamp');
    await act(async () => root.render(<CartEntryInspect group={group} targetDatasetIds={['ds1']} width={500} />));
    await wait(30);
    expect(useBrowserStore.getState().pinnedMotifs.fly).toEqual(['vfl', 'Trl', 'NRF1', 'Clamp']);
    expect(localStorage.getItem('fiberbrowser-pinned-motifs')).toBeNull();
    await wait(30);
    expect(vi.mocked(api.analyzeFootprints).mock.calls.at(-1)![6]).toMatchObject({ customMotifNames: ['vfl', 'Trl', 'NRF1', 'Clamp'] });
  });
});

// Every panel kind can show a different reference and chromosome from the main view.
for (const kind of ['per-panel', 'split', 'alternative', 'reversed', 'correspondence']) {
  it(`inspects motifs from the ${kind} panel even while other references are targeted`, async () => {
    const { usePanelGenomeStore } = await import('../../../stores/panelGenomeStore');
    usePanelGenomeStore.setState({ genomes: { own: { has_fasta: true } }, assignments: { ownDs: 'own' } } as never);
    useBrowserStore.setState({ chrom: 'stale', start: 0, end: 1000, hasFasta: false, navigationMode: 'perPanel',
      panels: [{ id: 'source', stateKey: 'copy', datasetId: 'ownDs', contentType: 'dataset', subTracks: [], genome: 'own', reversed: kind === 'reversed',
        viewportOverride: { chrom: 'chr3L', start: 15039000, end: 15041000 } }], selectedFootprints: [] } as never);
    vi.mocked(api.analyzeFootprints).mockReset().mockResolvedValue({ success: true, footprints: [{ sequence: 'ACGT', motif_hits: [] }] } as never);
    const node = document.createElement('div'); document.body.appendChild(node); const root = createRoot(node);
    try {
      await act(async () => root.render(<CartEntryInspect group={{ ...group, sourceIndex: -1, sourceDatasetId: 'ownDs', sourceViewKey: 'copy', referenceGenome: 'own' }} targetDatasetIds={['other', 'ownDs']} width={420} />));
      await wait(10);
      const call = vi.mocked(api.analyzeFootprints).mock.calls[0];
      expect(call.slice(0, 3)).toEqual(['chr3L', 15038600, 15040630]);
      expect(call[5]).toEqual(['ownDs']);
      expect(call[6]).toMatchObject({ panelGenome: 'own', autoMotifs: true, motifs: true });
      expect(node.querySelector('[data-testid="entry-motif-controls"]')).toBeTruthy();
    } finally { act(() => root.unmount()); node.remove(); usePanelGenomeStore.setState({ genomes: {}, assignments: {} }); }
  });
}


it('refreshes the V-plot when a split finishes classifying its reads', async () => {
  const { useSplitPanelStore } = await import('../../../stores/splitPanelStore');
  const original = useBrowserStore.getState(), originalSplit = useSplitPanelStore.getState();
  useBrowserStore.setState({ chrom: 'chr3L', hasFasta: true, selectedFootprints: [], panels: [
    { id: 'source', stateKey: 'split', datasetId: 'ds1', contentType: 'dataset', subTracks: [],
      viewportOverride: { chrom: 'chr3L', start: 15039000, end: 15041000 }, readSubset: { rule: { kind: 'frozen', datasetId: 'ds1', groupKeys: [] } } },
  ] } as never);
  useSplitPanelStore.getState().setReads('split', { state: 'loading' } as never);
  vi.mocked(api.analyzeFootprints).mockReset().mockResolvedValue({ success: true, footprints: [{ sequence: 'ACGT', motif_hits: [] }] } as never);
  const node = document.createElement('div'), root = createRoot(node);
  try {
    await act(async () => root.render(<CartEntryInspect group={{ ...group, sourceIndex: -1, sourceDatasetId: 'ds1', sourceViewKey: 'split' }} targetDatasetIds={['ds1']} width={420} />));
    await act(async () => [...node.querySelectorAll('button')].find(b => b.textContent?.includes('Show V-plot'))!.click());
    const plots = () => vi.mocked(api.analyzeFootprints).mock.calls.filter(c => c[6]?.vplot);
    expect(plots().at(-1)![6]?.readIdsByDataset).toEqual({ ds1: [] });
    await act(async () => useSplitPanelStore.getState().setReads('split', { state: 'ready', ids: new Set(['classified']) } as never));
    expect(plots().at(-1)![6]?.readIdsByDataset).toEqual({ ds1: ['classified'] });
  } finally { act(() => root.unmount()); useBrowserStore.setState(original, true); useSplitPanelStore.setState(originalSplit, true); }
});
