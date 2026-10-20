import { expect, it } from 'vitest';
import '../../features/testSetup';
import { createTestStore } from './helpers';
import { useLiveLiftStore } from '../../features/liveLift/store';
import { mainViewForPanel } from '../../utils/panelExtensions';

// A view-linked panel (here a native alternate-allele panel, live lift off) moved by its locus box takes the main
// view with it; both moves are one undo step, so undo and redo restore a consistent pair.
const layout = { name: 'alt1', chrom: 'chr1', ref: 10000, flank_left: 10000, insert_start: 10000, insert_end: 11000, insert_len: 1000, length: 21000 };
it('a linked panel\'s typed locus and the main view it moves are one undo step', () => {
  useLiveLiftStore.setState({ enabled: false });
  const s = createTestStore();
  const p = { id: 'alt', contentType: 'dataset', datasetId: 'native-alt', subTracks: [], collapsed: false, linkGroup: null,
    ownLocus: true, viewportOverride: { chrom: 'alt1', start: 1000, end: 2000 },
    altAllele: { linked: true, cluster: { datasetId: 'native' }, layout } } as never;
  s.setState({ panels: [p], chrom: 'chr1', start: 1000, end: 2000 });
  expect(mainViewForPanel(p, { chrom: 'alt1', start: 15000, end: 16000 })).toEqual({ chrom: 'chr1', start: 14000, end: 15000 });
  s.getState().clearHistory();
  s.getState().pushSnapshot('before', { kind: 'layout' });
  s.getState().navigatePanel('alt', 'alt1', 15000, 16000);
  expect(s.getState().start).toBe(14000);
  s.getState().undo();
  expect(s.getState().start).toBe(1000);
  expect(s.getState().panels[0].viewportOverride).toMatchObject({ start: 1000, end: 2000 });
  s.getState().redo();
  expect(s.getState().start).toBe(14000);
  expect(s.getState().panels[0].viewportOverride).toMatchObject({ start: 15000, end: 16000 });
});

it('a panel without a view link moves only itself', () => {
  const s = createTestStore();
  s.setState({ panels: [{ id: 'n', contentType: 'dataset', datasetId: 'n', subTracks: [], collapsed: false, linkGroup: null,
    viewportOverride: { chrom: 'chr2', start: 1000, end: 2000 } } as never], chrom: 'chr1', start: 1000, end: 2000 });
  s.getState().navigatePanel('n', 'chr2', 5000, 6000);
  expect(s.getState().panels[0].viewportOverride).toMatchObject({ chrom: 'chr2', start: 5000, end: 6000 });
  expect([s.getState().chrom, s.getState().start]).toEqual(['chr1', 1000]);
});
