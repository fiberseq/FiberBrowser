/**
 * Several sources in one Plots metaprofile: the spec (sources[] with `source` kept for compatibility; old specs and
 * sessions migrate), the chip rules per type, the drawing data (groups × sources: a panel per group, every source in
 * every legend, colours from the layer colour resolver), summaries and Compare per source (grouped bars), the TSV,
 * Gallery packing, request keys (one source unchanged), and the family membership rule shared with Quantify a window.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PROFILE_SETTINGS, MAX_SOURCES, duplicatePlot, newPlot, normalizePlot, plotSources, sourceMixBlocker, sourcesForType, toggleSource,
  withSources, withType, type PlotSpec,
} from './plotModel';
import { ALL_FOOTPRINTS } from '../../utils/footprintSizeSettings';
import { getLayerColor, setLayerColorOverrideSource } from '../../utils/layerColors';
import { baseGroupsOf, combineSourceGroups, sourceColor } from './multiSource';
import { multiSourcePairs, profileCharts, profileFigure, profileTsv } from './profileFigure';
import { compareSummaryView, isGroupedSummary, normalizeSummary, profileSummaryView, summaryLayout, summaryTsv, type SummaryUnit } from './summary';
import { packProfile, unpackProfile } from './gallery';
import { finishProfile } from './profileEngine';
import { familyEngineRead, multiSourceKey, profileRequestKey, type ProfileGroup } from './useProfileData';
import { familyState, type FamilyMembership } from '../hub/familySources';
import { normalizePlotsWorkspace } from './plotsState';
import { profileSummaryOf } from './ProfileSummaryBlock';

afterEach(() => setLayerColorOverrideSource(null));

const raw = (cov: number[], sig: number[], nReads = 4) => ({ group: 'g', nReads, coverage: Float64Array.from(cov), signal: Float64Array.from(sig) });
const units = (prefix: string, rows: Array<[number[], number[]]>): SummaryUnit[] => rows.map(([cov, sig], i) => ({ id: `${prefix}${i}`, cov, sig }));
const sum = (rows: Array<[number[], number[]]>) => raw(rows[0][0].map((_, j) => rows.reduce((a, r) => a + r[0][j], 0)), rows[0][1].map((_, j) => rows.reduce((a, r) => a + r[1][j], 0)), rows.length);

/** Per source, two datasets' groups, each from its reads (units); the reads are the same names across sources. */
const ROWS: Record<string, Record<string, Array<[number[], number[]]>>> = {
  nuc: { 'p1|all': [[[1, 1, 1, 1], [1, 1, 0, 0]], [[1, 1, 1, 1], [1, 1, 1, 0]]], 'p2|all': [[[1, 1, 1, 1], [1, 0, 0, 0]], [[1, 1, 1, 1], [0, 0, 0, 0]]] },
  tf: { 'p1|all': [[[1, 1, 1, 1], [0, 0, 1, 0]], [[1, 1, 1, 1], [0, 0, 0, 1]]], 'p2|all': [[[1, 1, 1, 1], [0, 1, 1, 0]], [[1, 1, 1, 1], [0, 1, 0, 0]]] },
  'fam:find-classes:j1|fp-class:j1:3': { 'p1|all': [[[1, 1, 1, 1], [0, 1, 1, 0]], [[1, 1, 1, 1], [0, 0, 0, 0]]], 'p2|all': [[[1, 1, 1, 1], [0, 1, 1, 0]], [[1, 1, 1, 1], [0, 1, 1, 0]]] },
};
const TITLES: Record<string, string> = { 'p1|all': 'Early', 'p2|all': 'Late' };
const perSource = (src: string): ProfileGroup[] => Object.entries(ROWS[src]).map(([id, rows]) => ({ id, title: TITLES[id], color: id === 'p1|all' ? '#111111' : '#222222', raw: sum(rows), units: units(id.slice(0, 2), rows) }));
const SOURCES = ['nuc', 'tf', 'fam:find-classes:j1|fp-class:j1:3'];
const LABELS = { 'fam:find-classes:j1|fp-class:j1:3': 'Class 3' };
const combined = () => combineSourceGroups(SOURCES.map(source => ({ source, groups: perSource(source) })), LABELS);
const plotWith = (patch: Partial<PlotSpec> = {}) => withSources(newPlot({ type: 'metaprofile', profile: { ...DEFAULT_PROFILE_SETTINGS, sigmaBp: 0, minCoverage: 0 }, ...patch }), SOURCES, LABELS);

