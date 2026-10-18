import '../testSetup';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { forgetRememberedState } from '../../hooks/useRememberedState';
import { resetPanelMemory } from '../panelMemory';
import { resetPreviewsForTests } from '../../utils/previewFeatures';
import { InsertionLensPanel } from './InsertionLensPanel';
import { setInsertionLensState } from './insertionLensTarget';
import type { InsertionLensTarget, LensResponse } from './insertionLensModel';
import { splitBySv } from '../../utils/svAlleleSplit';
import { identifyLens } from './IdentifyTab';
import { openAltAllelePanel } from '../altAllele/altAllelePanel';
import { downloadTextFile } from '../../utils/analysisExport';

vi.mock('../../components/tracks/read-track/ReadTrackCanvas', () => ({ drawReadTrack: vi.fn() }));
vi.mock('../../utils/analysisExport', async importOriginal => ({ ...await importOriginal<typeof import('../../utils/analysisExport')>(), downloadTextFile: vi.fn() }));
vi.mock('../../utils/svAlleleSplit', () => ({ splitBySv: vi.fn(async () => ({ label: 'test', counts: [1, 0, 0] })) }));
vi.mock('./IdentifyTab', () => ({ IdentifyTab: () => null, identifyLens: vi.fn(), lensIdentifyKey: () => '' }));
vi.mock('../altAllele/altAllelePanel', () => ({ openAltAllelePanel: vi.fn(async () => 'opened') }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const target = (datasetId: string, ref: number): InsertionLensTarget => ({
  datasetId, chrom: 'chr1', pos: ref, ref, len: 100, tolerance: 20, lenMin: 50, flank: 500,
});
const response = (ref: number): LensResponse => ({
  success: true, chrom: 'chr1', flank: 500,
  site: { pos: ref, tolerance: 20, len_min: 50, len_max: null },
  sv: { t: 'I', ref, len: 100, margin: 100 },
  cluster: { ref, len: 100, len_lo: 100, len_hi: 100, carriers: 1, reference: 0 },
  carriers: [], reference: [], excluded: { other_insert: 0, not_informative: 0 }, truncated: { carriers: 0, reference: 0 },
  consensus: { seq: 'ACGT', length: 4, n_reads: 1, seconds: 0 },
});

describe('lens actions belong to the current response identity', () => {
  let initial: ReturnType<typeof useBrowserStore.getState>;
  let container: HTMLDivElement;
  let root: Root;
  let pending: { url: URL; signal?: AbortSignal | null; resolve: (r: Response) => void; reject: (e: Error) => void }[];
  beforeEach(() => {
    initial = useBrowserStore.getState();
    resetPanelMemory();
    forgetRememberedState('insertion-lens');
    resetPreviewsForTests(true);
    vi.clearAllMocks();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
    pending = [];
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      pending.push({ url: new URL(url, 'http://x'), signal: init?.signal, resolve, reject });
    })));
    useBrowserStore.setState({
      chrom: 'chr1', start: 0, end: 10000, showDuplicateReads: false,
      datasets: [{ id: 'a', data_type: 'bam' }, { id: 'b', data_type: 'bam' }],
      panels: [
        { id: 'a', datasetId: 'a', contentType: 'dataset' },
        { id: 'b', datasetId: 'b', contentType: 'dataset' },
        { id: 'lens', contentType: 'insertion-lens', insertionLens: target('a', 1000) },
      ],
    } as any);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetPreviewsForTests(false);
    useBrowserStore.setState(initial, true);
  });
  const finish = async (index: number, ref: number) => {
    await act(async () => { pending[index].resolve(new Response(JSON.stringify(response(ref)))); });
  };
  const actions = () => container.querySelector('[data-testid="insertion-lens-split"]');

  it('makes old actions unavailable while another dataset loads and uses only its new coordinates', async () => {
    await act(async () => { root.render(<InsertionLensPanel />); });
    await finish(0, 1000);
    expect(actions()).not.toBeNull();
    await act(async () => { setInsertionLensState(target('b', 2000)); });
    expect(actions()).toBeNull();
    expect(container.querySelector('[data-testid="insertion-lens-identify"]')).toBeNull();
    expect(container.querySelector('[data-testid="insertion-lens-open-alt-allele"]')).toBeNull();
    expect(container.querySelector('[data-testid="insertion-lens-summary"]')).toBeNull();
    expect(pending[1].url.searchParams.get('dataset_id')).toBe('b');
    await finish(1, 2000);
    await act(async () => { (actions() as HTMLButtonElement).click(); });
    expect(splitBySv).toHaveBeenCalledWith(expect.objectContaining({ datasetId: 'b' }), { t: 'I', ref: 2000, len: 100 });
    await act(async () => { (container.querySelector('[data-testid="insertion-lens-identify"]') as HTMLButtonElement).click(); });
    expect(identifyLens).toHaveBeenCalledWith(expect.objectContaining({ sv: expect.objectContaining({ ref: 2000 }) }), 'b', expect.anything());
    await act(async () => { (container.querySelector('[data-analysis-tab="lens"]') as HTMLButtonElement).click(); });
    await act(async () => { (container.querySelector('[data-testid="insertion-lens-open-alt-allele"]') as HTMLButtonElement).click(); });
    expect(openAltAllelePanel).toHaveBeenCalledWith(expect.objectContaining({ datasetId: 'b', ref: 2000 }));
  });

  it('defaults to putative, excludes ambiguous, and forwards explicit evidence choices to splitting', async () => {
    await act(async () => { root.render(<InsertionLensPanel />); });
    await finish(0, 1000);
    const input = (label: string) => [...container.querySelectorAll('label')].find(l => l.textContent?.includes(label))!.querySelector('input')!;
    expect(input('Include putative').checked).toBe(true);
    expect(input('Include ambiguous').checked).toBe(false);
    expect(input('Include conflicting').checked).toBe(false);
    await act(async () => { (actions() as HTMLButtonElement).click(); });
    expect(splitBySv).toHaveBeenLastCalledWith(expect.objectContaining({ includePutative: true, includeAmbiguous: false }), expect.anything());
    act(() => { input('Include putative').click(); input('Include ambiguous').click(); input('Include conflicting').click(); });
    await act(async () => { (actions() as HTMLButtonElement).click(); });
    expect(splitBySv).toHaveBeenLastCalledWith(expect.objectContaining({ includePutative: false, includeAmbiguous: true, includeConflicting: true }), expect.anything());
  });

  it('invalidates response actions and export identity when conflict thresholds change', async () => {
    await act(async () => { root.render(<InsertionLensPanel />); });
    await finish(0, 1000);
    expect(actions()).not.toBeNull();
    await act(async () => { useBrowserStore.getState().setSvConflictOptions({ max_distance: 5000 }); });
    expect(actions()).toBeNull();
    expect(JSON.parse(pending[1].url.searchParams.get('conflict_options')!)).toMatchObject({ max_distance: 5000 });
    await finish(1, 1000);
    expect(actions()).not.toBeNull();
  });

  it('ignores late responses, including returning to the same dataset and target', async () => {
    await act(async () => { root.render(<InsertionLensPanel />); });
    await act(async () => { setInsertionLensState(target('b', 2000)); });
    await act(async () => { setInsertionLensState(target('a', 1000)); });
    await finish(0, 9999); // cancelled first request for A
    await finish(1, 8888); // cancelled B
    expect(actions()).toBeNull();
    await finish(2, 1000);
    expect(actions()).not.toBeNull();
    expect(container.textContent).not.toContain('9,999');
    expect(container.textContent).not.toContain('8,888');
  });

  it('invalidates actions on duplicate changes and leaves them unavailable on request failure', async () => {
    await act(async () => { root.render(<InsertionLensPanel />); });
    await finish(0, 1000);
    await act(async () => { useBrowserStore.setState({ showDuplicateReads: true }); });
    expect(actions()).toBeNull();
    expect(pending[1].url.searchParams.get('include_duplicates')).toBe('true');
    await act(async () => { pending[1].reject(new Error('injected load failure')); });
    expect(actions()).toBeNull();
    expect(container.textContent).toContain('injected load failure');
  });

  it('discards a sequence export if its originating response has been replaced', async () => {
    await act(async () => { root.render(<InsertionLensPanel />); });
    await finish(0, 1000);
    const button = [...container.querySelectorAll('button')].find(b => b.textContent === 'All inserts FASTA')!;
    await act(async () => { button.click(); });
    expect(pending[1].url.searchParams.get('dataset_id')).toBe('a');
    expect(pending[1].url.searchParams.get('ref')).toBe('1000');
    await act(async () => { setInsertionLensState(target('b', 2000)); });
    expect(pending[1].signal?.aborted).toBe(true);
    await finish(2, 2000);
    await finish(1, 1000);
    expect(downloadTextFile).not.toHaveBeenCalled();
  });

  it('invalidates a loaded response on seek, clear and a dataset revision', async () => {
    await act(async () => { root.render(<InsertionLensPanel />); });
    await finish(0, 1000);
    await act(async () => { useBrowserStore.setState(s => ({ refreshGeneration: s.refreshGeneration + 1 })); });
    expect(actions()).toBeNull();
    await finish(1, 1000);
    await act(async () => { setInsertionLensState({ datasetId: 'b', chrom: 'chr1', pos: 2000, seek: true }); });
    expect(actions()).toBeNull();
    await act(async () => { setInsertionLensState(null); });
    await finish(2, 2000); // ignored seek response
    expect(actions()).toBeNull();
  });
});
