import { describe, expect, it } from 'vitest';
import { formatPeakBed, parsePeakBed } from './peakBed';

describe('peak BED utilities', () => {
  it('round-trips FiberBrowser BED6+ peak metadata', () => {
    const bed = formatPeakBed([
      {
        chrom: '2R',
        peak: {
          start: 100,
          end: 180,
          index: 7,
          layer: 2,
          score: 0.4567,
          threshold: 0.15,
          ruleId: 'rule-a',
          isCustom: false,
        },
        rule: {
          id: 'rule-a',
          name: 'TF layer',
          source: 'tf_layer',
          enabled: true,
          color: '#e040fb',
          opacity: 0.6,
          useGradient: true,
          smoothWidth: 100,
          thresholds: [0.5, 0.3, 0.15, 0.08],
          minPeakWidth: 80,
          minReads: 5,
        },
        selected: true,
        mode: 'tf_layer',
      },
    ]);

    const parsed = parsePeakBed(bed);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      chrom: '2R',
      start: 100,
      end: 180,
      ruleId: 'rule-a',
      ruleName: 'TF layer',
      source: 'tf_layer',
      layer: 2,
      score: 0.4567,
      threshold: 0.15,
      selected: true,
      mode: 'tf_layer',
      isCustom: false,
      color: '#e040fb',
    });
  });

  it('parses generic BED3/BED6 files as importable peak intervals', () => {
    const parsed = parsePeakBed([
      'track name=peaks',
      '2R 100 150',
      '2R\t200\t260\tpeak_b\t750\t.',
    ].join('\n'));

    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ chrom: '2R', start: 100, end: 150 });
    expect(parsed[0].score).toBeUndefined();
    expect(parsed[1]).toMatchObject({ chrom: '2R', start: 200, end: 260, name: 'peak_b', score: 0.75 });
  });
});
