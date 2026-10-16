/**
 * The QC panel with a state-aware fiberhmm-qc report (real output for the demo
 * BAM, tests/fixtures/qc_state_aware) and with an older report: efficiency and
 * background lines, the verdict basis and the per-read state CDF appear only
 * when the fields are there.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import newQc from '../../../../../../tests/fixtures/qc_state_aware/napa_ddda.qc.json';
import newCurves from '../../../../../../tests/fixtures/qc_state_aware/napa_ddda.qc.curves.json';
import type { PipelineJob, QcPayload } from '../../../api/pipeline';
import { JobCard } from './DafRunJobList';
import { QcReport } from './QcReport';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('QcReport: state-aware rates', () => {
  let container: HTMLDivElement;
  let root: Root;
  const q = (id: string) => container.querySelector(`[data-testid="${id}"]`);

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('shows efficiency and background against the reference, the basis, the source and the state CDF', () => {
    const payload: QcPayload = { available: true, qc: newQc as any, curves: newCurves as any, plots: {} };
    act(() => root.render(<QcReport payload={payload} />));
    const chips = [...container.querySelectorAll('[data-testid^="qc-verdict-"]')]
      .filter(el => el.getAttribute('data-testid') !== 'qc-verdict-basis')
      .map(el => el.getAttribute('data-testid'));
    expect(chips).toEqual(['qc-verdict-overall', 'qc-verdict-efficiency', 'qc-verdict-background', 'qc-verdict-periodicity', 'qc-verdict-deamination']);
    expect(q('qc-verdict-deamination')!.getAttribute('data-in-verdict')).toBe('false');
    expect(q('qc-verdict-deamination')!.textContent).toContain('not in verdict');
    expect(q('qc-verdict-basis')!.textContent).toContain('Verdict from efficiency, background and periodicity (state-aware)');

    const eff = q('qc-state-efficiency')!;
    expect(eff.textContent).toContain('62.1%');
    expect(q('qc-state-efficiency-status')!.textContent).toBe('WARN');
    expect(q('qc-state-background-status')!.textContent).toBe('PASS');
    expect(eff.textContent).toContain('reference 66.4%');
    expect(eff.textContent).toContain('PASS ≥ 62.4% · WARN ≥ 55.4%');
    expect(eff.getAttribute('title')).toMatch(/^Efficiency: how often the enzyme marked accessible DNA/);
    expect(q('qc-state-efficiency-gauge')).not.toBeNull();
    const bg = q('qc-state-background')!;
    expect(bg.textContent).toContain('16.8%');
    expect(bg.textContent).toContain('PASS ≤ 19.2% · WARN ≤ 22.8%');
    expect(q('qc-state-msp-share')!.textContent).toContain('29%');
    expect(q('qc-state-ratio')!.textContent).toContain('3.7×');
    expect(q('qc-state-ratio')!.textContent).toContain('reference 4.0×');
    expect(q('qc-state-overall-rate')!.textContent).toContain('30.8%');
    expect(q('qc-state-source')!.textContent).toBe('States from the FiberHMM calls in the BAM on 1,997 of 2,000 sampled reads (written by fiberhmm-call 2.14.0).');
    expect(q('qc-state-cdf')!.querySelectorAll('svg path').length).toBe(4);
    // The overall-rate chart stays, after the state chart.
    expect(q('qc-rate-cdf')).not.toBeNull();
    const figures = [...container.querySelectorAll('figure')].map(f => f.getAttribute('data-testid'));
    expect(figures.indexOf('qc-state-cdf')).toBeLessThan(figures.indexOf('qc-rate-cdf'));
  });

  it('an older QC report shows what it did before', () => {
    const payload: QcPayload = {
      available: true,
      qc: { overall: { status: 'PASS', score: 80 }, signal: { label: 'deamination', status: 'PASS', median_per_read_rate: 0.03 }, periodicity: { status: 'WARN', nrl_bp: 190 }, assay: { reference_label: 'Drosophila embryo DddB DAF-seq control' } },
      curves: { schema: 'fiberhmm.qc.curves.v1', signal_rate: { per_read_rates: [0.02, 0.03, 0.04], ecdf: [1 / 3, 2 / 3, 1], reference_ecdf: null, warn_interval: null, reference_iqr: null } },
      plots: {},
    };
    act(() => root.render(<QcReport payload={payload} />));
    expect(q('qc-state-rates')).toBeNull();
    expect(q('qc-state-cdf')).toBeNull();
    expect(q('qc-verdict-basis')).toBeNull();
    expect(q('qc-verdict-efficiency')).toBeNull();
    expect(q('qc-verdict-deamination')!.getAttribute('data-in-verdict')).toBe('true');
    expect(container.textContent).toContain("PASS is the reference's middle half; WARN its 5–95% range.");
    expect(container.textContent).toContain('Median deamination');
  });

  it('a finished run card shows efficiency and background from outputs.json', () => {
    const job = {
      id: 'j1', sample: 's', enzyme: 'ddda', outdir: '/o', reference: null, cores: 1, reads: [], regions: [], options: {},
      option_labels: [], group: null, command: null, auto_open: false, status: 'done',
      progress: { version: '3.0.0', current_step: null, fraction: 1, eta_s: null, logs: [], warnings: [], settings: null, started: true, done: null, steps: [] },
      summary: { reads_aligned: 10, reads_called: 10, duplicate_percent: 0, footprints_per_read: 2, qc_status: 'WARN' },
      outputs: {
        open: { fasta: null, datasets: [], plasmid_maps: [], region: null },
        qc: { verdicts: {
          overall: 'WARN', efficiency: 'WARN', background: 'PASS', verdict_basis: 'state-aware',
          state_rates: { source: 'tags', msp_rate: 0.6212, outside_msp_rate: 0.1684 },
        } },
      },
    } as unknown as PipelineJob;
    act(() => root.render(<JobCard job={job} />));
    expect(q('qc-verdict-qc')!.getAttribute('title')).toBe('Overall verdict from efficiency, background and periodicity (state-aware).');
    expect(q('daf-run-qc-efficiency')!.textContent).toBe('Efficiency 62.1% WARN');
    expect(q('daf-run-qc-background')!.textContent).toBe('Background 16.8% PASS');
  });
});
