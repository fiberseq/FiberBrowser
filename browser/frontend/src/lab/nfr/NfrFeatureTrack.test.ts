import '../testSetup';
import { describe, expect, it } from 'vitest';
import { nfrRunFor, nfrRef, variantRef } from './NfrFeatureTrack';
import { runFromJob } from './useNfrRuns';
import type { NfrRun } from './nfrRunsStore';

const result = (chrom: string, start: number, end: number, ds = ['d1']) => ({
  region: { chrom, start, end }, datasets: ds.map(dataset_id => ({ dataset_id })),
  nfrs: [{ id: 'N1', start: start + 10, end: start + 60, status: 'ok', variants: [
    { id: 'N1:V1', nfr: 'N1', name: 'V1', L: start + 5, R: start + 70 }] }],
}) as never;
const run = (jobId: string, r: unknown, createdAt: number): NfrRun => ({ jobId, result: r as never, datasetIds: (r as any).datasets.map((d: any) => d.dataset_id), createdAt });

describe('the NFR channel', () => {
  it('draws the shown run when it covers the panel, else the newest run that does', () => {
    const runs = { a: run('a', result('chr1', 0, 1000), 1), b: run('b', result('chr1', 500, 1500), 2), c: run('c', result('chr2', 0, 1000), 3) };
    expect(nfrRunFor(runs, 'a', 'd1', 'chr1', 100, 200)?.jobId).toBe('a');
    expect(nfrRunFor(runs, null, 'd1', 'chr1', 600, 700)?.jobId).toBe('b');
    expect(nfrRunFor(runs, 'c', 'd1', 'chr1', 2000, 3000)).toBeNull();
    expect(nfrRunFor(runs, null, 'other', 'chr1', 0, 100)).toBeNull();
  });
  it('variant and NFR refs carry their span, label and colour; a completed job becomes a run', () => {
    const r = run('a', result('chr1', 0, 1000), 1);
    const n = (r.result as any).nfrs[0];
    expect(variantRef(r, n.variants[0])).toMatchObject({ kind: 'nfr-variant', source: 'a', id: 'N1:V1', start: 5, end: 70, label: 'N1 V1', chrom: 'chr1' });
    expect(nfrRef(r, n)).toMatchObject({ kind: 'nfr', id: 'N1', start: 5, end: 70 });
    expect(runFromJob({ job_id: 'j', status: 'running' } as never)).toBeNull();
    expect(runFromJob({ job_id: 'j', status: 'complete', class_job_id: 'k', created_at: 5, result: result('chr1', 0, 10, ['x', 'y']) } as never))
      .toMatchObject({ jobId: 'j', datasetIds: ['x', 'y'], classJobId: 'k', createdAt: 5 });
  });
});
