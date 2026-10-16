import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { PanelSiteBar } from './PanelSiteBar';
import { useBrowserStore } from '../../stores/browserStore';
import { usePanelGenomeStore } from '../../stores/panelGenomeStore';
import type { PanelConfig } from '../../types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('a panel\'s long reference name never overlaps its coordinates', () => {
  it('the chip shrinks and is cut (whole name in the tooltip); the bar clips', () => {
    const label = 'Contig ref chr2L:9,471,223 +1,888 bp';
    usePanelGenomeStore.setState({ genomes: { 'fasta:alt_1': { key: 'fasta:alt_1', label, kind: 'fasta', genome_id: null, assembly: null,
      fasta_path: '/x/alt.fa', gtf_path: null, has_fasta: true, has_gtf: false, gene_count: 0, n_chroms: 1,
      chroms: [{ name: 'chr2L_9471223_INS1888', size: 11_888 }] } } as never });
    const panel = { id: 'a1', contentType: 'dataset', datasetId: 'alt', subTracks: [], collapsed: false, linkGroup: null, layoutRow: 0,
      genome: 'fasta:alt_1', viewportOverride: { chrom: 'chr2L_9471223_INS1888', start: 4000, end: 8000 } } as unknown as PanelConfig;
    useBrowserStore.setState({ panels: [panel], exportInProgress: false } as never);
    const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === 'panel-site-bar' ? 520 : 0;
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(<PanelSiteBar panel={panel} />));
    const bar = container.querySelector<HTMLElement>('[data-testid="panel-site-bar"]')!;
    expect(bar.className).toContain('overflow-hidden');
    const chip = container.querySelector<HTMLElement>('[data-testid="panel-genome-chip"]')!;
    expect(chip).not.toBeNull();
    expect(chip.className).toContain('truncate');
    expect(chip.className).not.toContain('shrink-0');
    expect(chip.title).toBe(`Reference: ${label} — click to manage`);
    expect(chip.tagName).toBe('BUTTON');
    expect(chip.getAttribute('aria-haspopup')).toBe('dialog');
    // The location box keeps its room beside it.
    expect(container.querySelector<HTMLElement>('[data-testid="panel-location-box"]')!.style.minWidth).not.toBe('0px');
    act(() => root.unmount());
    container.remove();
    width.mockRestore();
  });
});
