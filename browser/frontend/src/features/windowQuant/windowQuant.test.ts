import { beforeEach, describe, expect, it } from 'vitest';
import { binnedWindowMean, binWindowWeights, readSums, shareSums, valueSums, viewFlanks, type UnitSums } from './windowMaths';
import { baselineFor, buildGroups, computeQuant, enrichForm, quantOrder, quantTsv, type QuantGroupDef } from './engine';
import { DEFAULT_QUANT_SPEC, effectiveBounds, normalizeQuantSpec, normalizeQuantWindow, type QuantSpec } from './spec';
import { normalizeWindowQuant } from './store';
import { unitKey, type MeasureDef } from './measures';
import { axisLabelOf, referenceOf } from './labels';
import { chiSquareSf, equalSharesTest, wilsonInterval } from '../../utils/statistics';
import { bootstrapSums } from '../plots/summary';
import { quantPlotSpec, quantRequestKey } from './quantPlots';
import { normalizePlot } from '../plots/plotModel';
import { normalizeGallery } from '../plots/gallery';
import { useBrowserStore } from '../../stores/browserStore';
import { registerWindowQuant } from './register';

const B = { win: [100, 200] as [number, number], flanks: viewFlanks(0, 1000, 0.1), view: [0, 1000] as [number, number] };
const spec = (p: Partial<QuantSpec> = {}): QuantSpec => normalizeQuantSpec({ ...DEFAULT_QUANT_SPEC, ...p });
const layer: MeasureDef = { id: 'layer:nuc', label: 'Nuc', source: 'layers', kind: 'fraction', unit: 'fraction of covered bp', enrichment: true, windowed: true, available: true };
const fam: MeasureDef = { id: 'fam:F3', label: 'F3', source: 'fp-families', kind: 'share', unit: 'share of reads', enrichment: true, windowed: false, available: true };
const score: MeasureDef = { id: 'nuc:regularity', label: 'Regularity', source: 'nuc-geometries', kind: 'value', unit: 'median tile score', enrichment: false, windowed: false, available: true };

/** Two clusters in one dataset: cluster 1 reads r0..r(n1-1), cluster 2 the next n2. */
function twoClusters(n1: number, n2: number) {
  const assignments: Record<string, Record<string, number>> = { ds: {} };
  for (let i = 0; i < n1 + n2; i++) assignments.ds[`r${i}`] = i < n1 ? 1 : 2;
  const groups = buildGroups('clusters', { panels: [{ key: 'ds', datasetId: 'ds', label: 'DS' }], clusterPanels: [{ key: 'ds', datasetId: 'ds', label: 'DS' }],
    visible: [{ cluster: 1, color: '#f00' }, { cluster: 2, color: '#00f' }], clusterLabel: c => `C${c}` });
  return { assignments, groups };
}

