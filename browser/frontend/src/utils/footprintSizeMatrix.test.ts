/** Footprint size plots: colour values and scales, the log2 ratio, the read-count note and the TSV export. */
import { describe, expect, it } from 'vitest';
import {
  colorScaleFor, densityNote, displayValue, scaleRgb, sizeMatrixTsv,
} from './footprintSizeMatrix';
import { colormapRgb } from './footprintSizeColormaps';
import { DEFAULT_FOOTPRINT_SIZE_SETTINGS, withView } from './footprintSizeSettings';

const enrich = DEFAULT_FOOTPRINT_SIZE_SETTINGS;
const counts = withView(DEFAULT_FOOTPRINT_SIZE_SETTINGS, 'vplot');

describe('footprint size matrix helpers', () => {
  it('colours enrichment by log2 (centred on 0) and counts by log1p; blanks stay blank', () => {
    expect(displayValue(2, enrich)).toBe(1);
    expect(displayValue(0.5, enrich)).toBe(-1);
    expect(displayValue(0, enrich)).toBe(Number.NEGATIVE_INFINITY);
    expect(scaleRgb(Number.NEGATIVE_INFINITY, colorScaleFor([[[1, -1]]], enrich))).toEqual(colormapRgb('magma', 0));
    expect(displayValue(null, enrich)).toBeNull();
    expect(displayValue(2, { ...enrich, log: false })).toBe(2);
    expect(displayValue(Math.E - 1, counts)).toBeCloseTo(1);
  });

  it('log2 enrichment has a symmetric range around 0 (1x) with log2 ends; counts use a sequential one', () => {
    const scale = colorScaleFor([[[1, -1, 0.5], [null, 0, 0]]], enrich);
    expect(scale.kind).toBe('diverging');
    expect(scale.lo).toBeCloseTo(-scale.hi);
    expect(scale.midLabel).toBe('0');
    // A single plot: magma, dark below 0, bright above.
    expect(scaleRgb(scale.lo, scale)).toEqual(colormapRgb('magma', 0));
    expect(scaleRgb(scale.hi, scale)).toEqual(colormapRgb('magma', 1));
    // Automatic limit: near-empty cells (log2 -10) do not stretch it past 4x; a flat plot keeps at least 1.25x.
    const stretched = colorScaleFor([[[...Array(40).fill(0.3), -10, -10, -10]]], enrich);
    expect(stretched.hi).toBeCloseTo(2);
    expect(colorScaleFor([[[-12, 12, -12, 12]]], enrich).hiLabel).toBe('+2');
    expect(colorScaleFor([[[0, 0, 0.01]]], enrich).hiLabel).toBe('+0.32');
    // A fixed limit: 2x (log2 1) at either end.
    const fixed = colorScaleFor([[[0.1]]], { ...enrich, colorMax: 2 });
    expect([fixed.lo, fixed.hi, fixed.loLabel, fixed.midLabel, fixed.hiLabel]).toEqual([-1, 1, '-1', '0', '+1']);
    // Linear enrichment (log off) keeps fold-change labels around 1x.
    expect(colorScaleFor([[[2, 0.5]]], { ...enrich, log: false, colorMax: 2 }).hiLabel).toBe('2.00x');
    const seq = colorScaleFor([[[0, 1, 2, 3]]], { ...counts, log: false });
    expect(seq.kind).toBe('sequential');
    expect(seq.lo).toBe(0);
    expect(seq.hi).toBe(3);
  });

  it('notes when panels rest on very different numbers of reads', () => {
    expect(densityNote([{ label: 'A', nReads: 100, nFootprints: 1 }, { label: 'B', nReads: 150, nFootprints: 1 }])).toBeNull();
    const note = densityNote([{ label: 'A', nReads: 1000, nFootprints: 1 }, { label: 'B', nReads: 200, nFootprints: 1 }]);
    expect(note).toMatch(/5\.0-fold.*A: 1,000 reads.*B: 200/);
    expect(densityNote([{ label: 'A', nReads: 10, nFootprints: 1 }])).toBeNull();
  });

  it('exports the matrix as TSV with its settings in the header', () => {
    const tsv = sizeMatrixTsv([[1.5, null], [0.25, 2]], { sizeMin: 10, sizeMax: 30, sizeBin: 10, posBin: 5, nReads: 12, nFootprints: 34 },
      { ...enrich, sigmaSizeBp: 10, sigmaPosBp: 20 }, { title: 'Sample A', chrom: 'chrT', start: 100 });
    const lines = tsv.trim().split('\n');
    const header = lines.filter(l => l.startsWith('#')).join('\n');
    expect(header).toMatch(/size enrichment/);
    expect(header).toMatch(/region: chrT:101-110/);
    expect(header).toMatch(/normalization: row/);
    expect(header).toMatch(/gaussian_sigma_size_bp: 10/);
    expect(header).toMatch(/gaussian_sigma_position_bp: 20/);
    expect(header).toMatch(/min_footprints: 20/);
    expect(header).toMatch(/reads: 12/);
    expect(header).toMatch(/footprints: 34/);
    const rows = lines.filter(l => !l.startsWith('#'));
    expect(rows[0]).toBe('size_bp\t101\t106');
    expect(rows[1]).toBe('10\t1.5\tNA');
    expect(rows[2]).toBe('20\t0.25\t2');
  });

  it('a log2 ratio TSV says its values are log2, whatever the Log colour setting; plain matrices are not logged', () => {
    const meta = { sizeMin: 10, sizeMax: 30, sizeBin: 10, posBin: 10, nReads: 0, nFootprints: 0 };
    for (const s of [enrich, { ...enrich, log: false }, counts, { ...counts, log: false }]) {
      const ratio = sizeMatrixTsv([[1, -1]], meta, s, { title: 'r', chrom: 'chrT', start: 0, value: 'log2 ratio', comparative: true });
      expect(ratio).toMatch(/^# value: log2 ratio \(log2 values: 0 = equal, \+1 = twice, -1 = half\)$/m);
      expect(ratio).toMatch(/^# colour_scale: log2, centred on 0$/m);
      expect(ratio).not.toMatch(/not logged|linear/);
    }
    const plain = sizeMatrixTsv([[1, 2]], meta, { ...enrich, log: false }, { title: 'A', chrom: 'chrT', start: 0 });
    expect(plain).toMatch(/^# value: Per size row \(ratio, 1 = average; not logged\)$/m);
    expect(plain).toMatch(/^# colour_scale: linear$/m);
    expect(sizeMatrixTsv([[1]], meta, counts, { title: 'A', chrom: 'chrT', start: 0 })).toMatch(/^# value: Counts \(not logged\)$\n[\s\S]*^# colour_scale: log1p$/m);
  });
});
