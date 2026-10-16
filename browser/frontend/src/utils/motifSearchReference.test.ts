import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchJasparMotifs } from '../api/tracks';
import { motifSearchReference } from './motifLoader';

const panel = (id: string, genome?: string) => ({ id, datasetId: `${id}-ds`, genome: genome ?? null, contentType: 'dataset' });

describe('JASPAR search ranks for the analysed panel reference', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends the panel reference, never the main genome name', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ available: true, results: [] }) }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    await searchJasparMotifs('CTCF', 'fasta:alt_abc');
    await searchJasparMotifs('CTCF', null);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/motifs/jaspar/search?q=CTCF&limit=12&panel_genome=fasta%3Aalt_abc');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/motifs/jaspar/search?q=CTCF&limit=12');
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('genome=hg38');
  });

  it('several panels on different references: the analysed one, else the one they share, else the main', () => {
    const panels = [panel('genomic'), panel('insert', 'fasta:alt_mm'), panel('fly', 'fasta:fly')];
    expect(motifSearchReference({ panels, selectedDatasets: new Set(['insert']) })).toBe('fasta:alt_mm');
    expect(motifSearchReference({ panels, selectedDatasets: new Set(['fly']) })).toBe('fasta:fly');
    expect(motifSearchReference({ panels, selectedDatasets: new Set() })).toBeNull();          // a mix: the main reference
    expect(motifSearchReference({ panels: [panels[1]], selectedDatasets: new Set() })).toBe('fasta:alt_mm');
    expect(motifSearchReference({ panels: [panels[0]], selectedDatasets: new Set() })).toBeNull();
    expect(motifSearchReference({ panels: [...panels, { id: 'chart', genome: 'x', contentType: 'chart' }], selectedDatasets: new Set(['insert', 'genomic']) })).toBeNull();
  });
});
