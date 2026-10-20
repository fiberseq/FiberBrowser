import { expect, it } from 'vitest';
import { mapSpan, prefetchView, resetNavigation, setNavigationFetcher, ensureSummary } from './navigation';
import { useBrowserStore } from '../../../stores/browserStore';
import { useLiveLiftStore } from '../store';
import { registerLiftLinking } from './liftLink';

function tile(n: number, side: number, runs: number[][]) {
  const out = [0x47, 0x4c, 0x54, 0x31, side];
  const uv = (v: number) => { while (v >= 128) { out.push((v & 127) | 128); v = Math.floor(v / 128); } out.push(v); };
  const zz = (v: number) => v < 0 ? -v * 2 - 1 : v * 2;
  uv(n); uv(runs.length);
  let e0 = n * 1000000, o0 = 0;
  for (const [a, b, q] of runs) { uv(zz(a - e0)); uv(b - a); uv(zz(q - o0)); uv(0); e0 = b; o0 = q; }
  return new Uint8Array(out);
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

it('a gap whose nearer flank\'s tile failed to load stays approximate', async () => {
  resetNavigation();
  setNavigationFetcher({
    json: async u => u.includes('summary')
      ? { key: 'k', tile_bp: 1000000, outline_max_drift: 1000, haplotypes: ['H'], labels: { H: 'MAT' }, sources: { S: 'H' }, targets: { T: 3000000 },
        selected: [true], chains: [['T', 990000, 1005000, 'S', 0, 14400, '+', 'H', 15000, 14400]] }
      : { rows: [[990000, 1005000, 0, 14400, '+', 0, 600]] },
    bytes: async u => {
      const n = Number(new URL(u, 'http://x').searchParams.get('tile'));
      if (n === 0) throw new Error('503');
      return tile(n, 0, n === 1 ? [[1000500, 1005000, 9900]] : []);
    },
  } as never);
  await prefetchView('d', 'k', 0, 'T', 1000000, 1000100);
  mapSpan('d', 'k', 'toSource', { chrom: 'T', start: 1000000, end: 1000100 }, { hap: 'H' });
  await flush();
  const actual = mapSpan('d', 'k', 'toSource', { chrom: 'T', start: 1000000, end: 1000100 }, { hap: 'H' });
  expect(actual).toMatchObject({ status: 'mapped', mapping: { exact: false } });
});

it('a linked panel\'s typed locus and its later exact main-view correction are one undo step', async () => {
  resetNavigation(); registerLiftLinking();
  useLiveLiftStore.setState({ enabled: true });
  const resolves: (() => void)[] = [];
  setNavigationFetcher({
    json: async u => u.includes('summary')
      ? { key: 'k1', tile_bp: 1000000, outline_max_drift: 1000, haplotypes: ['H'], labels: { H: 'MAT' }, sources: { S: 'H' }, targets: { T: 20000 },
        selected: [true], chains: [['T', 1000, 7900, 'S', 0, 6990, '+', 'H', 6900, 6890]] }
      : { rows: [[1000, 7900, 0, 6990, '+', 0, 100, 'T']] },
    bytes: u => new Promise(resolve => {
      const p = new URL(u, 'http://x').searchParams;
      const side = p.get('side') === 'source' ? 1 : 0, n = Number(p.get('tile'));
      resolves.push(() => resolve(tile(n, side, n > 0 ? [] : side
        ? [[0, 3000, 1000], [3000, 5000, 4010], [5100, 6990, 6010]]
        : [[1000, 4000, 0], [4010, 6010, 3000], [6010, 7900, 5100]])));
    }),
  } as never);
  useBrowserStore.setState({ chrom: 'T', start: 2000, end: 3000, navigationMode: 'linked', isReversed: false, _lastRestoreTime: 0,
    datasets: [
      { id: 'lift', path: '/s.bam', paths: ['/s.bam'], label: 'lift', color: '#000', data_type: 'bam_livelift', live_lift: { key: 'k1', haplotypes: ['H'], haplotype_labels: { H: 'MAT' } } },
      { id: 'native', path: '/s.bam', paths: ['/s.bam'], label: 'native', color: '#000', data_type: 'bam' },
    ],
    panels: [
      { id: 'mat', contentType: 'dataset', datasetId: 'lift', subTracks: [], collapsed: false, linkGroup: null, liftHap: 'MAT' },
      { id: 'src', contentType: 'dataset', datasetId: 'native', subTracks: [], collapsed: false, linkGroup: null,
        viewportOverride: { chrom: 'S', start: 1000, end: 2000 },
        liftLink: { id: 'L1', datasetId: 'lift', liftPanelId: 'mat', hap: 'H', hapLabel: 'MAT', contig: 'S', flip: false, chain: null } },
    ],
  } as never);
  await ensureSummary('lift', 'k1');
  mapSpan('lift', 'k1', 'toTarget', { chrom: 'S', start: 1000, end: 2000 });
  await flush();
  useBrowserStore.getState().clearHistory();
  useBrowserStore.getState().pushSnapshot('before', { kind: 'layout' });
  useBrowserStore.getState().navigatePanel('src', 'S', 3990, 6090);
  const pair = () => ({ main: [useBrowserStore.getState().start, useBrowserStore.getState().end],
    source: useBrowserStore.getState().panels.find(p => p.id === 'src')?.viewportOverride });
  const approximate = pair();
  for (const resolve of resolves.splice(0)) resolve();
  await flush();
  const corrected = pair();
  useBrowserStore.getState().undo();
  const undone = pair();
  useBrowserStore.getState().redo();
  await flush();
  const redone = pair();
  expect(approximate.main).not.toEqual(corrected.main);
  expect(corrected.main).toEqual([5000, 7000]);
  expect(undone.main).toEqual([2000, 3000]);
  expect(redone).toEqual(corrected);
});
