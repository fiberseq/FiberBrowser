import { describe, expect, it, vi } from 'vitest';

vi.mock('../api/datasets', () => ({
  addDataset: vi.fn(async (path: string) => (path.includes('denied')
    ? { success: false, error: `Access denied: ${path}` }
    : { success: true, dataset: { id: path.split(/[/?#]/).filter(Boolean).pop(), label: 'x', path, paths: [path] } })),
  addDatasetsGrouped: vi.fn(async () => { throw new Error('403 Forbidden'); }),
}));
vi.mock('./plasmidLoader', () => ({
  loadPlasmidFiles: vi.fn(async (paths: string[]) => ({
    success: true, count: 1, loaded: [{ success: true, name: 'good', length: 10 }], failed: paths.length - 1,
    failures: paths.filter(p => p.includes('bad')).map(path => ({ path, error: 'unreadable GenBank record' })),
  })),
}));

vi.mock('../api/tracks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/tracks')>()),
  addTrack: vi.fn(async (path: string) => ({
    success: true, track_index: 0, label: 'fly_enhancers', render_mode: 'annotation',
    ...(path.includes('fly') ? {
      warning: 'fly_enhancers.bed: its chromosomes (chr2L, chr2R, chr3R) are not on hg38, the main genome; they match dm6. '
        + 'Tracks are drawn in the main view, so it shows nothing until dm6 is the main genome.',
    } : {}),
  })),
}));

import { openLocalPaths } from './openFiles';
import { addDataset } from '../api/datasets';

describe('openLocalPaths', () => {
  it('a refused batch of BigBeds is opened file by file, so one refusal blocks nothing', async () => {
    const report = await openLocalPaths(['/allowed/good.bb', '/private/denied.bb']);
    expect(report.opened).toEqual(['/allowed/good.bb']);
    expect(report.errors).toEqual(['Access denied: /private/denied.bb']);
  });

  it('plasmid maps that fail are named and not counted as opened', async () => {
    const report = await openLocalPaths(['/m/good.gb', '/m/bad1.gb', '/m/bad2.gb']);
    expect(report.opened).toEqual(['/m/good.gb']);
    expect(report.errors).toEqual(['bad1.gb: unreadable GenBank record', 'bad2.gb: unreadable GenBank record']);
  });

  it('a remote BAM opens with the index URL chosen with it', async () => {
    vi.mocked(addDataset).mockClear();
    const bam = 'https://s3.example.org/lab/x.bam?X-Amz-Signature=aaa';
    const bai = 'https://s3.example.org/lab/x.bam.bai?X-Amz-Signature=bbb';
    const report = await openLocalPaths([bam, bai]);
    expect(vi.mocked(addDataset).mock.calls.map(c => c[0])).toEqual([`${bam}##idx##${bai}`]);
    expect(report.errors).toEqual([]);
  });

  it('a remote BAM chosen with its PacBio .pbi opens without it as its index (Codex 31)', async () => {
    vi.mocked(addDataset).mockClear();
    const bam = 'https://s3.example.org/lab/y.bam';
    const pbi = 'https://s3.example.org/lab/y.bam.pbi';
    const bai = 'https://s3.example.org/lab/y.bam.bai';
    await openLocalPaths([bam, pbi]);
    await openLocalPaths([bam, pbi, bai]);
    expect(vi.mocked(addDataset).mock.calls.map(c => c[0])).toEqual([bam, `${bam}##idx##${bai}`]);
  });

  it('a BED for another assembly opens with the reason it shows nothing in the main view (L11)', async () => {
    const report = await openLocalPaths(['/beds/fly_enhancers.bed', '/beds/human.bed']);
    expect(report.opened).toEqual(['/beds/fly_enhancers.bed', '/beds/human.bed']);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toMatch(/^fly_enhancers\.bed: its chromosomes \(chr2L, chr2R, chr3R\) are not on hg38.*they match dm6/);
  });
});
