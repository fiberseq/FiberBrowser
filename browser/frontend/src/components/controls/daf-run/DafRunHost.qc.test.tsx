/**
 * "QC a dataset": a verdict is only ever shown under the dataset and chemistry it
 * was computed for. Reproduction from the 29 Sep review: QC started on A, B
 * selected while it ran, then A's PASS appeared under B without a label.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../api/pipeline', () => ({
  listJobs: vi.fn(async () => ({ jobs: [] })),
  runDatasetQc: vi.fn(),
  getPipelineStatus: vi.fn(),
  scanReads: vi.fn(),
  submitRun: vi.fn(),
  validateRun: vi.fn(),
}));
vi.mock('../../../api/status', () => ({ getStatus: vi.fn(async () => ({ public_mode: false })) }));

import { runDatasetQc, type QcPayload } from '../../../api/pipeline';
import { useBrowserStore } from '../../../stores/browserStore';
import { DafRunHost } from './DafRunHost';
import { useDafRunStore } from './dafRunStore';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const PASS: QcPayload = { available: true, success: true, qc: { overall: { status: 'PASS' } }, curves: null, plots: {} } as any;
const FAIL: QcPayload = { available: true, success: true, qc: { overall: { status: 'FAIL' } }, curves: null, plots: {} } as any;

describe('QC a dataset', () => {
  let container: HTMLDivElement;
  let root: Root;
  const pending: Array<(value: QcPayload) => void> = [];

  beforeEach(() => {
    vi.clearAllMocks();
    pending.length = 0;
    vi.mocked(runDatasetQc).mockImplementation(() => new Promise(resolve => { pending.push(resolve); }));
    useDafRunStore.setState({ open: true, tab: 'qc', jobs: [] } as any);
    useBrowserStore.setState({ publicMode: false, datasets: [
      { id: 'dataset-A', path: '/scratch/A.bam', label: 'Alpha', data_type: 'bam' },
      { id: 'dataset-B', path: '/scratch/B.bam', label: 'Beta', data_type: 'bam' },
    ] } as any);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const q = (selector: string) => container.querySelector(selector);
  const selects = () => [...container.querySelectorAll('[data-testid="daf-run-dataset-qc"] select')] as HTMLSelectElement[];
  const change = (select: HTMLSelectElement, value: string) => act(() => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const run = () => act(async () => { (q('[data-testid="daf-run-dataset-qc-run"]') as HTMLButtonElement).click(); });

  it("drops dataset A's verdict when B was selected while it ran", async () => {
    await act(async () => { root.render(<DafRunHost />); });
    await run();
    expect(runDatasetQc).toHaveBeenCalledWith('dataset-A', 'auto');
    change(selects()[0], 'dataset-B');
    await act(async () => { pending[0](PASS); });
    expect(selects()[0].value).toBe('dataset-B');
    expect(q('[data-testid="qc-report"]')).toBeNull();
    expect(q('[data-testid="daf-run-dataset-qc-run"]')!.textContent).toBe('Run QC');

    // B's own run shows under B's name.
    await run();
    expect(runDatasetQc).toHaveBeenLastCalledWith('dataset-B', 'auto');
    await act(async () => { pending[1](FAIL); });
    expect(q('[data-testid="daf-run-dataset-qc-identity"]')!.textContent).toContain('Beta');
    expect(q('[data-testid="qc-report"]')!.textContent).toContain('FAIL');
  });

  it('clears the verdict when the chemistry changes, and ignores a superseded run', async () => {
    await act(async () => { root.render(<DafRunHost />); });
    await run();
    await act(async () => { pending[0](PASS); });
    expect(q('[data-testid="daf-run-dataset-qc-identity"]')!.textContent).toContain('Alpha');
    expect(q('[data-testid="qc-report"]')!.textContent).toContain('PASS');

    change(selects()[1], 'ddda');
    expect(q('[data-testid="qc-report"]')).toBeNull();

    // A run for DddB, switched back to automatic and run again: only the last answer counts.
    change(selects()[1], 'dddb');
    await run();
    change(selects()[1], 'auto');
    await run();
    await act(async () => { pending[2](FAIL); });
    await act(async () => { pending[1](PASS); });
    expect(q('[data-testid="daf-run-dataset-qc-identity"]')!.textContent).toContain('BAM header');
    expect(q('[data-testid="qc-report"]')!.textContent).toContain('FAIL');
  });
});
