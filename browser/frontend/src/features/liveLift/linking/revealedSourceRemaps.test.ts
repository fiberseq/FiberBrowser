// Revealing open source views from a graph host: several at once each settle into their own undo step, the one on
// the member's strand is the one relinked, and one relinked to a panel that follows the main view shows the main view
// (post-merge review, agy group C, HIGH 3).
import { beforeEach, describe, expect, it } from 'vitest';
import { useBrowserStore } from '../../../stores/browserStore';
import { openLinkedSourceView } from './liftLink';
import { ensureSummary, prefetchView, resetNavigation } from './navigation';
import { popOutPaths } from '../../graphPanel/popOutKind';
import { flush, hold, installTwoDatasetFixture, LIFT_A, LIFT_B, NATIVE_A, NATIVE_B, panelOf, releaseHeld, viewOf } from './twoDatasetFixture';

const DATASETS = [LIFT_A, LIFT_B, NATIVE_A, NATIVE_B];
const BASE = { chrom: 'T', start: 2000, end: 3000, navigationMode: 'perPanel', isReversed: false, _lastRestoreTime: 0, lastMovedPanels: {}, datasets: DATASETS };
const host = (members: { panelId: string; binding: string }[], extra: Record<string, unknown> = {}) => ({
  id: 'host', contentType: 'dataset', datasetId: 'liftA', subTracks: [], collapsed: false, linkGroup: null, liftHap: 'MAT',
  viewMode: 'graph', navOwn: true, viewportOverride: { chrom: 'T', start: 6000, end: 8000 }, ...extra,
  graphView: { schema: 2, role: 'host', registrationId: 'r1', targetBinding: 'T', selectedPathKeys: ['T', 'HM', 'HP'], members, popOutKind: 'source' },
});
const member = (id: string, datasetId: string, liftHap: string, extra: Record<string, unknown> = {}) => ({
  id, contentType: 'dataset', datasetId, subTracks: [], collapsed: true, graphMemberOf: 'host', collapsedByGraphGroup: 'host',
  navOwn: true, linkGroup: null, liftHap, viewportOverride: { chrom: 'T', start: 6000, end: 8000 }, ...extra,
});
const source = (id: string, datasetId: string, liftPanelId: string, hap: string, hapLabel: string, contig: string, extra: Record<string, unknown> = {}) => ({
  id, contentType: 'dataset', datasetId, subTracks: [], collapsed: true, linkGroup: null, genome: 'gSrc',
  viewportOverride: { chrom: contig, start: 1000, end: 2000 }, ...extra,
  liftLink: { id: `L-${id}`, datasetId: datasetId === 'nativeB' ? 'liftB' : 'liftA', liftPanelId, hap, hapLabel, contig, flip: false, chain: null },
});

