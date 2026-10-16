import { describe, expect, it } from 'vitest';
import type { JobProgress, PipelineJob } from '../api/pipeline';
import { describeJob, describeStep, formatEta, summaryItems } from './pipelineProgress';
import { phasogram, qcMetrics, rateCdf, sizeDistribution, thin, verdicts } from './qcView';

function progress(steps: JobProgress['steps'], fraction: number | null = null): JobProgress {
  return { version: '3.0.0', steps, current_step: null, fraction, eta_s: null, logs: [], warnings: [], settings: null, started: true, done: null };
}

function job(changes: Partial<PipelineJob>): PipelineJob {
  return {
    id: '20260929-120000-abcdef', sample: 's1', enzyme: 'dddb', outdir: '/o', reference: null, cores: 4, reads: [],
    regions: [], options: {}, option_labels: [], group: null, command: null, auto_open: false, status: 'running',
    progress: progress([]), ...changes,
  };
}

describe('pipeline progress', () => {
  it('words the ETA', () => {
    expect(formatEta(null)).toBeNull();
    expect(formatEta(20)).toBe('less than a minute left');
    expect(formatEta(185)).toBe('about 3 min left');
    expect(formatEta(3 * 3600 + 600)).toBe('about 3 h 10 min left');
  });

  it('shows a running step with counts, rate and ETA', () => {
    const view = describeStep({ name: 'align', label: 'Aligning reads (minimap2)', status: 'running', done: 1200, total: 4000, unit: 'reads', rate: 850, eta_s: 90 });
    expect(view.percent).toBe(30);
    expect(view.detail).toBe('1,200 / 4,000 reads · 850 reads/s · about 2 min left');
    expect(describeStep({ name: 'index', label: 'Indexing', status: 'skipped', message: 'complete' }).detail).toBe('already done (reused)');
  });

  it('describes the job as a whole', () => {
    const running = describeJob(job({
      progress: progress([
        { name: 'prepare_reference', label: 'Preparing the reference', status: 'done' },
        { name: 'align', label: 'Aligning reads (minimap2)', status: 'running', done: 2000, total: 4000, unit: 'reads', eta_s: 30 },
        { name: 'call', label: 'Calling footprints', status: 'pending' },
      ], 0.5),
    }));
    expect(running.percent).toBe(50);
    expect(running.tone).toBe('info');
    expect(running.headline).toBe('Aligning reads (minimap2): 2,000 / 4,000 reads · less than a minute left');
    expect(running.steps.map(s => s.status)).toEqual(['done', 'running', 'pending']);
    expect(describeJob(job({ status: 'queued' })).headline).toMatch(/Waiting/);
    const failed = describeJob(job({ status: 'error', error: 'fiberhmm-call failed (exit 1)' }));
    expect(failed.tone).toBe('error');
    expect(failed.headline).toBe('fiberhmm-call failed (exit 1)');
    expect(describeJob(job({ status: 'done', started_at: 100, finished_at: 400 })).headline).toBe('Finished in 5 min.');
  });

  it('summarizes the result', () => {
    const items = summaryItems({ reads_aligned: 3912, reads_called: 3500, duplicate_percent: 12.04, footprints_per_read: 5.83, qc_status: 'PASS' });
    expect(items.map(i => `${i.label}=${i.value}`)).toEqual([
      'Reads aligned=3,912', 'Reads called=3,500', 'Duplicates=12.0%', 'Footprints / read=5.8',
    ]);
    expect(summaryItems(null)).toEqual([]);
  });
});