describe('the spec: sources[] with source kept', () => {
  it('an old spec or session with `source` reads as a one-source list', () => {
    const p = normalizePlot({ id: 'x', type: 'metaprofile', source: 'tf' });
    expect(p.sources).toEqual(['tf']);
    expect(p.source).toBe('tf');
    // Older still: null / '' were the Nuc layer (as normalizeFootprintSizeLayer reads them).
    expect(normalizePlot({ id: 'y', type: 'metaprofile', source: null }).sources).toEqual([p.source === 'tf' ? normalizePlot({ source: null }).source : 'nuc']);
    expect(normalizePlot({ id: 'z', type: 'metaprofile' }).sources).toEqual([ALL_FOOTPRINTS]);
  });
  it('several sources round-trip (JSON, sessions); source is the first; names of families kept only for drawn ones', () => {
    const p = plotWith();
    expect(p.source).toBe('nuc');
    expect(p.sources).toEqual(SOURCES);
    expect(p.sourceLabels).toEqual(LABELS);
    const back = normalizePlot(JSON.parse(JSON.stringify(p)));
    expect(back.sources).toEqual(SOURCES);
    expect(back.sourceLabels).toEqual(LABELS);
    const ws = normalizePlotsWorkspace(JSON.parse(JSON.stringify({ version: 1, current: p, saved: [] })));
    expect(ws.current.sources).toEqual(SOURCES);
    expect(withSources(p, ['nuc']).sourceLabels).toBeUndefined();
  });
  it('a writer that sets only `source` wins (a { source } patch, a panel\'s Open in Plots)', () => {
    const p = { ...plotWith(), source: 'fire' };
    expect(plotSources(p)).toEqual(['fire']);
    expect(normalizePlot(p).sources).toEqual(['fire']);
  });
  it('single-source types keep one: the first selected (switching type trims to it)', () => {
    const p = plotWith();
    for (const t of ['size-histogram', 'vplot', 'size-enrichment', 'heatmap'] as const) {
      const q = withType(p, t);
      expect(q.sources).toEqual(['nuc']);
      expect(q.source).toBe('nuc');
      expect(normalizePlot({ ...p, type: t }).sources).toEqual(['nuc']);
    }
    // Marks have no sizes: a size type of m6A plots all footprints.
    expect(sourcesForType('size-histogram', ['m6a', 'nuc'])).toEqual([ALL_FOOTPRINTS]);
    // Back to Metaprofile: the one kept.
    expect(withType(withType(p, 'heatmap'), 'metaprofile').sources).toEqual(['nuc']);
  });
  it('a duplicate keeps its own copy of the sources', () => {
    const p = plotWith();
    const d = duplicatePlot(p);
    expect(d.sources).toEqual(SOURCES);
    expect(d.sources).not.toBe(p.sources);
  });
});

describe('chip rules per type', () => {
  it('Metaprofile toggles; the last one stays; at most MAX_SOURCES', () => {
    expect(toggleSource('metaprofile', ['nuc'], 'tf')).toEqual(['nuc', 'tf']);
    expect(toggleSource('metaprofile', ['nuc', 'tf'], 'nuc')).toEqual(['tf']);
    expect(toggleSource('metaprofile', ['tf'], 'tf')).toEqual(['tf']);
    const many = Array.from({ length: MAX_SOURCES }, (_, i) => `l${i}`);
    expect(toggleSource('metaprofile', many, 'new')).toEqual([...many.slice(1), 'new']);
  });
  it('m6A (marks per bp) never mixes with interval sources: the click replaces, with the reason', () => {
    expect(toggleSource('metaprofile', ['nuc', 'tf'], 'm6a')).toEqual(['m6a']);
    expect(toggleSource('metaprofile', ['m6a'], 'nuc')).toEqual(['nuc']);
    expect(sourceMixBlocker(['nuc'], 'm6a')).toMatch(/replaces/);
    expect(sourceMixBlocker(['nuc'], 'tf')).toBeNull();
  });
  it('single-select types: a chip replaces', () => {
    for (const t of ['size-histogram', 'vplot', 'size-enrichment', 'heatmap'] as const) expect(toggleSource(t, ['nuc'], 'tf')).toEqual(['tf']);
  });
});

