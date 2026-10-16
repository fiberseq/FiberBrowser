/**
 * "QC a dataset" with no BAM loaded: QC a Library BAM or a chosen file without loading
 * it (no "Load a BAM first" dead end); the loaded-dataset path is DafRunHost.qc.test.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ library: vi.fn(), add: vi.fn(), run: vi.fn(), pick: vi.fn(), dataset: vi.fn() }));
vi.mock('../../../api/pipeline', () => ({
  listJobs: vi.fn(async () => ({ jobs: [] })),
  runDatasetQc: api.dataset,
  getPipelineStatus: vi.fn(),
  scanReads: vi.fn(),
  submitRun: vi.fn(),
  validateRun: vi.fn(),
}));
vi.mock('../../../api/status', () => ({ getStatus: vi.fn(async () => ({ public_mode: false })) }));
vi.mock('../../../api/library', () => ({ getLibrary: api.library, addLibraryFiles: api.add }));
vi.mock('../../../api/libraryQc', () => ({ startLibraryEntryQc: api.run }));
vi.mock('../../../api/files', () => ({ pickFile: api.pick }));
vi.mock('./QcReport', () => ({
  QcReport: (p: { payload: { qc: { overall?: { status?: string } } } }) => <div data-testid="qc-report">{p.payload.qc?.overall?.status}</div>,
}));

import { useBrowserStore } from '../../../stores/browserStore';
import { DafRunHost } from './DafRunHost';
import { useDafRunStore } from './dafRunStore';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const bam = (id: string, extra: object = {}) => ({
  id, kind: 'bam', path: `/data/${id}.bam`, folder: '/data', label: `${id}.bam`, available: true, tags: [], notes: '',
  chemistry: { key: 'dddb', declared: true }, ...extra,
});
const result = (id: string, status: string) => ({
  success: true, available: true, entry_id: id, enzyme: 'dddb', qc: { overall: { status } }, curves: null, plots: {},
});

describe('QC a dataset with no BAM loaded', () => {
  let container: HTMLDivElement;
  let root: Root;
  const pending = new Map<string, (value: unknown) => void>();
  let library: object[];

  beforeEach(() => {
    vi.clearAllMocks();
    pending.clear();
    library = [bam('A'), bam('B'), bam('R', { remote: true }), { ...bam('T'), kind: 'bigbed' }, bam('M', { available: false })];
    api.library.mockImplementation(async () => ({ entries: library }));
    api.run.mockImplementation((id: string) => new Promise(resolve => { pending.set(id, resolve); }));
    useDafRunStore.setState({ open: true, tab: 'qc', jobs: [] } as any);
    useBrowserStore.setState({ publicMode: false, datasets: [] } as any);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  const select = () => q('daf-run-qc-library-select') as HTMLSelectElement;

  it("lists the Library's local BAMs and QCs the chosen one without loading it", async () => {
    await act(async () => { root.render(<DafRunHost />); });
    expect(container.textContent).not.toContain('Load a BAM first');
    expect([...select().options].map(o => o.value)).toEqual(['A', 'B']);
    await act(async () => q('daf-run-qc-library-run')!.click());
    expect(api.run).toHaveBeenCalledWith('A', false);
    expect(q('daf-run-qc-progress')).not.toBeNull();

    // B chosen while A runs: A's answer is dropped.
    await act(async () => { select().value = 'B'; select().dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => pending.get('A')!(result('A', 'PASS')));
    expect(q('qc-report')).toBeNull();
    await act(async () => q('daf-run-qc-library-run')!.click());
    await act(async () => pending.get('B')!(result('B', 'FAIL')));
    expect(q('daf-run-dataset-qc-identity')!.textContent).toContain('B.bam');
    expect(q('qc-report')!.textContent).toBe('FAIL');
    expect(api.dataset).not.toHaveBeenCalled();
    expect(useBrowserStore.getState().datasets).toEqual([]);
  });

  it('QCs a chosen file through the Library, and shows errors inline', async () => {
    library = [];
    api.pick.mockResolvedValue({ success: true, path: '/elsewhere/new.bam' });
    api.add.mockImplementation(async () => { library = [bam('N', { label: 'new.bam' })]; return { success: true, ids: ['N'], errors: [] }; });
    await act(async () => { root.render(<DafRunHost />); });
    expect(q('daf-run-qc-library-empty')).not.toBeNull();
    await act(async () => q('daf-run-qc-choose-file')!.click());
    expect(api.pick).toHaveBeenCalledWith('bam');
    expect(api.add).toHaveBeenCalledWith(['/elsewhere/new.bam']);
    expect(api.run).toHaveBeenCalledWith('N', false);
    await act(async () => pending.get('N')!({ success: false, available: false, entry_id: 'N', error: 'fiberhmm-qc failed: x', qc: null, curves: null, plots: {} }));
    expect(q('daf-run-qc-error')!.textContent).toBe('fiberhmm-qc failed: x');
  });

  it('asks before downloading an online-only file', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await act(async () => { root.render(<DafRunHost />); });
    await act(async () => q('daf-run-qc-library-run')!.click());
    await act(async () => pending.get('A')!({ success: false, needs_confirmation: true, error: 'A.bam is online-only.', available: false, qc: null, curves: null, plots: {} }));
    expect(confirm).toHaveBeenCalledWith('A.bam is online-only.');
    expect(api.run).toHaveBeenCalledTimes(1);  // declined: nothing downloaded
    expect(q('qc-report')).toBeNull();
    confirm.mockRestore();
  });
});
