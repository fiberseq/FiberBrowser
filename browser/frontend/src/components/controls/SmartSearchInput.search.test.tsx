import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchJson = vi.fn();
vi.mock('../../api/sharedFetch', async (orig) => ({ ...(await orig<object>()), fetchJson: (...a: unknown[]) => fetchJson(...a) }));
const searchGene = vi.fn();
vi.mock('../../api/reference', async (orig) => ({ ...(await orig<object>()), searchGene: (...a: unknown[]) => searchGene(...a) }));

import { useBrowserStore } from '../../stores/browserStore';
import { useRegionCatalogStore } from '../../stores/regionCatalogStore';
import { addCategory, addEntries, emptyCatalog } from '../../utils/regionCatalog';
import { runFromPalette, type SearchSuggestion } from '../../utils/search/providers';
import { SmartSearchInput } from './SmartSearchInput';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * integ-r4: the locus boxes (main and per panel) ask the same search providers
 * as the palette: loci, genes, saved regions and read names, grouped; Enter
 * runs the chosen suggestion, else the best match once the genes have answered.
 */
let root: Root | null = null;
let host: HTMLDivElement | null = null;
const setViewport = vi.fn((chrom: string, start: number, end: number) => useBrowserStore.setState({ chrom, start, end }));
const GENOME = 'hg38';

function seedRegions() {
  let c = emptyCatalog(GENOME);
  const cat = addCategory(c, { name: 'Enhancers' }); c = cat.catalog;
  c = addEntries(c, cat.id, [
    { chrom: 'chr19', start: 5_000, end: 6_000, label: 'NAPA', category: cat.id, source: 'saved' } as never,
    { chrom: 'chr19', start: 8_000, end: 9_000, label: 'napa enhancer', category: cat.id, source: 'saved' } as never,
  ]).catalog;
  useRegionCatalogStore.setState(st => ({ catalogs: { ...st.catalogs, [GENOME]: c } }));
}

function render(node: React.ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
}

beforeEach(() => {
  fetchJson.mockReset();
  searchGene.mockReset();
  setViewport.mockClear();
  useBrowserStore.setState({
    chrom: 'chr19', start: 1_000, end: 2_000, chroms: [{ name: 'chr19', size: 58_617_616 }] as never,
    currentGenome: GENOME, navigationMode: 'linked',
    datasets: [{ id: 'ds1', label: 'napa' }] as never,
    panels: [{ id: 'p1', contentType: 'dataset', datasetId: 'ds1', stateKey: 'ds1', subTracks: [] }] as never,
    setViewport,
  } as never);
  seedRegions();
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  useRegionCatalogStore.setState(st => { const { [GENOME]: _gone, ...rest } = st.catalogs; return { catalogs: rest }; });
});