describe('drawing data: groups × sources', () => {
  it('combined groups are base-major, carry source and base as fields, and take the source colour from the resolver', () => {
    setLayerColorOverrideSource(() => ({ tf: '#123456' }));
    const gs = combined();
    expect(gs.map(g => [g.base, g.source])).toEqual([['p1|all', 'nuc'], ['p1|all', 'tf'], ['p1|all', SOURCES[2]], ['p2|all', 'nuc'], ['p2|all', 'tf'], ['p2|all', SOURCES[2]]]);
    expect(gs[1].color).toBe('#123456');
    expect(gs[0].color).toBe(getLayerColor('nuc'));
    expect(gs[2].title).toBe('Early · Class 3');
    expect(baseGroupsOf(gs)).toEqual([{ id: 'p1|all', title: 'Early' }, { id: 'p2|all', title: 'Late' }]);
    // One source: as given (ids, titles, colours unchanged).
    expect(combineSourceGroups([{ source: 'nuc', groups: perSource('nuc') }])).toEqual(perSource('nuc'));
  });
  it('a panel per group with every source overlaid (three lines each), one shared y range, every source in every legend', () => {
    const fig = profileFigure(plotWith(), combined(), 10);
    expect(fig.facets?.panels.map(p => p.title)).toEqual(['Early', 'Late']);
    const charts = profileCharts(fig, { start: 0, binBp: 10, width: 400, height: 200, filename: 'x' });
    expect(charts).toHaveLength(2);
    for (const c of charts) {
      expect(c.series.map(s => s.label)).toEqual(['Nuc', 'TF', 'Class 3']);
      expect(c.series.map(s => s.color)).toEqual(SOURCES.map(sourceColor));
    }
    expect(charts[0].yRange).toEqual(charts[1].yRange);
    expect(charts[0].yRange).not.toBeNull();
    // Each its own y.
    const own = profileCharts(profileFigure(plotWith({ profile: { ...DEFAULT_PROFILE_SETTINGS, sigmaBp: 0, minCoverage: 0, multiYScale: 'own' } }), combined(), 10), { start: 0, binBp: 10, width: 400, height: 200, filename: 'x' });
    expect(own[0].yRange).toBeNull();
  });
  it('a source with no reads in a group keeps its legend entry (an empty line)', () => {
    const gs = combined().filter(g => !(g.base === 'p2|all' && g.source === 'tf'));
    const charts = profileCharts(profileFigure(plotWith(), gs, 10), { start: 0, binBp: 10, width: 400, height: 200, filename: 'x' });
    expect(charts[1].series.map(s => s.label)).toEqual(['Nuc', 'TF', 'Class 3']);
    expect(charts[1].series[1].values.every(v => v == null)).toBe(true);
  });
  it('overlay: one chart of six lines, groups told apart by dash', () => {
    const fig = profileFigure(plotWith({ profile: { ...DEFAULT_PROFILE_SETTINGS, sigmaBp: 0, minCoverage: 0, multiLayout: 'overlay' } }), combined(), 10);
    const charts = profileCharts(fig, { start: 0, binBp: 10, width: 400, height: 200, filename: 'x' });
    expect(charts).toHaveLength(1);
    expect(charts[0].series).toHaveLength(6);
    expect(charts[0].series[0].dash).not.toEqual(charts[0].series[3].dash);
  });
  it('the TSV names each column by group and source', () => {
    const plot = plotWith();
    const tsv = profileTsv(plot, profileFigure(plot, combined(), 10), 0, 10, 'chr1:1-40');
    expect(tsv).toContain('# source: nuc,tf,fam:');
    expect(tsv.split('\n').find(l => l.startsWith('position'))).toBe('position\tEarly · Nuc\tEarly · TF\tEarly · Class 3\tLate · Nuc\tLate · TF\tLate · Class 3');
  });
});

describe('Compare per source', () => {
  it('each source\'s groups are paired as one source\'s would be; a panel per comparison with a line per source in its colour', () => {
    const plot = plotWith({ compare: 'diff', compareMode: 'a-vs-b', compareAB: ['p2|all', 'p1|all'] });
    const paired = multiSourcePairs(plot, combined())!;
    expect(paired.pairs.map(p => [p.source, p.a, p.b])).toEqual(SOURCES.map(s => [s, [`${s}::p2|all`], [`${s}::p1|all`]]));
    const fig = profileFigure(plot, combined(), 10);
    expect(fig.comparing).toBe(true);
    const charts = profileCharts(fig, { start: 0, binBp: 10, width: 400, height: 200, filename: 'x' });
    expect(charts).toHaveLength(1);
    expect(charts[0].title).toBe('Late vs Early');
    expect(charts[0].series.map(s => s.color)).toEqual(SOURCES.map(sourceColor));
    expect(charts[0].signedLines).toBe(true);
    // Nuc: Late − Early per bin, fraction of reads.
    expect(charts[0].series[0].values).toEqual([0.5 - 1, 0 - 1, 0 - 0.5, 0]);
  });
});

