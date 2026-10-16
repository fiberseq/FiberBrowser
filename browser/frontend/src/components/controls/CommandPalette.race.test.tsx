/**
 * fb-r5-search (Codex 3 and 4): answers arriving while the palette is open
 * don't change what Enter runs, and answers from the previous assembly are
 * never listed nor run once the main genome changed.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const { searchGene, fetchJson } = vi.hoisted(() => ({ searchGene: vi.fn(), fetchJson: vi.fn() }));
vi.mock('../../api/reference', () => ({ searchGene }));
vi.mock('../../api/sharedFetch', async (orig) => ({ ...(await orig<object>()), fetchJson: (...a: unknown[]) => fetchJson(...a) }));

import { useBrowserStore } from '../../stores/browserStore';
import { setRegionCatalogPersistence, useRegionCatalogStore } from '../../stores/regionCatalogStore';
import { addCategory, addEntries, emptyCatalog } from '../../utils/regionCatalog';
import { ensureBuiltinPanelsRegistered } from '../../stores/__tests__/helpers';
import { CommandPaletteHost } from './CommandPalette';
import { closeCommandPalette, openCommandPalette } from '../../utils/commandPaletteStore';
import { goToReads } from '../../utils/readLocate';

const wait = (ms: number) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
const key = (target: EventTarget, init: KeyboardEventInit) => act(() => {
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
});
const dialog = () => document.querySelector('[data-testid="command-palette"]');
const input = () => document.querySelector<HTMLInputElement>('[data-testid="command-palette-input"]')!;
const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
const activeOption = () => document.getElementById(input().getAttribute('aria-activedescendant') ?? '');
function type(text: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input(), text);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
const NAPA_HG38 = { found: true, chrom: 'chr19', start: 47_510_062, end: 47_520_062, gene_name: 'NAPA' };

describe('the palette and answers that arrive later', () => {
  const initial = useBrowserStore.getState();
  const setViewport = vi.fn((chrom: string, start: number, end: number) => useBrowserStore.setState({ chrom, start, end }));
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => ensureBuiltinPanelsRegistered());
  beforeEach(() => {
    searchGene.mockReset();
    fetchJson.mockReset();
    setViewport.mockClear();
    setRegionCatalogPersistence(() => false);
    useBrowserStore.setState({
      currentGenome: 'hg38', fastaPath: null, chrom: 'chr19', start: 1_000, end: 2_000,
      chroms: [{ name: 'chr19', size: 58_000_000 }] as never, navigationMode: 'linked', setViewport,
    } as never);
    let c = emptyCatalog('hg38');
    const cat = addCategory(c, { name: 'Enhancers' }); c = cat.catalog;
    c = addEntries(c, cat.id, [{ chrom: 'chr19', start: 5_000, end: 6_000, label: 'NAPA', category: cat.id, source: 'saved' } as never]).catalog;
    useRegionCatalogStore.setState(st => ({ catalogs: { ...st.catalogs, hg38: c } }));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<CommandPaletteHost />));
  });
  afterEach(() => {
    act(() => closeCommandPalette());
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = '';
    useRegionCatalogStore.setState(st => { const { hg38: _gone, ...rest } = st.catalogs; return { catalogs: rest }; });
    useBrowserStore.setState(initial, true);
    try { localStorage.clear(); } catch { /* jsdom */ }
  });

  it('clicking a keep-open row without moving the pointer selects it before ArrowUp', () => {
    act(() => openCommandPalette());
    type('terminal');
    const [first, second] = options();
    expect(second.textContent).toMatch(/Turn (on|off): Hide terminal gaps/);
    act(() => second.click());
    expect(dialog()).not.toBeNull();
    expect(second.getAttribute('aria-selected')).toBe('true');
    key(input(), { key: 'ArrowUp' });
    expect(first.getAttribute('aria-selected')).toBe('true');
  });

  it('Codex 3: the region chosen with the arrows stays chosen when the gene arrives above it', async () => {
    const answer = deferred<unknown>();
    searchGene.mockReturnValue(answer.promise);
    act(() => openCommandPalette());
    type('NAPA');
    const region = options().find(o => o.dataset.paletteItem?.startsWith('goto:regions:'))!;
    expect(region).toBeTruthy();
    // Chosen explicitly (down and back up onto it).
    key(input(), { key: 'ArrowDown' });
    key(input(), { key: 'ArrowUp' });
    expect(activeOption()).toBe(region);
    await wait(250);  // the gene lookup starts
    await act(async () => { answer.resolve(NAPA_HG38); });
    await wait(0);
    expect(options()[0].dataset.paletteItem).toMatch(/^goto:gene:/);  // the gene is listed first now
    expect(activeOption()?.dataset.paletteItem).toBe(region.dataset.paletteItem);
    key(input(), { key: 'Enter' });
    await wait(0);
    expect(dialog()).toBeNull();
    expect(setViewport).toHaveBeenCalledWith('chr19', 5_000, 6_000);
    expect(setViewport).not.toHaveBeenCalledWith('chr19', 47_510_062, 47_520_062);
  });

  it('nothing chosen: the first row is what Enter runs, the gene once it arrives', async () => {
    searchGene.mockResolvedValue(NAPA_HG38);
    act(() => openCommandPalette());
    type('NAPA');
    await wait(250);
    expect(activeOption()?.dataset.paletteItem).toMatch(/^goto:gene:/);
  });

  // fb-n4-tour: Enter with nothing chosen ran the first row at once, so "NAPA" + Enter
  // before the gene lookup came back went to the region named NAPA, not the gene that
  // ranks above it. Enter now waits for the gene (as the locus box does), then runs the best.
  it('nothing chosen, Enter before the gene answers: waits ("Looking up…"), then goes to the gene', async () => {
    const answer = deferred<unknown>();
    searchGene.mockReturnValue(answer.promise);
    act(() => openCommandPalette());
    type('NAPA');
    expect(options()[0].dataset.paletteItem).toMatch(/^goto:regions:/);
    key(input(), { key: 'Enter' });
    await wait(0);
    expect(dialog()).not.toBeNull();
    expect(document.querySelector('[data-testid="command-palette-status"]')?.textContent).toBe('Looking up…');
    expect(searchGene).toHaveBeenCalledTimes(1);  // asked at once, not after the typing pause
    expect(setViewport).not.toHaveBeenCalled();
    await act(async () => { answer.resolve(NAPA_HG38); });
    await wait(0);
    expect(dialog()).toBeNull();
    expect(setViewport).toHaveBeenCalledWith('chr19', 47_510_062, 47_520_062);
    expect(setViewport).not.toHaveBeenCalledWith('chr19', 5_000, 6_000);
  });

  it('no gene by that name: the waiting Enter runs the region', async () => {
    const answer = deferred<unknown>();
    searchGene.mockReturnValue(answer.promise);
    act(() => openCommandPalette());
    type('NAPA');
    key(input(), { key: 'Enter' });
    await act(async () => { answer.resolve({ found: false, suggestions: [] }); });
    await wait(0);
    expect(setViewport).toHaveBeenCalledWith('chr19', 5_000, 6_000);
  });

  it('a waiting Enter is cancelled by Escape and by typing', async () => {
    const first = deferred<unknown>();
    searchGene.mockReturnValue(first.promise);
    act(() => openCommandPalette());
    type('NAPA');
    key(input(), { key: 'Enter' });
    type('NAPAB');
    expect(document.querySelector('[data-testid="command-palette-status"]')?.textContent).not.toBe('Looking up…');
    await act(async () => { first.resolve(NAPA_HG38); });
    await wait(250);
    expect(dialog()).not.toBeNull();
    expect(setViewport).not.toHaveBeenCalled();

    const second = deferred<unknown>();
    searchGene.mockReturnValue(second.promise);
    type('NAPA');
    key(input(), { key: 'Enter' });
    key(input(), { key: 'Escape' });
    expect(dialog()).toBeNull();
    await act(async () => { second.resolve(NAPA_HG38); });
    await wait(250);
    expect(setViewport).not.toHaveBeenCalled();
  });

  it('Codex review: a choice made while an Enter waits replaces it (a toggle is not run twice)', async () => {
    const answer = deferred<unknown>();
    searchGene.mockReturnValue(answer.promise);
    useBrowserStore.setState({ hideTerminalGaps: false } as never);
    act(() => openCommandPalette());
    type('terminal');
    key(input(), { key: 'Enter' });  // waits: a gene named so would be listed first
    expect(document.querySelector('[data-testid="command-palette-status"]')?.textContent).toBe('Looking up…');
    const flip = options().find(o => o.dataset.paletteItem === 'toggle:view.hide-terminal-gaps')!;
    act(() => { flip.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 11, clientY: 12 })); });
    key(input(), { key: 'Enter' });
    expect(useBrowserStore.getState().hideTerminalGaps).toBe(true);
    await act(async () => { answer.resolve({ found: false, suggestions: [] }); });
    await wait(250);
    expect(useBrowserStore.getState().hideTerminalGaps).toBe(true);
  });

  it('coordinates (no gene could outrank them) run at once', async () => {
    searchGene.mockReturnValue(new Promise(() => {}));
    act(() => openCommandPalette());
    type('chr19:10,000-20,000');
    key(input(), { key: 'Enter' });
    await wait(0);
    expect(dialog()).toBeNull();
    expect(setViewport).toHaveBeenCalledWith('chr19', 10_000, 20_000);
  });

  it('Codex 4: after the main genome changes, the previous assembly’s genes are neither listed nor run', async () => {
    searchGene.mockResolvedValueOnce(NAPA_HG38);
    act(() => openCommandPalette());
    type('NAPA');
    await wait(250);
    expect(options().some(o => o.dataset.paletteItem?.startsWith('goto:gene:'))).toBe(true);
    // A pending assembly load lands while the palette is open.
    const mouse = deferred<unknown>();
    searchGene.mockReturnValueOnce(mouse.promise);
    act(() => useBrowserStore.setState({ currentGenome: 'mm10' } as never));
    expect(options().some(o => o.dataset.paletteItem?.startsWith('goto:gene:'))).toBe(false);
    key(input(), { key: 'Enter' });
    await wait(250);
    expect(setViewport).not.toHaveBeenCalled();
    // Asked again, on mouse.
    await act(async () => { mouse.resolve({ found: false, suggestions: [] }); });
    await wait(0);
    expect(searchGene).toHaveBeenCalledTimes(2);
    expect(setViewport).not.toHaveBeenCalled();
  });

  it('Codex 4: an Enter waiting for the genes is dropped when the main genome changes', async () => {
    const human = deferred<unknown>();
    searchGene.mockReturnValueOnce(human.promise);
    searchGene.mockReturnValue(new Promise(() => {}));
    act(() => openCommandPalette());
    type('GATA1');
    key(input(), { key: 'Enter' });  // nothing listed yet: waits for the genes
    expect(dialog()).not.toBeNull();
    await wait(250);
    act(() => useBrowserStore.setState({ currentGenome: 'mm10' } as never));
    await act(async () => { human.resolve({ ...NAPA_HG38, gene_name: 'GATA1' }); });
    await wait(250);
    expect(setViewport).not.toHaveBeenCalled();
  });

  it('an Enter waiting for the genes is dropped when the main view moves meanwhile', async () => {
    const answer = deferred<unknown>();
    searchGene.mockReturnValueOnce(answer.promise);
    act(() => openCommandPalette());
    type('GATA1');
    key(input(), { key: 'Enter' });
    await wait(250);
    act(() => useBrowserStore.setState({ start: 3_000, end: 4_000 }));
    await act(async () => { answer.resolve({ ...NAPA_HG38, gene_name: 'GATA1' }); });
    await wait(0);
    expect(setViewport).not.toHaveBeenCalled();
    expect(useBrowserStore.getState().start).toBe(3_000);
  });

  it('Codex review: hovering the first row chooses it too (the gene arriving above does not take it)', async () => {
    const answer = deferred<unknown>();
    searchGene.mockReturnValue(answer.promise);
    act(() => openCommandPalette());
    type('NAPA');
    const region = options()[0];
    expect(region.dataset.paletteItem).toMatch(/^goto:regions:/);
    act(() => { region.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 13, clientY: 14 })); });
    await wait(250);
    await act(async () => { answer.resolve(NAPA_HG38); });
    await wait(0);
    expect(activeOption()?.dataset.paletteItem).toBe(region.dataset.paletteItem);
  });

  it('a mousemove under a still pointer (rows changing under it) does not take the choice from the arrow keys (e2e flake)', () => {
    act(() => openCommandPalette());
    type('terminal');
    const [first, second] = options();
    // the pointer moves onto the second row: it is chosen
    act(() => { second.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 50, clientY: 60 })); });
    expect(activeOption()?.dataset.paletteItem).toBe(second.dataset.paletteItem);
    // the keys choose the first row; the browser then sends a mousemove at the same place (rows changed under it): ignored
    key(input(), { key: 'ArrowUp' });
    expect(activeOption()?.dataset.paletteItem).toBe(first.dataset.paletteItem);
    act(() => { second.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 50, clientY: 60 })); });
    expect(activeOption()?.dataset.paletteItem).toBe(first.dataset.paletteItem);
    // a real move over it chooses it again
    act(() => { second.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 52, clientY: 61 })); });
    expect(activeOption()?.dataset.paletteItem).toBe(second.dataset.paletteItem);
    // reopened under the still pointer: its first (layout) mousemove does not override the keys either
    act(() => closeCommandPalette());
    act(() => openCommandPalette());
    type('terminal');
    key(input(), { key: 'ArrowDown' });
    const chosen = activeOption()?.dataset.paletteItem;
    act(() => { options()[0].dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 52, clientY: 61 })); });
    expect(activeOption()?.dataset.paletteItem).toBe(chosen);
  });

  it('Codex review: a chosen option pushed off the list by a late answer is not replaced by another', async () => {
    const answer = deferred<unknown>();
    searchGene.mockReturnValue(answer.promise);
    act(() => openCommandPalette());
    type('a');
    const n = options().length;
    expect(n).toBe(60);  // the list's limit
    key(input(), { key: 'ArrowUp' });  // the last one
    const last = activeOption()!.dataset.paletteItem;
    await wait(250);
    await act(async () => { answer.resolve({ found: true, chrom: 'chr19', start: 10, end: 20, gene_name: 'a' }); });
    await wait(0);
    expect(options()[0].dataset.paletteItem).toMatch(/^goto:gene:/);
    expect(options().some(o => o.dataset.paletteItem === last)).toBe(false);
    expect(activeOption()).toBeNull();
    key(input(), { key: 'Enter' });
    await wait(0);
    expect(dialog()).not.toBeNull();
    expect(document.querySelector('[data-testid="command-palette-status"]')?.textContent).toMatch(/no longer listed/);
    expect(setViewport).not.toHaveBeenCalled();
  });

  it('Codex review: an Enter waiting in the palette supersedes an older read lookup', async () => {
    useBrowserStore.setState({
      datasets: [{ id: 'ds1', label: 'ds1' }],
      panels: [{ id: 'ds1', contentType: 'dataset', datasetId: 'ds1', stateKey: 'ds1', subTracks: [] }],
    } as never);
    const read = deferred<unknown>();
    fetchJson.mockReturnValueOnce(read.promise);
    const lookup = goToReads(['m84046_240619_124816_s1/240062573/ccs']);
    const gene = deferred<unknown>();
    searchGene.mockReturnValueOnce(gene.promise);
    act(() => openCommandPalette());
    type('GATA1');
    key(input(), { key: 'Enter' });  // waits for the genes
    await act(async () => {
      read.resolve({ scope: 'region', complete: true, not_found: [], found: [
        { name: 'm84046_240619_124816_s1/240062573/ccs', read_id: 'r1', dataset_id: 'ds1', chrom: 'chr19', start: 10_000, end: 11_000, strand: '+' },
      ] });
      await lookup;
    });
    expect(setViewport).not.toHaveBeenCalled();
    await wait(250);
    await act(async () => { gene.resolve({ ...NAPA_HG38, gene_name: 'GATA1' }); });
    await wait(0);
    expect(setViewport).toHaveBeenCalledTimes(1);
    expect(setViewport).toHaveBeenCalledWith('chr19', 47_510_062, 47_520_062);
  });

  it('Codex review: a Go to chosen runs only if nothing moved before it runs', async () => {
    act(() => openCommandPalette());
    type('chr19:5000-6000');
    key(input(), { key: 'Enter' });
    expect(dialog()).toBeNull();
    // A navigation lands before the queued pick runs.
    act(() => useBrowserStore.setState({ start: 30_000, end: 40_000 }));
    await wait(0);
    expect(setViewport).not.toHaveBeenCalled();
    expect(useBrowserStore.getState().start).toBe(30_000);
  });

  it('Codex review: a saved region chosen just before the FASTA changes is not run on the new one', async () => {
    useBrowserStore.setState({ currentGenome: null, fastaPath: '/human/reference.fa' } as never);
    let c = emptyCatalog('reference.fa');
    const cat = addCategory(c, { name: 'Mine' }); c = cat.catalog;
    c = addEntries(c, cat.id, [{ chrom: 'chr19', start: 5_000, end: 6_000, label: 'enhancer one', category: cat.id, source: 'saved' } as never]).catalog;
    useRegionCatalogStore.setState(st => ({ catalogs: { ...st.catalogs, 'reference.fa': c } }));
    act(() => openCommandPalette());
    type('enhancer one');
    expect(activeOption()?.dataset.paletteItem).toMatch(/^goto:regions:/);
    key(input(), { key: 'Enter' });
    act(() => useBrowserStore.setState({ fastaPath: '/mouse/reference.fa' } as never));
    await wait(0);
    expect(setViewport).not.toHaveBeenCalled();
    useRegionCatalogStore.setState(st => { const { 'reference.fa': _gone, ...rest } = st.catalogs; return { catalogs: rest }; });
  });

  it('Codex review: going back to an earlier text does not bring back its old choice', () => {
    act(() => openCommandPalette());
    type('zoom in');
    const first = activeOption()?.dataset.paletteItem;
    key(input(), { key: 'ArrowDown' });
    expect(activeOption()?.dataset.paletteItem).not.toBe(first);
    type('terminal');
    type('zoom in');
    expect(activeOption()?.dataset.paletteItem).toBe(first);
  });

  it('Codex review: a queued pick does not run when a panel moved or was asked to go elsewhere meanwhile', async () => {
    const { beginNavigationIntent } = await import('../../utils/search/navigationIntent');
    useBrowserStore.setState({
      datasets: [{ id: 'ds1', label: 'ds1' }],
      panels: [{ id: 'p2', contentType: 'dataset', datasetId: 'ds1', stateKey: 'ds1', subTracks: [], navOwn: true,
        viewportOverride: { chrom: 'chr19', start: 1_000, end: 2_000 } }],
    } as never);
    act(() => openCommandPalette());
    type('m84046_240619_124816_s1/240062573/ccs');
    key(input(), { key: 'Enter' });
    beginNavigationIntent({ panelId: 'p2' });  // a gene lookup started in that panel's box
    await wait(0);
    expect(fetchJson).not.toHaveBeenCalled();
    act(() => openCommandPalette());
    type('chr19:5000-6000');
    key(input(), { key: 'Enter' });
    act(() => useBrowserStore.setState(st => ({ panels: st.panels.map(p => ({ ...p, viewportOverride: { chrom: 'chr19', start: 30_000, end: 40_000 } })) })));
    await wait(0);
    expect(setViewport).not.toHaveBeenCalled();
  });
});
