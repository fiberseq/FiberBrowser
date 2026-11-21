/** "From panels": panel plots open their panel, or the newest supplied card of their origin; ⌘K lists them. */
import '../testSetup';
import { describe, expect, it } from 'vitest';
import { PANEL_PLOTS, latestSuppliedCard, openPanelPlotCard } from './panelPlots';
import { openSuppliedPlot } from './supplied';
import { emptyGallery, useGalleryStore } from './gallery';
import { useWorkspaceStore } from './workspace';
import { buildPaletteItems } from '../../utils/commandPaletteItems';

const supplied = (origin: string, v: number) => openSuppliedPlot({ type: 'size-histogram', name: origin, datasets: [], series: [{ id: 'a', title: 'A', values: [v] }],
  spec: { origin, x0: 0, dx: 1, xLabel: '', yLabel: '' }, locus: { chrom: 'c', start: 0, end: 1, genome: null } })!;

describe('panel plots', () => {
  it('each has a panel; the supplied card is the newest of its origin', () => {
    expect(PANEL_PLOTS.every(p => p.panel && p.label)).toBe(true);
    useGalleryStore.setState(emptyGallery(), true);
    const nuc = PANEL_PLOTS.find(p => p.id === 'nuc-periods')!;
    expect(latestSuppliedCard(nuc)).toBeNull();
    supplied('Nucleosomes › Local repeat length', 1);
    const newest = supplied('Nucleosomes › Local repeat length', 2);
    supplied('Read stats › MAPQ', 3);
    expect(latestSuppliedCard(nuc)).toBe(newest);
    useWorkspaceStore.setState({ view: 'browser' });
    expect(openPanelPlotCard(nuc)).toBe(true);
    expect(useWorkspaceStore.getState().view).toBe('plots');
  });
  it('⌘K lists every panel plot, and the card where there is one', () => {
    const ids = buildPaletteItems().map(i => i.id);
    for (const p of PANEL_PLOTS) expect(ids).toContain(`panelplot:${p.id}`);
    expect(ids).toContain('panelplot-card:nuc-periods');
  });
});
