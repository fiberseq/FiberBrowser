// Downloads have no size cap but a warning size (3.1.0): the size is shown, and a download over the warning
// size asks first (the wizard and /api/load_genome).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatDownloadSize, largeDownloadQuestion } from './downloadSize';
import { genomeDownloadText } from './dafRun';
import { loadGenome } from '../api/reference';
import { getGenomeDownloadSize, startGenomeDownload } from '../api/pipeline';

afterEach(() => vi.unstubAllGlobals());

function stubFetch(...bodies: unknown[]) {
  const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(
    JSON.stringify(bodies.length > 1 ? bodies.shift() : bodies[0]), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const NEEDS = { success: false, genome_id: 'big', name: 'Big genome', needs_confirmation: true,
  download: { url: 'https://mirror.example/big.fa', bytes: 5_200_000_000, threshold: 4_000_000_000 } };

describe('download size warning', () => {
  it('formats decimal sizes and asks with the size and the threshold', () => {
    expect(formatDownloadSize(999)).toBe('999 bytes');
    expect(formatDownloadSize(8006)).toBe('8.0 KB');
    expect(formatDownloadSize(3_209_286_105)).toBe('3.2 GB');
    expect(largeDownloadQuestion('Big genome', NEEDS.download))
      .toBe('Big genome is 5.2 GB to download from mirror.example, over the 4.0 GB download warning size (Settings → App). Download it?');
  });

  it('the wizard line for a download waiting for confirmation', () => {
    expect(genomeDownloadText({ genome_id: 'big', name: 'Big', state: 'confirm', total: 5e9, threshold: 4e9, url: null }))
      .toEqual({ kind: 'confirm', text: 'Big is 5.0 GB to download, over the 4.0 GB download warning size (Settings → App). Download it?' });
  });

  it('the wizard asks for the size and starts a confirmed download', async () => {
    const fetchMock = stubFetch({ genome_id: 'big', url: null, bytes: 5e9, threshold: 4e9, over: true });
    await getGenomeDownloadSize('big');
    await startGenomeDownload('big');
    await startGenomeDownload('big', true);
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls[0]).toBe('/api/pipeline/genome_download/size?genome_id=big');
    expect(urls[1]).toBe('/api/pipeline/genome_download?genome_id=big');
    expect(urls[2]).toBe('/api/pipeline/genome_download?genome_id=big&confirm_large=true');
  });

  it('loadGenome asks before a large download and retries confirmed', async () => {
    const fetchMock = stubFetch(NEEDS, { success: true, genome_id: 'big', name: 'Big genome', fasta_loaded: true });
    const confirm = vi.fn(() => true);
    const res = await loadGenome('big', { confirm });
    expect(confirm).toHaveBeenCalledWith('Big genome', NEEDS.download);
    expect(res.success).toBe(true);
    expect(String(fetchMock.mock.calls[1][0])).toBe('/api/load_genome?genome_id=big&confirm_large=true');
  });

  it('loadGenome declined changes nothing and says why', async () => {
    const fetchMock = stubFetch(NEEDS);
    const res = await loadGenome('big', { confirm: () => false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.success).toBe(false);
    expect(res.fasta_error).toBe('Not downloaded: 5.2 GB is over the download warning size');
  });

  it('loadGenome declined for the annotation keeps the loaded sequence', async () => {
    const gtfNeeds = { ...NEEDS, success: true, fasta_loaded: true,
      download: { url: 'https://mirror.example/big.gtf', bytes: 5_200_000_000, threshold: 4_000_000_000 } };
    stubFetch(gtfNeeds);
    const res = await loadGenome('big', { confirm: () => false });
    expect(res.success).toBe(true);
    expect(res.fasta_error).toBeUndefined();
    expect(res.gtf_error).toBe('Not downloaded: 5.2 GB is over the download warning size');
  });

  it('loadGenome under the threshold asks nothing', async () => {
    const fetchMock = stubFetch({ success: true, genome_id: 'dm6', name: 'dm6', fasta_loaded: true });
    const confirm = vi.fn(() => true);
    expect((await loadGenome('dm6', { confirm })).success).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
