import { describe, expect, it } from 'vitest';
import { ensureSummary, mapSpan, resetNavigation, setNavigationFetcher } from './navigation';
import { registerLiftLinking } from './liftLink';
import { useLiveLiftStore } from '../store';
import { useBrowserStore } from '../../../stores/browserStore';

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

async function setupLinkedStore(resolves: (() => void)[]) {
  resetNavigation();
  registerLiftLinking();
  useLiveLiftStore.setState({ enabled: true });
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
  useBrowserStore.setState({
    chrom: 'T', start: 2000, end: 3000, navigationMode: 'linked', isReversed: false, _lastRestoreTime: 0,
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
  resolves.splice(0);
}

describe('linked panel corrections fold only into their own undo step (B2)', () => {
  it('never rewrites the "Before navigation" baseline: Undo returns to where the move started', async () => {
    const resolves: (() => void)[] = [];
    await setupLinkedStore(resolves);
    useBrowserStore.getState().clearHistory();
    useBrowserStore.getState().setPanelViewport('src', 3990, 6090);
    const stack = useBrowserStore.getState()._historyStack;
    expect(stack[0].baseline).toBe(true);
    expect(stack[0].state.start).toBe(2000);
    for (const r of resolves.splice(0)) r();
    await flush();
    const after = useBrowserStore.getState();
    expect([after.start, after.end]).toEqual([5000, 7000]);          // the exact correction applied
    expect(after._historyStack[0].state.start).toBe(2000);            // baseline untouched
    // The main view's own step (Browser.tsx records it after a pause), then Undo goes back to the start.
    useBrowserStore.getState().pushSnapshot('Navigate to T:5,000-7,000', { kind: 'navigation' });
    useBrowserStore.getState().undo();
    expect([useBrowserStore.getState().start, useBrowserStore.getState().end]).toEqual([2000, 3000]);
  });

  it("folds into the move's own step when that step was recorded before the correction arrived", async () => {
    const resolves: (() => void)[] = [];
    await setupLinkedStore(resolves);
    useBrowserStore.getState().clearHistory();
    useBrowserStore.getState().setPanelViewport('src', 3990, 6090);
    useBrowserStore.getState().pushSnapshot('Navigate panel', { kind: 'navigation' });
    for (const r of resolves.splice(0)) r();
    await flush();
    const st = useBrowserStore.getState();
    expect(st._historyStack.map(x => x.label)).toEqual(['Before navigation', 'Navigate panel']);
    expect(st._historyStack[1].state.start).toBe(5000);
    expect(st._historyStack[0].state.start).toBe(2000);
  });

  it('after Undo and a later unrelated step, the correction folds into nothing', async () => {
    const resolves: (() => void)[] = [];
    await setupLinkedStore(resolves);
    const s = useBrowserStore.getState();
    s.clearHistory();
    s.pushSnapshot('step0', { kind: 'layout' });
    useBrowserStore.setState({ selectedReadIds: new Set(['r1']), _lastRestoreTime: 0 });
    s.pushSnapshot('step1', { kind: 'layout' });
    useBrowserStore.setState({ selectedReadIds: new Set(['r2']), _lastRestoreTime: 0 });
    s.pushSnapshot('step2', { kind: 'layout' });
    useBrowserStore.getState().undo();
    useBrowserStore.setState({ _lastRestoreTime: 0 });
    useBrowserStore.getState().navigatePanel('src', 'S', 3990, 6090);
    useBrowserStore.setState({ selectedReadIds: new Set(['r3']) });
    useBrowserStore.getState().pushSnapshot('Filter reads', { kind: 'filtering' });
    const filterStep = useBrowserStore.getState()._historyStack.at(-1)!;
    const approximate = filterStep.state.start;
    for (const r of resolves.splice(0)) r();
    await flush();
    const st = useBrowserStore.getState();
    expect(st._historyStack.at(-1)!.label).toBe('Filter reads');
    expect(st._historyStack.at(-1)!.state.start).toBe(approximate);   // the unrelated step keeps its own state
  });
});

describe('"Each panel navigates": linked source and lifted panels move each other (A13)', () => {
  it('a source move takes the lifted panel along, and a lifted move takes the source along', async () => {
    const resolves: (() => void)[] = [];
    await setupLinkedStore(resolves);
    useBrowserStore.setState(s => ({ navigationMode: 'perPanel', panels: s.panels.map(p => p.id === 'mat'
      ? { ...p, viewportOverride: { chrom: 'T', start: 2000, end: 3000 } } : p) }) as never);
    // Load the tiles both directions need.
    useBrowserStore.getState().setPanelViewport('src', 3990, 6090);
    for (const r of resolves.splice(0)) r();
    await flush();
    useBrowserStore.getState().setPanelViewport('src', 3990, 6091);
    for (const r of resolves.splice(0)) r();
    await flush();
    useBrowserStore.getState().setPanelViewport('src', 3990, 6090);
    const mat = () => useBrowserStore.getState().panels.find(p => p.id === 'mat')!.viewportOverride!;
    expect([mat().chrom, mat().start, mat().end]).toEqual(['T', 5000, 7000]);
    expect([useBrowserStore.getState().start, useBrowserStore.getState().end]).toEqual([2000, 3000]);   // main view untouched
    useBrowserStore.getState().setPanelViewport('mat', 1500, 2500);
    for (const r of resolves.splice(0)) r();
    await flush();
    useBrowserStore.getState().setPanelViewport('mat', 1500, 2501);
    useBrowserStore.getState().setPanelViewport('mat', 1500, 2500);
    const src = useBrowserStore.getState().panels.find(p => p.id === 'src')!.viewportOverride!;
    expect([src.chrom, src.start, src.end]).toEqual(['S', 500, 1500]);
  });
});

describe('"Each panel navigates": a source-view pop-out of a graph host follows the host (Codex H r3 #4)', () => {
  it("the host's moves take the source view along, and the source view's moves take the host along", async () => {
    const resolves: (() => void)[] = [];
    await setupLinkedStore(resolves);
    // The haplotype panel the link names is folded into a graph host with a view of its own.
    useBrowserStore.setState(s => ({ navigationMode: 'perPanel', panels: [
      { id: 'host', contentType: 'dataset', datasetId: 'lift', subTracks: [], collapsed: false, linkGroup: null, liftHap: 'PAT',
        viewMode: 'graph', viewportOverride: { chrom: 'T', start: 2000, end: 3000 } },
      ...s.panels.map(p => p.id === 'mat' ? { ...p, collapsed: true, collapsedByGraphGroup: 'host', graphMemberOf: 'host',
        viewportOverride: { chrom: 'T', start: 2000, end: 3000 } } : p),
    ] }) as never);
    // Load the tiles both directions need.
    useBrowserStore.getState().setPanelViewport('src', 3990, 6090);
    for (const r of resolves.splice(0)) r();
    await flush();
    useBrowserStore.getState().setPanelViewport('src', 3990, 6091);
    for (const r of resolves.splice(0)) r();
    await flush();
    useBrowserStore.getState().setPanelViewport('src', 3990, 6090);
    const view = (id: string) => { const v = useBrowserStore.getState().panels.find(p => p.id === id)!.viewportOverride!; return [v.chrom, v.start, v.end]; };
    expect(view('host')).toEqual(['T', 5000, 7000]);
    expect([useBrowserStore.getState().start, useBrowserStore.getState().end]).toEqual([2000, 3000]);   // main view untouched
    useBrowserStore.getState().setPanelViewport('host', 1500, 2500);
    for (const r of resolves.splice(0)) r();
    await flush();
    useBrowserStore.getState().setPanelViewport('host', 1500, 2501);
    useBrowserStore.getState().setPanelViewport('host', 1500, 2500);
    expect(view('src')).toEqual(['S', 500, 1500]);
    // The link still names the haplotype's panel (ribbons, hover and retargeting keep using it).
    expect(useBrowserStore.getState().panels.find(p => p.id === 'src')!.liftLink!.liftPanelId).toBe('mat');
  });
});
