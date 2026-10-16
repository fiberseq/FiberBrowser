import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../../plugins/builtinPanels';
import { useBrowserStore } from '../../../stores/browserStore';
import { CircularGenomePanel } from '../CircularGenomePanel';
import { HAPLOTYPE_HINT_KEY } from './HaplotypePairHint';
import { useHaplotypeCompareRequest } from '../haplotype/haplotypeCompareRequest';
import { PanelHeader } from '../../tracks/PanelHeader';
import { HaplotypeComparisonSettings } from '../sidebar/haplotype/HaplotypeComparisonSettings';
import { forgetRememberedState } from '../../../hooks/useRememberedState';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const GENES = [
  { id: 'g1', name: 'NAPA', start: 47_487_636, end: 47_515_063, strand: '-', biotype: 'protein_coding' },
  { id: 'g2', name: 'NAPA', start: 47_487_678, end: 47_515_020, strand: '-', biotype: 'protein_coding' },
  { id: 'g3', name: 'ZNF541', start: 47_520_689, end: 47_573_148, strand: '-', biotype: 'protein_coding' },
  { id: 'g4', name: 'NAPA-AS1', start: 47_484_281, end: 47_502_399, strand: '+', biotype: 'lncRNA' },
];

describe('Regions panel: zoom window and haplotype entry points', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ genes: GENES }) }) as Response));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useHaplotypeCompareRequest.getState().set(null);
  });

  afterEach(() => {
    act(() => root.unmount());
    // Each test is a freshly opened panel (its tab is remembered only while it stays open).
    forgetRememberedState('circular-genome');
    container.remove();
    vi.unstubAllGlobals();
  });

  // The panel opens on its region catalog (fb-r4-regions); the maps are the Map tab.
  const showMap = async () => {
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-analysis-tab="navigator"]')!.click(); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
  };

  const setChroms = (names: string[]) => useBrowserStore.setState({
    chrom: names[0], start: 47_514_000, end: 47_519_000,
    chroms: names.map(name => ({ name, size: 58_617_616 })),
    datasets: [], panels: [], navigatorRegions: [],
  } as any);

  it('draws the zoom window as a map of named genes with the view marked, and no lens', async () => {
    setChroms(['chr19', 'chr1']);
    await act(async () => root.render(<CircularGenomePanel />));
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    // Saved regions first: the catalog with Save view (Add View's successor).
    expect(container.querySelector('[data-testid="region-catalog"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="region-save-view"]')).not.toBeNull();
    await showMap();
    const map = container.querySelector('[data-testid="regions-zoom-map"] svg')!;
    expect(map).not.toBeNull();
    const names = [...map.querySelectorAll('[data-testid="regions-zoom-gene"] text')].map(t => t.textContent);
    // Transcripts of one gene are one entry, and every gene is named.
    expect(names.sort()).toEqual(['NAPA', 'NAPA-AS1', 'ZNF541']);
    expect(container.querySelector('[data-testid="regions-zoom-count"]')!.textContent).toBe('3 genes');
    expect(map.querySelector('[data-testid="regions-zoom-view"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="regions-chromosome-view"]')).not.toBeNull();
    expect(container.textContent).not.toMatch(/lens/i);
  });

  it('points at Compare haplotypes once when the reference has haplotype pairs', async () => {
    setChroms(['chr1_mat', 'chr1_pat']);
    await act(async () => root.render(<CircularGenomePanel />));
    await showMap();
    const hint = container.querySelector('[data-testid="haplotype-pair-hint"]')!;
    expect(hint.textContent).toContain('chr1_mat / chr1_pat');
    await act(async () => { (hint.querySelector('button[aria-label="Dismiss"]') as HTMLButtonElement).click(); });
    expect(container.querySelector('[data-testid="haplotype-pair-hint"]')).toBeNull();
    expect(localStorage.getItem(HAPLOTYPE_HINT_KEY)).toBe('1');
    act(() => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<CircularGenomePanel />));
    await showMap();
    expect(container.querySelector('[data-testid="haplotype-pair-hint"]')).toBeNull();
  });

  it('opens on Compare haplotypes from a dataset panel\'s menu, filled in with that panel\'s locus', async () => {
    setChroms(['chr1_mat', 'chr1_pat']);
    const panel = { id: 'p9', contentType: 'dataset', datasetId: 'ds1', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0,
      viewportOverride: { chrom: 'chr1_pat', start: 2_000, end: 3_500 } } as any;
    useBrowserStore.setState({ datasets: [{ id: 'ds1', label: 'napa_ddda', color: '#3b82f6' }], panels: [panel], fullViewPanelId: 'p9',
      selectedDatasets: new Set(), exportInProgress: false } as any);
    await act(async () => root.render(<PanelHeader panel={panel} panelIndex={0} width={800} />));
    // The header shows its actions when there is room (fb-n11-tracks); else they are in ⋯.
    const more = container.querySelector<HTMLButtonElement>('[data-testid="panel-actions-p9"]');
    if (more) await act(async () => { more.click(); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-tour="panel-compare-haplotypes"]')!.click(); });
    const state = useBrowserStore.getState();
    expect(state.panels.some(p => p.contentType === 'circular-genome')).toBe(true);
    // A maximized panel would hide Regions.
    expect(state.fullViewPanelId).toBeNull();

    // A comparison form elsewhere (Contacts) leaves the request for Regions.
    await act(async () => root.render(<><HaplotypeComparisonSettings embedded /></>));
    expect(useHaplotypeCompareRequest.getState().request).not.toBeNull();

    await act(async () => root.render(<CircularGenomePanel />));
    const form = container.querySelector('[data-tour="haplotype-compare-form"]')!;
    expect(form).not.toBeNull();
    const selects = [...form.querySelectorAll('select')] as HTMLSelectElement[];
    expect(selects.slice(0, 2).map(s => s.value)).toEqual(['chr1_pat', 'chr1_mat']);
    expect((form.querySelector('input') as HTMLInputElement).value).toBe('chr1_pat:2,000-3,500');
    expect(useHaplotypeCompareRequest.getState().request).toBeNull();
  });

  it('keeps a gene\'s own bounds when it runs past the window, and opens it from the keyboard', async () => {
    setChroms(['chr19', 'chr1']);
    await act(async () => root.render(<CircularGenomePanel />));
    await showMap();
    const gene = [...container.querySelectorAll<SVGGElement>('[data-testid="regions-zoom-gene"]')]
      .find(g => g.textContent?.includes('ZNF541'))!;
    expect(gene.getAttribute('tabindex')).toBe('0');
    expect(gene.querySelector('title')!.textContent).toContain('47,520,689-47,573,148');
    await act(async () => { gene.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    const { start, end } = useBrowserStore.getState();
    expect(start).toBeLessThan(47_520_689);
    expect(end).toBeGreaterThan(47_573_148);
  });
});
