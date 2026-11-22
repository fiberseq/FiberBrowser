/** Window quantification: regressions from the 3.1.1 release audit. */
import { describe, expect, it } from 'vitest';
import { buildGroups, cellReads, computeQuant } from './engine';
import { DEFAULT_QUANT_SPEC, normalizeQuantSpec, type QuantSpec } from './spec';
import { flankBins, poolLayerData } from './sources';
import { clearProfileReadPool, getProfileReadPool, onProfileReadPool, setProfileReadPool } from '../../utils/profileReadPool';
import type { LoadContext } from './measures';
import { AXIS_STRIP_EXPORT_H, drawAxisStrip } from './AxisControls';
import { drawOverlayProfile } from '../../components/charts/OverlayProfileChart';
import { unitKey, type MeasureData, type MeasureDef } from './measures';
import type { UnitSums } from './windowMaths';

const groups = buildGroups('clusters', { panels: [{ key: 'ds', datasetId: 'ds', label: 'DS' }], clusterPanels: [{ key: 'ds', datasetId: 'ds', label: 'DS' }],
  visible: [{ cluster: 1, color: '#f00' }, { cluster: 2, color: '#00f' }], clusterLabel: c => `C${c}` });
const assignments = { ds: { r0: 1, r1: 1, r2: 2 } };

describe('link back to the reads (audit 3.1.1 #1)', () => {
  it('a layer bar in curve units (the default) links to the group reads that cover the bounds', () => {
    const unit = (cov: number[]) => ({ idx: Int32Array.from(cov.map((_, i) => i)), sig: Float64Array.from(cov), cov: Float64Array.from(cov) });
    const data: MeasureData = { binned: { weights: Float64Array.from([1, 1]), binBp: 8, units: new Map([
      [unitKey('ds', 'r0'), unit([1, 1])], [unitKey('ds', 'r1'), unit([0, 0])], [unitKey('ds', 'r2'), unit([1, 0])]]) } };
    expect(cellReads(data, 'fraction', groups[0], assignments)).toEqual({ ds: ['r0'] });
    expect(cellReads(data, 'fraction', groups[1], assignments)).toEqual({ ds: ['r2'] });
  });

  it('exact-bp units and shares keep their rules (covering reads; members of a share)', () => {
    const u = (num: number, den: number): UnitSums => [num, den, 0, 0, 0, 0];
    const data: MeasureData = { units: new Map([[unitKey('ds', 'r0'), u(0, 10)], [unitKey('ds', 'r1'), u(1, 1)], [unitKey('ds', 'r2'), u(0, 0)]]) };
    expect(cellReads(data, 'fraction', groups[0], assignments)).toEqual({ ds: ['r0', 'r1'] });
    expect(cellReads(data, 'share', groups[0], assignments)).toEqual({ ds: ['r1'] });
    expect(cellReads(undefined, 'share', groups[0], assignments)).toEqual({});
  });
});