describe('window maths', () => {
  it('a read counts its bp inside the window only; intervals are clipped to the read and the window; overlaps count once', () => {
    // Read 150..400 covers 50 bp of [100, 200); its layer 120..180 and 170..190 merge to 120..190, 40 bp of it inside the read.
    const s = readSums({ start: 150, end: 400, intervals: [[120, 180], [170, 190]] }, B);
    expect(s[0]).toBe(40);
    expect(s[1]).toBe(50);
    // A read ending exactly at the window's start contributes nothing there.
    expect(readSums({ start: 0, end: 100, intervals: [[0, 100]] }, B).slice(0, 2)).toEqual([0, 0]);
    // Marks: counted inside the window and the read.
    expect(readSums({ start: 0, end: 1000, points: [99, 100, 150, 199, 200] }, B).slice(0, 2)).toEqual([3, 100]);
    // Flanks: [0, 100) and [900, 1000).
    expect(readSums({ start: 0, end: 1000, intervals: [[50, 950]] }, B).slice(2, 4)).toEqual([100, 200]);
  });

  it('bins at the window edges count by their share inside it', () => {
    // 10 bins of 10 bp over [0, 100); window [15, 42) → bin 1 half, bins 2–3 whole, bin 4 two tenths.
    const w = binWindowWeights(10, 0, 100, 15, 42);
    expect(Array.from(w).map(x => +x.toFixed(3))).toEqual([0, 0.5, 1, 1, 0.2, 0, 0, 0, 0, 0]);
    const vals = [9, 1, 2, 3, 4, 9, 9, 9, 9, 9];
    expect(binnedWindowMean(vals, 0, 100, 15, 42)).toBeCloseTo((0.5 * 1 + 2 + 3 + 0.2 * 4) / 2.7, 10);
    // Reversed storage reads bin i from the other end; blank bins are left out.
    expect(binnedWindowMean([...vals].reverse(), 0, 100, 15, 42, true)).toBeCloseTo((0.5 * 1 + 2 + 3 + 0.2 * 4) / 2.7, 10);
    expect(binnedWindowMean([null, null, null, null, null], 0, 50, 0, 50)).toBeNull();
    // A window inside one bin: that bin's value.
    expect(binnedWindowMean(vals, 0, 100, 33, 34)).toBeCloseTo(3, 12);
  });

  it('the bounds: a window on this chromosome, clipped to the view; none falls back to the whole view and says so', () => {
    const view = { chrom: 'chr1', start: 0, end: 1000 };
    expect(effectiveBounds({ bounds: 'window' }, { chrom: 'chr1', from: 900, to: 1200 }, view)).toEqual({ from: 900, to: 1000, kind: 'window', windowMissing: false });
    expect(effectiveBounds({ bounds: 'window' }, null, view)).toMatchObject({ from: 0, to: 1000, windowMissing: true });
    expect(effectiveBounds({ bounds: 'window' }, { chrom: 'chr2', from: 1, to: 5 }, view)).toMatchObject({ windowMissing: true });
    expect(effectiveBounds({ bounds: 'region' }, { chrom: 'chr1', from: 1, to: 5 }, view)).toMatchObject({ from: 0, to: 1000, kind: 'region' });
    expect(normalizeQuantWindow({ chrom: 'c', from: 9, to: 3 })).toEqual({ chrom: 'c', from: 3, to: 9 });
    expect(normalizeQuantWindow({ chrom: 'c', from: 3, to: 3 })).toBeNull();
  });
});

function layerUnits(perCluster: Array<[number, number]>, ns: number[]): Map<string, UnitSums> {
  // Cluster c's reads each have fraction f_c in the window (100 bp covered) and 0.5 in the flank and view.
  const m = new Map<string, UnitSums>();
  let i = 0;
  ns.forEach((n, c) => { for (let j = 0; j < n; j++, i++) m.set(unitKey('ds', `r${i}`), [perCluster[c][0] * 100, 100, 50, 100, perCluster[c][1] * 1000, 1000]); });
  return m;
}

