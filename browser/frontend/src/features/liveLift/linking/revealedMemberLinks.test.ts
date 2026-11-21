// A graph host's revealed member (handed off to linear, "View as linear", a 'both' pop-out) moves in step with the
// host, so its linked source view follows the host's moves and moves the host (post-merge review, agy group C, HIGH 1).
import { beforeEach, describe, expect, it } from 'vitest';
import { useBrowserStore } from '../../../stores/browserStore';
import { ensureSummary, prefetchView } from './navigation';
import { applyShown } from '../../graphPanel/handoff';
import { leaveGraph } from '../../graphPanel/hostMode';
import { popOutPaths } from '../../graphPanel/popOutKind';
import { flush, installTwoDatasetFixture, LIFT_A, LIFT_B, NATIVE_A, NATIVE_B, panelOf, viewOf } from './twoDatasetFixture';

async function setup() {
  installTwoDatasetFixture();
  await ensureSummary('liftA', 'kA');
  await ensureSummary('liftB', 'kB');
  await prefetchView('liftA', 'kA', 0, 'T', 1000, 90_000);
  await prefetchView('liftA', 'kA', 1, 'S', 0, 89_000);
  await prefetchView('liftB', 'kB', 0, 'T', 1000, 90_000);
  await prefetchView('liftB', 'kB', 1, 'P', 0, 89_000);
  await flush();
  useBrowserStore.setState({
    chrom: 'T', start: 2000, end: 3000, navigationMode: 'perPanel', isReversed: false, _lastRestoreTime: 0, lastMovedPanels: {},
    datasets: [{ ...LIFT_A, live_lift: { key: 'kA', haplotypes: ['HM'], haplotype_labels: { HM: 'MAT' } } }, LIFT_B, NATIVE_A, NATIVE_B],
    panels: [
      { id: 'host', contentType: 'dataset', datasetId: 'liftA', subTracks: [], collapsed: false, linkGroup: null,
        viewMode: 'graph', navOwn: true, viewportOverride: { chrom: 'T', start: 5000, end: 15000 },
        graphView: { schema: 2, role: 'host', registrationId: 'r1', targetBinding: 'T', selectedPathKeys: ['T', 'HM', 'HP'],
          members: [{ panelId: 'host', binding: 'HM' }, { panelId: 'joined', binding: 'HP' }],
          handoff: { pinnedLinear: false, shown: 'graph' }, popOutKind: 'source' } },
      { id: 'joined', contentType: 'dataset', datasetId: 'liftB', subTracks: [], collapsed: true,
        graphMemberOf: 'host', collapsedByGraphGroup: 'host', navOwn: true, linkGroup: null, liftHap: 'PAT',
        viewportOverride: { chrom: 'T', start: 5000, end: 15000 } },
      { id: 'srcA', contentType: 'dataset', datasetId: 'nativeA', subTracks: [], collapsed: false, linkGroup: null, genome: 'gSrc',
        viewportOverride: { chrom: 'S', start: 4000, end: 14000 },
        liftLink: { id: 'LA', datasetId: 'liftA', liftPanelId: 'host', hap: 'HM', hapLabel: 'MAT', contig: 'S', flip: false, chain: null } },
      { id: 'srcB', contentType: 'dataset', datasetId: 'nativeB', subTracks: [], collapsed: false, linkGroup: null, genome: 'gSrc',
        viewportOverride: { chrom: 'P', start: 4000, end: 14000 },
        liftLink: { id: 'LB', datasetId: 'liftB', liftPanelId: 'joined', hap: 'HP', hapLabel: 'PAT', contig: 'P', flip: false, chain: null } },
    ],
  } as never);
}

describe('a revealed graph member in step with its host links its source view through the host (agy group C, HIGH 1)', () => {
  beforeEach(setup);

  it('after a hand-off to linear: the host moves the member\'s source view, and that source view moves the host', () => {
    useBrowserStore.setState(s => ({ panels: applyShown(s.panels, 'host', 'linear', 'complexity') }));
    expect(panelOf('joined')?.graphHandoff).toBe('host');
    useBrowserStore.getState().setPanelViewport('host', 20000, 30000);
    expect(viewOf('joined')).toEqual({ chrom: 'T', start: 20000, end: 30000 });
    expect(viewOf('srcA')).toEqual({ chrom: 'S', start: 19000, end: 29000 });
    expect(viewOf('srcB')).toEqual({ chrom: 'P', start: 19000, end: 29000 });
    useBrowserStore.getState().setPanelViewport('srcB', 30000, 40000);
    expect(viewOf('host')).toEqual({ chrom: 'T', start: 31000, end: 41000 });
    expect(viewOf('joined')).toEqual({ chrom: 'T', start: 31000, end: 41000 });
    expect(viewOf('srcA')).toEqual({ chrom: 'S', start: 30000, end: 40000 });
    // Still in step: back to the graph folds it again.
    const back = applyShown(useBrowserStore.getState().panels, 'host', 'graph');
    expect(back.find(p => p.id === 'joined')?.collapsedByGraphGroup).toBe('host');
  });

  it('after "View as linear": the member\'s source view follows the host', () => {
    useBrowserStore.setState(s => ({ panels: leaveGraph(s.panels, 'host') }));
    expect(panelOf('joined')?.collapsedByGraphGroup).toBeUndefined();
    useBrowserStore.getState().setPanelViewport('host', 20000, 30000);
    expect(viewOf('joined')).toEqual({ chrom: 'T', start: 20000, end: 30000 });
    expect(viewOf('srcB')).toEqual({ chrom: 'P', start: 19000, end: 29000 });
  });

  it('a \'both\' pop-out: the paired source view follows the host while the member is in step', async () => {
    useBrowserStore.setState(s => ({ panels: s.panels.map(p => {
      if (p.id === 'host') return { ...p, graphView: { ...p.graphView!, popOutKind: 'both' } };
      if (p.id === 'srcB') return { ...p, collapsed: true };
      return p;
    }) }) as never);
    popOutPaths('host', ['joined']);
    await flush();
    expect(panelOf('joined')?.collapsed).toBe(false);
    expect(panelOf('srcB')?.collapsed).toBe(false);
    useBrowserStore.getState().setPanelViewport('host', 25000, 35000);
    expect(viewOf('joined')).toEqual({ chrom: 'T', start: 25000, end: 35000 });
    expect(viewOf('srcB')).toEqual({ chrom: 'P', start: 24000, end: 34000 });
  });

  it('a member the user moved elsewhere stays detached: its source view follows it, not the host', () => {
    useBrowserStore.setState(s => ({ panels: applyShown(s.panels, 'host', 'linear', 'complexity') }));
    useBrowserStore.getState().setPanelViewport('joined', 40000, 50000);
    expect(viewOf('host')).toEqual({ chrom: 'T', start: 5000, end: 15000 });
    expect(viewOf('srcB')).toEqual({ chrom: 'P', start: 39000, end: 49000 });
    useBrowserStore.getState().setPanelViewport('srcB', 60000, 70000);
    expect(viewOf('joined')).toEqual({ chrom: 'T', start: 61000, end: 71000 });
    expect(viewOf('host')).toEqual({ chrom: 'T', start: 5000, end: 15000 });
    useBrowserStore.getState().setPanelViewport('host', 6000, 16000);
    expect(viewOf('joined')).toEqual({ chrom: 'T', start: 61000, end: 71000 });
    expect(viewOf('srcB')).toEqual({ chrom: 'P', start: 60000, end: 70000 });
  });
});
