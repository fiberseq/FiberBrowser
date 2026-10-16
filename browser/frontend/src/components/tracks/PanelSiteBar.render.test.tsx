import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCUS_BOX_MIN, PanelSiteBar, locusBoxMinWidth, siteBarLevel } from './PanelSiteBar';
import { useBrowserStore } from '../../stores/browserStore';
import { minimizedTrayShown } from './minimizedTray';
import type { PanelConfig } from '../../types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const hapPanel = (siteLocked: boolean) => ({
  id: 'h1', contentType: 'dataset', datasetId: 'ds1', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0,
  viewportOverride: { chrom: 'chr2R', start: 9974319, end: 9984319 }, regionLabel: 'chr2R',
  haplotypeGroup: 'hap-1', haplotypeSide: 1, siteLocked,
}) as unknown as PanelConfig;

describe('haplotype comparison views (M18)', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  it('a linked view shows where it is, not a cut-off location box', () => {
    act(() => root.render(<PanelSiteBar panel={hapPanel(true)} />));
    expect(container.querySelector('input')).toBeNull();
    expect(container.querySelector('[data-testid="panel-site-location"]')?.textContent).toBe('chr2R:9,974,319-9,984,319');
    expect(container.querySelector('[data-testid="panel-site-lock"]')?.textContent).toContain('Unlink');
    // Close uses the icon, not a "×" glyph.
    expect(container.querySelector('[aria-label="Close haplotype comparison"] svg')).not.toBeNull();
  });

  it('an unlinked view gets its own location box back', () => {
    act(() => root.render(<PanelSiteBar panel={hapPanel(false)} />));
    expect(container.querySelector('input')).not.toBeNull();
  });

  it('minimized panels are listed in one place: the strip, or the tray when the strip is folded', () => {
    const panels = [{ contentType: 'dataset', collapsed: true }, { contentType: 'dataset', collapsed: false }] as PanelConfig[];
    expect(minimizedTrayShown(panels, false)).toBe(false);
    expect(minimizedTrayShown(panels, true)).toBe(true);
    expect(minimizedTrayShown([{ contentType: 'dataset', collapsed: false }] as PanelConfig[], true)).toBe(false);
  });
});

describe('panel locus in exported figures (fb-r2-integ 5)', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useBrowserStore.setState({ exportInProgress: false });
  });

  it('a panel on its own reference names that reference and its locus in the figure', async () => {
    const { usePanelGenomeStore } = await import('../../stores/panelGenomeStore');
    usePanelGenomeStore.setState({ genomes: { dm6: { key: 'dm6', label: 'dm6', kind: 'registry', genome_id: 'dm6', assembly: 'dm6',
      fasta_path: null, gtf_path: null, has_fasta: true, has_gtf: false, gene_count: 0, n_chroms: 1, chroms: [{ name: 'chr2L', size: 23_513_712 }] } } });
    useBrowserStore.setState({ exportInProgress: true });
    const fly = { id: 'f1', contentType: 'dataset', datasetId: 'fly', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0,
      genome: 'dm6', viewportOverride: { chrom: 'chr2L', start: 1_000, end: 2_000 } } as unknown as PanelConfig;
    act(() => root.render(<PanelSiteBar panel={fly} />));
    const texts = [...container.querySelectorAll<HTMLElement>('[data-figure-text]')].map(el => el.dataset.figureText);
    expect(texts).toEqual(['dm6 · chr2L:1,000-2,000']);
  });
});

describe('Match other panels on a genome to this location (fb-r3-nav)', () => {
  let container: HTMLDivElement;
  let root: Root;
  const dm6 = (id: string, datasetId: string, v: { chrom: string; start: number; end: number }, over: Partial<PanelConfig> = {}) => ({
    id, contentType: 'dataset', datasetId, subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0,
    genome: 'dm6', viewportOverride: v, ...over,
  }) as unknown as PanelConfig;
  const A = { chrom: 'chr2L', start: 1_000, end: 2_000 };
  const B = { chrom: 'chr3R', start: 5_000, end: 9_000 };
  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const { usePanelGenomeStore } = await import('../../stores/panelGenomeStore');
    usePanelGenomeStore.setState({ genomes: { dm6: { key: 'dm6', label: 'dm6', kind: 'registry', genome_id: 'dm6', assembly: 'dm6',
      fasta_path: null, gtf_path: null, has_fasta: true, has_gtf: false, gene_count: 0, n_chroms: 2,
      chroms: [{ name: 'chr2L', size: 23_513_712 }, { name: 'chr3R', size: 32_079_331 }] } } });
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });
  const render = (id: string) => act(() => root.render(<PanelSiteBar panel={useBrowserStore.getState().panels.find(p => p.id === id)!} />));
  const button = () => container.querySelector<HTMLButtonElement>('[data-testid="panel-match-others"]');

  it('next to the find-reads crosshair: names the genome, is a keyboard-reachable button with an icon, and moves the others', () => {
    useBrowserStore.setState({ navigationMode: 'perPanel', panels: [
      dm6('f1', 'fly1', A, { navOwn: true }), dm6('f2', 'fly2', B, { navOwn: true }),
    ] });
    render('f1');
    const btn = button()!;
    expect(btn).not.toBeNull();
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.disabled).toBe(false);
    expect(btn.getAttribute('aria-label')).toBe('Match other panels on dm6 to this location');
    expect(btn.title).toContain('Match other panels on dm6 to this location');
    expect(btn.querySelector('svg')).not.toBeNull();
    // Right after the crosshair.
    expect(container.querySelector('[data-testid="panel-find-reads"]')?.nextElementSibling).toBe(btn);
    act(() => btn.click());
    expect(useBrowserStore.getState().panels.find(p => p.id === 'f2')!.viewportOverride).toEqual(A);
    expect(useBrowserStore.getState().navigationMode).toBe('perPanel');
  });

  it('greyed out when the others are there already; absent when no other panel is on that genome', () => {
    useBrowserStore.setState({ navigationMode: 'linked', panels: [dm6('f1', 'fly1', A), dm6('f2', 'fly2', A)] });
    render('f1');
    expect(button()!.disabled).toBe(true);
    // Linked with the other dm6 panel: the bar says so.
    expect(container.querySelector('[data-testid="panel-genome-linked"]')?.getAttribute('aria-label')).toBe('Linked with 1 other dm6 panel');
    useBrowserStore.setState({ panels: [dm6('f1', 'fly1', A), { ...dm6('h1', 'human', A), genome: undefined } as PanelConfig] });
    render('f1');
    expect(button()).toBeNull();
    expect(container.querySelector('[data-testid="panel-genome-linked"]')).toBeNull();
  });
});

