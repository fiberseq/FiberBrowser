/**
 * Summary across groups with Compare on: each comparison's summary is A − B (or log2 A / B) of the two sides' summaries
 * (profileSummary's pooled window mean, count, relative mean or band share), one value per comparison the figure
 * draws, with a seeded Poisson bootstrap of that difference (hand-checked); the size maps' summary is off while
 * comparing (derived, never written); the state line; saved plots round-trip and old ones load under the rule.
 */
import { describe, expect, it } from 'vitest';
import { compareSummary, compareSummaryCi, compareSummaryView, compareValues, normalizeSummary, profileSummary, resolveCompareCi, windowShort, type SummaryUnit } from './summary';
import { percentileInterval, poissonWeights } from '../../utils/stableSample';
import { profileFigure, profilePairs } from './profileFigure';
import { histogramFigure } from './sizeHistogram';
import { comparingNow, compareGroupBlocker, compareStateLine, groupingKey, knownGroupCount, reportGroupCount, summaryBlocker, SUMMARY_OFF_WHILE_COMPARING, typeHasCompare, useGroupCount } from './compareState';
import { DEFAULT_PROFILE_SETTINGS, newPlot, normalizePlot, type PlotSpec } from './plotModel';
import { normalizeGallery } from './gallery';
import { normalizePlotsWorkspace } from './plotsState';

const raw = (cov: number[], sig: number[], nReads = 4) => ({ group: 'g', nReads, coverage: Float64Array.from(cov), signal: Float64Array.from(sig) });
/** Units whose raw sums are the group's (so the pooled point and the bootstrap read the same reads). */
const unitsOf = (prefix: string, rows: Array<[number[], number[]]>): SummaryUnit[] => rows.map(([cov, sig], i) => ({ id: `${prefix}${i}`, cov, sig }));
const sumRows = (rows: Array<[number[], number[]]>) => raw(rows[0][0].map((_, j) => rows.reduce((a, r) => a + r[0][j], 0)), rows[0][1].map((_, j) => rows.reduce((a, r) => a + r[1][j], 0)), rows.length);

// Three groups on one 4-bin axis (bins of 10 from 0), each with its reads as units.
const R1: Array<[number[], number[]]> = [[[1, 1, 1, 1], [1, 0, 1, 0]], [[1, 1, 1, 1], [0, 1, 1, 1]], [[1, 1, 1, 0], [1, 1, 0, 0]]];
const R2: Array<[number[], number[]]> = [[[1, 1, 1, 1], [0, 0, 1, 0]], [[1, 1, 1, 1], [0, 1, 0, 0]], [[1, 1, 0, 0], [0, 0, 0, 0]], [[1, 1, 1, 1], [1, 0, 0, 1]]];
const R3: Array<[number[], number[]]> = [[[1, 1, 1, 1], [1, 1, 1, 1]], [[1, 1, 1, 1], [1, 0, 1, 1]]];
const groups = [
  { id: 'ds1|0', title: 'Early', raw: sumRows(R1), units: unitsOf('a', R1) },
  { id: 'ds2|0', title: 'Mid', raw: sumRows(R2), units: unitsOf('b', R2) },
  { id: 'ds3|0', title: 'Late', raw: sumRows(R3), units: unitsOf('c', R3) },
];
const S = normalizeSummary({ on: true, resamples: 400 });
const O = { histogram: false, start: 0, binBp: 10, sizeMin: 0, s: S, seed: 7 } as const;
const one = (gs: typeof groups) => profileSummary([{ id: 'x', title: '', raw: gs.length === 1 ? gs[0].raw : sumRows(gs.flatMap(g => g === groups[0] ? R1 : g === groups[1] ? R2 : R3)) }], { ...O, s: { ...S, ci: 'none' } })[0].value!;
const plotWith = (patch: Partial<PlotSpec>) => newPlot({ type: 'metaprofile', profile: { ...DEFAULT_PROFILE_SETTINGS, sigmaBp: 0, minCoverage: 0 }, ...patch });