describe('curve units honour the flank and dataset baselines (audit 3.1.1 #2)', () => {
  // A 10-bin view, the window over bins 4–5, flanks one bin at each end (10%). One read covers every bin: the curve is
  // 1 in the window, 0.5 in the flanks and 0 elsewhere, so window mean 1, flank mean 0.5, view (dataset) mean 0.3.
  const sigAll = [0.5, 0, 0, 0, 1, 1, 0, 0, 0, 0.5];
  const all = { idx: Int32Array.from(sigAll.map((_, i) => i)), sig: Float64Array.from(sigAll), cov: Float64Array.from(sigAll.map(() => 1)) };
  const data: MeasureData = { binned: { weights: Float64Array.from([1, 1]), binBp: 8, res: 10, flank: flankBins(10, 0.1),
    units: new Map([[unitKey('ds', 'r0'), { idx: Int32Array.from([0, 1]), sig: Float64Array.from([1, 1]), cov: Float64Array.from([1, 1]), all }]]) } };
  const layer: MeasureDef = { id: 'layer:nuc', label: 'Nuc', source: 'layers', kind: 'fraction', unit: 'fraction of covered bp', enrichment: true, windowed: true, available: true };
  const one = buildGroups('clusters', { panels: [{ key: 'ds', datasetId: 'ds', label: 'DS' }], clusterPanels: [{ key: 'ds', datasetId: 'ds', label: 'DS' }],
    visible: [{ cluster: 1, color: '#f00' }], clusterLabel: c => `C${c}` });
  const run = (p: Partial<QuantSpec>) => computeQuant({ spec: normalizeQuantSpec({ ...DEFAULT_QUANT_SPEC, value: 'enrichment', form: 'ratio', resamples: 200, ...p }),
    measures: [{ def: layer, data }], groups: one, assignments: { ds: { r0: 1 } }, boundsBp: 16, seed: 1 });

  it('flank: the window mean over the curve\'s own flank mean', () => {
    const r = run({ baseline: 'flank' });
    expect(r.measures[0].baseline).toBe('flank');
    expect(r.cells[0].value).toBeCloseTo(1, 12);
    expect(r.cells[0].enrich).toBeCloseTo(2, 12);
  });
  it('dataset: the window mean over the dataset curve\'s mean across the view', () => {
    const r = run({ baseline: 'dataset' });
    expect(r.measures[0].baseline).toBe('dataset');
    expect(r.cells[0].enrich).toBeCloseTo(1 / 0.3, 12);
  });
  it('auto follows the cluster y-scale baseline (flank)', () => {
    const r = computeQuant({ spec: normalizeQuantSpec({ ...DEFAULT_QUANT_SPEC, value: 'enrichment', form: 'ratio', baseline: 'auto', resamples: 200 }),
      measures: [{ def: layer, data }], groups: one, assignments: { ds: { r0: 1 } }, boundsBp: 16, seed: 1, yScaleBaseline: 'flank' });
    expect(r.measures[0].baseline).toBe('flank');
    expect(r.cells[0].enrich).toBeCloseTo(2, 12);
  });
  it('without full-view bins it falls back to region and says so', () => {
    const { res: _r, flank: _f, ...rest } = data.binned!;
    const r = computeQuant({ spec: normalizeQuantSpec({ ...DEFAULT_QUANT_SPEC, value: 'enrichment', form: 'ratio', baseline: 'flank', resamples: 200 }),
      measures: [{ def: layer, data: { binned: rest } }], groups: one, assignments: { ds: { r0: 1 } }, boundsBp: 16, seed: 1 });
    expect(r.measures[0].baseline).toBe('region');
  });
  it('the y-scale flank rule: round(res × fraction) bins at each end, at least one', () => {
    expect([...flankBins(500, 0.1)].length).toBe(100);
    expect([...flankBins(10, 0.01)]).toEqual([0, 9]);
  });
});

describe('an emptied panel never leaves its last reads to Quantify (audit 3.1.1 #4)', () => {
  const ctx = { view: { chrom: 'chr1', start: 0, end: 1000, genome: null }, bounds: { from: 100, to: 200 }, flankFraction: 0.1, layerUnits: 'curve',
    allReads: { panels: [{ key: 'p1', datasetId: 'ds', label: 'DS' }] } } as unknown as LoadContext;
  it('an empty pool for the view gives no reads (no value), not the previous pool', () => {
    setProfileReadPool('p1', { reads: [{ id: 'r0', start: 0, end: 1000 } as never], chrom: 'chr1', start: 0, end: 1000, resolution: 500 });
    setProfileReadPool('p1', { reads: [], chrom: 'chr1', start: 0, end: 1000, resolution: 500 });
    const d = poolLayerData(['nuc'], ctx)!;
    expect(d['layer:nuc'].binned!.units.size).toBe(0);
    expect(d['layer:nuc'].sampled).toEqual({ ds: { used: 0 } });
  });
  it('clearing a pool (a server profile) notifies and makes Quantify read a fresh sample', () => {
    let n = 0;
    const off = onProfileReadPool(() => { n++; });
    clearProfileReadPool('p1');
    off();
    expect(n).toBe(1);
    expect(getProfileReadPool('p1')).toBeUndefined();
    expect(poolLayerData(['nuc'], ctx)).toBeNull();
  });
});

