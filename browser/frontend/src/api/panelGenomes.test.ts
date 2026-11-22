import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachPanelGenome } from './panelGenomes';

// 3.1.1 deferred MED: a panel genome's download over the warning size asks first and retries confirmed,
// as loadGenome does (the attach flow had no confirmation, so such an annotation never loaded).
const DOWNLOAD = { url: 'https://hgdownload.example/dm6.gtf.gz', bytes: 5_200_000_000, threshold: 4_000_000_000 };
const PENDING_GENOME = { key: 'dm6', label: 'dm6', kind: 'registry', genome_id: 'dm6', has_fasta: true, has_gtf: false,
  annotation_pending: DOWNLOAD, chroms: [] };

function server(answers: unknown[]) {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')));
    return { ok: true, json: async () => answers[Math.min(bodies.length - 1, answers.length - 1)] } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, bodies };
}

afterEach(() => vi.unstubAllGlobals());

describe('attachPanelGenome: downloads over the warning size', () => {
  it('asks, then retries confirmed and returns the completed reference', async () => {
    const done = { success: true, genome: { ...PENDING_GENOME, has_gtf: true, annotation_pending: null } };
    const { bodies } = server([{ success: true, needs_confirmation: true, name: 'D. melanogaster (dm6)',
      download: DOWNLOAD, genome: PENDING_GENOME }, done]);
    const confirm = vi.fn(() => true);
    const res = await attachPanelGenome({ dataset_ids: ['ds'], genome_id: 'dm6' }, { confirm });
    expect(confirm).toHaveBeenCalledWith('D. melanogaster (dm6)', DOWNLOAD);
    expect(bodies).toHaveLength(2);
    expect(bodies[0].confirm_large).toBeUndefined();
    expect(bodies[1]).toMatchObject({ dataset_ids: ['ds'], genome_id: 'dm6', confirm_large: true });
    expect(res.genome?.has_gtf).toBe(true);
  });

  it('declined: the sequence stays attached without genes, or nothing is attached for the FASTA', async () => {
    server([{ success: true, needs_confirmation: true, name: 'dm6', download: DOWNLOAD, genome: PENDING_GENOME }]);
    const annotation = await attachPanelGenome({ dataset_ids: ['ds'], genome_id: 'dm6' }, { confirm: () => false });
    expect(annotation.success).toBe(true);
    expect(annotation.needs_confirmation).toBe(false);
    expect(annotation.annotation_error).toContain('over the download warning size');

    const { bodies } = server([{ success: false, needs_confirmation: true, name: 'dm6', download: DOWNLOAD, genome: null }]);
    const fasta = await attachPanelGenome({ dataset_ids: ['ds'], genome_id: 'dm6' }, { confirm: () => false });
    expect(bodies).toHaveLength(1);
    expect(fasta.success).toBe(false);
    expect(fasta.error).toContain('Not downloaded: 5.2 GB is over the download warning size');
  });
});
