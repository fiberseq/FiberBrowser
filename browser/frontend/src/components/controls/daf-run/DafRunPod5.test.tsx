/**
 * Raw Nanopore (POD5) runs in the New run wizard and the Runs view (FiberHMM 3.0's dorado step):
 * the POD5 input option, the dorado status (found / install instructions / Check again), the
 * basecalling defaults and Advanced choices in the request, the "basecall" progress step, the
 * "dorado was not found" error, resuming, and the basecaller of a finished run.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipelineJob } from '../../../api/pipeline';

const DORADO_HINT = 'The input contains raw Nanopore signal (POD5)... Install it:\n  1. Download the archive from https://github.com/nanoporetech/dorado';
const api = vi.hoisted(() => ({
  status: vi.fn(),
  validateRun: vi.fn(),
  scanReads: vi.fn(),
  pickFolder: vi.fn(),
}));
const baseStatus = (dorado: Record<string, unknown>) => ({
  available: true, aligner: { ok: true }, cores: 8, default_cores: 2, current_genome: 'hg38',
  genomes: [{ id: 'hg38', name: 'Human', downloaded: true, loaded: true, fasta: '/tmp/hg38.fa' }],
  output_parent: '/tmp/runs', default_options: {}, loaded_references: [], dorado,
  default_basecall: { model: 'sup', modified_bases: 'auto', device: 'auto', batchsize: null },
});
vi.mock('../../../api/status', () => ({ getStatus: vi.fn(async () => ({ public_mode: false, has_gtf: false, gene_count: 0, track_count: 0 })) }));
vi.mock('../../../api/pipeline', () => ({
  getPipelineStatus: api.status, scanReads: api.scanReads, validateRun: api.validateRun,
  listJobs: vi.fn(async () => ({ jobs: [] })), getJob: vi.fn(), submitRun: vi.fn(), runDatasetQc: vi.fn(),
  cancelJob: vi.fn(), forgetJob: vi.fn(), getJobLog: vi.fn(async () => ''), getJobQc: vi.fn(), retryJob: vi.fn(),
}));
vi.mock('../../../api/files', () => ({
  pickAnyFile: vi.fn(), pickFolder: api.pickFolder, pickFile: vi.fn(), pickDataset: vi.fn(), uploadFile: vi.fn(),
}));

import { DafRunHost } from './DafRunHost';
import { JobCard } from './DafRunJobList';
import { useDafRunStore } from './dafRunStore';
import { useBrowserStore } from '../../../stores/browserStore';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const MISSING = { ok: false, path: null, version: null, hint: DORADO_HINT, label: 'dorado not found' };
const FOUND = { ok: true, path: '/Users/me/dorado-2.0.1/bin/dorado', version: '2.0.1', hint: '', label: 'dorado 2.0.1' };

describe('New run wizard: raw Nanopore (POD5)', () => {
  let box: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    box = document.createElement('div');
    document.body.appendChild(box);
    root = createRoot(box);
    useBrowserStore.setState({ publicMode: false });
    useDafRunStore.setState({ open: true, tab: 'new', jobs: [], draft: null, draftSeeded: false });
    api.status.mockImplementation(async (refresh?: boolean) => baseStatus(refresh ? FOUND : MISSING));
    api.validateRun.mockImplementation(async () => ({ ok: true, errors: [], warnings: [], jobs: [{ sample: 'run1', outdir: '/tmp/runs/x', command: 'fiberhmm-pipeline', n_files: 1 }], output_root: '/tmp/runs/x', dorado: FOUND }));
    api.scanReads.mockImplementation(async () => ({
      success: true, input_kind: 'pod5', warnings: [],
      samples: [{ key: 'pod5:/data/run1/pod5', name: 'run1', order: null, barcode: null, size: 5e9,
        files: [{ path: '/data/run1/pod5', kind: 'pod5', size: 5e9 }], kinds: ['pod5'] }],
    }));
    api.pickFolder.mockResolvedValue({ success: true, path: '/data/run1/pod5' });
  });

  afterEach(() => {
    act(() => root.unmount());
    box.remove();
    vi.clearAllMocks();
  });

  const q = (testId: string) => box.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
  const click = async (testId: string) => {
    const el = q(testId);
    expect(el, testId).toBeTruthy();
    await act(async () => { el!.click(); });
  };
  const wait = (ms: number) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
  const select = async (testId: string, value: string) => {
    const el = q(testId) as HTMLSelectElement;
    expect(el, testId).toBeTruthy();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, value);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
  };

  it('picks a POD5 folder, shows the dorado status and offers Check again before the run', async () => {
    await act(async () => root.render(<DafRunHost />));
    await wait(0);
    expect(q('daf-run-dorado')).toBeNull();  // reads mode: no dorado line
    await click('daf-run-input-pod5');
    expect(q('daf-run-dropzone')!.textContent).toContain('Choose the POD5 folder');
    const dorado = q('daf-run-dorado')!;
    expect(dorado.getAttribute('data-dorado')).toBe('missing');
    expect(q('daf-run-dorado-hint')!.textContent).toContain('github.com/nanoporetech/dorado');

    await click('daf-run-dorado-recheck');
    expect(api.status).toHaveBeenLastCalledWith(true);
    expect(q('daf-run-dorado')!.getAttribute('data-dorado')).toBe('found');
    expect(q('daf-run-dorado')!.textContent).toBe('dorado 2.0.1 found: /Users/me/dorado-2.0.1/bin/dorado');

    await click('daf-run-choose-folder');
    expect(api.scanReads).toHaveBeenCalledWith(['/data/run1/pod5'], 'pod5');
    expect((box.querySelector('[data-testid="daf-run-sample-name"]') as HTMLInputElement).value).toBe('run1');
    expect(q('daf-run-samples')!.textContent).toContain('folder');
  });

  it('keeps the POD5 choice made before the status arrived (dorado is looked for meanwhile)', async () => {
    let answer!: (value: unknown) => void;
    api.status.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    await act(async () => root.render(<DafRunHost />));
    await click('daf-run-input-pod5');
    expect(q('daf-run-dorado')!.textContent).toBe('Looking for dorado…');
    await act(async () => answer(baseStatus(FOUND)));
    expect(q('daf-run-input-pod5')!.getAttribute('aria-checked')).toBe('true');
    expect(q('daf-run-dorado')!.getAttribute('data-dorado')).toBe('found');
  });

  it('defaults to sup + 6mA for Hia5 and plain for DAF-seq, with Advanced choices in the request', async () => {
    await act(async () => root.render(<DafRunHost />));
    await wait(0);
    await click('daf-run-input-pod5');
    await click('daf-run-choose-folder');
    await click('daf-run-next');
    await click('daf-run-next');  // the open genome is the reference
    expect(q('daf-run-enzyme-hia5')).not.toBeNull();
    await click('daf-run-enzyme-hia5');
    expect(q('daf-run-basecall-line')!.textContent).toBe('dorado sup + 6mA');
    expect(q('daf-run-opt-dedup')).toBeNull();  // DAF-seq's options do not apply to Hia5
    await wait(450);
    const request = api.validateRun.mock.calls.at(-1)![0];
    expect(request.input_kind).toBe('pod5');
    expect(request.enzyme).toBe('hia5');
    expect(request.basecall).toEqual({ model: 'sup', modified_bases: 'auto', device: 'auto', batchsize: null });
    expect(request.samples[0].files[0]).toEqual({ path: '/data/run1/pod5', kind: 'pod5', size: 5e9 });

    await click('daf-run-enzyme-dddb');
    expect(q('daf-run-basecall-line')!.textContent).toBe('dorado sup (no modification model)');
    await select('daf-run-bc-device', 'metal');
    await select('daf-run-bc-model', 'hac');
    expect(q('daf-run-basecall-line')!.textContent).toBe('dorado hac (no modification model) · metal');
    await wait(450);
    const changed = api.validateRun.mock.calls.at(-1)![0];
    expect(changed.basecall).toEqual({ model: 'hac', modified_bases: 'auto', device: 'metal', batchsize: null });
  });

  it('shows the dorado error from the server check instead of a generic error', async () => {
    api.status.mockImplementation(async () => baseStatus(MISSING));
    api.validateRun.mockImplementation(async () => ({
      ok: false, warnings: [], jobs: [], output_root: null, dorado: MISSING,
      errors: [{ field: 'dorado', message: 'dorado is not installed', hint: DORADO_HINT }],
    }));
    await act(async () => root.render(<DafRunHost />));
    await wait(0);
    await click('daf-run-input-pod5');
    await click('daf-run-choose-folder');
    await click('daf-run-next');
    await click('daf-run-next');
    await click('daf-run-enzyme-dddb');
    await wait(450);
    const lines = box.querySelectorAll('[data-testid="daf-run-dorado"][data-dorado="missing"]');
    expect(lines.length).toBeGreaterThan(0);
    expect(q('daf-run-preview')!.textContent).not.toContain('dorado is not installed');
    expect((q('daf-run-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('does not offer Hia5 for reads (FASTQ/BAM)', async () => {
    api.scanReads.mockImplementation(async () => ({
      success: true, warnings: [], samples: [{ key: 'k', name: 'embryo', order: null, barcode: null, size: 1,
        files: [{ path: '/tmp/embryo.fastq', kind: 'fastq', size: 1 }], kinds: ['fastq'] }],
    }));
    api.pickFolder.mockResolvedValue({ success: true, path: '/tmp/reads' });
    await act(async () => root.render(<DafRunHost />));
    await wait(0);
    await click('daf-run-choose-folder');
    expect(api.scanReads).toHaveBeenCalledWith(['/tmp/reads'], 'reads');
    await click('daf-run-next');
    await click('daf-run-next');
    expect(q('daf-run-enzyme-hia5')).toBeNull();
    expect(q('daf-run-basecall')).toBeNull();
  });
});

const pod5Job = (changes: Partial<PipelineJob>): PipelineJob => ({
  id: '20261003-120000-abcdef', sample: 'run1', enzyme: 'hia5', outdir: '/runs/run1',
  reference: { path: '/g/hg38.fa', kind: 'fasta', label: 'hg38', genome_id: 'hg38' }, cores: 4, reads: ['/data/run1/pod5'],
  regions: [], options: {}, option_labels: ['basecall: dorado sup + 6mA'], group: 'g', command: 'fiberhmm-pipeline /data/run1/pod5',
  auto_open: false, status: 'running', input_kind: 'pod5',
  progress: {
    version: '3.0.0', current_step: 'basecall', fraction: 0, eta_s: null, logs: [], warnings: [], settings: null, started: true, done: null,
    steps: [
      { name: 'basecall', label: 'Basecalling (dorado)', status: 'running', message: 'dorado 2.0.1: 1,204 MB written, 600 s' },
      { name: 'prepare_reference', label: 'Preparing the reference', status: 'pending' },
      { name: 'align', label: 'Aligning reads (minimap2)', status: 'pending' },
    ],
  },
  ...changes,
});

describe('Runs view: the basecall step', () => {
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

  const q = (testId: string) => container.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;

  it("shows dorado's running messages, then the reads it basecalled", () => {
    act(() => root.render(<JobCard job={pod5Job({})} />));
    expect(q('daf-run-job-headline')!.textContent).toBe('Basecalling (dorado): dorado 2.0.1: 1,204 MB written, 600 s');
    expect(container.querySelector('[data-step="basecall"]')!.getAttribute('data-step-status')).toBe('running');
    expect(container.textContent).toContain('Options: basecall: dorado sup + 6mA');

    const done = pod5Job({});
    done.progress = { ...done.progress, current_step: 'align', steps: [
      { name: 'basecall', label: 'Basecalling (dorado)', status: 'done', done: 40, unit: 'reads', started_at: 1000, finished_at: 4700,
        message: '40 reads basecalled with dorado 2.0.1 (sup, modified bases 6mA) in 3700 s' },
      { name: 'align', label: 'Aligning reads (minimap2)', status: 'running', done: 10, total: 40, unit: 'reads' },
    ] };
    act(() => root.render(<JobCard job={done} />));
    expect(container.querySelector('[data-step="basecall"]')!.textContent).toContain('40 reads · 1 h 1 min');
  });

  it('says clearly when dorado was not found, and resumes basecalling after a stop', () => {
    const failed = pod5Job({ status: 'error', error: 'dorado was not found', hint: DORADO_HINT });
    act(() => root.render(<JobCard job={failed} />));
    expect(q('daf-run-job-headline')!.textContent).toBe('dorado was not found');
    expect(q('daf-run-job-hint')!.textContent).toContain('github.com/nanoporetech/dorado');
    expect(q('daf-run-retry')!.textContent).toBe('Resume basecalling');

    const later = pod5Job({ status: 'interrupted', error: 'The pipeline stopped' });
    later.progress = { ...later.progress, steps: [{ name: 'basecall', label: 'Basecalling (dorado)', status: 'done', done: 40, unit: 'reads' },
      { name: 'align', label: 'Aligning reads (minimap2)', status: 'running' }] };
    act(() => root.render(<JobCard job={later} />));
    expect(q('daf-run-retry')!.textContent).toBe('Retry');
  });

  it("shows a finished run's basecaller and basecalled reads", () => {
    const job = pod5Job({
      status: 'done', started_at: 0, finished_at: 100,
      summary: { reads_basecalled: 40, reads_aligned: 38, reads_called: 36, duplicate_percent: null, footprints_per_read: null, qc_status: null },
      outputs: {
        called_bam: '/runs/run1/run1.fiberhmm.bam', basecalled_bam: '/runs/run1/run1.basecalled.bam',
        open: { fasta: null, datasets: [], plasmid_maps: [], region: null },
        settings: { basecaller: { available: true, program: 'dorado', version: '2.0.1',
          basecall_model: 'dna_r10.4.1_e8.2_400bps_sup@v5.2.0',
          modbase_models: ['dna_r10.4.1_e8.2_400bps_sup@v5.2.0_6mA@v1'], sources: { basecall_model: 'rg_ds' } } },
      },
    });
    act(() => root.render(<JobCard job={job} />));
    const summary = q('daf-run-job-summary')!.textContent!;
    expect(summary).toContain('Reads basecalled 40');
    expect(q('daf-run-job-basecaller')!.textContent).toBe('Basecaller dorado 2.0.1 · sup v5.2.0 · 6mA v1');
    expect(q('daf-run-job-basecaller')!.getAttribute('title')).toContain('Basecall model: dna_r10.4.1_e8.2_400bps_sup@v5.2.0');
  });
});
