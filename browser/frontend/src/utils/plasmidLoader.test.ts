import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../plugins';  // the built-in panels (Regions)
import { useBrowserStore } from '../stores/browserStore';
import type { Dataset, PlasmidLink, PlasmidProblem } from '../types';
import {
  classifyPlasmidDatasetPaths,
  installPlasmidLinkWatcher,
  openPlasmidDatasetFiles,
  plasmidLinkSummary,
  plasmidProblemsMessage,
  resetPlasmidLinkWatcherForTests,
} from './plasmidLoader';

const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

const ROTATED: PlasmidLink = {
  dataset_id: 'EF34GH', dataset_label: 'EF34GH', contig: 'D_orirot', chrom: 'D', map_chrom: 'D',
  offset: 295, method: 'reference', verified: true,
};
const RENAMED: PlasmidLink = {
  dataset_id: 'IJ56KL', dataset_label: 'IJ56KL', contig: 't', chrom: 'QR90ST_1_t', map_chrom: 'QR90ST_1_t',
  offset: 0, method: 'reads', verified: true,
};
const LENGTH: PlasmidProblem = {
  kind: 'length', dataset_id: 'AB12CD', dataset_label: 'AB12CD', can_confirm: false,
  message: 'No contig of AB12CD.bam is a loaded plasmid map: its contigs are pA_orirot (10,715 bp); the maps are pA (12,179 bp).',
};
const UNVERIFIED: PlasmidProblem = {
  kind: 'unverified', dataset_id: 'X', contig: 'x', chrom: 'D', can_confirm: true, suggested_offset: 0,
  message: 'x has the same length as map D (11,408 bp), but no M5 checksum, reference FASTA or MD tags to check its sequence.',
};

function dataset(id: string, plasmid?: Dataset['plasmid']): Dataset {
  return { id, label: id, path: `/data/${id}.bam`, color: '#000', data_type: 'bam', ...(plasmid ? { plasmid } : {}) };
}

function routeFetch(routes: Record<string, unknown>) {
  const fetchMock = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
    const path = new URL(String(url), 'http://fiberbrowser.test').pathname;
    if (!(path in routes)) throw new Error(`unexpected ${path}`);
    return jsonResponse(routes[path]);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  resetPlasmidLinkWatcherForTests();
  useBrowserStore.setState({ datasets: [], chroms: [], chrom: 'chr2L', start: 0, end: 1000, error: null } as never);
});
afterEach(() => vi.unstubAllGlobals());

describe('plasmid dataset files', () => {
  it('sorts a multi-file pick into map, BAMs and reference FASTA', () => {
    expect(classifyPlasmidDatasetPaths([
      '/r/MN78OP_2_D.gbk', '/d/EF34GH.fiberhmm.dddb.bam', '/r/MN78OP_2_D_orirot.fasta', '/d/other.BAM', '/d/notes.md', '/r/x.fa.gz',
    ])).toEqual({
      maps: ['/r/MN78OP_2_D.gbk'],
      bams: ['/d/EF34GH.fiberhmm.dddb.bam', '/d/other.BAM'],
      fastas: ['/r/MN78OP_2_D_orirot.fasta', '/r/x.fa.gz'],
      other: ['/d/notes.md'],
    });
  });

  it('describes links and problems in words', () => {
    expect(plasmidLinkSummary(ROTATED)).toBe('EF34GH: D_orirot → D (origin shifted 295 bp; checked against its reference FASTA)');
    expect(plasmidLinkSummary({ ...RENAMED, contig: 'QR90ST_1_t' })).toBe('IJ56KL: QR90ST_1_t (checked with its reads)');
    expect(plasmidProblemsMessage([])).toBeNull();
    const message = plasmidProblemsMessage([LENGTH, LENGTH, UNVERIFIED])!;
    expect(message.split('\n')[0]).toBe(`AB12CD: ${LENGTH.message}`);
    expect(message.split('\n')).toHaveLength(3);  // duplicates once, then the Link-anyway hint
    expect(message).toContain('Link anyway');
  });
});

