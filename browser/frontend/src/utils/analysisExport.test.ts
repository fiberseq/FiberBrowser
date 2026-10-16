import { describe, expect, it } from 'vitest';
import {
  formatContactMatrixTsv,
  formatDonutChartTsv,
  formatHeatmapChartTsv,
  formatHistogramChartTsv,
  formatProfileChartTsv,
  formatScatterChartTsv,
  formatSequenceLogoTsv,
  formatSignalProfileTsv,
  formatTsv,
  formatVPlotChartTsv,
  formatWorkingSetReadsTsv,
} from './analysisExport';

describe('analysis chart data exports', () => {
  it('exports histogram values and confidence metadata', () => {
    const tsv = formatHistogramChartTsv([{
      label: 'bin 1',
      bars: [{ label: 'dataset A', value: 4, ciLow: 2, ciHigh: 7, n: 10, color: '#123456' }],
    }]);
    expect(tsv).toContain('group\tseries\tvalue\tci_low\tci_high\tn\tcolor');
    expect(tsv).toContain('bin 1\tdataset A\t4\t2\t7\t10\t#123456');
  });

  it('exports profile source/display indices under reversal', () => {
    const tsv = formatProfileChartTsv(
      [{ label: 'A', data: [10, 20, 30], ciLow: [8, 18, 28], ciHigh: [12, 22, 32], n: 5 }],
      { windowBp: 1, isReversed: true },
    );
    expect(tsv).toContain('A\t0\t2\t-1\t30\t28\t32\t5');
    expect(tsv).toContain('A\t2\t0\t1\t10\t8\t12\t5');
  });

  it('exports donut denominators and fractions', () => {
    const tsv = formatDonutChartTsv([
      { label: 'one', value: 1 },
      { label: 'three', value: 3 },
    ]);
    expect(tsv).toContain('segment\tcount\ttotal\tfraction\tpercent\tci_low\tci_high\tcolor');
    expect(tsv).toContain('one\t1\t4\t0.25\t25\t');
    expect(tsv).toContain('three\t3\t4\t0.75\t75\t');
  });

  it('exports heatmap color and displayed values separately', () => {
    const tsv = formatHeatmapChartTsv([[0.5]], {
      valueMatrix: [[7]], rowLabels: ['row'], colLabels: ['column'],
    });
    expect(tsv).toContain('0\trow\t0\tcolumn\t0.5\t7');
  });

  it('formats a contact matrix with genomic X/Y bin coordinates', () => {
    const tsv = formatContactMatrixTsv({
      matrix: [[1, 2], [3, 4]],
      chrom: 'chr2L',
      xStart: 100,
      xEnd: 120,
      yStart: 200,
      yEnd: 220,
      resolution: 10,
      normalization: 'balanced',
    });
    expect(tsv).toContain('chr2L\t0\t200\t210\t1\t110\t120\t2\t10\tbalanced');
    expect(tsv.trim().split('\n')).toHaveLength(5);
  });

  it('exports read, layer, and modification records in long form', () => {
    const tsv = formatWorkingSetReadsTsv({
      chrom: 'chr2L', regionStart: 100,
      datasets: { ds1: { reads: [{
        id: 'read-1', intervals: [[1, 5, 4]], qualities: [200],
        layers: { tf: { intervals: [[2, 4, 2]], qualities: [[240]], quality_names: ['tq'] } },
        methyl_m6a: [3], deam: [[4, 1]],
      }] } },
    });
    expect(tsv).toContain('interval\tds1\tread-1\tprimary\t0\t1\t5\t101\t105\t4');
    expect(tsv).toContain('interval\tds1\tread-1\ttf\t0\t2\t4\t102\t104\t2\ttq\t[240]');
    expect(tsv).toContain('modification\tds1\tread-1\t\t0\t3\t4\t103\t104');
  });

  it('exports V-plot bin boundaries', () => {
    const tsv = formatVPlotChartTsv([[0.25, 0.5]], {
      sizeMin: 20, sizeBin: 5, windowBp: 10, posBin: 10,
    });
    expect(tsv).toContain('0\t20\t25\t0\t-10\t0\t0.25');
    expect(tsv).toContain('0\t20\t25\t1\t0\t10\t0.5');
  });

  it('exports scatter point identities', () => {
    const tsv = formatScatterChartTsv({
      coordsX: [1], coordsY: [2], labels: [3], pointIds: ['read-1'], datasetIds: ['dataset-1'],
    });
    expect(tsv).toContain('0\tread-1\tdataset-1\t3\t1\t2');
  });

  it('exports signal, thresholds, and detected peaks', () => {
    const tsv = formatSignalProfileTsv({
      signal: [0.1, 0.2], thresholds: [0.5], thresholdLabels: ['Strong'],
      peaks: [{ start: 10, end: 20, layer: 0, score: 0.8, threshold: 0.5 }],
      viewStart: 0, viewEnd: 20,
    });
    expect(tsv).toContain('signal\t0\t0\t10\t0.1');
    expect(tsv).toContain('threshold\t0\t0\t20\t0.5\tStrong');
    expect(tsv).toContain('peak\t0\t10\t20');
  });

  it('exports PWM inputs and derived logo quantities', () => {
    const tsv = formatSequenceLogoTsv({ A: [4], C: [0], G: [0], T: [0] }, [0, 1]);
    expect(tsv).toContain('1\tA\t4\t1\t2\t2\ttrue');
    expect(tsv).toContain('1\tC\t0\t0\t2\t0\ttrue');
  });

  it('neutralizes spreadsheet formulas in text while preserving negative numbers', () => {
    const tsv = formatTsv([
      ['label', 'value'],
      ['=HYPERLINK("bad")', -2.5],
      ['  +SUM(1,1)', 3],
    ]);
    expect(tsv).toContain("\"'=HYPERLINK(\"\"bad\"\")\"\t-2.5");
    expect(tsv).toContain("'  +SUM(1,1)\t3");
  });

  it('writes a strand on its own as + / - (fb-n3-export, audit M6: it was \'+ and \'-)', () => {
    const tsv = formatTsv([['strand', 'note'], ['+', '+1'], ['-', '-x']]);
    expect(tsv.split('\n')[1]).toBe("+\t'+1");
    expect(tsv.split('\n')[2]).toBe("-\t'-x");
  });

  it('a working set of several regions names each row\'s reference and chromosome (fb-n3-export, audit M3)', () => {
    const tsv = formatWorkingSetReadsTsv({ blocks: [
      { chrom: 'chr19', regionStart: 1000, reference: 'hg38', datasets: { napa: { reads: [{ id: 'h1', intervals: [[1, 5, 4]] }] } } },
      { chrom: 'chr2L', regionStart: 500, reference: 'dm6', datasets: { flyamp: { reads: [{ id: 'f1', intervals: [[2, 4, 2]] }] } } },
    ] });
    const lines = tsv.trim().split('\n');
    expect(lines[0].split('\t').slice(-2)).toEqual(['reference', 'chrom']);
    expect(lines[1]).toBe('interval\tnapa\th1\tprimary\t0\t1\t5\t1001\t1005\t4\t\t\t\t\thg38\tchr19');
    expect(lines[2]).toBe('interval\tflyamp\tf1\tprimary\t0\t2\t4\t502\t504\t2\t\t\t\t\tdm6\tchr2L');
  });
});