describe('exports keep the relative x-axis (audit 3.1.1 #6)', () => {
  const recorder = () => {
    const texts: Array<{ text: string; x: number; y: number }> = [];
    const ctx = { font: '', textAlign: '', textBaseline: '', strokeStyle: '', fillStyle: '', lineWidth: 1, save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
      fillText(text: string, x: number, y: number) { texts.push({ text, x, y }); } } as unknown as CanvasRenderingContext2D;
    return { ctx, texts };
  };
  it('the export strip draws the same ticks under the plot area, and the anchor label', () => {
    const { ctx, texts } = recorder();
    const anchor = { pos: 1000, strand: '+' as const, name: 'view centre', axisLabel: 'Distance from the view centre (bp)' };
    drawAxisStrip(ctx, { left: 30, width: 200 }, 120, { start: 900, end: 1100 }, false, anchor);
    const labels = texts.map(t => t.text);
    expect(labels).toContain('0');
    expect(labels).toContain('+100');
    expect(labels).toContain('-100');
    expect(labels).toContain(anchor.axisLabel);
    // 0 sits at the middle of the plot area (left 30 + 100), the tick label just right of it.
    expect(texts.find(t => t.text === '0')!.x).toBeCloseTo(30 + 100 + 0.5 + 2, 6);
    expect(Math.min(...texts.map(t => t.y))).toBeGreaterThanOrEqual(120);
    expect(AXIS_STRIP_EXPORT_H).toBeGreaterThan(10);
  });
  it('the chart returns its plot area on every path (the empty plot of a set too), so the footer has a place', () => {
    const ctx = { clearRect() {}, fillText() {}, fillRect() {}, strokeRect() {}, measureText: (t: string) => ({ width: t.length * 5 }), font: '', textAlign: '', textBaseline: '', fillStyle: '', strokeStyle: '', lineWidth: 1 } as unknown as CanvasRenderingContext2D;
    const g = drawOverlayProfile(ctx, 300, 120, [], true, false, 1000, 'y', false, undefined, undefined, undefined, false,
      [{ key: 'a', label: 'C1', color: '#f00' }, { key: 'b', label: 'C2', color: '#00f', missing: true }] as never);
    expect(g).not.toBeNull();
    expect(g!.width).toBeGreaterThan(0);
  });
});

describe('a pool answers only the layers the panel fetched (audit 3.1.1, agy #2)', () => {
  it('an extra layer or marks the panel never asked for send Quantify to a fresh sample', async () => {
    const { poolCarries } = await import('./sources');
    const pool = { reads: [{ id: 'r', start: 0, end: 10, layers: {} }] as never, chrom: 'c', start: 0, end: 10, resolution: 500, version: 1, layers: ['nuc'], marks: false };
    expect(poolCarries(pool, 'nuc')).toBe(true);
    // TF neither fetched nor on any read: a fresh sample (it was counted as zero).
    expect(poolCarries(pool, 'tf')).toBe(false);
    expect(poolCarries({ ...pool, reads: [{ id: 'r', layers: { tf: { intervals: [[1, 5, 4]] } } }] as never }, 'tf')).toBe(true);
    // A legacy read (calls only, no named layer): a fresh sample, whose reader takes the calls as footprints.
    expect(poolCarries({ ...pool, layers: [], reads: [{ id: 'r', intervals: [[0, 100, 100]] }] as never }, 'footprint')).toBe(false);
    expect(poolCarries({ ...pool, reads: [] }, 'fire')).toBe(true);
    expect(poolCarries(pool, 'fire')).toBe(false);
    expect(poolCarries(pool, 'm6a')).toBe(false);
    expect(poolCarries({ ...pool, layers: ['msp'], marks: true }, 'fire')).toBe(true);
    expect(poolCarries({ ...pool, marks: true }, 'm5c')).toBe(true);
    expect(poolCarries({ ...pool, layers: undefined, reads: [{ id: 'r', layers: { msp: { intervals: [[1, 5, 4]] } } }] as never }, 'fire')).toBe(true);
  });
});

