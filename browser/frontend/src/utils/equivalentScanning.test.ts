import { beforeEach, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../stores/browserStore';
import { scanEquivalentRegions, scanUnsharedRegions } from './equivalentScanning';
import { fetchJson } from '../api/sharedFetch';
vi.mock('../api/sharedFetch', () => ({ fetchJson: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

it('sends one pooled scan with all members, clipped to their views and with read filters', async () => {
  const s = useBrowserStore.getState();
  const state = { ...s, chrom: 'chr1', start: 100, end: 200,
    datasets: [{ id: 'a' }, { id: 'b' }], selectedDatasets: new Set(['p']),
    filteredReadIds: { a: new Set(['r1']), b: new Set(['r2']) },
    panels: [{ id: 'p', contentType: 'dataset', datasetId: 'a' },
      { id: 'q', contentType: 'dataset', datasetId: 'b', genome: 'alt', viewportOverride: { chrom: 'other', start: 300, end: 400 } }],
    peakRules: [{ ...s.peakRules[0], id: 'g', source: 'matched' }],
    peaksByRule: { g: [
      { index: 0, chrom: 'chr1', start: 0, end: 200, match: { groupId: 'g', panelId: 'p', label: 'W1', length: 200, reversed: false, blocks: [{ frame: [0, 200], genomic: [0, 200] }] } },
      { index: 1, chrom: 'other', genome: 'alt', start: 300, end: 500, match: { groupId: 'g', panelId: 'q', label: 'W2', length: 200, reversed: true, blocks: [{ frame: [0, 200], genomic: [300, 500] }] } },
    ] },
  } as never;
  vi.mocked(fetchJson).mockResolvedValue({ shared_blocks: [[120, 180]], peaks: [{ index: 0, start: 120, end: 150 }], profiles: [], members: {}, n_reads: 2 });
  const result = await scanEquivalentRegions(state, s.peakRules[0], 'accessibility');
  expect(fetchJson).toHaveBeenCalledTimes(1);
  const body = JSON.parse(vi.mocked(fetchJson).mock.calls[0][1]!.body as string);
  expect(body.viewports.map((w: any) => [w.read_ids, w.blocks])).toEqual([
    [['r1'], [{ frame: [100, 200], genomic: [100, 200], feature: 0, reverse: false }]],
    [['r2'], [{ frame: [100, 200], genomic: [300, 400], feature: 0, reverse: true }]],
  ]);
  expect(result.peaks[0]).toMatchObject({ chrom: 'chr1', start: 120, end: 150 });
  expect(result.remainder({ index: 0, chrom: 'chr1', start: 100, end: 200 }).map(p => [p.start, p.end])).toEqual([[100, 120], [180, 200]]);
  vi.mocked(fetchJson).mockResolvedValue({ peaks: [] });
  await scanUnsharedRegions(state, s.peakRules[0], 'accessibility', result);
  expect(fetchJson).toHaveBeenCalledTimes(5);
  expect(vi.mocked(fetchJson).mock.calls.slice(1).map(([url]) => {
    const q = new URL(String(url), 'http://localhost').searchParams;
    return [q.get('chrom'), q.get('start'), q.get('end')];
  })).toEqual([['chr1', '100', '120'], ['chr1', '180', '200'], ['other', '300', '320'], ['other', '380', '400']]);
});

it('skips disjoint visible frame positions and scans a duplicate map only once', async () => {
  const initial = useBrowserStore.getState();
  const a = { index: 0, chrom: 'chr1', start: 0, end: 200, match: { groupId: 'g', panelId: 'p', label: 'W1', length: 200, reversed: false, blocks: [{ frame: [0, 200], genomic: [0, 200] }] } };
  const b = { ...a, chrom: 'chr2', match: { ...a.match, panelId: 'q', label: 'W2' } };
  const s = { ...initial, datasets: [{ id: 'a' }, { id: 'b' }], chrom: 'chr1', start: 0, end: 50,
    panels: [{ id: 'p', contentType: 'dataset', datasetId: 'a' },
      { id: 'q', contentType: 'dataset', datasetId: 'b', viewportOverride: { chrom: 'chr2', start: 100, end: 200 } }],
    peakRules: [{ ...initial.peakRules[0], id: 'g', source: 'matched' }], peaksByRule: { g: [a, b] },
  } as unknown as typeof initial;
  expect((await scanEquivalentRegions(s, initial.peakRules[0], 'accessibility')).peaks).toEqual([]);
  expect(fetchJson).not.toHaveBeenCalled();
  s.end = 200;
  s.panels[1].viewportOverride!.start = 0;
  s.peakRules.push({ ...s.peakRules[0], id: 'duplicate' });
  s.peaksByRule.duplicate = [a, b].map(p => ({ ...p, match: { ...p.match, groupId: 'duplicate', length: 300,
    blocks: [{ frame: [100, 300], genomic: [0, 200] }] } })) as never;
  vi.mocked(fetchJson).mockResolvedValue({ shared_blocks: [[0, 200]], peaks: [{ index: 0, start: 20, end: 50 }], profiles: [], members: {}, n_reads: 2 });
  const result = await scanEquivalentRegions(s, initial.peakRules[0], 'accessibility');
  expect(fetchJson).toHaveBeenCalledTimes(1);
  expect(result.peaks[0]).toMatchObject({ correspondenceId: 'g', memberPanelId: 'p' });
});
