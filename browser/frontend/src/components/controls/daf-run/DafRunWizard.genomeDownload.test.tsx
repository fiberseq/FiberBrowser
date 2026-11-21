/**
 * New DAF-seq run wizard: Download for a catalog genome. The owner's report:
 * the button showed as pressed for a moment, then nothing happened and Next
 * stayed blocked. Download now runs the cache-only download
 * (/api/pipeline/genome_download), shows its progress, says which mirror
 * failed and why (Retry, or use a FASTA file), and Next works once it is done.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { genomeDownloadText, hintText, initialWizardState } from '../../../utils/dafRun';

const api = vi.hoisted(() => {
  const state = { downloaded: false };
  return {
    state,
    getPipelineStatus: vi.fn(async () => ({
      available: true, aligner: { ok: true }, cores: 8, default_cores: 2, current_genome: 'dm6',
      genomes: [{ id: 'dm6', name: 'D. melanogaster (dm6)', downloaded: state.downloaded, loaded: false,
        fasta: state.downloaded ? '/data/genomes/dm6.fa' : null }],
      output_parent: '/tmp/runs', default_options: {}, loaded_references: [],
    })),
    startGenomeDownload: vi.fn(),
    getGenomeDownload: vi.fn(),
    cancelGenomeDownload: vi.fn(async () => ({ genome_id: 'dm6', state: 'cancelled' })),
    getGenomeDownloadSize: vi.fn(),
  };
});
vi.mock('../../../api/status', () => ({ getStatus: vi.fn(async () => ({ public_mode: false, has_gtf: false, gene_count: 0, track_count: 0 })) }));
vi.mock('../../../api/pipeline', () => ({
  getPipelineStatus: api.getPipelineStatus,
  startGenomeDownload: api.startGenomeDownload,
  getGenomeDownload: api.getGenomeDownload,
  cancelGenomeDownload: api.cancelGenomeDownload,
  getGenomeDownloadSize: api.getGenomeDownloadSize,
  scanReads: vi.fn(async () => ({
    success: true,
    samples: [{ key: 'k', name: 'embryo', order: null, barcode: null, size: 123, files: [{ path: '/tmp/embryo.fastq', size: 123 }], kinds: ['fastq'] }],
    warnings: [],
  })),
  listJobs: vi.fn(async () => ({ jobs: [] })), getJob: vi.fn(), submitRun: vi.fn(),
  validateRun: vi.fn(async () => ({ ok: true, errors: [], warnings: [], jobs: [] })), runDatasetQc: vi.fn(),
}));
vi.mock('../../../api/files', () => ({
  pickAnyFile: vi.fn(async () => ({ success: true, paths: ['/tmp/embryo.fastq'] })),
  pickFolder: vi.fn(), pickFile: vi.fn(), pickDataset: vi.fn(), uploadFile: vi.fn(),
}));

import { DafRunHost } from './DafRunHost';
import { useDafRunStore } from './dafRunStore';
import { useBrowserStore } from '../../../stores/browserStore';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const MB = 1024 * 1024;
const IGV = 'https://s3.amazonaws.com/igv.broadinstitute.org/genomes/seq/dm6/dm6.fa';
const UCSC = 'https://hgdownload.soe.ucsc.edu/goldenPath/dm6/bigZips/dm6.fa';

describe('run wizard: genome download', () => {
  let box: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    api.state.downloaded = false;
    api.startGenomeDownload.mockReset();
    api.getGenomeDownload.mockReset();
    api.getGenomeDownload.mockResolvedValue({ genome_id: 'dm6', state: 'idle' });
    api.cancelGenomeDownload.mockClear();
    api.getGenomeDownloadSize.mockReset();
    api.getGenomeDownloadSize.mockResolvedValue({ genome_id: 'dm6', url: IGV, bytes: null, threshold: 4e9, over: false });
    box = document.createElement('div');
    document.body.appendChild(box);
    root = createRoot(box);
    useBrowserStore.setState({ publicMode: false });
    useDafRunStore.setState({ open: true, tab: 'new', jobs: [], draft: null, draftSeeded: false });
  });

  afterEach(() => {
    act(() => root.unmount());
    box.remove();
  });

  const q = (testId: string) => box.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
  const click = async (testId: string) => {
    const el = q(testId);
    expect(el, testId).toBeTruthy();
    await act(async () => { el!.click(); });
  };
  const wait = (ms: number) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
  const toReference = async () => {
    await act(async () => root.render(<DafRunHost />));
    await click('daf-run-choose-files');
    await click('daf-run-next');
    expect((q('daf-run-genome-select') as HTMLSelectElement).value).toBe('dm6');
  };

  it('shows progress, then the genome is ready and Next goes on', async () => {
    api.startGenomeDownload.mockResolvedValue({ genome_id: 'dm6', name: 'D. melanogaster (dm6)', state: 'running', url: IGV, bytes: 0, total: 0 });
    api.getGenomeDownload
      .mockResolvedValueOnce({ genome_id: 'dm6', state: 'idle' })   // choosing the genome: nothing under way
      .mockResolvedValueOnce({ genome_id: 'dm6', name: 'D. melanogaster (dm6)', state: 'running', url: IGV, bytes: 70 * MB, total: 140 * MB })
      .mockImplementation(async () => {
        api.state.downloaded = true;
        return { genome_id: 'dm6', name: 'D. melanogaster (dm6)', state: 'done', fasta: '/data/genomes/dm6.fa' };
      });
    await toReference();
    await click('daf-run-download-genome');
    expect(api.startGenomeDownload).toHaveBeenCalledWith('dm6');
    expect(q('daf-run-download-genome')!.textContent).toBe('Downloading…');
    expect(q('daf-run-genome-progress')!.textContent).toContain('Starting the D. melanogaster (dm6) download from s3.amazonaws.com');
    expect(q('daf-run-genome-cancel')).not.toBeNull();
    await wait(1100);
    expect(q('daf-run-genome-progress')!.textContent).toContain('70 MB of 140 MB (50%)');
    await wait(1100);
    expect(q('daf-run-download-genome')).toBeNull();
    expect(q('daf-run-genome-fasta')!.textContent).toContain('/data/genomes/dm6.fa');
    await click('daf-run-next');
    expect(q('daf-run-enzyme-dddb')).not.toBeNull();
  }, 10_000);

  it('a failed download says which mirror failed and why, with Retry and Use a FASTA file', async () => {
    api.startGenomeDownload.mockResolvedValue({
      genome_id: 'dm6', name: 'D. melanogaster (dm6)', state: 'error', error: 'Could not download D. melanogaster (dm6).',
      errors: [{ url: IGV, error: 'HTTP 403 Forbidden' }, { url: UCSC, error: 'could not reach the server (timed out)' }],
    });
    await toReference();
    await click('daf-run-download-genome');
    const err = q('daf-run-genome-error')!;
    expect(err.textContent).toContain('Could not download D. melanogaster (dm6). Tried:');
    expect(err.textContent).toContain(`${IGV}: HTTP 403 Forbidden`);
    expect(err.textContent).toContain(`${UCSC}: could not reach the server (timed out)`);
    expect(q('daf-run-download-genome')!.textContent).toBe('Download dm6');
    await click('daf-run-genome-retry');
    expect(api.startGenomeDownload).toHaveBeenCalledTimes(2);
    await click('daf-run-genome-use-file');
    expect(q('daf-run-reference-path')).not.toBeNull();
  });

  it('a request that fails outright is shown, not swallowed', async () => {
    api.startGenomeDownload.mockRejectedValue(new Error('HTTP 500'));
    await toReference();
    await click('daf-run-download-genome');
    expect(q('daf-run-genome-error')!.textContent).toContain('Could not start the dm6 download: HTTP 500');
  });

  it('Cancel asks the server to stop', async () => {
    api.startGenomeDownload.mockResolvedValue({ genome_id: 'dm6', state: 'running', url: IGV, bytes: MB, total: 140 * MB });
    api.getGenomeDownload
      .mockResolvedValueOnce({ genome_id: 'dm6', state: 'idle' })
      .mockResolvedValue({ genome_id: 'dm6', state: 'cancelled' });
    await toReference();
    await click('daf-run-download-genome');
    await click('daf-run-genome-cancel');
    expect(api.cancelGenomeDownload).toHaveBeenCalledWith('dm6');
    await wait(1100);
    expect(q('daf-run-genome-cancelled')!.textContent).toBe('Download cancelled.');
    expect(q('daf-run-download-genome')!.textContent).toBe('Download dm6');
  });

  it('Cancel says Cancelling at once (decompressing or indexing may finish first)', async () => {
    api.startGenomeDownload.mockResolvedValue({ genome_id: 'dm6', state: 'running', url: IGV, bytes: 140 * MB, total: 140 * MB, stage: 'indexing' });
    api.getGenomeDownload.mockResolvedValueOnce({ genome_id: 'dm6', state: 'idle' })
      .mockResolvedValue({ genome_id: 'dm6', state: 'running', bytes: 140 * MB, total: 140 * MB, stage: 'indexing', cancelling: true });
    let release!: () => void;
    api.cancelGenomeDownload.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ genome_id: 'dm6', state: 'running' }); }));
    await toReference();
    await click('daf-run-download-genome');
    expect(q('daf-run-genome-progress')!.textContent).toContain('Indexing');
    await click('daf-run-genome-cancel');
    expect(q('daf-run-genome-cancel')!.textContent).toBe('Cancelling…');
    expect((q('daf-run-genome-cancel') as HTMLButtonElement).disabled).toBe(true);
    expect(q('daf-run-genome-progress')!.textContent).toContain('Cancelling the');
    await act(async () => { release(); });
  });

  it('the button shows the download size; over the warning size it asks first', async () => {
    api.getGenomeDownloadSize.mockResolvedValue({ genome_id: 'dm6', url: IGV, bytes: 5_200_000_000, threshold: 4e9, over: true });
    api.startGenomeDownload.mockResolvedValue({ genome_id: 'dm6', state: 'running', url: IGV, bytes: 0, total: 0 });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    try {
      await toReference();
      await wait(0);
      expect(q('daf-run-download-genome')!.textContent).toBe('Download dm6 (5.2 GB)');
      await click('daf-run-download-genome');
      expect(confirm.mock.calls[0][0]).toContain('is 5.2 GB to download from s3.amazonaws.com, over the 4.0 GB download warning size');
      expect(api.startGenomeDownload).not.toHaveBeenCalled();   // declined: nothing starts
      await click('daf-run-download-genome');
      expect(api.startGenomeDownload).toHaveBeenCalledWith('dm6', true);
    } finally {
      confirm.mockRestore();
    }
  });

  it('a download the server holds for confirmation shows its size and Download goes ahead', async () => {
    api.startGenomeDownload
      .mockResolvedValueOnce({ genome_id: 'dm6', name: 'D. melanogaster (dm6)', state: 'confirm', url: IGV, total: 5e9, threshold: 4e9 })
      .mockResolvedValueOnce({ genome_id: 'dm6', state: 'running', url: IGV, bytes: 0, total: 0,
        warning: 'Large download: 5.0 GB (over the 4.0 GB download warning size) from ' + IGV });
    await toReference();
    await click('daf-run-download-genome');
    expect(q('daf-run-genome-confirm')!.textContent).toContain('D. melanogaster (dm6) is 5.0 GB to download');
    await click('daf-run-genome-confirm-download');
    expect(api.startGenomeDownload).toHaveBeenLastCalledWith('dm6', true);
    expect(q('daf-run-genome-warning')!.textContent).toContain('Large download: 5.0 GB');
  });

  it('closing the wizard while Download is being started never polls afterwards', async () => {
    let resolveStart!: (v: unknown) => void;
    api.startGenomeDownload.mockImplementation(() => new Promise(resolve => { resolveStart = resolve; }));
    await toReference();
    await click('daf-run-download-genome');
    const polls = api.getGenomeDownload.mock.calls.length;
    act(() => root.unmount());
    root = createRoot(box);
    await act(async () => { resolveStart({ genome_id: 'dm6', state: 'running', url: IGV, bytes: 0, total: 140 * MB }); });
    await wait(1300);
    expect(api.getGenomeDownload.mock.calls.length).toBe(polls);
  });
});

describe('genome download text', () => {
  it('reads progress with and without a known size', () => {
    expect(genomeDownloadText({ genome_id: 'hg38', state: 'running', url: 'https://igv.org/x', bytes: 512 * MB, total: 1024 * MB }).text)
      .toBe('Downloading hg38 from igv.org: 512 MB of 1.0 GB (50%)');
    expect(genomeDownloadText({ genome_id: 'hg38', state: 'running', bytes: 3 * MB, total: 0 }).text).toBe('Downloading hg38: 3.0 MB');
    expect(genomeDownloadText({ genome_id: 'hg38', state: 'done' }).kind).toBe('none');
  });

  it('a size the bytes outgrew is not shown as "of"; stages and cancelling read as such', () => {
    expect(genomeDownloadText({ genome_id: 'hg38', state: 'running', bytes: 140 * MB, total: 42 * MB }).text).toBe('Downloading hg38: 140 MB');
    expect(genomeDownloadText({ genome_id: 'hg38', state: 'running', bytes: 42 * MB, total: 42 * MB, stage: 'indexing' }).text).toBe('Indexing hg38…');
    expect(genomeDownloadText({ genome_id: 'hg38', state: 'running', stage: 'decompressing' }).text).toBe('Decompressing hg38…');
    expect(genomeDownloadText({ genome_id: 'hg38', state: 'running', bytes: MB, total: 42 * MB, cancelling: true }).text).toBe('Cancelling the hg38 download…');
  });

  it('one FASTA file open in the browser (no catalog genome) seeds the reference path', () => {
    const base = { default_cores: 2, current_genome: null, genomes: [] };
    const one = initialWizardState({ ...base, loaded_references: [{ kind: 'file', path: '/data/own.fa', label: 'own.fa' }] });
    expect(one.referenceMode).toBe('file');
    expect(one.referencePath).toBe('/data/own.fa');
    const two = initialWizardState({ ...base, loaded_references: [
      { kind: 'file', path: '/a.fa', label: 'a' }, { kind: 'file', path: '/b.fa', label: 'b' }] });
    expect(two.referencePath).toBe('');
  });

  it('a failure without per-mirror errors keeps the server message', () => {
    expect(genomeDownloadText({ genome_id: 'dm6', state: 'error', error: 'Could not download dm6: index failed', errors: [] }))
      .toEqual({ kind: 'error', text: 'Could not download dm6: index failed' });
  });

  it('machine hint tokens are not prose', () => {
    expect(hintText('download_genome')).toBe('');
    expect(hintText('Run samtools faidx on it.')).toBe('Run samtools faidx on it.');
    expect(hintText(undefined)).toBe('');
  });
});
