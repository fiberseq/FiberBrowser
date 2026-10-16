/**
 * State-aware QC (FiberHMM >= 3.0): efficiency (in-MSP rate), background
 * (outside-MSP rate), the verdict basis and the per-read state CDF, read from
 * real fiberhmm-qc output for the demo BAM (tests/fixtures/qc_state_aware:
 * `fiberhmm-qc -i browser/data/demo/napa_ddda.bam` with FiberHMM f809c0f,
 * scratch paths replaced, per-read arrays thinned to 80 points). An older QC
 * without these fields keeps the previous display.
 */
import { describe, expect, it } from 'vitest';
import newQc from '../../../../tests/fixtures/qc_state_aware/napa_ddda.qc.json';
import newCurves from '../../../../tests/fixtures/qc_state_aware/napa_ddda.qc.curves.json';
import {
  bandText, qcMetrics, stateCdf, stateRates, stateSummary, verdictBasisText, verdictBasisTitle, verdictItems, verdicts,
} from './qcView';

// fiberhmm-qc 2.x: no state_rates, efficiency, background or overall.verdict_basis
// (the shape tests/library_fixtures.py write_qc_json writes).
const OLD_QC = {
  schema_version: 1,
  overall: { status: 'WARN', score: 61 },
  signal: { label: 'deamination', status: 'PASS', score: 80, median_per_read_rate: 0.0291 },
  periodicity: { status: 'WARN', score: 55, nrl_bp: 192 },
  footprints: { median_nucleosome_bp: 150 },
};
const OLD_CURVES = {
  schema: 'fiberhmm.qc.curves.v1',
  verdicts: { overall: 'WARN' },
  signal_rate: { per_read_rates: [0.02, 0.03], ecdf: [0.5, 1], reference_ecdf: null, warn_interval: null, reference_iqr: null },
};

