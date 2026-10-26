// Adapted from the post-merge review's agy probe (group C).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { useLiveLiftStore } from '../liveLift/store';
import { usePanelGenomeStore } from '../../stores/panelGenomeStore';
import {
  openLinkedSourceView,
  registerLiftLinking,
} from '../liveLift/linking/liftLink';
import {
  ensureSummary,
  prefetchView,
  resetNavigation,
  setNavigationFetcher,
} from '../liveLift/linking/navigation';
import { applyShown, startHandoffController } from './handoff';
import { popOutPaths } from './popOutKind';
import { showSourceSpan } from './navigation';

const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};

function encodeTile(n: number, side: number, runs: Array<[number, number, number, number?]>) {
  const out = [0x47, 0x4c, 0x54, 0x31, side];
  const uv = (v: number) => {
    while (v >= 128) {
      out.push((v & 127) | 128);
      v = Math.floor(v / 128);
    }
    out.push(v);
  };
  const zz = (v: number) => (v < 0 ? -v * 2 - 1 : v * 2);
  uv(n);
  uv(runs.length);
  let e0 = n * 1_000_000;
  let o0 = 0;
  for (const [a, b, q, chain = 0] of runs) {
    uv(zz(a - e0));
    uv(b - a);
    uv(zz(q - o0));
    uv(chain * 2);
    e0 = b;
    o0 = q;
  }
  return new Uint8Array(out);
}

const viewOf = (id: string) =>
  useBrowserStore.getState().panels.find(p => p.id === id)?.viewportOverride;