describe('summary of a comparison', () => {
  for (const op of ['diff', 'log2ratio'] as const) {
    for (const mode of ['a-vs-b', 'each-vs-rest', 'each-vs-all'] as const) {
      it(`${mode}, ${op}: one value per drawn comparison = ${op === 'diff' ? 'A − B' : 'log2(A / B)'} of the sides' summaries; a seeded interval`, () => {
        const plot = plotWith({ compare: op, compareMode: mode, compareAB: mode === 'a-vs-b' ? ['ds3|0', 'ds1|0'] : null });
        const fig = profileFigure(plot, groups, 10);
        expect(fig.comparing).toBe(true);
        expect(fig.pairs.map(p => p.label)).toEqual(fig.series.map(s => s.label));
        const vals = compareSummary(groups, fig.pairs, { ...O, op });
        expect(vals.map(v => v.title)).toEqual(fig.series.map(s => s.label));
        const g = (id: string) => groups.find(x => x.id === id)!;
        fig.pairs.forEach((p, i) => {
          const a = one(p.a.map(g)), b = one(p.b.map(g));
          expect(vals[i].value).toBeCloseTo(op === 'diff' ? a - b : Math.log2(a / b), 12);
          expect(vals[i].lo).not.toBeNull();
          expect(vals[i].lo!).toBeLessThanOrEqual(vals[i].hi!);
        });
        if (mode === 'a-vs-b') expect(fig.pairs).toEqual([{ id: 'ds3|0~ds1|0', label: 'Late vs Early', a: ['ds3|0'], b: ['ds1|0'] }]);
        if (mode === 'each-vs-rest') expect(fig.pairs[0].b).toEqual(['ds2|0', 'ds3|0']);
        if (mode === 'each-vs-all') expect(fig.pairs[0].b).toEqual(['ds1|0', 'ds2|0', 'ds3|0']);
        // Seeded: the same seed gives the same interval; another seed another one.
        expect(compareSummary(groups, fig.pairs, { ...O, op })).toEqual(vals);
        const other = compareSummary(groups, fig.pairs, { ...O, op, seed: 8 });
        expect(other.map(v => v.value)).toEqual(vals.map(v => v.value));
        expect(other.map(v => [v.lo, v.hi])).not.toEqual(vals.map(v => [v.lo, v.hi]));
      });
    }
  }

  it('hand-checked bootstrap (A vs B, A − B): each resample is the A side\'s weighted mean minus the B side\'s, the units\' own Poisson streams', () => {
    const pairs = [{ id: 'p', label: 'Early vs Mid', a: ['ds1|0'], b: ['ds2|0'] }];
    const [v] = compareSummary(groups, pairs, { ...O, op: 'diff' });
    const side = (rows: Array<[number[], number[]]>, prefix: string, b: number) => {
      let n = 0, d = 0;
      rows.forEach(([cov, sig], i) => { const w = poissonWeights(7, `${prefix}${i}`, 400)[b]; n += w * sig.reduce((x, y) => x + y, 0); d += w * cov.reduce((x, y) => x + y, 0); });
      return d > 0 ? n / d : null;
    };
    const vals: number[] = [];
    for (let b = 0; b < 400; b++) { const a = side(R1, 'a', b), c = side(R2, 'b', b); if (a != null && c != null) vals.push(a - c); }
    expect([v.lo, v.hi]).toEqual(percentileInterval(vals, 0.95));
  });

  it('a unit on both sides gets the same draws (paired): A vs all with A\'s reads only is exactly 0 in every resample', () => {
    const solo = [groups[0]];
    const vals = compareSummary(solo, [{ id: 'p', label: 'Early vs all', a: ['ds1|0'], b: ['ds1|0'] }], { ...O, op: 'diff' });
    expect(vals[0].value).toBe(0);
    expect([vals[0].lo, vals[0].hi]).toEqual([0, 0]);
  });

  it('the window, count and relative scales, and mark profiles per bp, are the per-group summary\'s', () => {
    const pairs = [{ id: 'p', label: 'Early vs Late', a: ['ds1|0'], b: ['ds3|0'] }];
    for (const normalization of ['fraction', 'count', 'relative'] as const) {
      const o = { ...O, normalization, from: 10, to: 30 };
      const [v] = compareSummary(groups, pairs, { ...o, op: 'diff' });
      const per = profileSummary([groups[0], groups[2]], { ...o, s: { ...S, ci: 'none' } });
      expect(v.value).toBeCloseTo(per[0].value! - per[1].value!, 12);
    }
    const marks = compareSummary(groups, pairs, { ...O, marksPerBp: true, op: 'diff' })[0];
    const plain = compareSummary(groups, pairs, { ...O, op: 'diff' })[0];
    expect(marks.value).toBeCloseTo(plain.value! / 10, 12);
    expect(marks.hi).toBeCloseTo(plain.hi! / 10, 12);
  });

  it('histograms: A − B of the band shares', () => {
    const h1 = { id: 'a|0', title: 'A', raw: raw([1, 1, 1], [6, 2, 2]), units: [{ id: 'x', cov: [1, 1, 1], sig: [6, 2, 2] }] };
    const h2 = { id: 'b|0', title: 'B', raw: raw([1, 1, 1], [2, 2, 6]), units: [{ id: 'y', cov: [1, 1, 1], sig: [2, 2, 6] }] };
    const s = normalizeSummary({ on: true, sizeFrom: 0, sizeTo: 30, resamples: 200 });
    const [v] = compareSummary([h1, h2], [{ id: 'p', label: 'A vs B', a: ['a|0'], b: ['b|0'] }], { histogram: true, start: 0, binBp: 30, sizeMin: 0, s, seed: 1, op: 'diff' });
    expect(v.value).toBeCloseTo(0.6 - 0.2, 12);
  });

  it('intervals: auto and bootstrap resample; Wilson (one group\'s share) and none give no interval, and the header says so', () => {
    expect(resolveCompareCi(normalizeSummary({ ci: 'auto' }))).toBe('bootstrap');
    expect(resolveCompareCi(normalizeSummary({ ci: 'wilson' }))).toBe('none');
    const pairs = [{ id: 'p', label: 'Early vs Mid', a: ['ds1|0'], b: ['ds2|0'] }];
    const [w] = compareSummary(groups, pairs, { ...O, s: normalizeSummary({ on: true, ci: 'wilson' }), op: 'diff' });
    expect([w.lo, w.hi]).toEqual([null, null]);
    expect(compareSummaryCi(groups, normalizeSummary({ ci: 'wilson' }), 1, 'reads')).toContain('Wilson is for one group');
    expect(compareSummaryCi([{}], S, 1, 'reads')).toContain('interval not available');
    expect(compareSummaryCi(groups, S, 3, 'regions')).toBe('bootstrap 95% (400 Poisson resamples of regions, seed 3), A and B resampled together');
  });

  it('the view: header, 0 reference and the window in a few words (centre ±100 bp for a relative profile around an anchor)', () => {
    const pairs = [{ id: 'p', label: 'Early vs Mid', a: ['ds1|0'], b: ['ds2|0'] }];
    const v = compareSummaryView(groups, pairs, { ...O, start: -20, normalization: 'relative', anchored: true, unitNoun: 'reads', what: 'X', op: 'diff' });
    expect(v.reference).toBe(0);
    expect(v.window).toBe('centre ±100 bp');
    expect(v.measures).toMatch(/^A − B of the mean \(relative to the window, 1 = average\) over -100 to 100 \(the default centre window\), one value per comparison; bootstrap 95%/);
    const f = compareSummaryView(groups, pairs, { ...O, normalization: 'fraction', anchored: false, unitNoun: 'reads', what: 'X', op: 'log2ratio' });
    expect(f.window).toBe('the whole axis');
    expect(f.measures.startsWith('log2(A / B) of the mean over the whole axis')).toBe(true);
    expect(windowShort(1000, 2000, false, false)).toBe('1,000 to 2,000');
  });

  it('values match compareValues: log2 is blank unless both sides are positive', () => {
    expect(compareValues('diff', 0.3, 0.1)).toBeCloseTo(0.2);
    expect(compareValues('log2ratio', 0.4, 0.1)).toBeCloseTo(2);
    expect(compareValues('log2ratio', 0, 0.1)).toBeNull();
    expect(compareValues('diff', null, 0.1)).toBeNull();
  });

  it('band lines: the histogram figure and the summary share pairs', () => {
    const plot = newPlot({ type: 'size-histogram', compare: 'diff' });
    const h = [{ id: 'a|0', title: 'A', raw: raw([1, 1], [1, 2]) }, { id: 'b|0', title: 'B', raw: raw([1, 1], [2, 1]) }];
    const fig = histogramFigure(plot, h);
    expect(fig.pairs.map(p => p.label)).toEqual(fig.series.map(s => s.label));
    expect(profilePairs({ ...plot, compare: 'off' }, h)).toBeNull();
  });
});

