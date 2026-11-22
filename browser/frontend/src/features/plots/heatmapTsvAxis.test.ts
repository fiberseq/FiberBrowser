// Coverage 3.1.1: the heatmap's exported table (coordinates and values a user re-plots) and the BED plot axis words.
import { describe, expect, it } from 'vitest';
import { heatmapTsv, type HeatmapEntry, type HeatmapFigure } from './heatmapData';
import { bedAxis, histogramPadBp } from './bedData';
import { newPlot } from './plotModel';

const fig = (values: Array<Array<number | null>>): HeatmapFigure => ({
  blocks: [{ title: 'Cluster 1', rows: values.map((v, i) => ({ label: `read${i}`, values: v })) }],
  signed: false, comparing: false, mode: null, valueLabel: 'fraction', colormap: 'viridis', reverse: false, note: null, profile: null,
} as unknown as HeatmapFigure);
const entry = (mode: 'reads' | 'features', start: number, binBp: number): HeatmapEntry =>
  ({ key: 'k', locus: { chrom: 'chrA', start: 0, end: 100, genome: null }, mode, binBp, start, groups: [] }) as HeatmapEntry;

describe('heatmap TSV export', () => {
  it('labels read-mode columns with 1-based genomic bin starts and feature-mode columns with bp from the centre', () => {
    const plot = newPlot({ name: 'My map', type: 'heatmap' } as never);
    const reads = heatmapTsv(plot, fig([[0.123456789, null, 2]]), entry('reads', 1000, 10), 'chrA:1,001-1,030').split('\n');
    expect(reads[0]).toBe('# plot: My map');
    expect(reads[1]).toBe('# computed_for: chrA:1,001-1,030');
    expect(reads[2]).toBe('# rows: reads');
    expect(reads).toContain('# bin_bp: 10');
    expect(reads[6]).toBe(['block', 'row', '1001', '1011', '1021'].join('\t'));
    // five significant digits, missing bins as NA
    expect(reads[7]).toBe(['Cluster 1', 'read0', '0.12346', 'NA', '2'].join('\t'));

    const feats = heatmapTsv(plot, fig([[1, 1]]), entry('features', -50, 50), 'features').split('\n');
    expect(feats[2]).toBe('# rows: features');
    expect(feats[6]).toBe(['block', 'row', '-50', '0'].join('\t'));
  });

  it('writes only a header when there are no rows', () => {
    const t = heatmapTsv(newPlot(), { ...fig([]), blocks: [] }, entry('reads', 0, 5), 'x').split('\n');
    expect(t).toHaveLength(7);
    expect(t[6]).toBe('block\trow');
  });
});

describe('BED plot axis', () => {
  it('point mode is relative to the anchor in bp; scale mode stretches the body between two flanks', () => {
    const p = newPlot();
    const point = bedAxis({ ...p, bed: { ...p.bed, mode: 'point', anchor: 'start', flankBp: 1500 }, profile: { ...p.profile, binBp: 25 } });
    expect(point.start).toBe(-1500);
    expect(point.binBp).toBe(25);
    expect(point.label).toBe('bp from the region start (TSS, strand-aware) (25 bp bins)');
    expect(point.ticks).toBeUndefined();
    const end = bedAxis({ ...p, bed: { ...p.bed, mode: 'point', anchor: 'end', flankBp: 10 } });
    expect(end.label).toContain('end (strand-aware)');
    const scale = bedAxis({ ...p, bed: { ...p.bed, mode: 'scale', scaleFlankBp: 2000, bodyBins: 40 } });
    expect(scale.start).toBe(-2000);
    expect(scale.ticks).toEqual(['−2,000 bp', 'region start → end (40 bins)', '+2,000 bp']);
  });

  it('pads size-histogram fetches by twice the largest size so whole footprints are read', () => {
    const p = newPlot();
    expect(histogramPadBp({ ...p, hist: { ...p.hist, sizeMax: 300 } })).toBe(600);
  });
});
