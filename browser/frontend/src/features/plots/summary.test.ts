/** Summaries across groups, hand-computed: window mean (pooled sums), band share with exact Wilson, box mean. */
import { describe, expect, it } from 'vitest';
import { bandShare, bootstrapRatio, boxMean, boxSummarySpec, constantBoxNote, normalizeSummary, profileSummary, profileSummaryCi, profileSummaryView, resolveCi, summaryMeasures, summaryWindow, windowMean } from './summary';
import { percentileInterval, poissonWeights } from '../../utils/stableSample';
import { wilsonInterval } from '../../utils/statistics';

const raw = (cov: number[], sig: number[]) => ({ group: 'g', nReads: 10, coverage: Float64Array.from(cov), signal: Float64Array.from(sig) });

describe('summaries', () => {
  it('window mean: Σ signal / Σ coverage over the bins in the window', () => {
    // bins of 10 from 100: [100,110) [110,120) [120,130) [130,140)
    const r = raw([10, 10, 20, 20], [2, 4, 10, 0]);
    expect(windowMean(r, 100, 10, 110, 130, false).value).toBeCloseTo((4 + 10) / (10 + 20));
    expect(windowMean(r, 100, 10, null, null, false).value).toBeCloseTo(16 / 60);
    const w = windowMean(r, 100, 10, 110, 130, true);
    expect(w.n).toBe(15);
    expect(w.lo).toBeCloseTo(wilsonInterval(7, 15).low);
  });
  it('band share: the band weight over the total, exact Wilson', () => {
    // sizes from 0 in 30 bp bins: [0,30) [30,60) [60,90) [90,120)
    const r = raw([1, 1, 1, 1], [5, 10, 15, 70]);
    const b = bandShare(r, 0, 30, 0, 90, true);
    expect(b.value).toBeCloseTo(0.3);
    expect([b.lo, b.hi]).toEqual([wilsonInterval(30, 100).low, wilsonInterval(30, 100).high]);
  });
  it('box mean over sizes × positions, blanks left out', () => {
    const m = [[1, 2, 3], [4, null, 6], [7, 8, 9]];  // sizes 10, 20, 30; positions 0, 10, 20
    const s = normalizeSummary({ sizeFrom: 10, sizeTo: 30, from: 0, to: 20 });
    expect(boxMean(m, { size_min: 10, size_bin: 10, pos_bin: 10 }, 0, s)).toEqual({ value: (1 + 2 + 4) / 3, lo: null, hi: null, n: 3 });
  });
  it('keeps panel order and says what it measures', () => {
    const v = profileSummary([{ id: 'b', title: 'Late', raw: raw([1], [1]) }, { id: 'a', title: 'Early', raw: raw([2], [1]) }], { histogram: false, start: 0, binBp: 10, sizeMin: 0, s: normalizeSummary({ ci: 'none' }) });
    expect(v.map(x => [x.title, x.value])).toEqual([['Late', 1], ['Early', 0.5]]);
    expect(summaryMeasures('band-share', normalizeSummary({ sizeFrom: 0, sizeTo: 90 }), 'X')).toBe('Share of 0–90 bp per group, groups in panel order; Wilson 95% (exact for counts). Of: X');
  });
});

