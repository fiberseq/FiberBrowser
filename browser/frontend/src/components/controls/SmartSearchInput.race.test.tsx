/**
 * fb-r5-search: rapid typing, Enter and panning in the locus boxes never move
 * a view to a stale target (an answer for text since replaced, or for a view
 * since moved).
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchJson = vi.fn();
vi.mock('../../api/sharedFetch', async (orig) => ({ ...(await orig<object>()), fetchJson: (...a: unknown[]) => fetchJson(...a) }));
const searchGene = vi.fn();
vi.mock('../../api/reference', async (orig) => ({ ...(await orig<object>()), searchGene: (...a: unknown[]) => searchGene(...a) }));

import { useBrowserStore } from '../../stores/browserStore';
import { SmartSearchInput } from './SmartSearchInput';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const READ = 'm84046_240619_124816_s1/240062573/ccs';
let root: Root | null = null;
let host: HTMLDivElement | null = null;
const moves: string[] = [];
const setViewport = vi.fn((chrom: string, start: number, end: number) => {
  moves.push(`main ${chrom}:${start}-${end}`);
  useBrowserStore.setState({ chrom, start, end });
});
const navigatePanel = vi.fn((id: string, chrom: string, start: number, end: number) => {
  moves.push(`${id} ${chrom}:${start}-${end}`);
  useBrowserStore.setState(s => ({ panels: s.panels.map(p => (p.id === id ? { ...p, viewportOverride: { chrom, start, end } } : p)) }));
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
const readHit = (dataset = 'ds1') => ({
  scope: 'region', complete: true, not_found: [],
  found: [{ name: READ, read_id: 'r1', dataset_id: dataset, chrom: 'chr19', start: 10_000, end: 11_000, strand: '+' }],
});
const GENE = (name: string, start: number) => ({ found: true, chrom: 'chr19', start, end: start + 1_000, gene_name: name });

function render(node: React.ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
}
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
async function enter() {
  await act(async () => { host!.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  await wait(0);
}
const pan = (start: number, end: number) => act(() => useBrowserStore.setState({ start, end }));

beforeEach(() => {
  fetchJson.mockReset();
  searchGene.mockReset();
  setViewport.mockClear();
  navigatePanel.mockClear();
  moves.length = 0;
  useBrowserStore.setState({
    chrom: 'chr19', start: 1_000, end: 2_000, chroms: [{ name: 'chr19', size: 58_617_616 }] as never,
    currentGenome: 'hg38', fastaPath: null, navigationMode: 'linked', spanningOnly: false,
    datasets: [{ id: 'ds1', label: 'ds1' }, { id: 'ds2', label: 'ds2' }] as never,
    panels: [
      { id: 'ds1', contentType: 'dataset', datasetId: 'ds1', stateKey: 'ds1', subTracks: [] },
      { id: 'p2', contentType: 'dataset', datasetId: 'ds2', stateKey: 'ds2', subTracks: [], navOwn: true,
        viewportOverride: { chrom: 'chr19', start: 1_000, end: 2_000 } },
    ] as never,
    selectedReadIds: {},
    setViewport,
  } as never);
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

describe('the main box', () => {
  it('a read looked up, then a pan: the answer does not jump back', async () => {
    const answer = deferred<unknown>();
    fetchJson.mockReturnValueOnce(answer.promise);
    render(<SmartSearchInput />);
    type(READ);
    await enter();
    pan(5_000, 6_000);
    await act(async () => { answer.resolve(readHit()); });
    await wait(0);
    expect(moves).toEqual([]);
    expect(useBrowserStore.getState().start).toBe(5_000);
  });

  it('a read looked up, then a gene typed and entered: only the gene moves the view, whatever answers first', async () => {
    const read = deferred<unknown>();
    fetchJson.mockReturnValueOnce(read.promise);
    const gene = deferred<unknown>();
    searchGene.mockReturnValue(gene.promise);
    render(<SmartSearchInput />);
    type(READ);
    await enter();
    type('NAPA');
    await enter();  // waits for the gene
    await act(async () => { read.resolve(readHit()); });
    await wait(0);
    expect(moves).toEqual([]);
    await act(async () => { gene.resolve(GENE('NAPA', 47_510_062)); });
    await wait(0);
    expect(moves).toEqual(['main chr19:47510062-47511062']);
  });

  it('two genes entered in a row: the first answer arriving last moves nothing', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    searchGene.mockImplementation((name: string) => (name === 'NAPA' ? first.promise : second.promise));
    render(<SmartSearchInput />);
    type('NAPA');
    await enter();
    type('GATA1');
    await enter();
    await act(async () => { second.resolve(GENE('GATA1', 2_000_000)); });
    await wait(0);
    await act(async () => { first.resolve(GENE('NAPA', 47_510_062)); });
    await wait(0);
    expect(moves).toEqual(['main chr19:2000000-2001000']);
  });

  it('a gene entered, typing on, a pan, then the answer: nothing moves', async () => {
    const gene = deferred<unknown>();
    searchGene.mockReturnValue(gene.promise);
    render(<SmartSearchInput />);
    type('NAPA');
    await enter();
    type('NAP');
    type('NAPA');
    pan(7_000, 8_000);
    await act(async () => { gene.resolve(GENE('NAPA', 47_510_062)); });
    await wait(250);
    expect(moves).toEqual([]);
  });
});

describe("a panel's box", () => {
  function renderPanelBox() {
    const vpo = useBrowserStore.getState().panels.find(p => p.id === 'p2')!.viewportOverride!;
    render(<SmartSearchInput compact viewport={vpo} panelId="p2" genome={null}
      onNavigate={(c, s, e) => navigatePanel('p2', c, s, e)} />);
  }

  it('a read looked up, then the panel resized (start unchanged): its answer moves nothing', async () => {
    const answer = deferred<unknown>();
    fetchJson.mockReturnValueOnce(answer.promise);
    renderPanelBox();
    type(READ, 'panel-location-input');
    await enter();
    act(() => useBrowserStore.setState(s => ({
      panels: s.panels.map(p => (p.id === 'p2' ? { ...p, viewportOverride: { chrom: 'chr19', start: 1_000, end: 4_000 } } : p)),
    })));
    await act(async () => { answer.resolve(readHit('ds2')); });
    await wait(0);
    expect(moves).toEqual([]);
  });

  it('unmoved, it goes to the read in its own panel (the control)', async () => {
    fetchJson.mockResolvedValueOnce(readHit('ds2'));
    renderPanelBox();
    type(READ, 'panel-location-input');
    await enter();
    await wait(0);
    expect(moves).toEqual(['p2 chr19:9900-11100']);
  });
});

describe('the locus box and the reference', () => {
  it('replacing a loaded pair’s FASTA asks the providers again (as the palette does)', async () => {
    useBrowserStore.setState({ referencePairs: [{ fasta: '/p/hap2-v1.fa', annotation: null }] } as never);
    searchGene.mockResolvedValue(GENE('NAPA', 47_510_062));
    render(<SmartSearchInput />);
    type('NAPA');
    await wait(250);
    expect(searchGene).toHaveBeenCalledTimes(1);
    act(() => useBrowserStore.setState({ referencePairs: [{ fasta: '/p/hap2-v2.fa', annotation: null }] } as never));
    await wait(250);
    expect(searchGene).toHaveBeenCalledTimes(2);
  });
});