describe('state-aware QC (new fiberhmm-qc)', () => {
  it('lists Overall, Efficiency, Background, Periodicity, then the overall rate as not in the verdict', () => {
    const items = verdictItems(newQc);
    expect(items.map(v => `${v.label}:${v.status}:${v.inVerdict}`)).toEqual([
      'Overall:WARN:true', 'Efficiency:WARN:true', 'Background:PASS:true', 'Periodicity:WARN:true', 'Deamination:FAIL:false',
    ]);
    expect(items[0].title).toBe('Overall verdict from efficiency, background and periodicity (state-aware).');
    expect(items[1].title).toMatch(/comparable between amplicons and whole-genome data/);
    expect(Math.round(items[1].score!)).toBe(67);
  });

  it('says what the verdict is based on', () => {
    expect(verdictBasisText(newQc)).toBe(
      'Verdict from efficiency, background and periodicity (state-aware). '
      + 'The overall deamination rate is shown but not used: it mixes enzyme efficiency with how open the chromatin is.',
    );
  });

  it('reads efficiency and background against the reference with their PASS/WARN bands', () => {
    const rates = stateRates(newQc)!;
    expect(rates.available).toBe(true);
    expect(rates.source).toBe('tags');
    expect(rates.sourceText).toBe('States from the FiberHMM calls in the BAM on 1,997 of 2,000 sampled reads (written by fiberhmm-call 2.14.0).');
    expect(rates.minMspBp).toBe(85);
    expect(rates.efficiency.value).toBeCloseTo(0.6212, 4);
    expect(rates.efficiency.referenceMedian).toBeCloseTo(0.6644, 4);
    expect(rates.efficiency.status).toBe('WARN');
    expect(bandText(rates.efficiency)).toBe('PASS ≥ 62.4% · WARN ≥ 55.4%');
    expect(rates.background.value).toBeCloseTo(0.1684, 4);
    expect(rates.background.status).toBe('PASS');
    expect(bandText(rates.background)).toBe('PASS ≤ 19.2% · WARN ≤ 22.8%');
    expect(rates.ratio).toBeCloseTo(3.66, 2);
    expect(rates.referenceRatio).toBeCloseTo(4.01, 2);
    expect(rates.mspShare).toBeCloseTo(0.291, 3);
    expect(rates.referenceMspShareMedian).toBeCloseTo(0.256, 3);
    expect(rates.overallRate).toBeCloseTo(0.3085, 4);
    expect(rates.efficiency.pooledCi).toHaveLength(2);
    expect(rates.notes).toEqual([]);
  });

  it('labels the overall rate metric as overall when the verdict is state-aware', () => {
    const labels = qcMetrics(newQc).map(m => m.label);
    expect(labels[0]).toBe('Overall deamination (median)');
    expect(qcMetrics(newQc)[0].title).toMatch(/not used by the verdict/);
  });

  it('draws in-MSP and outside-MSP per-read CDFs with the reference quantiles', () => {
    const cdf = stateCdf(newCurves as any)!;
    expect(cdf.msp).toHaveLength(80);
    expect(cdf.outside).toHaveLength(80);
    expect(cdf.msp[cdf.msp.length - 1][1]).toBe(1);
    expect(cdf.referenceMsp.map(p => p[1])).toEqual([0.05, 0.25, 0.5, 0.75, 0.95]);
    expect(cdf.referenceMsp[2][0]).toBeCloseTo(66.44, 1);
    expect(cdf.referenceOutside[2][0]).toBeCloseTo(16.52, 1);
    // in-MSP sits right of outside-MSP; the axis covers both
    expect(cdf.msp[40][0]).toBeGreaterThan(cdf.outside[40][0]);
    expect(cdf.xMax).toBeGreaterThanOrEqual(Math.max(...cdf.msp.map(p => p[0])));
    // Null reference quantiles are dropped, not drawn at 0%.
    const partial = { state_rates: { ...newCurves.state_rates, reference: { msp: { probabilities: [0.05, 0.5, 0.95], quantiles: [null, 0.6, 0.7] }, outside_msp: null } } };
    const thinRef = stateCdf(partial as any)!;
    expect(thinRef.referenceMsp).toEqual([[60, 0.5], [70, 0.95]]);
    expect(thinRef.referenceOutside).toEqual([]);
  });

  it('describes a light call and its stop reason', () => {
    const light = {
      ...newQc,
      state_rates: { ...newQc.state_rates, source: 'light_call', light_call: { reads_called: 400, stopped_by: 'read budget' } },
    };
    expect(stateRates(light)!.sourceText).toBe(
      "The BAM carries no calls: states from a light call (FiberHMM's HMM only, no nucleosome or TF re-call) on 400 sampled reads, stopped by the read budget.",
    );
  });

  it('reports why rates were not graded, and an unavailable state block', () => {
    const ungraded = {
      ...newQc,
      overall: { status: 'FAIL', score: 20, components: ['signal', 'periodicity'], verdict_basis: 'overall-rate' },
      efficiency: { ...newQc.efficiency, status: 'INSUFFICIENT', score: null, note: 'not graded: the reference has no calibration for states from fibertools_tags (available: tags)' },
      background: { ...newQc.background, status: 'INSUFFICIENT', score: null, note: 'not graded: the reference has no calibration for states from fibertools_tags (available: tags)' },
      state_rates: { ...newQc.state_rates, source: 'fibertools_tags' },
    };
    const items = verdictItems(ungraded);
    expect(items.map(v => `${v.label}:${v.inVerdict}`)).toEqual([
      'Overall:true', 'Efficiency:false', 'Background:false', 'Deamination:true', 'Periodicity:true',
    ]);
    expect(verdictBasisText(ungraded)).toBe('Verdict from the overall deamination rate and periodicity.');
    const rates = stateRates(ungraded)!;
    expect(rates.notes).toHaveLength(1);
    expect(rates.sourceText).toMatch(/fibertools' calls .* not graded/);

    const unavailable = stateRates({ state_rates: { available: false, source: null, note: 'too few opportunities in one of the compartments' } })!;
    expect(unavailable.available).toBe(false);
    expect(unavailable.notes).toEqual(['too few opportunities in one of the compartments']);
  });

  it('reads the flat verdicts of an outputs.json / Library entry', () => {
    // fiberhmm-pipeline's outputs.json qc.verdicts (runner.qc_verdicts)
    const flat = {
      overall: 'WARN', overall_score: 69.9, signal: 'FAIL', signal_score: 0, periodicity: 'WARN', periodicity_score: 46,
      efficiency: 'WARN', efficiency_score: 67.5, background: 'PASS', background_score: 96.3, verdict_basis: 'state-aware',
      state_rates: { source: 'tags', msp_rate: 0.6212, outside_msp_rate: 0.1684, msp_to_outside_ratio: 3.66, msp_length_fraction: 0.29 },
    };
    expect(verdictItems(flat, true).map(v => `${v.label}:${v.status}:${v.inVerdict}`)).toEqual([
      'Overall:WARN:true', 'Efficiency:WARN:true', 'Background:PASS:true', 'Periodicity:WARN:true', 'Signal:FAIL:false',
    ]);
    expect(stateSummary(flat).map(m => `${m.label} ${m.value}`)).toEqual(['Efficiency 62.1% WARN', 'Background 16.8% PASS']);
    // Library: rates from its numbers, statuses already on the chips
    expect(stateSummary({ msp_rate: 0.6212, outside_msp_rate: 0.1684, efficiency: 'WARN' }, false).map(m => `${m.label} ${m.value}`))
      .toEqual(['Efficiency 62.1%', 'Background 16.8%']);
    expect(verdictBasisTitle(flat)).toBe('Overall verdict from efficiency, background and periodicity (state-aware).');
    // An ungraded background is left out of the verdict, as fiberhmm-qc does.
    expect(verdictBasisTitle({ ...flat, background: 'INSUFFICIENT' })).toBe('Overall verdict from efficiency and periodicity (state-aware).');
  });
});

describe('older QC (fields absent): the display is unchanged', () => {
  it('keeps the three verdicts and the rate metric', () => {
    expect(verdicts(OLD_QC).map(v => `${v.label}:${v.status}`)).toEqual(['Overall:WARN', 'Deamination:PASS', 'Periodicity:WARN']);
    expect(verdictItems(OLD_QC).every(v => v.inVerdict)).toBe(true);
    expect(verdictItems(OLD_QC).every(v => v.title === undefined)).toBe(true);
    expect(verdictBasisText(OLD_QC)).toBeNull();
    expect(stateRates(OLD_QC)).toBeNull();
    expect(qcMetrics(OLD_QC)[0].label).toBe('Median deamination');
    expect(stateCdf(OLD_CURVES as any)).toBeNull();
  });

  it('keeps old flat verdicts', () => {
    const flat = { overall: 'PASS', overall_score: 80, signal: 'PASS', periodicity: 'WARN' };
    expect(verdictItems(flat, true).map(v => `${v.label}:${v.status}:${v.inVerdict}`)).toEqual([
      'Overall:PASS:true', 'Signal:PASS:true', 'Periodicity:WARN:true',
    ]);
    expect(stateSummary(flat)).toEqual([]);
    expect(verdictBasisTitle(flat)).toBeUndefined();
  });
});