// Audit M14: with four panels the per-panel location boxes were 0-60 px ("chr3R:6", "c").
describe('a narrow panel keeps a readable location box', () => {
  const fly = {
    genomeLabel: 'dm6', linkedIcon: false, name: null, showChroms: true, findReads: true, match: true, canLink: false, grouped: false,
  };

  it('everything in the bar when it fits; then the tools, the chromosome list and the chip go to ⋯', () => {
    expect(siteBarLevel(0, fly)).toBe(0);
    expect(siteBarLevel(430, fly)).toBe(0);
    expect(siteBarLevel(330, fly)).toBe(1);
    expect(siteBarLevel(260, fly)).toBe(2);
    expect(siteBarLevel(210, fly)).toBe(3);
  });

  it('too narrow even for that: the box takes what ⋯, Link and Close leave', () => {
    expect(locusBoxMinWidth(400, { canLink: true, grouped: false }, 1)).toBe(LOCUS_BOX_MIN);
    expect(locusBoxMinWidth(230, { canLink: false, grouped: false }, 3)).toBe(LOCUS_BOX_MIN);
    expect(locusBoxMinWidth(230, { canLink: true, grouped: true }, 3)).toBe(230 - 83);
  });

  it('a narrow bar renders the location box at its minimum width and the rest in ⋯', async () => {
    const { usePanelGenomeStore } = await import('../../stores/panelGenomeStore');
    usePanelGenomeStore.setState({ genomes: { dm6: { key: 'dm6', label: 'dm6', kind: 'registry', genome_id: 'dm6', assembly: 'dm6',
      fasta_path: null, gtf_path: null, has_fasta: true, has_gtf: false, gene_count: 0, n_chroms: 1, chroms: [{ name: 'chr3R', size: 32_079_331 }] } } });
    const panel = { id: 'f1', contentType: 'dataset', datasetId: 'fly', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0,
      genome: 'dm6', viewportOverride: { chrom: 'chr3R', start: 6_864_398, end: 6_869_796 } } as unknown as PanelConfig;
    useBrowserStore.setState({ panels: [panel], exportInProgress: false } as never);
    const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === 'panel-site-bar' ? 230 : 0;
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(<PanelSiteBar panel={panel} />));
    const bar = container.querySelector<HTMLElement>('[data-testid="panel-site-bar"]')!;
    expect(bar.dataset.compact).toBe('3');
    expect(container.querySelector<HTMLElement>('[data-testid="panel-location-box"]')!.style.minWidth).toBe(`${LOCUS_BOX_MIN}px`);
    expect(container.querySelector('[data-testid="panel-chrom-select"]')).toBeNull();
    expect(container.querySelector('[title="Pan left"]')).toBeNull();
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="panel-site-more"]')!.click());
    // Outside the panel (which clips it): in the tracks area, here the page.
    const menu = document.querySelector('[data-testid="panel-site-menu"]')!;
    expect(container.contains(menu)).toBe(false);
    expect(menu.querySelector('[data-testid="panel-chrom-select"]')).not.toBeNull();
    expect(menu.querySelector('[data-testid="panel-genome-chip"]')?.textContent).toBe('dm6');
    expect([...menu.querySelectorAll('[role="menuitem"]')].map(b => b.textContent)).toEqual(
      expect.arrayContaining(['Pan left', 'Pan right', 'Zoom out', 'Zoom in', "Go to this dataset's reads"]));
    // Keyboard: the first item has the focus, arrows move, Escape closes and gives the focus back to ⋯.
    expect(menu.contains(document.activeElement)).toBe(true);
    const first = document.activeElement;
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
    expect(document.activeElement).not.toBe(first);
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(document.querySelector('[data-testid="panel-site-menu"]')).toBeNull();
    expect(document.activeElement?.getAttribute('data-testid')).toBe('panel-site-more');
    act(() => root.unmount());
    container.remove();
    width.mockRestore();
  });
});
