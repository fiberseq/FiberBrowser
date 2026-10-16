import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PipelineJob, QcPayload } from '../../../api/pipeline';
import { JobCard } from './DafRunJobList';
import { QcReport } from './QcReport';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const runningJob: PipelineJob = {
  id: '20260929-120000-abcdef', sample: 'sample_a', enzyme: 'dddb', outdir: '/runs/sample_a',
  reference: { path: '/g/dm6.fa', kind: 'fasta', label: 'dm6', genome_id: 'dm6' }, cores: 4, reads: [],
  regions: [], options: {}, option_labels: ['duplicates off'], group: 'g', command: 'fiberhmm-pipeline r.fastq --reference dm6.fa',
  auto_open: true, status: 'running',
  progress: {
    version: '3.0.0', current_step: 'align', fraction: 0.4, eta_s: 30, logs: [], warnings: [], settings: null, started: true, done: null,
    steps: [
      { name: 'prepare_reference', label: 'Preparing the reference', status: 'done' },
      { name: 'align', label: 'Aligning reads (minimap2)', status: 'running', done: 1000, total: 4000, unit: 'reads', eta_s: 30 },
      { name: 'call', label: 'Calling footprints', status: 'pending' },
    ],
  },
};

describe('New DAF-seq run components', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders a running job with its steps, progress and actions', () => {
    act(() => root.render(<JobCard job={runningJob} />));
    const card = container.querySelector('[data-testid="daf-run-job"]')!;
    expect(card.getAttribute('data-job-status')).toBe('running');
    expect(container.querySelector('[data-testid="daf-run-job-headline"]')!.textContent)
      .toBe('Aligning reads (minimap2): 1,000 / 4,000 reads · less than a minute left');
    const steps = [...container.querySelectorAll('[data-step]')].map(el => `${el.getAttribute('data-step')}:${el.getAttribute('data-step-status')}`);
    expect(steps).toEqual(['prepare_reference:done', 'align:running', 'call:pending']);
    expect(container.querySelector('[data-testid="daf-run-cancel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="daf-run-retry"]')).toBeNull();
    expect(container.textContent).toContain('Options: duplicates off');
  });

  it('offers retry and the pipeline hint after a failure, open and QC after success', () => {
    act(() => root.render(<JobCard job={{ ...runningJob, status: 'error', error: 'minimap2 not found', hint: 'brew install minimap2' }} />));
    expect(container.querySelector('[data-testid="daf-run-retry"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="daf-run-job-hint"]')!.textContent).toBe('brew install minimap2');
    act(() => root.render(<JobCard job={{
      ...runningJob, status: 'done', started_at: 0, finished_at: 250,
      summary: { reads_aligned: 3912, reads_called: 3500, duplicate_percent: 12, footprints_per_read: 5.8, qc_status: 'PASS' },
    }} />));
    expect(container.querySelector('[data-testid="daf-run-open-result"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="daf-run-job-summary"]')!.textContent).toContain('Reads aligned 3,912');
    expect(container.querySelector('[data-testid="qc-verdict-qc"]')!.textContent).toContain('PASS');
  });

  it('draws the QC curves against the reference', () => {
    const payload: QcPayload = {
      available: true,
      plots: { plot: '/api/pipeline/jobs/x/files/plot' },
      qc: { overall: { status: 'PASS', score: 80 }, signal: { label: 'deamination', status: 'PASS', median_per_read_rate: 0.03 }, periodicity: { status: 'WARN', nrl_bp: 190 }, assay: { reference_label: 'Drosophila embryo DddB DAF-seq control' } },
      curves: {
        signal_rate: { per_read_rates: [0.01, 0.02, 0.03], ecdf: [0.33, 0.66, 1], reference_ecdf: { rates: [0.01, 0.04], probabilities: [0.1, 0.9] }, warn_interval: [0.01, 0.07], reference_iqr: [0.02, 0.04] },
        phasogram: { lags_bp: [60, 190, 800], detrended_pair_frequency: [1, 1.1, 1], nrl_bp: 190, reference: null },
        footprint_sizes: { nucleosome: { bin_edges_bp: [0, 100, 200], sample_fraction_per_bin: [0.4, 0.6], sample_n: 10, reference_fraction_per_bin: [0.5, 0.5] } },
      },
    };
    act(() => root.render(<QcReport payload={payload} />));
    for (const id of ['qc-rate-cdf', 'qc-phasogram', 'qc-nucleosome-sizes']) {
      expect(container.querySelector(`[data-testid="${id}"] svg path`), id).not.toBeNull();
    }
    expect(container.querySelector('[data-testid="qc-verdict-periodicity"]')!.textContent).toContain('WARN');
    expect(container.querySelector('[data-testid="qc-file-plot"]')!.getAttribute('href')).toBe('/api/pipeline/jobs/x/files/plot');
    expect(container.textContent).toContain('NRL 190 bp');
  });
});