describe('summary across groups: grouped bars, one per source', () => {
  const O = { histogram: false, start: 0, binBp: 10, sizeMin: 0, seed: 3, normalization: 'fraction' as const, anchored: false, unitNoun: 'reads', what: 'x' };
  it('one value per source per group, with its interval, colour and legend; table and TSV per source', () => {
    const s = normalizeSummary({ on: true, resamples: 200 });
    const sv = profileSummaryView(combined(), { ...O, s });
    expect(isGroupedSummary(sv.values)).toBe(true);
    const lay = summaryLayout(sv.values);
    expect(lay.clusters.map(c => c.title)).toEqual(['Early', 'Late']);
    expect(lay.series.map(x => x.label)).toEqual(['Nuc', 'TF', 'Class 3']);
    expect(lay.series.map(x => x.color)).toEqual(SOURCES.map(sourceColor));
    expect(sv.values).toHaveLength(6);
    for (const v of sv.values) { expect(v.lo).not.toBeNull(); expect(v.hi).not.toBeNull(); }
    // Early Nuc: 5 of 8 bp-bins.
    expect(sv.values[0].value).toBeCloseTo(5 / 8);
    const tsv = summaryTsv(sv.values, 'what');
    expect(tsv.split('\n')[1]).toBe('group\tsource\tvalue\tlo95\thi95\tn');
    expect(tsv.split('\n').slice(2).map(l => l.split('\t').slice(0, 2).join('|'))).toEqual(['Early|Nuc', 'Late|Nuc', 'Early|TF', 'Late|TF', 'Early|Class 3', 'Late|Class 3']);
  });
  it('Compare on: one summary-of-the-difference bar per source', () => {
    const s = normalizeSummary({ on: true, resamples: 200 });
    const plot = plotWith({ compare: 'diff', compareMode: 'a-vs-b', compareAB: ['p2|all', 'p1|all'], summary: s });
    const fig = profileFigure(plot, combined(), 10);
    const sv = compareSummaryView(combined(), fig.pairs, { ...O, s, op: 'diff' });
    expect(sv.values).toHaveLength(3);
    const lay = summaryLayout(sv.values);
    expect(lay.clusters).toEqual([{ id: 'p2|all~p1|all', title: 'Late vs Early' }]);
    expect(lay.series.map(x => x.label)).toEqual(['Nuc', 'TF', 'Class 3']);
    expect(sv.values[0].value).toBeCloseTo(1 / 8 - 5 / 8);
    // The block the plot draws.
    const block = profileSummaryOf({ plot, figure: fig, groups: combined(), histogram: false, start: 0, binBp: 10, anchored: false, unitNoun: 'reads', marksPerBp: false });
    expect(block?.comparing).toBe(true);
    expect(block?.values).toHaveLength(3);
  });
  it('one source: values as before (no series fields)', () => {
    const sv = profileSummaryView(perSource('nuc'), { ...O, s: normalizeSummary({ on: true, ci: 'none' }) });
    expect(isGroupedSummary(sv.values)).toBe(false);
    expect(sv.values.every(v => v.series === undefined)).toBe(true);
  });
});