describe('engine', () => {
  it('a group value is Σ num / Σ den (reads weigh by their covered bp); the raw value needs no baseline', () => {
    const { assignments, groups } = twoClusters(2, 1);
    const units = new Map<string, UnitSums>([[unitKey('ds', 'r0'), [10, 100, 0, 0, 0, 0]], [unitKey('ds', 'r1'), [30, 50, 0, 0, 0, 0]], [unitKey('ds', 'r2'), [5, 10, 0, 0, 0, 0]]]);
    const r = computeQuant({ spec: spec({ ci: 'none', minReads: 0 }), measures: [{ def: layer, data: { units } }], groups, assignments, boundsBp: 100, seed: 1 });
    expect(r.cells.map(c => c.value)).toEqual([40 / 150, 0.5]);
    expect(r.cells.map(c => c.n)).toEqual([2, 1]);
    // Area: the mean × the bounds bp.
    const a = computeQuant({ spec: spec({ ci: 'none', stat: 'area', minReads: 0 }), measures: [{ def: layer, data: { units } }], groups, assignments, boundsBp: 100, seed: 1 });
    expect(a.cells[0].value).toBeCloseTo(100 * 40 / 150, 10);
  });

  it('enrichment: each baseline and form', () => {
    const { assignments, groups } = twoClusters(30, 10);
    const units = layerUnits([[0.6, 0.3], [0.2, 0.1]], [30, 10]);
    const run = (p: Partial<QuantSpec>) => computeQuant({ spec: spec({ value: 'enrichment', ci: 'none', ...p }), measures: [{ def: layer, data: { units } }], groups, assignments, boundsBp: 100, seed: 1 });
    const pooled = (30 * 0.6 + 10 * 0.2) / 40;
    expect(run({ baseline: 'pooled', form: 'ratio' }).cells[0].enrich).toBeCloseTo(0.6 / pooled, 10);
    expect(run({ baseline: 'rest', form: 'ratio' }).cells[0].enrich).toBeCloseTo(0.6 / 0.2, 10);
    expect(run({ baseline: 'reference', form: 'ratio', reference: 'ds|2' }).cells[0].enrich).toBeCloseTo(3, 10);
    // Region: all reads of the dataset (here the same reads as pooled).
    expect(run({ baseline: 'region', form: 'percent' }).cells[0].enrich).toBeCloseTo(100 * 0.6 / pooled, 10);
    // Flank: the group's own flank (0.5); dataset: all reads over the whole view.
    expect(run({ baseline: 'flank', form: 'log2' }).cells[0].enrich).toBeCloseTo(Math.log2(0.6 / 0.5), 10);
    expect(run({ baseline: 'dataset', form: 'ratio' }).cells[1].enrich).toBeCloseTo(0.2 / ((30 * 0.3 + 10 * 0.1) / 40), 10);
    // auto: layers follow the y-scale baseline; shares the pooled share; flank never applies to a share.
    expect(baselineFor(layer, { baseline: 'auto' }, 'flank')).toBe('flank');
    expect(baselineFor(fam, { baseline: 'auto' }, 'flank')).toBe('pooled');
    expect(baselineFor(fam, { baseline: 'flank' })).toBe('region');
    expect(enrichForm(2, 'percent')).toBe(200);
    expect(enrichForm(0, 'log2')).toBeNull();
    // A measure without a meaningful ratio stays raw.
    const sc = new Map<string, UnitSums>([[unitKey('ds', 'r0'), valueSums(-0.5)!], [unitKey('ds', 'r30'), valueSums(1)!]]);
    const r = computeQuant({ spec: spec({ value: 'enrichment', minReads: 0 }), measures: [{ def: score, data: { units: sc } }], groups, assignments, boundsBp: 100, seed: 1 });
    expect(r.measures[0].baseline).toBeNull();
    expect(r.cells.map(c => c.enrich)).toEqual([null, null]);
    expect(axisLabelOf(r.measures[0], spec({ value: 'enrichment' }))).toBe('median tile score');
    expect(referenceOf({ baseline: 'pooled' }, spec({ value: 'enrichment', form: 'percent' }))).toBe(100);
  });

  it('the bootstrap is seeded: the same seed gives the same interval, another seed another; it holds the value', () => {
    const { assignments, groups } = twoClusters(40, 25);
    const units = new Map<string, UnitSums>();
    for (let i = 0; i < 65; i++) units.set(unitKey('ds', `r${i}`), [((i * 37) % 100), 100, 0, 0, 0, 0]);
    const run = (seed: number) => computeQuant({ spec: spec({ resamples: 400 }), measures: [{ def: layer, data: { units } }], groups, assignments, boundsBp: 100, seed });
    const a = run(7), b = run(7), c = run(8);
    expect(a.cells.map(x => [x.lo, x.hi])).toEqual(b.cells.map(x => [x.lo, x.hi]));
    expect(a.cells.map(x => [x.lo, x.hi])).not.toEqual(c.cells.map(x => [x.lo, x.hi]));
    for (const x of a.cells) { expect(x.lo!).toBeLessThan(x.value!); expect(x.hi!).toBeGreaterThan(x.value!); }
    // The engine's interval is the Plots summaries' bootstrap (same draws, same seed handling).
    const g0 = [...units].filter(([k]) => assignments.ds[k.split('\u0001')[1]] === 1).map(([id, v]) => ({ id, v }));
    expect(bootstrapSums(g0, 400, 7, S => (S[1] > 0 ? S[0] / S[1] : null))).toEqual([a.cells[0].lo, a.cells[0].hi]);
  });

  it('shares of reads take the Wilson interval (exact for counts); the test of equal shares; BH across measures', () => {
    const { assignments, groups } = twoClusters(50, 50);
    const units = new Map<string, UnitSums>();
    for (let i = 0; i < 100; i++) units.set(unitKey('ds', `r${i}`), shareSums(i < 50 ? (i < 40 ? '1' : '0') : (i < 60 ? '1' : '0'))!);
    units.set(unitKey('ds', 'not-evaluated'), shareSums('.') ?? [0, 0, 0, 0, 0, 0]);
    const flat = new Map<string, UnitSums>();
    for (let i = 0; i < 100; i++) flat.set(unitKey('ds', `r${i}`), shareSums(i % 2 ? '1' : '0')!);
    const r = computeQuant({ spec: spec(), measures: [{ def: fam, data: { units } }, { def: { ...fam, id: 'fam:F4', label: 'F4' }, data: { units: flat } }], groups, assignments, boundsBp: 100, seed: 1 });
    const w = wilsonInterval(40, 50);
    expect(r.cells[0]).toMatchObject({ value: 0.8, k: 40, n: 50, method: 'wilson' });
    expect(r.cells[0].lo).toBeCloseTo(w.low, 12);
    expect(r.cells[0].hi).toBeCloseTo(w.high, 12);
    const t = equalSharesTest([{ k: 40, n: 50 }, { k: 10, n: 50 }])!;
    expect(r.tests['fam:F3']!.p).toBeCloseTo(t.p, 12);
    expect(t.stat).toBeCloseTo(36, 10);
    expect(r.tests['fam:F4']!.p).toBeCloseTo(1, 6);
    // Two measures tested: q = BH of the two p-values.
    expect(r.tests['fam:F3']!.q).toBeCloseTo(Math.min(1, t.p * 2), 12);
    expect(quantOrder(r, spec({ sort: 'spread' })).measures).toEqual(['fam:F3', 'fam:F4']);
    expect(chiSquareSf(3.841458820694124, 1)).toBeCloseTo(0.05, 8);
    expect(chiSquareSf(5.991464547107979, 2)).toBeCloseTo(0.05, 8);
    expect(equalSharesTest([{ k: 0, n: 10 }, { k: 0, n: 5 }])).toBeNull();
    expect(equalSharesTest([{ k: 40, n: 50 }, { k: 10, n: 50 }], 'g')!.p).toBeLessThan(1e-6);
  });

  it('versus the reference: difference and log2 ratio, with a bootstrap interval; the reference reads 0', () => {
    const { assignments, groups } = twoClusters(60, 60);
    const units = layerUnits([[0.6, 0.3], [0.3, 0.3]], [60, 60]);
    // Some read-to-read variation so the interval has width.
    let i = 0;
    for (const [k, v] of units) { const f = (i++ % 3) * 0.1; units.set(k, [v[0] + f * 100, v[1], v[2], v[3], v[4], v[5]]); }
    const diff = computeQuant({ spec: spec({ compare: 'diff', reference: 'ds|2', resamples: 300 }), measures: [{ def: layer, data: { units } }], groups, assignments, boundsBp: 100, seed: 3 });
    const c1 = diff.cells.find(c => c.group === 'ds|1')!, c2 = diff.cells.find(c => c.group === 'ds|2')!;
    expect(c1.cmp).toBeCloseTo(c1.value! - c2.value!, 10);
    expect(c1.cmpLo!).toBeLessThan(c1.cmp!);
    expect(c1.cmpHi!).toBeGreaterThan(c1.cmp!);
    expect(c2.cmp).toBe(0);
    expect(c2.cmpLo).toBeNull();
    const lr = computeQuant({ spec: spec({ compare: 'log2ratio', reference: 'ds|2', resamples: 300 }), measures: [{ def: layer, data: { units } }], groups, assignments, boundsBp: 100, seed: 3 });
    expect(lr.cells[0].cmp).toBeCloseTo(Math.log2(c1.value! / c2.value!), 10);
    expect(axisLabelOf(lr.measures[0], spec({ compare: 'log2ratio' }))).toBe('log2 ratio vs reference (fraction of covered bp)');
  });

  it('few reads: the group is greyed with its n, never dropped; the TSV carries n per group', () => {
    const { assignments, groups } = twoClusters(30, 3);
    const units = layerUnits([[0.5, 0.5], [0.4, 0.4]], [30, 3]);
    const r = computeQuant({ spec: spec({ ci: 'none' }), measures: [{ def: layer, data: { units } }], groups, assignments, boundsBp: 100, seed: 1 });
    expect(r.cells.map(c => [c.low, c.n])).toEqual([[false, 30], [true, 3]]);
    expect(r.cells[1].value).toBeCloseTo(0.4, 10);
    const tsv = quantTsv(r, ['test']).split('\n');
    expect(tsv[1].split('\t')).toContain('n_reads');
    expect(tsv[3].split('\t')[4]).toBe('3');
    expect(tsv[3].split('\t')[16]).toBe('yes');
  });

  it('groups: clusters pooled across datasets, clusters × datasets, datasets', () => {
    const panels = [{ key: 'a', datasetId: 'A', label: 'A' }, { key: 'b', datasetId: 'B', label: 'B' }];
    const o = { panels, clusterPanels: panels, visible: [{ cluster: 1, color: '#f00' }], clusterLabel: (c: number) => `C${c}` };
    expect(buildGroups('clusters', o).map((g: QuantGroupDef) => [g.id, g.match.length])).toEqual([['cl:1', 2]]);
    expect(buildGroups('clusters-datasets', o).map(g => g.id)).toEqual(['a|1', 'b|1']);
    expect(buildGroups('datasets', o).map(g => g.id)).toEqual(['ds:A', 'ds:B']);
  });
});