describe('the seeded bootstrap', () => {
  it('hand-checked: each resample is Σ w·num / Σ w·den with the units\' own Poisson streams; the same seed gives the same interval in any order', () => {
    const units = [{ id: 'A', num: 1, den: 2 }, { id: 'B', num: 3, den: 4 }];
    const wa = poissonWeights(9, 'A', 300), wb = poissonWeights(9, 'B', 300);
    const vals: number[] = [];
    for (let b = 0; b < 300; b++) { const d = wa[b] * 2 + wb[b] * 4; if (d > 0) vals.push((wa[b] * 1 + wb[b] * 3) / d); }
    expect(bootstrapRatio(units, 300, 9)).toEqual(percentileInterval(vals, 0.95));
    expect(bootstrapRatio([...units].reverse(), 300, 9)).toEqual(bootstrapRatio(units, 300, 9));
  });
  it('auto: bootstrap for the window mean (over the group\'s units), exact Wilson for a band share of counts, bootstrap on request', () => {
    const raw = { group: 'g', nReads: 2, coverage: Float64Array.from([2, 2]), signal: Float64Array.from([1, 1]) };
    const units = [{ id: 'r1', cov: [1, 1], sig: [1, 0] }, { id: 'r2', cov: [1, 1], sig: [0, 1] }];
    const s = normalizeSummary({ on: true, resamples: 200 });
    const [w] = profileSummary([{ id: 'g', title: 'G', raw, units }], { histogram: false, start: 0, binBp: 10, sizeMin: 0, s, seed: 3 });
    expect(w.value).toBe(0.5);
    expect(w.lo).not.toBeNull();
    expect(resolveCi('window-mean', s)).toBe('bootstrap');
    expect(resolveCi('band-share', s, true)).toBe('wilson');
    expect(resolveCi('band-share', s, false)).toBe('bootstrap');
    expect(resolveCi('band-share', normalizeSummary({ ci: 'bootstrap' }), true)).toBe('bootstrap');
    // Without units the bootstrap has nothing to resample: no interval, and the header says so.
    const [none] = profileSummary([{ id: 'g', title: 'G', raw }], { histogram: false, start: 0, binBp: 10, sizeMin: 0, s, seed: 3 });
    expect([none.lo, none.hi]).toEqual([null, null]);
    expect(profileSummaryCi([{}], { histogram: false, s, seed: 3 })).toMatch(/interval not available/);
    expect(profileSummaryCi([{ units }], { histogram: false, s, seed: 3, unitNoun: 'regions' })).toBe('bootstrap 95% (200 Poisson resamples of regions, seed 3)');
  });
});

