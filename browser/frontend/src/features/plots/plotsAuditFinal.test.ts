import { describe, expect, it } from 'vitest';
import { addReadUnits, unitsOf } from './useProfileData';
import { profileSummaryOf } from './ProfileSummaryBlock';
import { histogramFigure } from './sizeHistogram';
import { newPlot } from './plotModel';
import { overlayProfileLayout } from '../../components/charts/OverlayProfileChart';
import type { ProfileRead } from './profileEngine';

// Final 3.1.0 audit of Plots Compare/Summary and the full cluster legend.
const raw = (cov: number[], sig: number[], nReads = 4) => ({ group: 'g', nReads, coverage: Float64Array.from(cov), signal: Float64Array.from(sig) });

describe('Plots compare/summary audit fixes', () => {
  it('bootstrap units are one dataset\'s read: two datasets\' reads of one name are never paired', () => {
    const into = new Map<string, Map<string, { cov: Float64Array; sig: Float64Array }>>();
    const reads: ProfileRead[] = [
      { group: 'A', id: 'r0', dataset: 'd1', start: 0, end: 10 } as ProfileRead,
      { group: 'B', id: 'r0', dataset: 'd2', start: 0, end: 10 } as ProfileRead,
    ];
    addReadUnits(into, reads, () => raw([1], [1], 1));
    const a = unitsOf(into, 'A')!.map(u => u.id), b = unitsOf(into, 'B')!.map(u => u.id);
    expect(a).toHaveLength(1);
    expect(a[0]).not.toBe(b[0]);
    // The same dataset's read in two groups (overlapping groups) stays one unit, so it is still paired.
    const into2 = new Map<string, Map<string, { cov: Float64Array; sig: Float64Array }>>();
    addReadUnits(into2, [{ ...reads[0] }, { ...reads[0], group: 'B' }], () => raw([1], [1], 1));
    expect(unitsOf(into2, 'A')![0].id).toBe(unitsOf(into2, 'B')![0].id);
  });

  it('a histogram comparison summary is labelled in band shares, whatever the histogram axis', () => {
    const groups = [{ id: 'a|0', title: 'A', raw: raw([1, 1], [6, 4]) }, { id: 'b|0', title: 'B', raw: raw([1, 1], [2, 8]) }];
    for (const [compare, label] of [['diff', 'Δ band share'], ['log2ratio', 'log2 ratio of band shares']] as const) {
      const plot = newPlot({ type: 'size-histogram', compare });
      plot.summary.on = true;
      const figure = histogramFigure(plot, groups);
      const s = profileSummaryOf({ plot, figure, groups, histogram: true, start: plot.hist.sizeMin, binBp: plot.hist.binBp, anchored: true, unitNoun: 'reads', marksPerBp: false });
      expect(s?.comparing).toBe(true);
      expect(s?.yLabel).toBe(label);
    }
  });
});

describe('full cluster legend audit fix', () => {
  it('when not every entry fits, missing (hollow) entries never push out the plot\'s own series', () => {
    const ctx = { font: '', measureText: (t: string) => ({ width: t.length * 5 }) } as unknown as CanvasRenderingContext2D;
    const legendItems = [
      ...['m1', 'm2', 'm3', 'm4'].map(label => ({ label, color: '#999999', missing: true })),
      { label: 'a long real layer name', color: '#ff0000' }, { label: 'another long real layer', color: '#00ff00' },
    ];
    const series = legendItems.filter(e => !e.missing).map(e => ({ data: [1, 2], color: e.color, label: e.label }));
    const layout = overlayProfileLayout(ctx, 240, 36, { series, showLegend: true, legendItems, noAxes: false });
    const shownLabels = layout.legend.entries.map(e => e.series.label);
    expect(shownLabels.length).toBeLessThan(legendItems.length);
    expect(shownLabels).toEqual(expect.arrayContaining(['a long real layer name', 'another long real layer']));
  });
});

describe('Plots compare/summary audit fixes (agy)', () => {
  it('the group count belongs to the settings that split groups too (bands, state at the anchor, excluded reads)', async () => {
    const { groupingKey } = await import('./compareState');
    const base = newPlot({ type: 'metaprofile' });
    const k = groupingKey(base);
    expect(groupingKey({ ...base, profile: { ...base.profile, band: 'each' } })).not.toBe(k);
    expect(groupingKey({ ...base, profile: { ...base.profile, conditionOn: true } })).not.toBe(k);
    expect(groupingKey({ ...base, profile: { ...base.profile, bandEdges: [90, 300] } })).not.toBe(k);
    expect(groupingKey({ ...base })).toBe(k);
  });

  it('a count-normalised side over an uncovered window has no value, in resamples as in the point estimate', async () => {
    const { compareSummary, normalizeSummary } = await import('./summary');
    const s = { ...normalizeSummary({}), on: true, ci: 'bootstrap' as const, resamples: 50, from: 0, to: 10 };
    // A covers bin 0; B covers only bin 1, so B's window [0, 10) is uncovered.
    const A = { id: 'a', title: 'A', raw: raw([1, 1], [1, 0], 1), units: [{ id: 'a0', cov: [1, 1], sig: [1, 0] }] };
    const B = { id: 'b', title: 'B', raw: raw([0, 1], [0, 1], 1), units: [{ id: 'b0', cov: [0, 1], sig: [0, 1] }] };
    const [v] = compareSummary([A, B], [{ id: 'p', label: 'A vs B', a: ['a'], b: ['b'] }],
      { histogram: false, start: 0, binBp: 10, sizeMin: 0, s, seed: 3, normalization: 'count', op: 'diff' } as never);
    expect(v.value).toBeNull();
    expect(v.lo).toBeNull();
    expect(v.hi).toBeNull();
  });
});

describe('Plots audit re-check fixes', () => {
  it('a long missing label never costs the plot one of its own labels', () => {
    const ctx = { font: '', measureText: (t: string) => ({ width: t.length * 5 }) } as unknown as CanvasRenderingContext2D;
    const own = ['Nuc', 'TF', 'Fire'].map(label => ({ label, color: '#123456' }));
    const series = own.map(e => ({ data: [1, 2], color: e.color, label: e.label }));
    const alone = overlayProfileLayout(ctx, 240, 36, { series, showLegend: true, legendItems: own, noAxes: false });
    const withMissing = overlayProfileLayout(ctx, 240, 36, { series, showLegend: true, noAxes: false,
      legendItems: [...own, { label: 'a very long missing layer label here', color: '#999999', missing: true }] });
    const labels = (l: typeof alone) => l.legend.entries.map(e => e.series.label);
    expect(labels(alone)).toEqual(['Nuc', 'TF', 'Fire']);
    expect(labels(withMissing)).toEqual(expect.arrayContaining(['Nuc', 'TF', 'Fire']));
  });

  it('a plot reloading clears its earlier group count (unknown: Compare is not blocked meanwhile)', async () => {
    const { reportGroupCount, knownGroupCount, groupingKey, useGroupCount } = await import('./compareState');
    const plot = newPlot({ type: 'metaprofile' });
    reportGroupCount(plot, 2);
    expect(useGroupCount.getState()).toEqual({ key: groupingKey(plot), n: 2 });
    reportGroupCount(plot, null);
    expect(useGroupCount.getState().n).toBeNull();
    expect(knownGroupCount(useGroupCount.getState(), plot)).toBeNull();
  });
});