describe('keys, Gallery, families', () => {
  const target = { chrom: 'chr1', start: 0, end: 40, genome: null, panels: [{ key: 'p1', datasetId: 'd1', label: 'Early' }] } as never;
  it('one source keeps the request key it always had; several add theirs', () => {
    const one = newPlot({ type: 'metaprofile', source: 'nuc' });
    expect(multiSourceKey(one)).toBe(false);
    expect(JSON.parse(profileRequestKey(one, target, null, 's', 'k')).sources).toBeUndefined();
    const many = plotWith();
    expect(JSON.parse(profileRequestKey(many, target, null, 's', 'k', '', [], 'f')).sources).toEqual(SOURCES);
  });
  it('a stored card keeps each line\'s source and group', () => {
    const back = unpackProfile(packProfile(10, combined()));
    expect(back.groups.map(g => [g.source, g.base, g.baseTitle])).toEqual(combined().map(g => [g.source, g.base, g.baseTitle]));
    expect(profileFigure(plotWith(), back.groups as ProfileGroup[], 10).facets?.panels).toHaveLength(2);
  });
  it('membership: any ref says 1 → member; 0 → scored, not a member; neither → not scored', () => {
    expect(familyState('01', [0, 1])).toBe('1');
    expect(familyState('0.', [0, 1])).toBe('0');
    expect(familyState('..', [0, 1])).toBeUndefined();
  });
  it('a family line: scored reads cover, members carry the family span', () => {
    const fam: FamilyMembership = { id: 'fam:s|h', label: 'Class 3', span: [110, 130], chrom: 'chr1', members: { d1: new Set(['r1']) }, evaluated: { d1: new Set(['r1', 'r2']) } };
    const read = (id: string) => ({ id, aligned_blocks: [[100, 200]] });
    expect(familyEngineRead(read('r1'), 0, fam, 'd1', 'g')).toEqual({ group: 'g', start: 100, end: 200, intervals: [[110, 130]] });
    expect(familyEngineRead(read('r2'), 0, fam, 'd1', 'g')).toEqual({ group: 'g', start: 100, end: 200, intervals: [] });
    expect(familyEngineRead(read('r3'), 0, fam, 'd1', 'g')).toBeNull();
    // The analysis id (a meta-locus observation) is the id the states use.
    expect(familyEngineRead({ ...read('x'), analysis_id: 'r1' }, 0, fam, 'd1', 'g')?.intervals).toEqual([[110, 130]]);
  });
});

describe('summary bars agree with the curves they summarise (3.1.1 consistency)', () => {
  // Uniform coverage: a bar's window mean (Σ signal / Σ coverage) is the mean of its drawn line over the window.
  const O = { histogram: false, start: 0, binBp: 10, sizeMin: 0, seed: 3, normalization: 'fraction' as const, anchored: false, unitNoun: 'reads', what: 'x' };
  it('every (group, source) bar equals the mean of that group and source\'s line, in that source\'s colour', () => {
    const plot = plotWith();
    const groups = combined();
    const fig = profileFigure(plot, groups, 10);
    const sv = profileSummaryView(groups, { ...O, s: normalizeSummary({ on: true, ci: 'none' }) });
    expect(sv.values).toHaveLength(groups.length);
    for (const v of sv.values) {
      const g = groups.find(x => x.source === v.series && x.base === v.cluster)!;
      const line = fig.series.find(s => s.id === g.id)!;
      const vals = (line.values as number[]).filter(Number.isFinite);
      expect(v.value!).toBeCloseTo(vals.reduce((a, b) => a + b, 0) / vals.length, 12);
      expect(v.color).toBe(line.color);
    }
  });
});

