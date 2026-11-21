/**
 * Automatic opening of a finished run (FH_RUN_CHECK finding 3): only in the page that started the run, and
 * only once. It used to be remembered per browser in localStorage, so every other profile, origin or window
 * (and the desktop app's webview) re-opened the result for 24 h, replacing the genome given on the command line.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipelineJob } from '../../../api/pipeline';

const api = vi.hoisted(() => ({ listJobs: vi.fn(), markJobOpened: vi.fn() }));
vi.mock('../../../api/pipeline', () => ({
  listJobs: api.listJobs, markJobOpened: api.markJobOpened, runDatasetQc: vi.fn(), getPipelineStatus: vi.fn(),
  scanReads: vi.fn(), submitRun: vi.fn(), validateRun: vi.fn(),
}));
vi.mock('../../../api/status', () => ({ getStatus: vi.fn(async () => ({ public_mode: false })) }));
const open = vi.hoisted(() => vi.fn(async () => ({ success: true, message: 'Opened.' })));
vi.mock('../../../utils/pipelineResults', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../utils/pipelineResults')>()), openJobResult: open,
}));

import { useBrowserStore } from '../../../stores/browserStore';
import { pageOpenerId } from '../../../utils/pipelineResults';
import { DafRunHost } from './DafRunHost';
import { useDafRunStore } from './dafRunStore';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const finished = (changes: Partial<PipelineJob> = {}): PipelineJob => ({
  id: '20261107-120000-abcdef', sample: 'synthetic', enzyme: 'hia5', outdir: '/o', cores: 2, reads: [], regions: [],
  options: {}, option_labels: [], group: null, command: null, auto_open: true, status: 'done', reference: null,
  progress: { version: null, steps: [], current_step: null, fraction: 1, eta_s: null, logs: [], warnings: [], settings: null, started: true, done: null },
  outputs: { called_bam: '/o/s.bam', reference_fasta: '/o/g.fa', plasmid_map: null, open: { fasta: '/o/g.fa', datasets: ['/o/s.bam'], plasmid_maps: [], region: null } },
  opener: pageOpenerId(), opened_at: null, finished_at: 1, ...changes,
});

describe('automatic opening of a finished run', () => {
  let box: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    useBrowserStore.setState({ publicMode: false });
    useDafRunStore.setState({ open: false, tab: 'new', jobs: [] } as any);
    box = document.createElement('div');
    document.body.appendChild(box);
    root = createRoot(box);
  });

  afterEach(() => {
    act(() => root.unmount());
    box.remove();
  });

  const render = async (jobs: PipelineJob[]) => {
    api.listJobs.mockResolvedValue({ jobs });
    await act(async () => root.render(<DafRunHost />));
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    // Polls again: still asked (and opened) only once.
    await act(async () => { await useDafRunStore.getState().refresh(); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
  };

  it('opens a run this page started once, after the server grants the claim', async () => {
    api.markJobOpened.mockResolvedValue({ claimed: true, opened_at: 2, reason: null });
    await render([finished()]);
    expect(api.markJobOpened).toHaveBeenCalledTimes(1);
    expect(api.markJobOpened).toHaveBeenCalledWith('20261107-120000-abcdef', { auto: true, opener: pageOpenerId() });
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0][1]).toEqual({ claimed: true });
    expect(box.querySelector('[data-testid="daf-run-chip"]')!.textContent).toBe('synthetic finished and is open.');
  });

  it('never opens a run another page started, nor one opened before, nor asks the server', async () => {
    await render([finished({ opener: 'tab-from-another-window' }), finished({ id: '20261107-120000-bbbbbb', opened_at: 5 }),
      finished({ id: '20261107-120000-cccccc', opener: null })]);
    expect(api.markJobOpened).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('does not open when the server refuses the claim (opened meanwhile in a duplicated tab)', async () => {
    api.markJobOpened.mockResolvedValue({ claimed: false, opened_at: 3, reason: 'already opened' });
    await render([finished()]);
    expect(api.markJobOpened).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
  });
});