describe('split panels of one dataset each give their reads (audit 3.1.1, agy #3)', () => {
  it('both panels\' pools are read; a read in both counts once', () => {
    const r = (id: string) => ({ id, start: 0, end: 1000, intervals: [[0, 1000, 1000]], layers: { nuc: { intervals: [[100, 200, 100]] } } });
    setProfileReadPool('s1', { reads: [r('a'), r('b')] as never, chrom: 'chr1', start: 0, end: 1000, resolution: 500 });
    setProfileReadPool('s2', { reads: [r('b'), r('c')] as never, chrom: 'chr1', start: 0, end: 1000, resolution: 500 });
    const ctx = { view: { chrom: 'chr1', start: 0, end: 1000, genome: null }, bounds: { from: 100, to: 200 }, flankFraction: 0.1, layerUnits: 'curve',
      allReads: { panels: [{ key: 's1', datasetId: 'ds', label: 'DS · A' }, { key: 's2', datasetId: 'ds', label: 'DS · B' }] } } as unknown as LoadContext;
    const d = poolLayerData(['nuc'], ctx)!['layer:nuc'];
    expect([...d.binned!.units.keys()].sort()).toEqual(['a', 'b', 'c'].map(x => unitKey('ds', x)));
    expect(d.sampled).toEqual({ ds: { used: 3 } });
    clearProfileReadPool('s1'); clearProfileReadPool('s2');
  });
});

describe('split panels keep their labels in cluster groups (audit 3.1.1)', () => {
  it('two allele panels of one dataset are told apart', () => {
    const g = buildGroups('clusters-datasets', { panels: [], clusterPanels: [{ key: 'a', datasetId: 'ds', label: 'DS · MAT', datasetLabel: 'DS' }, { key: 'b', datasetId: 'ds', label: 'DS · PAT', datasetLabel: 'DS' }],
      visible: [{ cluster: 0, color: '#f00' }], clusterLabel: c => `C${c}` });
    expect(g.map(x => x.title)).toEqual(['DS · MAT · C0', 'DS · PAT · C0']);
  });
});

describe('round 7: curve units with Interval none; regularity content (audit 3.1.1)', () => {
  const layer: MeasureDef = { id: 'layer:nuc', label: 'Nuc', source: 'layers', kind: 'fraction', unit: 'fraction of covered bp', enrichment: true, windowed: true, available: true };
  const unit = (sig: number) => ({ idx: Int32Array.from([0]), sig: Float64Array.from([sig]), cov: Float64Array.from([1]) });
  const data: MeasureData = { binned: { weights: Float64Array.from([1]), binBp: 8, units: new Map([
    [unitKey('A', 'a0'), unit(0)], [unitKey('A', 'a1'), unit(1)], [unitKey('B', 'b0'), unit(1)], [unitKey('B', 'b1'), unit(1)]]) } };
  const groups2 = buildGroups('datasets', { panels: [{ key: 'A', datasetId: 'A', label: 'A' }, { key: 'B', datasetId: 'B', label: 'B' }], clusterPanels: [], visible: [], clusterLabel: c => `C${c}` });
  it('no whiskers for the comparison or enrichment when the interval is none', () => {
    for (const p of [{ compare: 'diff' as const, reference: 'ds:B' }, { value: 'enrichment' as const, baseline: 'pooled' as const }]) {
      const r = computeQuant({ spec: normalizeQuantSpec({ ...DEFAULT_QUANT_SPEC, ci: 'none', resamples: 200, ...p }), measures: [{ def: layer, data }], groups: groups2, assignments: {}, boundsBp: 8, seed: 1 });
      for (const c of r.cells) { expect([c.lo, c.hi, c.cmpLo, c.cmpHi, c.enrichLo, c.enrichHi].every(x => x == null)).toBe(true); }
      expect(r.cells.find(c => c.group === 'ds:A')![p.compare ? 'cmp' : 'enrich']).not.toBeNull();
    }
  });
  it('the regularity digest changes with the medians, not only the count', async () => {
    const { regularityDigest } = await import('./sources');
    const m = (a: number, b: number) => ({ p: new Map<string, [number | null, number | null]>([['r0', [a, null]], ['r1', [b, null]]]) });
    expect(regularityDigest(m(1, 3))).not.toBe(regularityDigest(m(5, 7)));
    expect(regularityDigest(m(1, 3))).toBe(regularityDigest(m(1, 3)));
  });
});