describe('summary statistic: the curve (default) or pooled (3.1.0) (audit 3.1.1)', () => {
  const finish = (sigmaBp: number, minCoverage: number) => ({ normalization: 'fraction' as const, sigmaBp, minCoverage, binBp: 10, marksPerBp: false });
  const O = { histogram: false, start: 0, binBp: 10, sizeMin: 0, seed: 3, normalization: 'fraction' as const, anchored: false, unitNoun: 'reads', what: 'x' };
  // Unequal coverage: Nuc fills the well-covered bin, TF the thin one; both curves are [1, 0] / [0, 1].
  const g = (source: string, sig: number[]) => ({ id: `${source}|p1|all`, title: `P · ${source}`, source, base: 'p1|all', baseTitle: 'P', color: sourceColor(source),
    raw: raw([100, 10], sig), units: [{ id: 'u1', cov: [100, 10], sig }] });
  const groups = [g('nuc', [100, 0]), g('tf', [0, 10])];
  it('curve: each bar is its curve\'s mean (0.5 and 0.5), pooled gives 3.1.0\'s Σ/Σ (0.909 and 0.091)', () => {
    const curve = profileSummaryView(groups, { ...O, s: normalizeSummary({ on: true, ci: 'none', statistic: 'curve' }), finish: finish(0, 0) });
    expect(curve.values.map(v => v.value)).toEqual([0.5, 0.5]);
    expect(curve.measures).toContain('Mean of the curve');
    const pooled = profileSummaryView(groups, { ...O, s: normalizeSummary({ on: true, ci: 'none', statistic: 'pooled' }), finish: finish(0, 0) });
    expect(pooled.values[0].value).toBeCloseTo(100 / 110, 12);
    expect(pooled.values[1].value).toBeCloseTo(10 / 110, 12);
    expect(pooled.measures).toContain('pooled');
    expect(normalizeSummary(undefined).statistic).toBe('curve');
    // A 3.1.0 summary (no statistic) keeps its pooled value.
    expect(normalizeSummary({ on: true, chart: 'bar', ci: 'auto' }).statistic).toBe('pooled');
  });
  it('with smoothing and blank bins, the bar is the mean of the curve as drawn', () => {
    const cov = [5, 50, 50, 50, 1, 50], sig = [5, 10, 40, 25, 1, 0];
    const gr = [{ id: 'a', title: 'A', raw: raw(cov, sig), units: [{ id: 'u', cov, sig }] }];
    const f = finish(15, 3);
    const v = profileSummaryView(gr, { ...O, s: normalizeSummary({ on: true, ci: 'none', statistic: 'curve' }), finish: f }).values[0].value!;
    const drawn = finishProfile(raw(cov, sig), f).filter((x): x is number => x != null);
    expect(drawn.length).toBe(5);   // the 1-read bin is blank
    expect(v).toBeCloseTo(drawn.reduce((a, b) => a + b, 0) / drawn.length, 12);
  });
  it('the curve bootstrap brackets the value and pairs sources', () => {
    const units = Array.from({ length: 30 }, (_, i) => ({ id: `r${i}`, cov: [1, 1], sig: [i % 3 ? 1 : 0, i % 2] }));
    const sum2 = (k: 'cov' | 'sig') => [0, 1].map(j => units.reduce((a, u) => a + u[k][j], 0));
    const gr = [{ id: 'a', title: 'A', raw: raw(sum2('cov'), sum2('sig')), units }];
    const v = profileSummaryView(gr, { ...O, s: normalizeSummary({ on: true, resamples: 300, statistic: 'curve' }), finish: finish(0, 0) }).values[0];
    expect(v.lo!).toBeLessThanOrEqual(v.value!);
    expect(v.hi!).toBeGreaterThanOrEqual(v.value!);
  });
});

describe('family sources where they cannot be drawn (audit 3.1.1)', () => {
  it('a size type or heatmap keeps the first layer, never a family (All footprints when only families)', () => {
    const fam = 'fam:find-classes:j1|fp-class:j1:3';
    expect(sourcesForType('size-histogram', [fam])).toEqual([ALL_FOOTPRINTS]);
    expect(sourcesForType('vplot', [fam, 'tf'])).toEqual(['tf']);
    expect(sourcesForType('heatmap', [fam])).toEqual([ALL_FOOTPRINTS]);
    expect(withType(withSources(newPlot({ type: 'metaprofile' }), [fam], { [fam]: 'Class 3' }), 'size-enrichment').sources).toEqual([ALL_FOOTPRINTS]);
  });
  it('BED sets with only families draw All footprints and say so', async () => {
    const { bedSources } = await import('./bedData');
    const b = bedSources(withSources(newPlot({ type: 'metaprofile', where: 'bed' }), ['fam:s|h']));
    expect(b.sources).toEqual(['all_footprints']);
    expect(b.missing[0].reason).toContain('All footprints is drawn instead');
  });
});

describe('source colours follow the resolver in bars as in lines (audit 3.1.1)', () => {
  it('a colour change after the groups were built reaches the summary bars', () => {
    const groups = combined();
    setLayerColorOverrideSource(() => ({ nuc: '#123456' }));
    const plot = plotWith({ summary: normalizeSummary({ on: true, ci: 'none' }) });
    const fig = profileFigure(plot, groups, 10);
    const block = profileSummaryOf({ plot, figure: fig, groups, histogram: false, start: 0, binBp: 10, anchored: false, unitNoun: 'reads', marksPerBp: false })!;
    const nucBar = block.values.find(v => v.series === 'nuc')!;
    expect(nucBar.color).toBe('#123456');
    expect(fig.series.find(s => s.id === groups.find(g => g.source === 'nuc')!.id)!.color).toBe('#123456');
  });
});

describe('several sources asked, one with reads (audit 3.1.1, agy #4)', () => {
  it('is still drawn as sources: facets, the source colour and the legend', () => {
    const groups = combineSourceGroups([{ source: 'nuc', groups: perSource('nuc') }, { source: 'fam:x|y', groups: [] }], { 'fam:x|y': 'Class 9' });
    const fig = profileFigure(plotWith(), groups, 10);
    expect(fig.facets).toBeTruthy();
    expect(fig.series.every(s => s.color === sourceColor('nuc'))).toBe(true);
  });
});