describe('Each panel navigates: a graph host with linked source views (post-merge review, agy C)', () => {
  let heldTargetA: (() => void)[] = [];
  let holdTargetA = false;

  beforeEach(async () => {
    heldTargetA = [];
    holdTargetA = false;
    resetNavigation();
    registerLiftLinking();
    startHandoffController();
    useLiveLiftStore.setState({ enabled: true });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network forbidden'); }));
    usePanelGenomeStore.setState({
      genomes: {
        gSrc: {
          key: 'gSrc',
          label: 'Source assembly',
          chroms: [
            { name: 'S', size: 200_000 },
            { name: 'S2', size: 200_000 },
            { name: 'P', size: 200_000 },
          ],
        } as never,
      },
      assignments: { nativeA: 'gSrc', nativeB: 'gSrc' },
    } as never);

    setNavigationFetcher({
      json: async (u: string) => {
        const p = new URL(u, 'http://x').searchParams;
        const ds = p.get('dataset_id') ?? 'liftA';
        if (u.includes('summary')) {
          if (ds === 'liftB') {
            return {
              key: 'kB',
              tile_bp: 1_000_000,
              outline_max_drift: 0,
              haplotypes: ['HP'],
              labels: { HP: 'PAT' },
              sources: { P: 'HP' },
              targets: { T: 200_000, T2: 200_000 },
              selected: [true],
              chains: [['T', 1000, 100_000, 'P', 0, 99_000, '+', 'HP', 99_000, 99_000]],
            };
          }
          return {
            key: 'kA',
            tile_bp: 1_000_000,
            outline_max_drift: 0,
            haplotypes: ['HM', 'HP'],
            labels: { HM: 'MAT', HP: 'PAT' },
            sources: { S: 'HM', S2: 'HM', P: 'HP' },
            targets: { T: 200_000, T2: 200_000 },
            selected: [true, true, true],
            chains: [
              ['T', 1000, 100_000, 'S', 0, 99_000, '+', 'HM', 99_000, 99_000],
              ['T2', 1000, 100_000, 'S2', 0, 99_000, '+', 'HM', 99_000, 99_000],
              ['T', 1000, 100_000, 'P', 0, 99_000, '+', 'HP', 99_000, 99_000],
            ],
          };
        }
        const chrom = p.get('contig') ?? p.get('source') ?? p.get('chrom') ?? 'T';
        const isSource = Boolean(p.get('source')) || p.get('side') === 'source';
        if (ds === 'liftB') {
          return { rows: [[1000, 100_000, 0, 99_000, '+', 0, 0, isSource ? 'T' : 'P']] };
        }
        if (chrom === 'P') {
          return { rows: [[1000, 100_000, 0, 99_000, '+', 2, 0, 'T']] };
        }
        if (chrom === 'T2' || chrom === 'S2') {
          return { rows: [[1000, 100_000, 0, 99_000, '+', 1, 0, isSource ? 'T2' : 'S2']] };
        }
        return {
          rows: isSource
            ? [[1000, 100_000, 0, 99_000, '+', 0, 0, 'T']]
            : [
                [1000, 100_000, 0, 99_000, '+', 0, 0, 'S'],
                [1000, 100_000, 0, 99_000, '+', 2, 0, 'P'],
              ],
        };
      },
      bytes: async (u: string) => {
        const p = new URL(u, 'http://x').searchParams;
        const ds = p.get('dataset_id') ?? 'liftA';
        const contig = p.get('contig') ?? 'T';
        const side = p.get('side') === 'source' ? 1 : 0;
        const n = Number(p.get('tile') ?? '0');
        let runs: Array<[number, number, number, number?]> = [];
        if (n === 0) {
          if (ds === 'liftB') runs = side ? [[0, 99_000, 1000, 0]] : [[1000, 100_000, 0, 0]];
          else if (contig === 'P') runs = [[0, 99_000, 1000, 2]];
          else if (contig === 'S2') runs = [[0, 99_000, 1000, 1]];
          else if (contig === 'T2') runs = [[1000, 100_000, 0, 1]];
          else if (side) runs = [[0, 99_000, 1000, 0]];
          else runs = [[1000, 100_000, 0, 0], [1000, 100_000, 0, 2]];
        }
        const t = encodeTile(n, side, runs);
        if (holdTargetA && ds === 'liftA' && !side && n === 0) {
          return new Promise<Uint8Array>(r => heldTargetA.push(() => r(t)));
        }
        return t;
      },
    } as never);
  });

  it('showing a source span moves only the source view; the graph host stays where it is (post-merge review, agy C)', async () => {
    await ensureSummary('liftA', 'kA');
    await prefetchView('liftA', 'kA', 0, 'T', 1000, 95_000);
    await prefetchView('liftA', 'kA', 1, 'S', 0, 94_000);
    await flush();

    useBrowserStore.setState({
      chrom: 'T', start: 5000, end: 15000, navigationMode: 'perPanel', isReversed: false, _lastRestoreTime: 0, lastMovedPanels: {},
      datasets: [
        { id: 'liftA', path: '/a.bam', paths: ['/a.bam'], label: 'liftA', color: '#000', data_type: 'bam_livelift', live_lift: { key: 'kA', haplotypes: ['HM'], haplotype_labels: { HM: 'MAT' } } },
        { id: 'nativeA', path: '/a.bam', paths: ['/a.bam'], label: 'nativeA', color: '#000', data_type: 'bam' },
      ],
      panels: [
        {
          id: 'host', contentType: 'dataset', datasetId: 'liftA', subTracks: [], collapsed: false, linkGroup: null,
          viewMode: 'graph', navOwn: true, viewportOverride: { chrom: 'T', start: 5000, end: 15000 },
          graphView: { schema: 2, role: 'host', registrationId: 'r1', targetBinding: 'T', selectedPathKeys: ['T', 'HM'] },
        },
        {
          id: 'srcA', contentType: 'dataset', datasetId: 'nativeA', subTracks: [], collapsed: false, linkGroup: null, genome: 'gSrc',
          viewportOverride: { chrom: 'S', start: 4000, end: 14000 },
          liftLink: { id: 'LA', datasetId: 'liftA', liftPanelId: 'host', hap: 'HM', hapLabel: 'MAT', contig: 'S', flip: false, chain: null },
        },
      ],
    } as never);

    showSourceSpan(
      'host',
      { path: 'HM', span: { start: 80_000, end: 80_200 }, note: 'visit 2 of 2 (repeat)' },
      { kind: 'panel', panelId: 'srcA', contig: 'S', label: 'liftA · MAT source view' },
      'r1',
    );
    expect(viewOf('srcA')).toEqual({ chrom: 'S', start: 79_900, end: 80_300 });
    expect(viewOf('host')).toEqual({ chrom: 'T', start: 5000, end: 15000 });
  });
});
