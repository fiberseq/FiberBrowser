/**
 * Nucleosome charts open in Plots as supplied series: the chart's lines exactly (x, values, dashes), pinned to the
 * view they were computed for, in a Gallery card.
 */
import '../testSetup';
import { describe, expect, it } from 'vitest';
import { openLinesInPlots } from './RegularityView';
import { emptyGallery, useGalleryStore } from '../plots/gallery';
import { useBrowserStore } from '../../stores/browserStore';
import { useWorkspaceStore } from '../plots/workspace';

describe('nucleosome charts → Plots', () => {
  it('local repeat length opens with its uneven periods and exact shares', () => {
    useGalleryStore.setState(emptyGallery(), true);
    const lines = [
      { key: 'o1::c0', label: 'Early · C1', color: '#123456', dash: '4 2', points: [[163.8, 0.1], [170.7, 0.25], [178.2, 0.65]] as Array<[number, number | null]> },
      { key: 'o2', label: 'Late', color: '#654321', points: [[163.8, 0.3], [178.2, 0.7]] as Array<[number, number | null]> },
    ];
    const id = openLinesInPlots(lines, 'repeat length (bp)', 'share', { name: 'Local repeat length', origin: 'Nucleosomes › Local repeat length', locus: { chrom: 'chrT', start: 10, end: 9010, genome: null }, datasets: ['Early', 'Late'] })!;
    const card = useGalleryStore.getState().entries.find(e => e.id === id)!;
    expect(card.supplied!.xs).toEqual([163.8, 170.7, 178.2]);
    expect(card.supplied!.series).toEqual([
      { id: 'o1::c0', title: 'Early · C1', color: '#123456', dash: [4, 2], values: [0.1, 0.25, 0.65] },
      { id: 'o2', title: 'Late', color: '#654321', values: [0.3, null, 0.7] },
    ]);
    expect(useBrowserStore.getState().plotsWorkspace.current).toMatchObject({ type: 'nuc-spacing', supplied: { origin: 'Nucleosomes › Local repeat length', xLabel: 'repeat length (bp)' } });
    expect(useWorkspaceStore.getState().view).toBe('plots');
  });
});
