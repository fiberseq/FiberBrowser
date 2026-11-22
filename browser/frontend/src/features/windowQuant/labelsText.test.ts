// Coverage 3.1.1: the words and numbers a quantification card prints (interval method, p-values, the relative window
// on either strand, bounds text). These are what a user copies into a figure legend.
import { describe, expect, it } from 'vitest';
import { intervalText, measuresLine, pText, unitsText } from './labels';
import { boundsText, DEFAULT_QUANT_SPEC, normalizeQuantSpec, relText, windowGenomic } from './spec';
import type { QuantMeasureInfo, QuantResult } from './engine';

const m = (p: Partial<QuantMeasureInfo>): QuantMeasureInfo => ({ id: 'layer:nuc', label: 'Nuc', kind: 'fraction', unit: 'fraction of covered bp',
  source: 'layers', enrichment: true, windowed: true, baseline: null, method: 'bootstrap', ...p });
const result = (measures: QuantMeasureInfo[], p: Partial<QuantResult> = {}): QuantResult => ({ cells: [], measures, tests: {}, reference: null,
  boundsBp: 300, seed: 7, resamples: 2000, groups: [{ id: 'g1', title: 'Cluster 1', dataset: 'ds' }, { id: 'g2', title: 'Cluster 2', dataset: 'ds' }], ...p });

describe('quantification card text', () => {
  it('names each interval method that the measures use, with resamples and seed', () => {
    expect(intervalText(result([m({ method: 'wilson', kind: 'share' })]))).toBe('Wilson 95% for shares of reads');
    expect(intervalText(result([m({})]))).toBe('bootstrap 95% (2,000 Poisson resamples of reads, seed 7)');
    // a Wilson share shown as enrichment over a baseline is bootstrapped as well
    expect(intervalText(result([m({ method: 'wilson', kind: 'share', baseline: 'flanks' })]))).toContain('bootstrap 95%');
    expect(intervalText(result([m({ method: 'none' as QuantMeasureInfo['method'], kind: 'group' })]))).toBe('no interval for group-level series');
    expect(intervalText(result([m({ method: 'none' as QuantMeasureInfo['method'] })]))).toBe('no interval');
  });

  it('formats p-values without hiding small ones', () => {
    expect(pText(null)).toBe('–');
    expect(pText(Number.NaN)).toBe('–');
    expect(pText(0.5)).toBe('0.500');
    expect(pText(0.005)).toBe('0.0050');
    expect(pText(3e-7)).toBe('3.0e-7');
  });

  it('says which units the layers are in and when the bootstrap was reduced', () => {
    const r = result([m({ units: 'curve', resamplesUsed: 400 }), m({ id: 'layer:tf', units: 'exact', resamplesUsed: 900 })]);
    const t = unitsText(r, 12.345);
    expect(t).toContain("profile's own 12.3 bp bins");
    expect(t).toContain('layers in exact bp');
    expect(t).toContain('reduced to 400 resamples');
    expect(unitsText(result([m({})]))).toBe('');
  });

  it('builds the measures line with the comparison reference and read counts', () => {
    const spec = normalizeQuantSpec({ ...DEFAULT_QUANT_SPEC, compare: 'diff', comparison: 'clusters' });
    const line = measuresLine(result([m({})], { reference: 'g2' }), spec, {
      boundsText: 'chrA:100–400 (300 bp)', sampled: { ds: { used: 1234 } }, datasetLabel: () => 'Demo', readSource: 'panel', windowMissing: true });
    expect(line.startsWith('Mean over chrA:100–400 (300 bp) (no window set: the whole view) per cluster; difference vs Cluster 2;')).toBe(true);
    expect(line).toContain("reads: the panel's curve reads (Demo 1,234)");
    expect(line.endsWith('.')).toBe(true);
    const fetched = measuresLine(result([m({})]), normalizeQuantSpec({ ...DEFAULT_QUANT_SPEC, stat: 'area' }), {
      boundsText: 'x', sampled: { ds: { used: 5 } }, datasetLabel: d => d, readSource: 'fetch' });
    expect(fetched.startsWith('Area over x')).toBe(true);
    expect(fetched).toMatch(/reads used: ds 5 \(up to [\d,]+ per dataset, seed \d+\)/);
  });
});

describe('relative window', () => {
  it('maps a relative window through the anchor on either strand (upstream negative)', () => {
    const w = { relative: true, from: -200, to: 50 } as Parameters<typeof windowGenomic>[0];
    expect(windowGenomic(w, 'chrA', { pos: 1000, strand: '+' })).toEqual([800, 1050]);
    expect(windowGenomic(w, 'chrA', { pos: 1000, strand: '-' })).toEqual([950, 1200]);
    expect(windowGenomic(w, 'chrA', null)).toBeNull();
  });

  it('keeps a genomic window on its own chromosome only', () => {
    const w = { relative: false, chrom: 'chrA', from: 10, to: 20 } as Parameters<typeof windowGenomic>[0];
    expect(windowGenomic(w, 'chrA', null)).toEqual([10, 20]);
    expect(windowGenomic(w, 'chrB', null)).toBeNull();
    expect(windowGenomic(null, 'chrA', null)).toBeNull();
  });

  it('prints signed relative bounds and genomic bounds with their width', () => {
    expect(relText(-1200, 50)).toBe('−1,200 to +50 bp');
    expect(relText(0, 0)).toBe('0 to 0 bp');
    expect(boundsText('chrA', 1000, 1300)).toBe('chrA:1,000–1,300 (300 bp)');
  });
});