describe('footprint size band', () => {
  it('counts a read\'s footprints by their centre in the bounds, and those sized in the band', async () => {
    const { bandCounts } = await import('./sources');
    // Footprints of 40, 150 and 60 bp; centres 120, 275, 330. Bounds [100, 300): the first two; band [0, 90): one.
    expect(bandCounts([[100, 140], [200, 350], [300, 360]], [[100, 300]], [0, 90])).toEqual([1, 2]);
    expect(bandCounts([[100, 140], [200, 350], [300, 360]], [[0, 1000]], [0, 90])).toEqual([2, 3]);
    expect(bandCounts([], [[0, 1]], [0, 90])).toEqual([0, 0]);
  });
});

describe('spec, session and PlotSpec', () => {
  beforeEach(() => { registerWindowQuant(); });

  it('normalises every field and falls back per field', () => {
    expect(normalizeQuantSpec({ measures: ['a', 'a', 3], bounds: 'nope', resamples: 5, flankFraction: 2, ci: 'wilson' })).toEqual({ ...DEFAULT_QUANT_SPEC, measures: ['a'], resamples: 50, flankFraction: 0.45, ci: 'wilson' });
    expect(normalizeWindowQuant(undefined)).toEqual({ version: 1, window: null, spec: { ...DEFAULT_QUANT_SPEC, measures: [] }, openIn: null, axis: { mode: 'genome', anchor: 'tss', gene: null, position: null } });
  });

  it('the window and the spec go through the session; an older session loads with no window and the defaults', async () => {
    const st = useBrowserStore.getState();
    st.setQuantWindow({ chrom: 'chr19', from: 47_515_100, to: 47_515_200 });
    st.updateQuantSpec({ measures: ['layer:nuc', 'fam:x|y'], comparison: 'datasets', value: 'enrichment', baseline: 'rest', compare: 'diff' });
    st.setQuantOpen('cluster');
    st.setQuantAxis({ mode: 'relative', anchor: 'centre' });
    st.setQuantWindow({ chrom: 'chr19', from: -200, to: 50, relative: true });
    const saved = useBrowserStore.getState().windowQuant;
    const { applyImportedState, collectFrontendState } = await import('../../api/session');
    const frontend = JSON.parse(JSON.stringify(collectFrontendState()));
    expect(frontend.windowQuant.window).toEqual({ chrom: 'chr19', from: -200, to: 50, relative: true });
    expect(frontend.windowQuant.axis).toEqual({ mode: 'relative', anchor: 'centre', gene: null, position: null });
    useBrowserStore.getState().setQuantWindow(null);
    applyImportedState({ datasets: [], overlays: [], has_fasta: false, frontend, viewport: { chrom: 'chr19', start: 47_515_000, end: 47_515_300 } });
    expect(useBrowserStore.getState().windowQuant).toEqual(saved);
    applyImportedState({ datasets: [], overlays: [], has_fasta: false, frontend: {}, viewport: { chrom: 'chr19', start: 47_515_000, end: 47_515_300 } });
    expect(useBrowserStore.getState().windowQuant.window).toBeNull();
    expect(useBrowserStore.getState().windowQuant.spec).toEqual(DEFAULT_QUANT_SPEC);
    expect(useBrowserStore.getState().windowQuant.axis.mode).toBe('genome');
  });

  it('a kept quantification records the spec, the window, the bounds and the sampling in its PlotSpec, and its values in the card', () => {
    const { assignments, groups } = twoClusters(30, 30);
    const units = layerUnits([[0.5, 0.5], [0.4, 0.4]], [30, 30]);
    const s = spec({ readCap: 1500, seed: 4, comparison: 'clusters' });
    const result = computeQuant({ spec: s, measures: [{ def: layer, data: { units } }], groups, assignments, boundsBp: 100, seed: 4 });
    const input = { result, spec: s, window: { chrom: 'chr19', from: 100, to: 200 }, bounds: { chrom: 'chr19', from: 100, to: 200, kind: 'window' as const },
      axis: { mode: 'relative' as const, anchor: 'tss' as const, gene: 'G1', position: null }, anchor: { pos: 150, strand: '-' as const, name: 'TSS of G1' },
      name: 'Quantify · Nuc', measures: 'Mean over …', yLabel: 'fraction of covered bp', datasets: ['ds'], genome: null, origin: 'Clusters › Profiles · Quantify window' };
    const plot = quantPlotSpec(input);
    const back = normalizePlot(JSON.parse(JSON.stringify(plot)));
    expect(back.supplied?.quant).toEqual({ spec: s, window: input.window, bounds: input.bounds, axis: input.axis, anchor: input.anchor });
    // A view metaprofile's relative axis goes through the PlotSpec too; genome coordinates leave no field.
    expect(normalizePlot({ ...plot, axis: { mode: 'relative', anchor: 'centre' } }).axis).toEqual({ mode: 'relative', anchor: 'centre', gene: null, position: null });
    expect(normalizePlot({ ...plot, axis: { mode: 'genome' } }).axis).toBeUndefined();
    expect(back.sampling).toEqual({ mode: 'random', n: 1500, seed: 4 });
    expect(back.pinned).toEqual({ chrom: 'chr19', start: 100, end: 200, genome: null });
    const g = normalizeGallery(JSON.parse(JSON.stringify({ version: 2, cap: 50, liveId: null, states: { s1: {} }, entries: [{
      id: 'e1', name: 'q', status: 'kept', starred: true, createdAt: 1, parentId: null, plot, computedFor: plot.pinned, requestKey: quantRequestKey(input), data: {},
      supplied: { series: [], quant: result }, items: [], thumb: '', stateId: 's1', datasets: ['ds'] }] })));
    expect(g.entries[0].supplied?.quant?.cells).toEqual(JSON.parse(JSON.stringify(result.cells)));
    expect(g.entries[0].plot.supplied?.quant?.spec).toEqual(s);
  });
});
