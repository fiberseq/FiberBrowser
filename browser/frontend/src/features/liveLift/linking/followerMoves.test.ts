// A panel a linked panel moves in "Each panel navigates" moves as if the user had moved it (its jump leaves its
// clusters behind, and Linked navigation goes where it is), and back in Linked navigation the linked source views
// show the main view (post-merge review, agy group C, HIGH 4).
import { beforeEach, describe, expect, it } from 'vitest';
import { useBrowserStore } from '../../../stores/browserStore';
import { ensureSummary, prefetchView } from './navigation';
import { flush, installTwoDatasetFixture, LIFT_A, NATIVE_A, viewOf } from './twoDatasetFixture';

const DATASETS = [
  { id: 'ref', path: '/r.bam', paths: ['/r.bam'], label: 'ref', color: '#000', data_type: 'bam' },
  { ...LIFT_A, live_lift: { key: 'kA', haplotypes: ['HM'], haplotype_labels: { HM: 'MAT' } } },
  NATIVE_A,
];
const SRC_LINK = { id: 'LM', datasetId: 'liftA', liftPanelId: 'mat', hap: 'HM', hapLabel: 'MAT', contig: 'S', flip: false, chain: null };
const mainView = () => { const s = useBrowserStore.getState(); return [s.chrom, s.start, s.end]; };

describe('moves a linked panel makes in "Each panel navigates" (agy group C, HIGH 4)', () => {
  beforeEach(async () => {
    installTwoDatasetFixture();
    await ensureSummary('liftA', 'kA');
    await prefetchView('liftA', 'kA', 0, 'T', 1000, 20_000);
    await prefetchView('liftA', 'kA', 1, 'S', 0, 19_000);
    await prefetchView('liftA', 'kA', 0, 'T2', 1000, 20_000);
    await prefetchView('liftA', 'kA', 1, 'S2', 0, 19_000);
    await flush();
  });

  it('a lifted panel a source view moves to another contig keeps its clusters, and Linked navigation goes where it is', () => {
    useBrowserStore.setState({
      chrom: 'T', start: 2000, end: 3000, navigationMode: 'linked', isReversed: false, _lastRestoreTime: 0, lastMovedPanels: {},
      clusterAssignments: { mat: { r1: 0 }, src: { r1: 0 } },
      datasets: DATASETS,
      panels: [
        { id: 'ref', contentType: 'dataset', datasetId: 'ref', stateKey: 'ref', subTracks: [], collapsed: false, linkGroup: null },
        { id: 'mat', contentType: 'dataset', datasetId: 'liftA', stateKey: 'mat', subTracks: [], collapsed: false, linkGroup: null, liftHap: 'MAT' },
        { id: 'src', contentType: 'dataset', datasetId: 'nativeA', stateKey: 'src', subTracks: [], collapsed: false, linkGroup: null, genome: 'gSrc',
          viewportOverride: { chrom: 'S', start: 1000, end: 2000 }, liftLink: SRC_LINK },
      ],
    } as never);
    useBrowserStore.getState().setNavigationMode('perPanel');
    useBrowserStore.getState().navigatePanel('src', 'S2', 1000, 2000);
    expect(viewOf('mat')).toEqual({ chrom: 'T2', start: 2000, end: 3000 });
    expect(useBrowserStore.getState().clusterAssignments.src).toBeUndefined();   // the panel the user moved
    expect(useBrowserStore.getState().clusterAssignments.mat).toEqual({ r1: 0 });   // the follower keeps its own
    useBrowserStore.getState().setNavigationMode('linked');
    expect(mainView()).toEqual(['T2', 2000, 3000]);
    expect(viewOf('mat')).toBeUndefined();
    expect(viewOf('src')).toEqual({ chrom: 'S2', start: 1000, end: 2000 });
  });

  it('a follower\'s pan keeps its clusters', () => {
    useBrowserStore.setState({
      chrom: 'T', start: 2000, end: 3000, navigationMode: 'perPanel', isReversed: false, _lastRestoreTime: 0, lastMovedPanels: {},
      clusterAssignments: { mat: { r1: 0 } },
      datasets: DATASETS,
      panels: [
        { id: 'mat', contentType: 'dataset', datasetId: 'liftA', stateKey: 'mat', subTracks: [], collapsed: false, linkGroup: null, liftHap: 'MAT',
          navOwn: true, viewportOverride: { chrom: 'T', start: 2000, end: 3000 } },
        { id: 'src', contentType: 'dataset', datasetId: 'nativeA', stateKey: 'src', subTracks: [], collapsed: false, linkGroup: null, genome: 'gSrc',
          viewportOverride: { chrom: 'S', start: 1000, end: 2000 }, liftLink: SRC_LINK },
      ],
    } as never);
    useBrowserStore.getState().setPanelViewport('src', 1500, 2500);
    expect(viewOf('mat')).toEqual({ chrom: 'T', start: 2500, end: 3500 });
    expect(useBrowserStore.getState().clusterAssignments.mat).toEqual({ r1: 0 });
  });

  it('back in Linked navigation, a source view left elsewhere shows the main view mapped', () => {
    useBrowserStore.setState({
      chrom: 'T', start: 2000, end: 3000, navigationMode: 'perPanel', isReversed: false, _lastRestoreTime: 0, lastMovedPanels: {},
      datasets: DATASETS,
      panels: [
        { id: 'ref', contentType: 'dataset', datasetId: 'ref', stateKey: 'ref', subTracks: [], collapsed: false, linkGroup: null,
          navOwn: true, viewportOverride: { chrom: 'T', start: 2000, end: 3000 } },
        { id: 'mat', contentType: 'dataset', datasetId: 'liftA', stateKey: 'mat', subTracks: [], collapsed: false, linkGroup: null, liftHap: 'MAT',
          navOwn: true, viewportOverride: { chrom: 'T', start: 2000, end: 3000 } },
        { id: 'src', contentType: 'dataset', datasetId: 'nativeA', stateKey: 'src', subTracks: [], collapsed: false, linkGroup: null, genome: 'gSrc',
          viewportOverride: { chrom: 'S', start: 7000, end: 8000 }, liftLink: SRC_LINK },
      ],
    } as never);
    useBrowserStore.getState().setNavigationMode('linked');
    expect(mainView()).toEqual(['T', 2000, 3000]);
    expect(viewOf('mat')).toBeUndefined();
    expect(viewOf('src')).toEqual({ chrom: 'S', start: 1000, end: 2000 });
    // One undo step: Undo puts it back where it was.
    useBrowserStore.getState().undo();
    expect(viewOf('src')).toEqual({ chrom: 'S', start: 7000, end: 8000 });
  });
});