describe('Compare in the builder and the summary rule', () => {
  it('Compare needs two groups: the reason per grouping; unknown counts never block', () => {
    expect(compareGroupBlocker(null, 'dataset', 'view')).toBeNull();
    expect(compareGroupBlocker(2, 'dataset', 'view')).toBeNull();
    expect(compareGroupBlocker(1, 'dataset', 'view')).toContain('one dataset');
    expect(compareGroupBlocker(1, 'none', 'view')).toContain('Group by None pools every dataset');
    expect(compareGroupBlocker(0, 'cluster', 'view')).toContain('two clusters');
    expect(compareGroupBlocker(1, 'read-groups', 'view')).toContain('only one');
    expect(compareGroupBlocker(1, 'dataset', 'bed')).toContain('BED set');
    expect(comparingNow('diff', null)).toBe(true);
    expect(comparingNow('diff', 1)).toBe(false);
    expect(comparingNow('off', 3)).toBe(false);
    expect(typeHasCompare('metaprofile')).toBe(true);
    expect(typeHasCompare('co-accessibility')).toBe(true);
    expect(typeHasCompare('differential')).toBe(false);
  });

  it('the group count is the drawn one, for this grouping only', () => {
    const p = plotWith({});
    reportGroupCount(p, 1);
    expect(knownGroupCount(useGroupCount.getState(), p)).toBe(1);
    expect(knownGroupCount(useGroupCount.getState(), { ...p, groupBy: 'cluster' })).toBeNull();
    expect(groupingKey({ ...p, where: 'bed', bed: { ...p.bed, setIds: ['a', 'b'] } })).toContain('a,b');
  });

  it('size maps: the summary is off while comparing (derived); profiles and histograms summarise the comparison', () => {
    for (const type of ['size-enrichment', 'vplot'] as const) {
      expect(summaryBlocker({ type, compare: 'log2ratio' }, 2)).toBe(SUMMARY_OFF_WHILE_COMPARING);
      expect(summaryBlocker({ type, compare: 'diff' }, null)).toBe(SUMMARY_OFF_WHILE_COMPARING);
      // One group: Compare can't apply, so the per-group summary works.
      expect(summaryBlocker({ type, compare: 'diff' }, 1)).toBeNull();
      expect(summaryBlocker({ type, compare: 'off' }, 2)).toBeNull();
    }
    expect(summaryBlocker({ type: 'metaprofile', compare: 'diff' }, 2)).toBeNull();
    expect(summaryBlocker({ type: 'size-histogram', compare: 'log2ratio' }, 2)).toBeNull();
    expect(SUMMARY_OFF_WHILE_COMPARING).toBe('Summary is off while comparing; turn Compare off to summarise each group.');
  });

  it('the state line says what is shown', () => {
    expect(compareStateLine({ compare: 'diff', mode: 'a-vs-b', pairs: [{ label: 'Early vs Late' }], summary: { window: 'centre ±200 bp' } }))
      .toBe('Comparing Early vs Late · A − B · summary of the difference, centre ±200 bp');
    expect(compareStateLine({ compare: 'log2ratio', mode: 'each-vs-rest', pairs: [{ label: 'C1 vs rest' }, { label: 'C2 vs rest' }], summary: null }))
      .toBe('Comparing each group vs the rest · log2(A / B)');
    expect(compareStateLine({ compare: 'diff', mode: 'each-vs-all', pairs: [{ label: 'x' }], summary: 'blocked' }))
      .toBe('Comparing each group vs all · A − B · summary off while comparing');
    expect(compareStateLine({ compare: 'diff', mode: null, pairs: [], summary: null })).toBeNull();
    expect(compareStateLine({ compare: 'off', mode: 'a-vs-b', pairs: [{ label: 'x' }], summary: null })).toBeNull();
  });
});