describe('QC view', () => {
  const curves = {
    signal_rate: {
      label: 'deamination',
      per_read_rates: [0.01, 0.02, 0.03, 0.04],
      ecdf: [0.25, 0.5, 0.75, 1],
      reference_ecdf: { rates: [0.015, 0.03], probabilities: [0.1, 0.9] },
      warn_interval: [0.01, 0.07],
      reference_iqr: [0.02, 0.041],
    },
    phasogram: {
      lags_bp: [0, 59, 60, 190, 800, 801],
      detrended_pair_frequency: [0, 1, 1.02, 1.1, 0.99, 1],
      nrl_bp: 190,
      reference: { lags_bp: [60, 800], detrended_pair_frequency: [1, 1] },
    },
    footprint_sizes: {
      nucleosome: { bin_edges_bp: [0, 100, 200], sample_fraction_per_bin: [0.3, 0.7], sample_n: 10, reference_fraction_per_bin: null },
    },
  };

  it('draws the per-read rate CDF in percent with the PASS/WARN bands', () => {
    const cdf = rateCdf(curves)!;
    expect(cdf.sample).toEqual([[1, 0.25], [2, 0.5], [3, 0.75], [4, 1]]);
    expect(cdf.reference).toEqual([[1.5, 0.1], [3, 0.9]]);
    expect(cdf.passBand![0]).toBeCloseTo(2);
    expect(cdf.passBand![1]).toBeCloseTo(4.1);
    expect(cdf.warnBand![0]).toBeCloseTo(1);
    expect(cdf.warnBand![1]).toBeCloseTo(7);
    expect(cdf.median).toBe(2);
    expect(rateCdf({})).toBeNull();
  });

  it('keeps the 60-800 bp phasogram and the NRL', () => {
    const ph = phasogram(curves)!;
    expect(ph.sample.map(p => p[0])).toEqual([60, 190, 800]);
    expect(ph.reference).toHaveLength(2);
    expect(ph.nrl).toBe(190);
  });

  it('turns a size histogram into steps', () => {
    const dist = sizeDistribution(curves.footprint_sizes.nucleosome)!;
    expect(dist.sample).toEqual([[0, 0.3], [100, 0.3], [100, 0.7], [200, 0.7]]);
    expect(dist.reference).toEqual([]);
  });

  it('thins long curves', () => {
    const points = Array.from({ length: 1000 }, (_, i) => [i, i] as [number, number]);
    const out = thin(points, 100);
    expect(out).toHaveLength(100);
    expect(out[0]).toEqual([0, 0]);
    expect(out[99]).toEqual([999, 999]);
  });

  it('reads verdicts and headline numbers from the QC JSON', () => {
    const qc = {
      overall: { status: 'WARN', score: 61 },
      signal: { label: 'deamination', status: 'PASS', score: 80, median_per_read_rate: 0.0291 },
      periodicity: { status: 'WARN', score: 55, nrl_bp: 192 },
      footprints: { median_nucleosome_bp: 150, median_tf_footprint_bp: 27 },
      deduplication: { duplicate_fraction: 0.125, full_run: true },
      variant_masking: { applied: true, n_masked_sites: 3 },
    };
    expect(verdicts(qc).map(v => `${v.label}:${v.status}`)).toEqual(['Overall:WARN', 'Deamination:PASS', 'Periodicity:WARN']);
    const metrics = Object.fromEntries(qcMetrics(qc).map(m => [m.label, m.value]));
    expect(metrics['Median deamination']).toBe('2.91%');
    expect(metrics['Nucleosome repeat']).toBe('192 bp');
    expect(metrics.Duplicates).toBe('12.5%');
    expect(metrics['SNP mask']).toBe('3 sites');
    expect(metrics['Unaligned bases']).toBeUndefined();  // not a FiberHMM 3.0 DAF report
  });

  it("shows FiberHMM 3.0's unaligned-base masking from a DAF QC JSON", () => {
    const qc = { unaligned_masking: { unaligned_bases: 1234, query_bases: 100000, fraction_unaligned: 0.01234,
      n_reads_with_no_call_blocks: 7, note: 'insertion and soft-clip bases have no reference counterpart' } };
    const metric = qcMetrics(qc).find(m => m.label === 'Unaligned bases')!;
    expect(metric.value).toBe('1.23%');
    expect(metric.title).toContain('1,234 of 100,000');
    expect(metric.title).toContain('7 reads have uncalled stretches of 50 bp or more');
  });
});