describe('revealing open source views (agy group C, HIGH 3)', () => {
  beforeEach(() => { installTwoDatasetFixture(); });

  it('Pop out of an open source view waiting on its tiles and a new one: both come out at once, nothing waits (agy group C round 2)', async () => {
    hold.targetA = true;
    await ensureSummary('liftB', 'kB');
    await prefetchView('liftB', 'kB', 0, 'T', 1000, 20_000);
    await prefetchView('liftB', 'kB', 1, 'P', 0, 19_000);
    await flush();
    useBrowserStore.setState({ ...BASE, panels: [
      host([{ panelId: 'host', binding: 'HM' }, { panelId: 'joined', binding: 'HP' }]),
      member('joined', 'liftB', 'PAT'),
      source('srcA', 'nativeA', 'host', 'HM', 'MAT', 'S'),
    ] } as never);
    useBrowserStore.getState().clearHistory();
    popOutPaths('host', ['host', 'joined']);
    await flush();
    // The open one is shown and the new one opened, while the first one's tiles are still held.
    expect(panelOf('srcA')?.collapsed).toBe(false);
    expect(useBrowserStore.getState().panels.some(p => p.liftLink?.datasetId === 'liftB')).toBe(true);
    await releaseHeld();
    expect(panelOf('srcA')?.collapsed).toBe(false);
  });

  it('Pop out of two open source views waiting on their tiles: both come out at once; the latest settles in its step; Undo steps back one at a time', async () => {
    hold.targetA = true;
    useBrowserStore.setState({ ...BASE, panels: [
      host([{ panelId: 'host', binding: 'HM' }, { panelId: 'pat', binding: 'HP' }]),
      member('pat', 'liftA', 'PAT'),
      source('srcMat', 'nativeA', 'host', 'HM', 'MAT', 'S'),
      source('srcPat', 'nativeA', 'host', 'HP', 'PAT', 'P'),
    ] } as never);
    useBrowserStore.getState().clearHistory();
    popOutPaths('host', ['host', 'pat']);
    await flush();
    expect(panelOf('srcMat')?.collapsed).toBe(false);
    expect(panelOf('srcPat')?.collapsed).toBe(false);
    await releaseHeld();
    expect(viewOf('srcPat')).toEqual({ chrom: 'P', start: 5000, end: 7000 });
    // Undo "Show PAT source view": PAT folds away again, MAT stays shown.
    useBrowserStore.getState().undo();
    expect(panelOf('srcPat')?.collapsed).toBe(true);
    expect(panelOf('srcMat')?.collapsed).toBe(false);
  });

  it('source views split by strand: the member\'s strand is the one relinked and remapped', async () => {
    resetNavigation();
    await ensureSummary('liftA', 'kA');
    await prefetchView('liftA', 'kA', 0, 'T', 1000, 20_000);
    await prefetchView('liftA', 'kA', 1, 'S', 0, 19_000);
    await flush();
    useBrowserStore.setState({ ...BASE, panels: [
      { ...host([{ panelId: 'host', binding: 'HM' }, { panelId: 'matGA', binding: 'HM' }], { strand: 'CT' }) },
      member('matGA', 'liftA', 'MAT', { strand: 'GA' }),
      { id: 'oldCopy', contentType: 'dataset', datasetId: 'liftA', subTracks: [], collapsed: false, linkGroup: null, liftHap: 'MAT', ownLocus: true,
        viewportOverride: { chrom: 'T', start: 2000, end: 3000 } },
      source('srcCT', 'nativeA', 'oldCopy', 'HM', 'MAT', 'S', { strand: 'CT' }),
      source('srcGA', 'nativeA', 'oldCopy', 'HM', 'MAT', 'S', { strand: 'GA' }),
    ] } as never);
    popOutPaths('host', ['matGA']);
    await flush();
    expect(panelOf('srcGA')?.collapsed).toBe(false);
    expect(panelOf('srcGA')?.liftLink?.liftPanelId).toBe('host');
    expect(viewOf('srcGA')).toEqual({ chrom: 'S', start: 5000, end: 7000 });
    expect(panelOf('srcCT')?.liftLink?.liftPanelId).toBe('oldCopy');
    expect(viewOf('srcCT')).toEqual({ chrom: 'S', start: 1000, end: 2000 });
  });

  it('relinked from a copy at its own locus to a panel following the main view: it shows the main view mapped', async () => {
    await ensureSummary('liftA', 'kA');
    await prefetchView('liftA', 'kA', 0, 'T', 1000, 20_000);
    await prefetchView('liftA', 'kA', 1, 'S', 0, 19_000);
    await flush();
    useBrowserStore.setState({ ...BASE, navigationMode: 'linked', panels: [
      { id: 'matMain', contentType: 'dataset', datasetId: 'liftA', subTracks: [], collapsed: false, linkGroup: null, liftHap: 'MAT' },
      { id: 'matCopy', contentType: 'dataset', datasetId: 'liftA', subTracks: [], collapsed: false, linkGroup: null, liftHap: 'MAT', ownLocus: true,
        viewportOverride: { chrom: 'T', start: 8000, end: 10000 } },
      source('srcMat', 'nativeA', 'matCopy', 'HM', 'MAT', 'S', { collapsed: false, viewportOverride: { chrom: 'S', start: 7000, end: 9000 } }),
    ] } as never);
    await openLinkedSourceView('matMain', 'MAT');
    expect(panelOf('srcMat')?.liftLink?.liftPanelId).toBe('matMain');
    expect(viewOf('srcMat')).toEqual({ chrom: 'S', start: 1000, end: 2000 });
  });
});
