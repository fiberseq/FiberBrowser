import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  declareGenome,
  getChromosomes,
  getGenes,
  getSequence,
  getSequenceChunked,
  loadFasta,
  loadGenome,
  loadGtf,
  loadPlasmid,
  loadPlasmids,
  removeGtf,
  searchGene,
  setCircularChrom,
} from './reference';

describe('reference API client', () => {
  it('serializes reference read endpoints and forwards abort signals', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ chroms: [], genes: [], sequence: 'ACGT', found: false }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    await getChromosomes();
    await getGenes('chr2R', 100, 200, { signal: controller.signal });
    await searchGene('eve', { signal: controller.signal });
    await getSequence('chr2R', 100, 104);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const chromUrl = new URL(String(fetchMock.mock.calls[0][0]), 'http://fiberbrowser.test');
    expect(chromUrl.pathname).toBe('/api/chroms');
    expect(chromUrl.searchParams.get('_t')).toMatch(/^\d+$/);
    expect(fetchMock.mock.calls[1][0]).toBe('/api/genes?chrom=chr2R&start=100&end=200');
    expect(fetchMock.mock.calls[1][1]?.signal).toBe(controller.signal);
    expect(fetchMock.mock.calls[2][0]).toBe('/api/gene_search?query=eve');
    expect(fetchMock.mock.calls[2][1]?.signal).toBe(controller.signal);
    expect(fetchMock.mock.calls[3][0]).toBe('/api/sequence?chrom=chr2R&start=100&end=104');
  });

  it('scopes annotation and circular edits to the requested reference', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({ ok: true, json: async () => ({ success: true }) }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    await loadGtf('/tmp/genes & features.gtf', 'fasta:ring');
    await setCircularChrom('ring', true, 'fasta:ring');
    await setCircularChrom('chr1', false);
    const urls = fetchMock.mock.calls.map(call => new URL(String(call[0]), 'http://fiberbrowser.test'));
    expect(urls[0].searchParams.get('path')).toBe('/tmp/genes & features.gtf');
    expect(urls[0].searchParams.get('panel_genome')).toBe('fasta:ring');
    expect(urls[1].searchParams.get('panel_genome')).toBe('fasta:ring');
    expect(urls[1].searchParams.get('circular')).toBe('true');
    expect(urls[2].searchParams.has('panel_genome')).toBe(false);
  });

  it('serializes reference load and removal endpoints', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ success: true }),
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    await loadFasta('/tmp/ref dm6.fa');
    await loadGtf('/tmp/ref dm6.gtf');
    await removeGtf();
    await loadGenome('dm6');
    await loadPlasmid('/tmp/plasmid.gbk');
    await loadPlasmids(['/tmp/a.gbk', '/tmp/b.gbk']);

    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/load_fasta?path=%2Ftmp%2Fref%20dm6.fa');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', credentials: 'include' });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/load_gtf?path=%2Ftmp%2Fref+dm6.gtf');
    expect(fetchMock.mock.calls[2][0]).toBe('/api/gtf');
    expect(fetchMock.mock.calls[2][1]).toMatchObject({ method: 'DELETE', credentials: 'include' });
    expect(fetchMock.mock.calls[3][0]).toBe('/api/load_genome?genome_id=dm6');
    expect(fetchMock.mock.calls[4][0]).toBe('/api/load_plasmid?path=%2Ftmp%2Fplasmid.gbk');
    expect(fetchMock.mock.calls[5][0]).toBe('/api/load_plasmids');
    expect(fetchMock.mock.calls[5][1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ paths: ['/tmp/a.gbk', '/tmp/b.gbk'] }),
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('declareGenome', () => {
  it('posts the genome for the main FASTA or a panel reference, and null to clear it', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    await declareGenome('hg38');
    await declareGenome(null, 'fasta:alt_abc');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/reference/declare_genome');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', body: JSON.stringify({ genome: 'hg38' }) });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/reference/declare_genome?panel_genome=fasta%3Aalt_abc');
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ body: JSON.stringify({ genome: null }) });
  });

  it('a declaration announces itself to every view (the shared reference revision), a refused one does not', async () => {
    const { useBrowserStore } = await import('../stores/browserStore');
    const rev = () => useBrowserStore.getState().referenceRevision;
    const start = rev();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ success: true, revision: 1 }) }) as Response));
    await declareGenome('hg38');
    await declareGenome('hg19');
    await declareGenome(null);
    expect(rev()).toBe(start + 3);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ success: false, error: 'Load a FASTA first' }) }) as Response));
    await declareGenome('hg38');
    expect(rev()).toBe(start + 3);
  });
});

describe('getSequenceChunked', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('fetches a region longer than one request in pieces, and stops at the contig end', async () => {
    const calls: Array<[number, number]> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      const u = new URL(String(url), 'http://fiberbrowser.test');
      const start = Number(u.searchParams.get('start'));
      const end = Math.min(Number(u.searchParams.get('end')), 25_000);  // a 25 kb contig
      calls.push([start, end]);
      return { ok: true, json: async () => ({ sequence: 'A'.repeat(Math.max(0, end - start)) }) } as Response;
    }));
    expect((await getSequenceChunked('chr1', 0, 20_000)).length).toBe(20_000);
    expect(calls).toEqual([[0, 10_000], [10_000, 20_000]]);
    calls.length = 0;
    expect((await getSequenceChunked('chr1', 12_000, 40_000)).length).toBe(13_000);
    expect(calls.length).toBe(2);
  });
});