describe('saved plots', () => {
  it('a PlotSpec with Compare and Summary on round-trips unchanged (the summary is never switched off on save or load)', () => {
    for (const type of ['metaprofile', 'size-enrichment', 'size-histogram'] as const) {
      const p = newPlot({ type, compare: 'diff', compareMode: 'a-vs-b', compareAB: ['x|0', 'y|0'], summary: normalizeSummary({ on: true, from: -200, to: 200, resamples: 500, bootSeed: 4 }) });
      const back = normalizePlot(JSON.parse(JSON.stringify(p)));
      expect(back).toEqual(p);
      expect(back.summary.on).toBe(true);
    }
  });

  it('an old spec (3.1 betas: Compare on + Summary on, no newer fields) loads with both kept and renders under the rule', () => {
    const old = { id: 'plot-old', name: '', type: 'metaprofile', source: 'all_footprints', where: 'view', groupBy: 'dataset', compare: 'log2ratio',
      summary: { on: true, chart: 'bar' }, profile: { binBp: 10, sigmaBp: 0, minCoverage: 0 } };
    const p = normalizePlot(old);
    expect([p.compare, p.compareMode, p.summary.on]).toEqual(['log2ratio', 'auto', true]);
    const two = [{ id: 'a|0', title: 'A', raw: raw([2, 2], [1, 1]), units: [{ id: 'r1', cov: [2, 2], sig: [1, 1] }] }, { id: 'b|0', title: 'B', raw: raw([2, 2], [1, 0]), units: [{ id: 'r2', cov: [2, 2], sig: [1, 0] }] }];
    const fig = profileFigure(p, two, 10);
    expect(fig.mode).toBe('a-vs-b');
    const [v] = compareSummary(two, fig.pairs, { ...O, s: p.summary, op: 'log2ratio' });
    expect(v.value).toBeCloseTo(Math.log2(0.5 / 0.25), 12);
    // An old size plot with both on: the summary is off while comparing (its saved summary.on stays true).
    const size = normalizePlot({ ...old, type: 'size-enrichment' });
    expect(size.summary.on).toBe(true);
    expect(summaryBlocker(size, 2)).toBe(SUMMARY_OFF_WHILE_COMPARING);
    // A supplied card with a stray summary.on loads (supplied cards have no summary control).
    const sup = normalizePlot({ ...old, supplied: { origin: 'Nucleosomes', x0: 0, dx: 10, xLabel: 'bp', yLabel: 'v' } });
    expect(sup.summary.on).toBe(true);
    expect(sup.supplied).toBeTruthy();
  });

  it('sessions and the Gallery keep the plot as saved', () => {
    const p = newPlot({ type: 'metaprofile', compare: 'diff', summary: normalizeSummary({ on: true }) });
    const ws = normalizePlotsWorkspace(JSON.parse(JSON.stringify({ current: p })));
    expect(ws.current).toEqual(p);
    const g = normalizeGallery(JSON.parse(JSON.stringify({ version: 2, states: { s1: {} }, entries: [{ id: 'e1', stateId: 's1', data: {}, plot: p, computedFor: { chrom: 'chr1', start: 0, end: 100, genome: null }, createdAt: 1, status: 'kept', items: [], datasets: [] }] })));
    expect(g.entries).toHaveLength(1);
    expect(g.entries[0].plot).toEqual(p);
  });
});
