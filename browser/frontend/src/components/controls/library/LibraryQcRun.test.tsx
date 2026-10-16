/**
 * Run QC from the Library's details: fiberhmm-qc on the entry itself (no "load a BAM
 * first"), progress and the result in place, and never one entry's result on another.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibraryEntry } from '../../../api/library';
import type { LibraryQcRunResult } from '../../../api/libraryQc';
import { resetLibraryQcRuns } from '../../../api/libraryQc';
import { LibraryDetails } from './LibraryDetails';

const api = vi.hoisted(() => ({ get: vi.fn(), qc: vi.fn(), run: vi.fn(), dialog: vi.fn() }));
vi.mock('../../../api/library', () => ({
  getLibraryEntry: api.get, recallLibraryEntry: vi.fn(),
  getLibraryEntryQc: api.qc, editLibraryEntry: vi.fn(), locateLibraryEntry: vi.fn(),
  removeLibraryEntries: vi.fn(), rescanLibraryEntry: vi.fn(), revealLibraryEntry: vi.fn(),
}));
vi.mock('../../../api/sharedFetch', () => ({ fetchJson: (url: string, init: RequestInit) => api.run(url, init) }));
vi.mock('../../../api/files', () => ({ pickAnyFile: vi.fn() }));
vi.mock('../daf-run/QcReport', () => ({
  QcReport: (p: { payload: { qc: { overall?: { status?: string } } } }) => <div data-testid="qc-report">{p.payload.qc?.overall?.status}</div>,
  VerdictChip: (p: { label: string; status: string | null }) => <span data-testid="chip">{`${p.label}:${p.status}`}</span>,
}));
vi.mock('../daf-run/dafRunStore', () => ({ openDafRunDialog: api.dialog }));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const entry = (id: string, extra: Partial<LibraryEntry> = {}): LibraryEntry => ({
  id, kind: 'bam', path: `/scratch/${id}.bam`, folder: '/scratch', label: id,
  available: true, tags: [], notes: '', inspected: 1, chemistry: { key: 'dddb', declared: true }, ...extra,
});

const passFor = (id: string, status = 'PASS'): LibraryQcRunResult => ({
  success: true, available: true, entry_id: id, remembered: true, enzyme: 'dddb', reference: null,
  reference_note: 'Ran without a reference FASTA.', qc: { overall: { status } }, curves: null, plots: {},
});

describe('Run QC in the Library', () => {
  let container: HTMLDivElement;
  let root: Root;
  let changed: ReturnType<typeof vi.fn>;
  const pending = new Map<string, (value: LibraryQcRunResult) => void>();

  const render = async (e: LibraryEntry) => {
    await act(async () => root.render(
      <LibraryDetails entry={e} groups={[]} fiberhmmVersion="3.0.0"
        onOpen={() => {}} onChanged={changed} onAddToGroup={() => {}} />));
  };
  const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

  beforeEach(() => {
    resetLibraryQcRuns();
    pending.clear();
    changed = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    api.get.mockImplementation(async (id: string) => ({ entry: entry(id) }));
    api.run.mockImplementation((url: string) => {
      const id = decodeURIComponent(url.split('/')[4]);
      return new Promise(resolve => { pending.set(id, resolve); });
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.resetAllMocks();
  });

  it('runs fiberhmm-qc on the entry itself and shows the result in the QC section', async () => {
    await render(entry('A'));
    expect(container.textContent).not.toContain('QC a dataset');
    expect(container.textContent).not.toContain('Open it, then');
    const button = q('library-qc-run')!;
    expect(button.textContent).toBe('Run QC');
    await act(async () => button.click());
    expect(api.run).toHaveBeenCalledWith('/api/library/entries/A/qc/run', expect.objectContaining({ method: 'POST', body: '{}' }));
    expect(api.dialog).not.toHaveBeenCalled();
    expect(q('library-qc-run')!.textContent).toBe('Running QC…');
    expect(q('library-qc-progress')).not.toBeNull();

    await act(async () => pending.get('A')!(passFor('A')));
    expect(q('qc-report')!.textContent).toBe('PASS');
    expect(q('library-qc-run')).toBeNull();
    expect(q('library-qc-note')!.textContent).toContain('reference FASTA');
    expect(changed).toHaveBeenCalledTimes(1);  // the table's QC column refreshes
  });

  it("never shows A's result on B, and follows B's run when B is shown again", async () => {
    await render(entry('A'));
    await act(async () => q('library-qc-run')!.click());
    await render(entry('B'));
    expect(q('library-qc-run')!.textContent).toBe('Run QC');  // B is not running
    expect(q('library-qc-progress')).toBeNull();

    await act(async () => pending.get('A')!(passFor('A')));
    expect(q('qc-report')).toBeNull();
    expect(changed).toHaveBeenCalledTimes(1);  // the list still learns A's verdict

    // B's run, still in flight when B is shown again: followed, then shown on B (not on A).
    await act(async () => q('library-qc-run')!.click());
    await render(entry('A'));
    expect(q('library-qc-run')!.textContent).toBe('Run QC');
    await render(entry('B'));
    expect(q('library-qc-run')!.textContent).toBe('Running QC…');
    await act(async () => pending.get('B')!(passFor('B', 'FAIL')));
    expect(q('qc-report')!.textContent).toBe('FAIL');
    expect(changed).toHaveBeenCalledTimes(2);
    await render(entry('A'));
    expect(q('qc-report')).toBeNull();
  });

  it('shows errors inline, asks before downloading an online-only file, and explains a blocked entry', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await render(entry('A', { cloud_only: true }));
    await act(async () => q('library-qc-run')!.click());
    await act(async () => pending.get('A')!({
      success: false, available: false, needs_confirmation: true, entry_id: 'A',
      error: 'A.bam is online-only. Running QC downloads it.', qc: null, curves: null, plots: {},
    }));
    expect(confirm).toHaveBeenCalledWith('A.bam is online-only. Running QC downloads it.');
    expect(api.run).toHaveBeenLastCalledWith('/api/library/entries/A/qc/run', expect.objectContaining({ body: '{"confirm":true}' }));
    await act(async () => pending.get('A')!({
      success: false, available: false, entry_id: 'A', error: 'fiberhmm-qc failed: boom', qc: null, curves: null, plots: {},
    }));
    expect(q('library-qc-error')!.textContent).toBe('fiberhmm-qc failed: boom');
    expect(q('library-qc-run')!.textContent).toBe('Run QC');
    confirm.mockRestore();

    await render(entry('R', { remote: true, path: 'ssh://hpc/data/R.bam' }));
    expect(q('library-qc-error')).toBeNull();
    expect((q('library-qc-run') as HTMLButtonElement).disabled).toBe(true);
    expect(q('library-qc-blocked')!.textContent).toContain('cluster');
    await render(entry('M', { available: false }));
    expect(q('library-qc-blocked')!.textContent).toContain('Locate');
    await render(entry('T', { kind: 'bigbed' }));
    expect(q('library-qc-run')).toBeNull();
  });

  it("drops a shown report when the entry's file changes, and reads a newer one", async () => {
    const withQc = (status: string) => entry('A', { qc: { verdicts: { overall: status }, json: `/cache/${status}/A.qc.json` } });
    api.qc.mockResolvedValueOnce({ available: true, qc: { overall: { status: 'PASS' } }, curves: null, plots: {} });
    await render(withQc('PASS'));
    expect(q('qc-report')!.textContent).toBe('PASS');
    await render(entry('A', { changed: true }));  // the file changed: its remembered QC no longer applies
    expect(q('qc-report')).toBeNull();
    expect(q('library-qc-run')!.textContent).toBe('Run QC');
    api.qc.mockResolvedValueOnce({ available: true, qc: { overall: { status: 'WARN' } }, curves: null, plots: {} });
    await render(withQc('WARN'));  // a run finished elsewhere (the Library list now has it)
    expect(q('qc-report')!.textContent).toBe('WARN');
  });
});