const input = (testId = 'location-search-input') => host!.querySelector(`[data-testid="${testId}"]`) as HTMLInputElement;
function type(value: string, testId?: string) {
  const el = input(testId);
  act(() => el.focus());
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const wait = (ms: number) => act(async () => { await new Promise(r => setTimeout(r, ms)); });
async function submit() {
  await act(async () => { host!.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  await wait(0);
  await wait(0);
}
const groups = () => [...host!.querySelectorAll('[data-testid="search-suggestions"] [role="group"]')].map(g => g.getAttribute('data-group'));

describe('the locus box lists every kind of place, grouped', () => {
  it('releases coordinate focus after Go and keeps invalid input editable', async () => {
    render(<SmartSearchInput />);
    type('chr19:5000-6000');
    expect(document.activeElement).toBe(input());
    await submit();
    expect(setViewport).toHaveBeenCalledWith('chr19', 5000, 6000);
    expect(document.activeElement).not.toBe(input());
    type('chrMissing:5000-6000');
    await submit();
    expect(document.activeElement).toBe(input());
  });

  it('genes (after a pause) and saved regions; the exact gene is the best match', async () => {
    searchGene.mockResolvedValue({ found: true, chrom: 'chr19', start: 47_510_062, end: 47_520_062, gene_name: 'NAPA' });
    render(<SmartSearchInput />);
    type('NAPA');
    expect(groups()).toEqual(['regions']);
    await wait(250);
    expect(groups()).toEqual(['gene', 'regions']);
    const enter = host!.querySelector('[data-enter="true"]');
    expect(enter?.getAttribute('data-kind')).toBe('gene');
  });

  it('Enter at once waits for the gene, which wins over the region of that name', async () => {
    let answer!: (v: unknown) => void;
    searchGene.mockReturnValue(new Promise(r => { answer = r; }));
    render(<SmartSearchInput />);
    type('NAPA');
    const submitted = submit();
    await submitted;
    expect(setViewport).not.toHaveBeenCalled();
    await act(async () => { answer({ found: true, chrom: 'chr19', start: 47_510_062, end: 47_520_062, gene_name: 'NAPA' }); });
    await wait(0);
    expect(setViewport).toHaveBeenCalledWith('chr19', 47_510_062, 47_520_062);
    // One gene lookup, not two (Enter reuses the list's).
    expect(searchGene).toHaveBeenCalledTimes(1);
  });

  it('no such gene: Enter goes to the region named so', async () => {
    searchGene.mockResolvedValue({ found: false, suggestions: ['NAPB'] });
    render(<SmartSearchInput />);
    type('NAPA');
    await submit();
    expect(setViewport).toHaveBeenCalledTimes(1);
    expect(setViewport.mock.calls[0][0]).toBe('chr19');
    expect(setViewport.mock.calls[0][1]).toBe(5_000);
  });

  it('nothing runnable: the gene names the server suggests', async () => {
    searchGene.mockResolvedValue({ found: false, suggestions: ['ROX1', 'ROX2'] });
    render(<SmartSearchInput />);
    type('rox');
    await submit();
    expect(setViewport).not.toHaveBeenCalled();
    expect(host!.textContent).toContain('Try: ROX1, ROX2');
  });

  it('arrow keys choose; Enter runs the chosen one', async () => {
    searchGene.mockResolvedValue({ found: true, chrom: 'chr19', start: 47_510_062, end: 47_520_062, gene_name: 'NAPA' });
    render(<SmartSearchInput />);
    type('napa enh');
    await wait(250);
    const options = [...host!.querySelectorAll('[data-testid="search-suggestion"]')];
    expect(options.map(o => o.getAttribute('data-kind'))).toEqual(['region']);
    act(() => { input().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
    expect(input().getAttribute('aria-activedescendant')).toBeTruthy();
    await submit();
    expect(setViewport).toHaveBeenCalledWith('chr19', 8_000, 9_000);
    expect(searchGene).not.toHaveBeenCalled();  // "napa enh" is no gene name
  });

  it('a read name is a Read suggestion only, run at once (no gene lookup)', async () => {
    render(<SmartSearchInput />);
    type('m84046_240619_124816_s1/240062573/ccs');
    expect(groups()).toEqual(['read-names']);
    expect(searchGene).not.toHaveBeenCalled();
  });
});

describe('Codex review (integ-r4): choices and pending Enters stay right', () => {
  it('an arrow-chosen region stays chosen when the gene answer arrives above it', async () => {
    let answer!: (v: unknown) => void;
    searchGene.mockReturnValue(new Promise(r => { answer = r; }));
    render(<SmartSearchInput />);
    type('NAPA');
    act(() => { input().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
    await wait(250);  // the lookup starts
    await act(async () => { answer({ found: true, chrom: 'chr19', start: 47_510_062, end: 47_520_062, gene_name: 'NAPA' }); });
    await wait(0);
    expect(groups()).toEqual(['gene', 'regions']);
    const active = host!.querySelector('[role="option"][aria-selected="true"]');
    expect(active?.getAttribute('data-kind')).toBe('region');
    await submit();
    expect(setViewport).toHaveBeenCalledWith('chr19', 5_000, 6_000);
  });

  it('a choice is forgotten when the text changes', async () => {
    searchGene.mockResolvedValue({ found: false, suggestions: [] });
    render(<SmartSearchInput />);
    type('napa');
    act(() => { input().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
    type('napa enh');
    expect(host!.querySelector('[role="option"][aria-selected="true"]')).toBeNull();
  });

  it('an Enter waiting for the gene does nothing once the view has moved', async () => {
    let answer!: (v: unknown) => void;
    searchGene.mockReturnValue(new Promise(r => { answer = r; }));
    render(<SmartSearchInput />);
    type('NAPA');
    await submit();
    // The user pans meanwhile.
    act(() => useBrowserStore.setState({ start: 3_000, end: 4_000 }));
    await act(async () => { answer({ found: false, suggestions: [] }); });
    await wait(0);
    expect(setViewport).not.toHaveBeenCalled();
    expect(useBrowserStore.getState().start).toBe(3_000);
  });

  it('another main assembly: the list is asked again (no human regions on mouse)', async () => {
    searchGene.mockResolvedValue({ found: false, suggestions: [] });
    render(<SmartSearchInput />);
    type('napa enh');
    expect(groups()).toEqual(['regions']);
    act(() => useBrowserStore.setState({ currentGenome: 'mm10' } as never));
    await wait(0);
    expect(groups()).toEqual([]);
  });
});

describe("a panel's box", () => {
  it('lists and runs in its own panel, on its own reference and chromosome', async () => {
    const navigate = vi.fn();
    searchGene.mockResolvedValue({ found: true, chrom: 'chr19', start: 10, end: 20, gene_name: 'NAPA' });
    render(<SmartSearchInput compact viewport={{ chrom: 'chr19', start: 100, end: 200 }} onNavigate={navigate} genome={GENOME} />);
    type('NAPA', 'panel-location-input');
    await wait(250);
    expect(searchGene).toHaveBeenCalledWith('NAPA', expect.anything(), 'chr19', GENOME);
    expect(groups()).toEqual(['gene', 'regions']);
    // The region goes to this panel too.
    const region = [...host!.querySelectorAll<HTMLElement>('[data-testid="search-suggestion"][data-kind="region"]')][0];
    await act(async () => { region.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); });
    await wait(0);
    expect(navigate).toHaveBeenCalledWith('chr19', 5_000, 6_000);
    expect(setViewport).not.toHaveBeenCalled();
  });
});

describe('the palette runs its picks in the main box', () => {
  it('shows the outcome under the main box', async () => {
    render(<SmartSearchInput />);
    const suggestion: SearchSuggestion = { id: 'x', kind: 'region', label: 'gone', score: 700, run: () => 'This region is on hg19: no panel shows it' };
    await act(async () => { await runFromPalette(suggestion); });
    expect(host!.textContent).toContain('This region is on hg19: no panel shows it');
  });
});
