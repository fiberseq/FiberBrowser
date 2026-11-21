/**
 * Panels' plots open in Plots as supplied cards with their exact numbers and what they measure: the Footprints class
 * size histogram, the read-stats histograms.
 */
import '../testSetup';
import { describe, expect, it } from 'vitest';
import { emptyGallery, useGalleryStore } from './gallery';
import { openClassHistogramInPlots } from '../../components/controls/footprint-analysis/SizesTab';
import { openReadStatsHistogram } from '../../components/controls/read-stats/DistributionsTab';

describe('panel → Plots (supplied, exact)', () => {
  it('the class size histogram: per dataset counts on its 5 bp bins, measures say first footprint per read', () => {
    useGalleryStore.setState(emptyGallery(), true);
    const hist = (counts: number[]) => ({ per_footprint: [{ size_histogram: { bins: [10, 15, 20], counts, bin_width: 5 } }] });
    const id = openClassHistogramInPlots({ overlap_stats: { d1: hist([1, 4, 2]), d2: hist([0, 3, 9]) } },
      [{ id: 'd1', label: 'Early', color: '#f00' }, { id: 'd2', label: 'Late' }], 0, { absStart: 1000, absEnd: 1040, chrom: 'chrT' })!;
    const card = useGalleryStore.getState().entries.find(e => e.id === id)!;
    expect(card.supplied!.series.map(s => s.values)).toEqual([[1, 4, 2], [0, 3, 9]]);
    expect(card.plot.supplied).toMatchObject({ origin: 'Footprints › Sizes', x0: 10, dx: 5 });
    expect(card.plot.supplied!.measures).toMatch(/first footprint overlapping 1,000–1,040/);
  });
  it('a read-stats histogram: its counts, bin starts as x, the scope in what it measures', () => {
    useGalleryStore.setState(emptyGallery(), true);
    const bins = [{ lo: 0, hi: 20, count: 5, label: '0' }, { lo: 20, hi: 40, count: 12, label: '20' }];
    const id = openReadStatsHistogram('Footprint Size', bins, 'reads shown: 1,200 reads', { chrom: 'chrT', start: 0, end: 5000, genome: null })!;
    const card = useGalleryStore.getState().entries.find(e => e.id === id)!;
    expect(card.supplied).toMatchObject({ xs: [0, 20], series: [{ values: [5, 12] }] });
    expect(card.plot.supplied!.measures).toBe('every footprint (size > 0) of the reads, pooled; 20 bp bins from 0; reads shown: 1,200 reads');
  });
});