describe('openPlasmidDatasetFiles', () => {
  it('adds the datasets, lists the map and opens the reads on it', async () => {
    const fetchMock = routeFetch({
      '/api/plasmid/open': {
        success: true, chrom: 'D', plasmid: { success: true, name: 'D', length: 11408 },
        datasets: [dataset('EF34GH', { links: [ROTATED] })], links: [ROTATED], problems: [], errors: [],
      },
      '/api/chroms': { chroms: [{ name: 'D', size: 11408, circular: true, plasmid: true }] },
    });

    const result = await openPlasmidDatasetFiles('/r/MN78OP_2_D.gbk', ['/d/EF34GH.bam'], '/r/D_orirot.fasta');

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).toEqual({ map_path: '/r/MN78OP_2_D.gbk', bam_paths: ['/d/EF34GH.bam'], reference_fasta: '/r/D_orirot.fasta' });
    expect(result.success).toBe(true);
    const st = useBrowserStore.getState();
    expect(st.datasets.map(d => d.id)).toEqual(['EF34GH']);
    expect(st.chroms.map(c => c.name)).toEqual(['D']);
    expect(st.hasFasta).toBe(true);
    expect([st.chrom, st.start]).toEqual(['D', 0]);
    expect(st.panels.some(p => p.contentType === 'circular-genome')).toBe(true);
    expect(st.error).toBeNull();
  });

  it('says what differs when a BAM is not the map', async () => {
    routeFetch({
      '/api/plasmid/open': {
        success: true, chrom: 'pA', plasmid: { success: true, name: 'pA', length: 12179 },
        datasets: [dataset('AB12CD', { problems: [LENGTH] })], links: [], problems: [LENGTH], errors: [],
      },
      '/api/chroms': { chroms: [{ name: 'pA', size: 12179, circular: true, plasmid: true }] },
    });

    const result = await openPlasmidDatasetFiles('/r/pA.dna', ['/d/AB12CD.bam']);

    expect(result.problems).toEqual([LENGTH]);
    expect(useBrowserStore.getState().error).toContain('10,715 bp');
    expect(useBrowserStore.getState().error).toContain('12,179 bp');
  });
});

describe('installPlasmidLinkWatcher', () => {
  it('refreshes the chromosomes and moves to the map when a loaded BAM was linked', async () => {
    // BAM-first: the view is on the BAM's own contig, which becomes the map.
    useBrowserStore.setState({ chrom: 'D_orirot', chroms: [{ name: 'D_orirot', size: 11408 }] } as never);
    const fetchMock = routeFetch({ '/api/chroms': { chroms: [{ name: 'D', size: 11408, circular: true, plasmid: true }] } });
    const unsubscribe = installPlasmidLinkWatcher();
    const before = useBrowserStore.getState().refreshGeneration;

    useBrowserStore.setState({ datasets: [dataset('EF34GH', { links: [ROTATED] })] } as never);
    await vi.waitFor(() => expect(useBrowserStore.getState().chrom).toBe('D'));

    expect(fetchMock).toHaveBeenCalled();
    expect(useBrowserStore.getState().refreshGeneration).toBeGreaterThan(before);
    // A dataset is handled once.
    fetchMock.mockClear();
    useBrowserStore.setState({ datasets: [...useBrowserStore.getState().datasets, dataset('plain')] } as never);
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
    // Removed and loaded again (same id): handled again.
    useBrowserStore.setState({ datasets: [] } as never);
    useBrowserStore.setState({ datasets: [dataset('EF34GH', { links: [ROTATED] })] } as never);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    unsubscribe();
  });

  it('shows why a plasmid BAM did not match', async () => {
    routeFetch({});
    const unsubscribe = installPlasmidLinkWatcher();
    useBrowserStore.setState({ datasets: [dataset('AB12CD', { problems: [LENGTH] })] } as never);
    await vi.waitFor(() => expect(useBrowserStore.getState().error).toContain('AB12CD: No contig'));
    unsubscribe();
  });
});
