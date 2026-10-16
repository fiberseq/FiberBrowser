/**
 * fb-n3-search (audit M7, L3, L5): the palette's "Go to" in "Each panel
 * navigates" mode and with panels on another assembly. Every reference on
 * screen is searched (its genes, its contigs), each place goes to the panel
 * showing that reference (the active one for its own), labelled by reference;
 * weak fuzzy matches no longer outrank or crowd a real answer.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const { searchGene } = vi.hoisted(() => ({ searchGene: vi.fn() }));
vi.mock('../../api/reference', () => ({ searchGene }));

import { useBrowserStore } from '../../stores/browserStore';
import { usePanelGenomeStore } from '../../stores/panelGenomeStore';
import { ensureBuiltinPanelsRegistered } from '../../stores/__tests__/helpers';
import { CommandPaletteHost } from './CommandPalette';
import { SmartSearchInput } from './SmartSearchInput';
import { closeCommandPalette, openCommandPalette } from '../../utils/commandPaletteStore';

const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });

const DM6_CHROMS = [{ name: 'chr2L', size: 23_513_712 }, { name: 'chr2R', size: 25_286_936 }, { name: 'chr3L', size: 28_110_227 }, { name: 'chr3R', size: 32_079_331 }];
const navigatePanel = vi.fn();
const setViewport = vi.fn();
const dm6BoxNavigate = vi.fn();

function Harness({ dm6Box }: { dm6Box: boolean }) {
  return (
    <>
      <CommandPaletteHost />
      {dm6Box && (
        <SmartSearchInput compact panelId="p2" genome="dm6" chroms={DM6_CHROMS}
          viewport={{ chrom: 'chr2L', start: 1_000, end: 2_000 }} onNavigate={dm6BoxNavigate} />
      )}
    </>
  );
}

const input = () => document.querySelector<HTMLInputElement>('[data-testid="command-palette-input"]')!;
const options = () => [...document.querySelectorAll<HTMLElement>('[data-testid="command-palette"] [role="option"]')];
const dialog = () => document.querySelector('[data-testid="command-palette"]');
const key = (target: EventTarget, init: KeyboardEventInit) => act(() => {
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
});
function type(text: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input(), text);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('command palette in Per panel mode, two assemblies (fb-n3-search)', () => {
  const initial = useBrowserStore.getState();
  const initialGenomes = usePanelGenomeStore.getState();
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => ensureBuiltinPanelsRegistered());
  beforeEach(() => {
    navigatePanel.mockReset();
    setViewport.mockReset();
    dm6BoxNavigate.mockReset();
    // hg38 knows NAPA; dm6 knows eve and ftz (the dm6 annotation calls its contigs 2R, 3R: L3).
    searchGene.mockReset().mockImplementation(async (name: string, _opts: unknown, _hint: unknown, genome?: string | null) => {
      if (genome === 'dm6' && name.toLowerCase() === 'eve') return { found: true, chrom: '2R', start: 9_974_318, end: 9_984_318, gene_name: 'eve' };
      if (genome === 'dm6' && name.toLowerCase() === 'ftz') return { found: true, chrom: '3R', start: 6_868_000, end: 6_870_000, gene_name: 'ftz' };
      if (!genome && name.toUpperCase() === 'NAPA') return { found: true, chrom: 'chr19', start: 47_510_062, end: 47_520_062, gene_name: 'NAPA' };
      return { found: false, suggestions: [] };
    });
    usePanelGenomeStore.setState({ genomes: { dm6: { key: 'dm6', label: 'dm6', chroms: DM6_CHROMS } as never } } as never);
    useBrowserStore.setState({
      currentGenome: 'hg38', fastaPath: null, navigationMode: 'perPanel',
      chrom: 'chr19', start: 47_514_262, end: 47_519_210,
      chroms: [{ name: 'chr19', size: 58_617_616 }] as never,
      datasets: [{ id: 'ds1', label: 'napa' }, { id: 'ds2', label: 'fly' }] as never,
      panels: [
        { id: 'p1', contentType: 'dataset', datasetId: 'ds1', stateKey: 'ds1', subTracks: [], viewportOverride: { chrom: 'chr19', start: 47_514_262, end: 47_519_210 } },
        { id: 'p2', contentType: 'dataset', datasetId: 'ds2', stateKey: 'ds2', subTracks: [], genome: 'dm6', viewportOverride: { chrom: 'chr2L', start: 1_000, end: 2_000 } },
      ] as never,
      selectedDatasets: new Set(), lastMovedPanels: {}, collapsedRows: new Set(), fullViewPanelId: null,
      navigatePanel, setViewport,
    } as never);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => closeCommandPalette());
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = '';
    useBrowserStore.setState(initial, true);
    usePanelGenomeStore.setState(initialGenomes, true);
  });

  const render = (dm6Box = false) => act(() => root.render(<Harness dm6Box={dm6Box} />));

  it('offers the dm6 gene, labelled by its reference and under its own contig name, first (M7, L3)', async () => {
    render();
    act(() => openCommandPalette());
    type('eve');
    await settle();
    await flush();
    const first = options()[0];
    expect(first.dataset.paletteKind).toBe('goto');
    expect(first.textContent).toContain('Go to eve (dm6)');
    expect(first.textContent).toContain('chr2R:9,974,318-9,984,318');  // not "2R:…"
    expect(first.getAttribute('aria-disabled')).toBeNull();
    // Unrelated fuzzy matches ("eve" inside "revert", "several", "level") are left out.
    const ids = options().map(o => o.dataset.paletteItem ?? '');
    expect(ids).not.toContain('cmd:undo');
    expect(options().some(o => /Paste a read name/.test(o.textContent ?? ''))).toBe(false);
    key(input(), { key: 'Enter' });
    await flush();
    expect(dialog()).toBeNull();
    expect(navigatePanel).toHaveBeenCalledWith('p2', 'chr2R', 9_974_318, 9_984_318);
    expect(setViewport).not.toHaveBeenCalled();
    // Each reference is asked with its panel's chromosome as the preference, as that panel's own box does.
    expect(searchGene).toHaveBeenCalledWith('eve', expect.anything(), 'chr2L', 'dm6');
    expect(searchGene).toHaveBeenCalledWith('eve', expect.anything(), 'chr19', null);
  });

  it('coordinates go to the panel whose reference has that contig (M7)', async () => {
    render();
    act(() => openCommandPalette());
    type('chr2R:9974000-9984000');
    await flush();
    const gotos = options().filter(o => o.dataset.paletteKind === 'goto');
    // Only the dm6 one (hg38 has no chr2R: not also listed as unavailable).
    expect(gotos).toHaveLength(1);
    expect(gotos[0].getAttribute('aria-disabled')).toBeNull();
    expect(gotos[0].textContent).toContain('(dm6)');
    key(input(), { key: 'Enter' });
    await flush();
    expect(navigatePanel).toHaveBeenCalledWith('p2', 'chr2R', 9_974_000, 9_984_000);
  });

  it('a gene of the main genome goes to the active panel on it, not "Each panel navigates" (M7)', async () => {
    render();
    act(() => openCommandPalette());
    type('NAPA');
    await settle();
    await flush();
    expect(options()[0].textContent).toContain('Go to NAPA (hg38)');
    expect(document.body.textContent).not.toContain('Each panel navigates');
    key(input(), { key: 'Enter' });
    await flush();
    expect(navigatePanel).toHaveBeenCalledWith('p1', 'chr19', 47_510_062, 47_520_062);
  });

  it("runs in that panel's own locus box when it is on screen (its progress and outcome show there)", async () => {
    render(true);
    act(() => openCommandPalette());
    type('ftz');
    await settle();
    await flush();
    expect(options()[0].textContent).toContain('Go to ftz (dm6)');
    key(input(), { key: 'Enter' });
    await flush();
    expect(dm6BoxNavigate).toHaveBeenCalledWith('chr3R', 6_868_000, 6_870_000);
    expect(navigatePanel).not.toHaveBeenCalled();
  });

  it('a read name is offered once (looked for in every dataset), not once per reference; lab names too (L5)', async () => {
    render();
    act(() => openCommandPalette());
    type('4741_FP64DJ_3');
    await flush();
    const reads = options().filter(o => o.dataset.paletteItem?.startsWith('goto:read-names:'));
    expect(reads).toHaveLength(1);
    expect(reads[0].textContent).not.toContain('(dm6)');
    expect(reads[0].getAttribute('aria-selected')).toBe('true');
  });

  it('one reference on screen: no reference labels', async () => {
    useBrowserStore.setState(s => ({ panels: s.panels.filter(p => p.id === 'p1') }) as never);
    render();
    act(() => openCommandPalette());
    type('NAPA');
    await settle();
    await flush();
    expect(options()[0].textContent).toContain('Go to NAPA');
    expect(options()[0].textContent).not.toContain('(hg38)');
  });

  it('nothing matches: the read: prefix is suggested for names of other shapes (L5)', () => {
    render();
    act(() => openCommandPalette('qqqzzz'));
    expect(document.querySelector('[data-testid="command-palette-empty"]')?.textContent).toContain('read: qqqzzz');
  });
});
