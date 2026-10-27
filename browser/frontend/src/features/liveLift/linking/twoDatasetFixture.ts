// Test fixture (adapted from the post-merge review's group C probes, agy): two lifted datasets on target contigs
// T and T2. liftA has haplotypes HM (MAT, sources S and S2) and HP (PAT, source P); liftB has HP (PAT, source P).
// Every map is a plain offset: target x is source x - 1000. `hold.targetA` holds liftA's target tile 0 until released.
import { vi } from 'vitest';
import { useBrowserStore } from '../../../stores/browserStore';
import { usePanelGenomeStore } from '../../../stores/panelGenomeStore';
import { useLiveLiftStore } from '../store';
import { registerLiftLinking } from './liftLink';
import { resetNavigation, setNavigationFetcher } from './navigation';
import { startHandoffController } from '../../graphPanel/handoff';

export const flush = async (n = 60) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
export const viewOf = (id: string) => useBrowserStore.getState().panels.find(p => p.id === id)?.viewportOverride;
export const panelOf = (id: string) => useBrowserStore.getState().panels.find(p => p.id === id);

function encodeTile(n: number, side: number, runs: Array<[number, number, number, number?]>) {
  const out = [0x47, 0x4c, 0x54, 0x31, side];
  const uv = (v: number) => { while (v >= 128) { out.push((v & 127) | 128); v = Math.floor(v / 128); } out.push(v); };
  const zz = (v: number) => (v < 0 ? -v * 2 - 1 : v * 2);
  uv(n); uv(runs.length);
  let e0 = n * 1_000_000, o0 = 0;
  for (const [a, b, q, chain = 0] of runs) { uv(zz(a - e0)); uv(b - a); uv(zz(q - o0)); uv(chain * 2); e0 = b; o0 = q; }
  return new Uint8Array(out);
}

export const hold = { targetA: false, held: [] as (() => void)[] };

/** Release every held tile and let the arrivals settle (repeatedly: a settle may start the next request). */
export async function releaseHeld(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await flush();
    for (const r of hold.held.splice(0)) r();
    await flush();
  }
}

export function installTwoDatasetFixture(): void {
  hold.targetA = false;
  hold.held = [];
  resetNavigation();
  registerLiftLinking();
  startHandoffController();
  useLiveLiftStore.setState({ enabled: true });
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network forbidden'); }));
  usePanelGenomeStore.setState({
    genomes: { gSrc: { key: 'gSrc', label: 'Source assembly', chroms: [{ name: 'S', size: 200_000 }, { name: 'S2', size: 200_000 }, { name: 'P', size: 200_000 }] } as never },
    assignments: { nativeA: 'gSrc', nativeB: 'gSrc' },
  } as never);
  setNavigationFetcher({
    json: async (u: string) => {
      const p = new URL(u, 'http://x').searchParams;
      const ds = p.get('dataset_id') ?? 'liftA';
      if (u.includes('summary')) {
        if (ds === 'liftB') {
          return { key: 'kB', tile_bp: 1_000_000, outline_max_drift: 0, haplotypes: ['HP'], labels: { HP: 'PAT' }, sources: { P: 'HP' },
            targets: { T: 200_000, T2: 200_000 }, selected: [true], chains: [['T', 1000, 100_000, 'P', 0, 99_000, '+', 'HP', 99_000, 99_000]] };
        }
        return { key: 'kA', tile_bp: 1_000_000, outline_max_drift: 0, haplotypes: ['HM', 'HP'], labels: { HM: 'MAT', HP: 'PAT' },
          sources: { S: 'HM', S2: 'HM', P: 'HP' }, targets: { T: 200_000, T2: 200_000 }, selected: [true, true, true],
          chains: [
            ['T', 1000, 100_000, 'S', 0, 99_000, '+', 'HM', 99_000, 99_000],
            ['T2', 1000, 100_000, 'S2', 0, 99_000, '+', 'HM', 99_000, 99_000],
            ['T', 1000, 100_000, 'P', 0, 99_000, '+', 'HP', 99_000, 99_000],
          ] };
      }
      const chrom = p.get('contig') ?? p.get('source') ?? p.get('chrom') ?? 'T';
      const isSource = Boolean(p.get('source')) || p.get('side') === 'source';
      if (ds === 'liftB') return { rows: [[1000, 100_000, 0, 99_000, '+', 0, 0, isSource ? 'T' : 'P']] };
      if (chrom === 'P') return { rows: [[1000, 100_000, 0, 99_000, '+', 2, 0, 'T']] };
      if (chrom === 'T2' || chrom === 'S2') return { rows: [[1000, 100_000, 0, 99_000, '+', 1, 0, isSource ? 'T2' : 'S2']] };
      return { rows: isSource ? [[1000, 100_000, 0, 99_000, '+', 0, 0, 'T']]
        : [[1000, 100_000, 0, 99_000, '+', 0, 0, 'S'], [1000, 100_000, 0, 99_000, '+', 2, 0, 'P']] };
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
      if (hold.targetA && ds === 'liftA' && !side && n === 0) return new Promise<Uint8Array>(r => hold.held.push(() => r(t)));
      return t;
    },
  } as never);
}

export const LIFT_A = { id: 'liftA', path: '/a.bam', paths: ['/a.bam'], label: 'liftA', color: '#000', data_type: 'bam_livelift',
  live_lift: { key: 'kA', haplotypes: ['HM', 'HP'], haplotype_labels: { HM: 'MAT', HP: 'PAT' } } };
export const LIFT_B = { id: 'liftB', path: '/b.bam', paths: ['/b.bam'], label: 'liftB', color: '#000', data_type: 'bam_livelift',
  live_lift: { key: 'kB', haplotypes: ['HP'], haplotype_labels: { HP: 'PAT' } } };
export const NATIVE_A = { id: 'nativeA', path: '/a.bam', paths: ['/a.bam'], label: 'nativeA', color: '#000', data_type: 'bam' };
export const NATIVE_B = { id: 'nativeB', path: '/b.bam', paths: ['/b.bam'], label: 'nativeB', color: '#000', data_type: 'bam' };