describe('meaningful defaults and the plot\'s scale', () => {
  it('a normalised plot never defaults to its whole axis: anchor ± 100 bp, or the middle 10% of the view', () => {
    const s = normalizeSummary({ on: true });
    expect(summaryWindow(s, { normalised: true, anchored: true, start: -1000, end: 1000 })).toEqual({ from: -100, to: 100, isDefault: true });
    expect(summaryWindow(s, { normalised: true, anchored: false, start: 1000, end: 5000 })).toEqual({ from: 2800, to: 3200, isDefault: true });
    expect(summaryWindow(s, { normalised: false, anchored: false, start: 1000, end: 5000 })).toEqual({ from: null, to: null, isDefault: false });
    expect(summaryWindow(normalizeSummary({ from: 10, to: 20 }), { normalised: true, anchored: true, start: -1000, end: 1000 })).toEqual({ from: 10, to: 20, isDefault: false });
  });
  it('row-normalised whole axis (or column-normalised every size) is constant by construction: a note instead of bars', () => {
    const s = normalizeSummary({ sizeFrom: 0, sizeTo: 90 });
    const axis = { start: 0, end: 100, sizeMin: 10, sizeMax: 300 };
    expect(constantBoxNote('row', s, { from: null, to: null }, axis, true)).toMatch(/0 \(log2 of 1\) by construction; pick a window/);
    expect(constantBoxNote('row', s, { from: 40, to: 60 }, axis, true)).toBeNull();
    expect(constantBoxNote('column', normalizeSummary({ sizeFrom: 0, sizeTo: 400 }), { from: 40, to: 60 }, axis, false)).toMatch(/1 by construction/);
    expect(constantBoxNote('raw', s, { from: null, to: null }, axis, true)).toBeNull();
    // Size enrichment (row, log2): the centre window by default, log2, reference 0; V-plot (raw counts, log1p): whole axis.
    const e = boxSummarySpec({ normalization: 'row', log: true, sizeMin: 10, sizeMax: 300 }, normalizeSummary({ on: true }), { start: 0, end: 4000, anchored: false });
    expect([e.win.from, e.win.to, e.transform, e.reference, e.note]).toEqual([1800, 2200, 'log2', 0, null]);
    const v = boxSummarySpec({ normalization: 'raw', log: true, sizeMin: 10, sizeMax: 300 }, normalizeSummary({ on: true }), { start: 0, end: 4000, anchored: false });
    expect([v.win.from, v.transform, v.reference, v.note]).toEqual([null, 'log1p', 0, null]);
    const whole = boxSummarySpec({ normalization: 'row', log: true, sizeMin: 10, sizeMax: 300 }, normalizeSummary({ on: true, from: -10, to: 99999 }), { start: 0, end: 4000, anchored: false });
    expect(whole.note).toMatch(/by construction/);
  });
  it('the box mean on the plot\'s scale: the mean of log2 (enrichment) or log1p (counts) of the cells', () => {
    const d = { size_min: 0, size_bin: 10, pos_bin: 10 };
    const m = [[2, 0.5], [4, 1]];
    const s = normalizeSummary({ sizeFrom: 0, sizeTo: 20 });
    expect(boxMean(m, d, 0, s).value).toBeCloseTo((2 + 0.5 + 4 + 1) / 4);
    expect(boxMean(m, d, 0, s, { transform: 'log2' }).value).toBeCloseTo((1 - 1 + 2 + 0) / 4);
    expect(boxMean(m, d, 0, s, { transform: 'log1p' }).value).toBeCloseTo((Math.log1p(2) + Math.log1p(0.5) + Math.log1p(4) + Math.log1p(1)) / 4);
    expect(boxMean(m, d, 0, s, { from: 10, to: 20 }).value).toBeCloseTo((0.5 + 1) / 2);
  });
  it('relative profiles: the window over the whole axis (1 = average; whole window = the note); counts per bin', () => {
    const raw = { group: 'g', nReads: 10, coverage: Float64Array.from([10, 10, 10, 10]), signal: Float64Array.from([2, 2, 6, 6]) };
    const s = normalizeSummary({ on: true, ci: 'none' });
    const base = { histogram: false, start: -20, binBp: 10, sizeMin: 0, s, seed: 1 };
    // Whole: 16/40 = 0.4; window [-10, 10): bins 1, 2 = 8/20 = 0.4 -> 1; window [0, 20): 12/20 = 0.6 -> 1.5.
    expect(profileSummary([{ id: 'g', title: 'G', raw }], { ...base, normalization: 'relative', from: 0, to: 20 })[0].value).toBeCloseTo(1.5);
    expect(profileSummary([{ id: 'g', title: 'G', raw }], { ...base, normalization: 'count', from: 0, to: 20 })[0].value).toBeCloseTo(6);
    const raw40 = { group: 'g', nReads: 10, coverage: new Float64Array(40).fill(10), signal: new Float64Array(40).fill(4) };
    const v = profileSummaryView([{ id: 'g', title: 'G', raw: raw40 }], { ...base, start: -200, normalization: 'relative', anchored: true, unitNoun: 'reads', what: 'the profile above' });
    expect(v.reference).toBe(1);
    expect(v.measures).toContain('-100 to 100 (the default centre window)');
    expect(v.note).toBeNull();
    const wholeV = profileSummaryView([{ id: 'g', title: 'G', raw }], { ...base, s: normalizeSummary({ ci: 'none', from: -20, to: 20 }), normalization: 'relative', anchored: true, unitNoun: 'reads', what: 'x' });
    expect(wholeV.note).toMatch(/1 by construction/);
    // Wilson is for a share of reads only.
    expect(resolveCi('window-mean', normalizeSummary({ ci: 'wilson' }), true, 'relative')).toBe('none');
  });
});

describe('mark profile summaries', () => {
  it('fraction of a mark profile is per read per bp, as the profile drawn', () => {
    const r = { group: 'g', nReads: 2, coverage: Float64Array.from([2, 2]), signal: Float64Array.from([2, 2]) };
    const o = { histogram: false, start: 0, binBp: 10, sizeMin: 0, s: normalizeSummary({ ci: 'none' }) };
    expect(profileSummary([{ id: 'g', title: 'G', raw: r }], { ...o, marksPerBp: true })[0].value).toBeCloseTo(0.1);
    expect(profileSummary([{ id: 'g', title: 'G', raw: r }], { ...o, marksPerBp: true, normalization: 'count' })[0].value).toBeCloseTo(2);
  });
});
