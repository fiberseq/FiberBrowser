/**
 * New DAF-seq run wizard: the draft survives leaving the tab or the dialog,
 * a run check always belongs to the request it checked, and missing inputs
 * are help (not errors) until the user tries to go on.
 *
 * The first two are the Codex UI audit reproductions (round 19,
 * observations.test.tsx), turned around to assert the fixed behaviour:
 * "Switching wizard tabs silently discards the run draft" and "Failed wizard
 * revalidation retains obsolete errors and blocks Run". The third is UI audit L15.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { scanReads, validateRun } = vi.hoisted(() => ({
  validateRun: vi.fn(),
  scanReads: vi.fn(async () => ({
    success: true,
    samples: [{ key: 'k', name: 'embryo', order: null, barcode: null, size: 123, files: [{ path: '/tmp/embryo.fastq', size: 123 }], kinds: ['fastq'] }],
    warnings: [],
  })),
}));
vi.mock('../../../api/status', () => ({ getStatus: vi.fn(async () => ({ public_mode: false, has_gtf: false, gene_count: 0, track_count: 0 })) }));
vi.mock('../../../api/pipeline', () => ({
  getPipelineStatus: vi.fn(async () => ({
    available: true, aligner: { ok: true }, cores: 8, default_cores: 2, current_genome: 'hg38',
    genomes: [{ id: 'hg38', name: 'Human', downloaded: true, loaded: true, fasta: '/tmp/hg38.fa' }],
    output_parent: '/tmp/runs', default_options: {}, loaded_references: [],
  })),
  scanReads, listJobs: vi.fn(async () => ({ jobs: [] })), getJob: vi.fn(), submitRun: vi.fn(), validateRun, runDatasetQc: vi.fn(),
}));
vi.mock('../../../api/files', () => ({
  pickAnyFile: vi.fn(async () => ({ success: true, paths: ['/tmp/embryo.fastq'] })),
  pickFolder: vi.fn(), pickFile: vi.fn(), pickDataset: vi.fn(), uploadFile: vi.fn(),
}));

import { DafRunHost } from './DafRunHost';
import { useDafRunStore } from './dafRunStore';
import { useBrowserStore } from '../../../stores/browserStore';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('New DAF-seq run wizard', () => {
  let box: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    validateRun.mockReset();
    box = document.createElement('div');
    document.body.appendChild(box);
    root = createRoot(box);
    useBrowserStore.setState({ publicMode: false });
    useDafRunStore.setState({ open: true, tab: 'new', jobs: [], draft: null, draftSeeded: false });
    scanReads.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    box.remove();
  });

  const q = (testId: string) => box.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
  const click = async (selector: string) => {
    const el = box.querySelector(selector) as HTMLElement | null;
    expect(el, selector).toBeTruthy();
    await act(async () => { el!.click(); });
  };
  const wait = (ms: number) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
  const setValue = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  it('keeps the draft through New → Runs → New and a close and reopen', async () => {
    await act(async () => root.render(<DafRunHost />));
    await click('[data-testid="daf-run-choose-files"]');
    expect(box.querySelectorAll('[data-testid="daf-run-sample-name"]')).toHaveLength(1);

    await click('[data-testid="daf-run-tab-runs"]');
    await click('[data-testid="daf-run-tab-new"]');
    expect(box.querySelectorAll('[data-testid="daf-run-sample-name"]')).toHaveLength(1);

    await act(async () => { useDafRunStore.getState().setOpen(false); });
    await act(async () => { useDafRunStore.getState().setOpen(true, 'new'); });
    expect(box.querySelectorAll('[data-testid="daf-run-sample-name"]')).toHaveLength(1);
    // Reference edits on the next step are kept too.
    await click('[data-testid="daf-run-next"]');
    const regions = box.querySelector('[data-testid="daf-run-regions"]') as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(regions, 'chr2L:1000-5000');
      regions.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('[data-testid="daf-run-tab-runs"]');
    await click('[data-testid="daf-run-tab-new"]');
    expect((box.querySelector('[data-testid="daf-run-regions"]') as HTMLTextAreaElement).value).toBe('chr2L:1000-5000');

    // Start over is the explicit reset.
    await click('[data-testid="daf-run-start-over"]');
    expect(box.querySelectorAll('[data-testid="daf-run-sample-name"]')).toHaveLength(0);
  });

  // Codex review: a scan still running when the draft is started over must
  // not put its reads into the new draft.
  it('a scan that answers after Start over leaves the new draft alone', async () => {
    let answer: (value: unknown) => void = () => {};
    const sample = { key: 'k', name: 'embryo', order: null, barcode: null, size: 1, files: [{ path: '/tmp/embryo.fastq', size: 1 }], kinds: ['fastq'] };
    scanReads.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }) as any);
    await act(async () => root.render(<DafRunHost />));
    await click('[data-testid="daf-run-choose-files"]');
    await act(async () => { useDafRunStore.getState().clearDraft(); });
    await act(async () => { answer({ success: true, samples: [sample], warnings: [] }); });
    expect(box.querySelectorAll('[data-testid="daf-run-sample-name"]')).toHaveLength(0);
    expect(useDafRunStore.getState().draft?.samples ?? []).toHaveLength(0);
  });

  it('a failed re-check replaces the obsolete result and does not block Run', async () => {
    validateRun
      .mockResolvedValueOnce({ ok: false, errors: [{ message: 'OLD output is not writable' }], warnings: [], jobs: [] })
      .mockRejectedValueOnce(new Error('503 preflight unavailable'))
      .mockResolvedValueOnce({ ok: true, errors: [], warnings: [], jobs: [{ sample: 'embryo', outdir: '/tmp/runs/x' }] });
    await act(async () => root.render(<DafRunHost />));
    await click('[data-testid="daf-run-choose-files"]');
    await click('[data-testid="daf-run-next"]');
    await click('[data-testid="daf-run-next"]');
    await click('[data-testid="daf-run-enzyme-ddda"] input');
    await wait(450);
    expect(box.textContent).toContain('OLD output is not writable');
    expect((q('daf-run-submit') as HTMLButtonElement).disabled).toBe(true);

    // An edit makes the old answer obsolete at once.
    await setValue(box.querySelector('[data-testid="daf-run-cores"]') as HTMLInputElement, '3');
    expect(box.textContent).not.toContain('OLD output is not writable');
    expect(q('daf-run-checking')).not.toBeNull();
    await wait(450);
    expect(validateRun).toHaveBeenCalledTimes(2);
    expect(box.textContent).not.toContain('OLD output is not writable');
    expect(q('daf-run-check-failed')!.textContent).toContain("Couldn't check the run: 503 preflight unavailable");
    expect((q('daf-run-submit') as HTMLButtonElement).disabled).toBe(false);

    await click('[data-testid="daf-run-recheck"]');
    await wait(450);
    expect(validateRun).toHaveBeenCalledTimes(3);
    expect(q('daf-run-check-failed')).toBeNull();
    expect(q('daf-run-preview')!.textContent).toContain('embryo');
  });

  it('shows missing inputs as help on open, and as errors once Next is tried (L15)', async () => {
    await act(async () => root.render(<DafRunHost />));
    expect(q('daf-run-errors')).toBeNull();
    expect(q('daf-run-help')!.textContent).toContain('Add reads:');
    expect(q('daf-run-help')!.className).not.toContain('red');

    await click('[data-testid="daf-run-next"]');
    expect(q('daf-run-step-0')!.className).toContain('bg-blue-500');  // still on Reads
    expect(q('daf-run-help')).toBeNull();
    expect(q('daf-run-errors')!.textContent).toContain('Add reads:');

    // Adding reads clears it; the next step starts with help again.
    await click('[data-testid="daf-run-choose-files"]');
    expect(q('daf-run-errors')).toBeNull();
  });
});
