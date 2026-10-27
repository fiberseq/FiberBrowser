import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureSummary, mapSpan, resetNavigation, setNavigationFetcher } from './navigation';
import { chooseLinkChain, openLinkedSourceView, registerLiftLinking } from './liftLink';
import { LiftRibbonStrip } from './LiftRibbonStrip';
import { popOutPaths, popOutPlan } from '../../graphPanel/popOutKind';
import { startHandoffController } from '../../graphPanel/handoff';
import { useLiveLiftStore } from '../store';
import { useBrowserStore } from '../../../stores/browserStore';
import { usePanelGenomeStore } from '../../../stores/panelGenomeStore';

function tile(n: number, side: number, runs: number[][]) {
  const out = [0x47, 0x4c, 0x54, 0x31, side];
  const uv = (v: number) => { while (v >= 128) { out.push((v & 127) | 128); v = Math.floor(v / 128); } out.push(v); };
  const zz = (v: number) => (v < 0 ? -v * 2 - 1 : v * 2);
  uv(n); uv(runs.length);
  let e0 = n * 1000000, o0 = 0;
  for (const [a, b, q] of runs) { uv(zz(a - e0)); uv(b - a); uv(zz(q - o0)); uv(0); e0 = b; o0 = q; }
  return new Uint8Array(out);
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function installMapFetcher() {
  resetNavigation();
  registerLiftLinking();
  startHandoffController();
  useLiveLiftStore.setState({ enabled: true });
  setNavigationFetcher({
    json: async (u: string) => {
      if (u.includes('summary')) {
        return {
          key: 'k1', tile_bp: 1000000, outline_max_drift: 1000,
          haplotypes: ['H'], labels: { H: 'MAT' },
          sources: { S: 'H', S2: 'H' }, targets: { T: 20000, T2: 20000 },
          selected: [true, true],
          chains: [
            ['T', 1000, 7900, 'S', 0, 6990, '+', 'H', 6900, 6890],
            ['T2', 1000, 7900, 'S2', 0, 6990, '+', 'H', 6900, 6890],
          ],
        };
      }
      const p = new URL(u, 'http://x').searchParams;
      const chrom = p.get('chrom') ?? 'T';
      const src = chrom === 'T2' || chrom === 'S2' ? 'S2' : 'S';
      const tgt = chrom === 'T2' || chrom === 'S2' ? 'T2' : 'T';
      const ch = chrom === 'T2' || chrom === 'S2' ? 1 : 0;
      return { rows: [[1000, 7900, 0, 6990, '+', ch, 100, p.get('side') === 'source' ? tgt : src]] };
    },
    bytes: async (u: string) => {
      const p = new URL(u, 'http://x').searchParams;
      const side = p.get('side') === 'source' ? 1 : 0, n = Number(p.get('tile'));
      return tile(n, side, n > 0 ? [] : side
        ? [[0, 3000, 1000], [3000, 5000, 4010], [5100, 6990, 6010]]
        : [[1000, 4000, 0], [4010, 6010, 3000], [6010, 7900, 5100]]);
    },
  } as never);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('"Each panel navigates": linked source views follow the view their lifted panel shows (post-merge review, group C)', () => {
  it('a source view of a folded member follows the graph host, moves it, and follows its moves to another contig', async () => {
    installMapFetcher();
    useBrowserStore.setState({
      chrom: 'T', start: 2000, end: 3000, navigationMode: 'perPanel', isReversed: false, _lastRestoreTime: 0,
      datasets: [
        { id: 'liftA', path: '/a.bam', paths: ['/a.bam'], label: 'liftA', color: '#000', data_type: 'bam_livelift', live_lift: { key: 'k1', haplotypes: ['H'], haplotype_labels: { H: 'MAT' } } },
        { id: 'liftB', path: '/b.bam', paths: ['/b.bam'], label: 'liftB', color: '#000', data_type: 'bam_livelift', live_lift: { key: 'k1', haplotypes: ['H'], haplotype_labels: { H: 'MAT' } } },
        { id: 'nativeA', path: '/a.bam', paths: ['/a.bam'], label: 'nativeA', color: '#000', data_type: 'bam' },
        { id: 'nativeB', path: '/b.bam', paths: ['/b.bam'], label: 'nativeB', color: '#000', data_type: 'bam' },
      ],
      panels: [
        {
          id: 'host', contentType: 'dataset', datasetId: 'liftA', subTracks: [], collapsed: false, linkGroup: null,
          viewMode: 'graph', viewportOverride: { chrom: 'T', start: 2000, end: 3000 },
          graphView: { role: 'host', registrationId: 'r1', targetPathKey: 'T', targetViewport: null, linkMode: 'follow', initiatingPanelId: null, initiatingReferenceId: null, popOutKind: 'source' },
        },
        {
          id: 'joined', contentType: 'dataset', datasetId: 'liftB', subTracks: [], collapsed: true,
          graphMemberOf: 'host', collapsedByGraphGroup: 'host', linkGroup: null, liftHap: 'MAT',
          viewportOverride: { chrom: 'T', start: 2000, end: 3000 },
        },
        {
          id: 'srcA', contentType: 'dataset', datasetId: 'nativeA', subTracks: [], collapsed: false, linkGroup: null,
          viewportOverride: { chrom: 'S', start: 1000, end: 2000 },
          liftLink: { id: 'LA', datasetId: 'liftA', liftPanelId: 'host', hap: 'H', hapLabel: 'MAT', contig: 'S', flip: false, chain: null },
        },
        {
          id: 'srcB', contentType: 'dataset', datasetId: 'nativeB', subTracks: [], collapsed: false, linkGroup: null,
          viewportOverride: { chrom: 'S', start: 1000, end: 2000 },
          liftLink: { id: 'LB', datasetId: 'liftB', liftPanelId: 'joined', hap: 'H', hapLabel: 'MAT', contig: 'S', flip: false, chain: null },
        },
      ],
    } as never);

    // Confirm popOutPlan produces liftPanelId === 'joined' for the joined dataset's folded member.
    const st0 = useBrowserStore.getState();
    const plan = popOutPlan(st0.panels, st0.datasets, st0.panels[0], ['joined']);
    expect(plan.sources).toEqual([{ liftPanelId: 'joined', hap: 'MAT', fromPanelId: 'joined' }]);

    // Prime exact tiles on both datasets and both contigs (outline + exact bytes).
    for (const ds of ['liftA', 'liftB']) {
      await ensureSummary(ds, 'k1');
      mapSpan(ds, 'k1', 'toSource', { chrom: 'T', start: 1500, end: 2500 }, { hap: 'H' });
      mapSpan(ds, 'k1', 'toSource', { chrom: 'T2', start: 1500, end: 2500 }, { hap: 'H' });
      mapSpan(ds, 'k1', 'toTarget', { chrom: 'S', start: 3990, end: 6090 });
    }
    await flush();
    for (const ds of ['liftA', 'liftB']) {
      mapSpan(ds, 'k1', 'toSource', { chrom: 'T', start: 1500, end: 2500 }, { hap: 'H' });
      mapSpan(ds, 'k1', 'toSource', { chrom: 'T2', start: 1500, end: 2500 }, { hap: 'H' });
      mapSpan(ds, 'k1', 'toTarget', { chrom: 'S', start: 3990, end: 6090 });
    }
    await flush();

    // 1a. Host pans to T:1500-2500 -> srcA moves to S:500-1500, but srcB (linked to folded 'joined') stays stranded at S:1000-2000.
    useBrowserStore.getState().setPanelViewport('host', 1500, 2500);
    const srcA1 = useBrowserStore.getState().panels.find(p => p.id === 'srcA')!.viewportOverride!;
    const srcB1 = useBrowserStore.getState().panels.find(p => p.id === 'srcB')!.viewportOverride!;
    expect([srcA1.chrom, srcA1.start, srcA1.end]).toEqual(['S', 500, 1500]);
    expect([srcB1.chrom, srcB1.start, srcB1.end]).toEqual(['S', 500, 1500]);

    // 1b. srcB pans to S:3990-6090 -> mutates hidden folded 'joined' to T:5000-7000 while visible 'host' stays at T:1500-2500!
    useBrowserStore.getState().setPanelViewport('srcB', 3990, 6090);
    const hostAfterSrc = useBrowserStore.getState().panels.find(p => p.id === 'host')!.viewportOverride!;
    const joinedAfterSrc = useBrowserStore.getState().panels.find(p => p.id === 'joined')!.viewportOverride!;
    expect([hostAfterSrc.chrom, hostAfterSrc.start, hostAfterSrc.end]).toEqual(['T', 5000, 7000]);
    expect([joinedAfterSrc.chrom, joinedAfterSrc.start, joinedAfterSrc.end]).toEqual(['T', 5000, 7000]);
    // The host's own source view follows the host the other source view moved.
    const srcAAfterSrc = useBrowserStore.getState().panels.find(p => p.id === 'srcA')!.viewportOverride!;
    expect([srcAAfterSrc.chrom, srcAAfterSrc.start, srcAAfterSrc.end]).toEqual(['S', 3990, 6090]);

    // 1c. Cross-contig host navigation (GraphPanel.tsx:743 -> navigatePanelOwnView) strands even host's own srcA!
    useBrowserStore.getState().navigatePanelOwnView('host', 'T2', 1500, 2500);
    const srcA2 = useBrowserStore.getState().panels.find(p => p.id === 'srcA')!.viewportOverride!;
    expect([srcA2.chrom, srcA2.start, srcA2.end]).toEqual(['S2', 500, 1500]);
  });

  it('opening, re-choosing a chain and revealing an existing source view map the lifted panel\'s own view, not the main view', async () => {
    installMapFetcher();
    usePanelGenomeStore.setState({
      genomes: { gS: { key: 'gS', label: 'S', chroms: [{ name: 'S', size: 20000 }] } as never },
      assignments: { native: 'gS' },
    });
    useBrowserStore.setState({
      chrom: 'Unmapped', start: 0, end: 1000, navigationMode: 'perPanel', isReversed: false, error: null, _lastRestoreTime: 0,
      datasets: [
        { id: 'lift', path: '/s.bam', paths: ['/s.bam'], label: 'lift', color: '#000', data_type: 'bam_livelift', live_lift: { key: 'k1', haplotypes: ['H'], haplotype_labels: { H: 'MAT' } } },
        { id: 'native', path: '/s.bam', paths: ['/s.bam'], label: 'native', color: '#000', data_type: 'bam' },
      ],
      panels: [
        {
          id: 'mat', contentType: 'dataset', datasetId: 'lift', subTracks: [], collapsed: false, linkGroup: null,
          liftHap: 'MAT', viewportOverride: { chrom: 'T', start: 5000, end: 7000 },
        },
      ],
    } as never);
    await ensureSummary('lift', 'k1');
    mapSpan('lift', 'k1', 'toSource', { chrom: 'T', start: 5000, end: 7000 }, { hap: 'H' });
    mapSpan('lift', 'k1', 'toSource', { chrom: 'T', start: 2000, end: 3000 }, { hap: 'H' });
    await flush();

    // The lifted panel is at T:5000-7000 while the main view is on another contig: the source view opens at its view.
    const openedId = await openLinkedSourceView('mat', 'MAT');
    expect(useBrowserStore.getState().error).toBeNull();
    expect(openedId).toBeTruthy();
    const opened = useBrowserStore.getState().panels.find(p => p.id === openedId)!;
    expect([opened.viewportOverride!.chrom, opened.viewportOverride!.start, opened.viewportOverride!.end]).toEqual(['S', 3990, 6090]);
    useBrowserStore.setState({ chrom: 'T', start: 2000, end: 3000, error: null });

    // Choosing a chain maps the lifted panel's view (T:5000-7000), not the main view (T:2000-3000).
    chooseLinkChain(openedId!, 0);
    const afterChain = useBrowserStore.getState().panels.find(p => p.id === openedId)!;
    expect([afterChain.viewportOverride!.chrom, afterChain.viewportOverride!.start, afterChain.viewportOverride!.end]).toEqual(['S', 3990, 6090]);

    // 2c. Graph host at T:5000-7000 pops out an already-open collapsed source panel sitting at stale S:1000-2000 -> revealed at stale locus!
    useBrowserStore.setState(s => ({
      panels: [
        {
          id: 'host', contentType: 'dataset', datasetId: 'lift', subTracks: [], collapsed: false, linkGroup: null,
          viewMode: 'graph', viewportOverride: { chrom: 'T', start: 5000, end: 7000 },
          graphView: { role: 'host', registrationId: 'r1', targetPathKey: 'T', targetViewport: null, linkMode: 'follow', initiatingPanelId: null, initiatingReferenceId: null, popOutKind: 'source' },
        },
        ...s.panels.map(p => (p.id === 'mat'
          ? { ...p, collapsed: true, graphMemberOf: 'host', collapsedByGraphGroup: 'host', viewportOverride: { chrom: 'T', start: 5000, end: 7000 } }
          : p.id === openedId ? { ...p, collapsed: true, viewportOverride: { chrom: 'S', start: 1000, end: 2000 } } : p)),
      ],
    }) as never);
    popOutPaths('host', ['mat'], []);
    await flush();
    const revealed = useBrowserStore.getState().panels.find(p => p.id === openedId)!;
    expect(revealed.collapsed).toBe(false);
    expect([revealed.viewportOverride!.chrom, revealed.viewportOverride!.start, revealed.viewportOverride!.end]).toEqual(['S', 3990, 6090]);
  });

  it('the ribbon strip asks for the lifted panel\'s own view', async () => {
    vi.useFakeTimers();
    try {
      const urls: string[] = [];
      vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
      vi.stubGlobal('CSS', { escape: (s: string) => s });
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const u = String(input);
        urls.push(u);
        const chrom = new URL(u, 'http://x').searchParams.get('chrom') ?? 'T';
        return {
          ok: true, status: 200,
          json: async () => ({
            chrom,
            key: 'k1', start: 5000, end: 7000, min_bp: 0, alternatives_capped: 0, alternatives: false,
            pieces: chrom === 'T' ? [[5000, 7000, 3990, 6090, '+', 0, false, 'S']] : [],
            gaps: [],
          }),
        } as Response;
      }));

      useBrowserStore.setState({
        chrom: 'Unmapped', start: 0, end: 1000, navigationMode: 'perPanel', darkMode: false, isReversed: false,
        datasets: [
          { id: 'lift', path: '/s.bam', paths: ['/s.bam'], label: 'lift', color: '#000', data_type: 'bam_livelift', live_lift: { key: 'k1', haplotypes: ['H'], haplotype_labels: { H: 'MAT' } } },
          { id: 'native', path: '/s.bam', paths: ['/s.bam'], label: 'native', color: '#000', data_type: 'bam' },
        ],
        panels: [
          {
            id: 'mat', contentType: 'dataset', datasetId: 'lift', subTracks: [], collapsed: false, linkGroup: null,
            liftHap: 'MAT', viewportOverride: { chrom: 'T', start: 5000, end: 7000 },
          },
          {
            id: 'src', contentType: 'dataset', datasetId: 'native', subTracks: [], collapsed: false, linkGroup: null,
            viewportOverride: { chrom: 'S', start: 3990, end: 6090 },
            liftLink: { id: 'L1', datasetId: 'lift', liftPanelId: 'mat', hap: 'H', hapLabel: 'MAT', contig: 'S', flip: false, chain: null },
          },
        ],
      } as never);

      const track = document.createElement('div');
      track.setAttribute('data-track-panel', 'mat');
      track.setAttribute('data-track-type', 'reads');
      track.getBoundingClientRect = () => ({ left: 0, top: 0, right: 500, bottom: 100, width: 500, height: 100, x: 0, y: 0, toJSON: () => ({}) });
      document.body.appendChild(track);

      const srcPanel = useBrowserStore.getState().panels.find(p => p.id === 'src')!;
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      await act(async () => {
        root.render(<LiftRibbonStrip panel={srcPanel} width={500} height={44} sidebarWidth={0} />);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150);
      });

      expect(urls.length).toBeGreaterThan(0);
      const q = new URL(urls[0], 'http://x').searchParams;
      expect([q.get('chrom'), q.get('start'), q.get('end')]).toEqual(['T', '5000', '7000']);
      const strip = container.querySelector('[data-testid="lift-ribbon"]')!;
      expect(JSON.parse(strip.getAttribute('data-ribbon-shapes') ?? '{}').primary).toBe(1);

      await act(async () => { root.unmount(); });
      container.remove();
      track.remove();
    } finally {
      vi.useRealTimers();
    }
  });
});
