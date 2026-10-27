// Late source-view remaps and Undo/Redo (post-merge review, agy group C round 3, NEW HIGH 2; adapted from its probes
// 2a-2d): a reveal's late exact remap lands while Redo exists, the header menu reveals the source view on the lifted
// panel's strand, and a 'panel' correction is part of the step that scheduled it.
import { beforeEach, describe, expect, it } from 'vitest';
import { useBrowserStore } from '../../../stores/browserStore';
import { openLinkedSourceView } from './liftLink';
import { ensureSummary, prefetchView, resetNavigation } from './navigation';
import { popOutPaths } from '../../graphPanel/popOutKind';
import { flush, hold, installTwoDatasetFixture, LIFT_A, NATIVE_A, panelOf, releaseHeld, viewOf } from './twoDatasetFixture';

const BASE = { chrom: 'T', start: 2000, end: 3000, navigationMode: 'perPanel', isReversed: false, _lastRestoreTime: 0, lastMovedPanels: {},
  datasets: [LIFT_A, NATIVE_A] };
const lifted = (id: string, extra: Record<string, unknown> = {}) => ({
  id, contentType: 'dataset', datasetId: 'liftA', stateKey: id, liftHap: 'MAT', subTracks: [], collapsed: false, linkGroup: null, ...extra,
});
const source = (id: string, liftPanelId: string, extra: Record<string, unknown> = {}) => ({
  id, contentType: 'dataset', datasetId: 'nativeA', stateKey: id, subTracks: [], collapsed: false, linkGroup: null, genome: 'gSrc',
  viewportOverride: { chrom: 'S2', start: 1000, end: 2000 }, ...extra,
  liftLink: { id: `L-${id}`, datasetId: 'liftA', liftPanelId, hap: 'HM', hapLabel: 'MAT', contig: 'S', flip: false, chain: null },
});

/** The source view's locus in the current undo step. */
const recorded = (id: string) => {
  const st = useBrowserStore.getState();
  return st._historyStack[st._historyPointer]?.state.panels?.find(p => p.id === id)?.viewportOverride;
};

/** A lifted MAT panel at its own view T:6000-8000 and its source view left on S2, with a Redo step on the stack. */
async function revealWithRedo() {
  hold.targetA = true;
  await prefetchView('liftA', 'kA', 1, 'S', 0, 19_000);
  await flush();
  useBrowserStore.setState({ ...BASE, panels: [
    lifted('mat', { navOwn: true, viewportOverride: { chrom: 'T', start: 6000, end: 8000 } }),
    source('src', 'mat'),
  ] } as never);
  useBrowserStore.getState().clearHistory();
  useBrowserStore.getState().setPanelReversed('mat', true);
  useBrowserStore.getState().undo();
  // (A restore time no later Undo/Redo can share.)
  useBrowserStore.setState({ _lastRestoreTime: 0 } as never);
  expect(useBrowserStore.getState().canRedo()).toBe(true);
  // "Open MAT source view" from the lifted panel's menu: it records no step of its own.
  await openLinkedSourceView('mat', 'MAT');
  await flush();
}

describe('late source-view remaps and Undo/Redo (agy group C round 3, NEW HIGH 2)', () => {
  beforeEach(() => { installTwoDatasetFixture(); });

  it('2a: "Open source view" after an Undo (Redo exists): the late exact remap still lands, and Redo stays', async () => {
    await revealWithRedo();
    expect(viewOf('src')).toEqual({ chrom: 'S2', start: 1000, end: 2000 });   // still waiting on its tiles
    await releaseHeld();
    expect(viewOf('src')).toEqual({ chrom: 'S', start: 5000, end: 7000 });
    expect(useBrowserStore.getState().canRedo()).toBe(true);
  });

  it('2a: the late remap is dropped after a Redo moved the history', async () => {
    await revealWithRedo();
    useBrowserStore.getState().redo();
    await releaseHeld();
    expect(viewOf('src')).toEqual({ chrom: 'S2', start: 1000, end: 2000 });
  });

  it('2a: the late remap is dropped after a Redo and an Undo back to the same step', async () => {
    await revealWithRedo();
    useBrowserStore.getState().redo();
    useBrowserStore.getState().undo();
    await releaseHeld();
    expect(viewOf('src')).toEqual({ chrom: 'S2', start: 1000, end: 2000 });
  });

  it('2a: the late remap is dropped after a later step', async () => {
    await revealWithRedo();
    useBrowserStore.getState().setPanelReversed('mat', true);
    await releaseHeld();
    expect(viewOf('src')).toEqual({ chrom: 'S2', start: 1000, end: 2000 });
  });

  it('2b: "Open MAT source view" on the GA panel reveals the GA source view, never the CT panel\'s', async () => {
    await ensureSummary('liftA', 'kA');
    await prefetchView('liftA', 'kA', 0, 'T', 1000, 20_000);
    await flush();
    useBrowserStore.setState({ ...BASE, panels: [
      lifted('matCT', { strand: 'CT', navOwn: true, viewportOverride: { chrom: 'T', start: 2000, end: 3000 } }),
      lifted('matGA', { strand: 'GA', navOwn: true, viewportOverride: { chrom: 'T', start: 8000, end: 9000 } }),
      source('srcCT', 'matCT', { strand: 'CT', viewportOverride: { chrom: 'S', start: 1000, end: 2000 } }),
      source('srcGA', 'matGA', { strand: 'GA', viewportOverride: { chrom: 'S', start: 1000, end: 2000 } }),
    ] } as never);
    expect(await openLinkedSourceView('matGA', 'MAT')).toBe('srcGA');
    expect(panelOf('srcCT')?.liftLink?.liftPanelId).toBe('matCT');
    expect(viewOf('srcCT')).toEqual({ chrom: 'S', start: 1000, end: 2000 });
    expect(panelOf('srcGA')?.liftLink?.liftPanelId).toBe('matGA');
    expect(viewOf('srcGA')).toEqual({ chrom: 'S', start: 7000, end: 8000 });
  });

  it('2c: Linked navigation while the tiles load: the source view\'s correction is part of its step (Undo then Redo keeps it)', async () => {
    resetNavigation();
    hold.targetA = true;
    useBrowserStore.setState({ ...BASE, start: 5000, end: 7000, panels: [
      lifted('mat', { navOwn: true, viewportOverride: { chrom: 'T', start: 5000, end: 7000 } }),
      source('src', 'mat'),
    ] } as never);
    useBrowserStore.getState().clearHistory();
    useBrowserStore.getState().setNavigationMode('linked');
    await releaseHeld();
    expect(viewOf('src')).toEqual({ chrom: 'S', start: 4000, end: 6000 });
    expect(recorded('src')).toEqual({ chrom: 'S', start: 4000, end: 6000 });
    useBrowserStore.getState().undo();
    expect(useBrowserStore.getState().navigationMode).toBe('perPanel');
    expect(viewOf('src')).toEqual({ chrom: 'S2', start: 1000, end: 2000 });
    useBrowserStore.getState().redo();
    expect(useBrowserStore.getState().navigationMode).toBe('linked');
    expect(viewOf('src')).toEqual({ chrom: 'S', start: 4000, end: 6000 });
  });

  it('2d: a source view relinked to a graph host that follows the main view, while the tiles load: Undo then Redo keeps its correction', async () => {
    resetNavigation();
    hold.targetA = true;
    useBrowserStore.setState({ ...BASE, start: 5000, end: 7000, navigationMode: 'linked', panels: [
      lifted('host', { viewMode: 'graph', graphView: { role: 'host', registrationId: 'r1', targetPathKey: 'T', targetViewport: null, linkMode: 'follow',
        initiatingPanelId: null, initiatingReferenceId: null, popOutKind: 'source', members: [{ panelId: 'host', binding: 'HM' }] } }),
      lifted('matCopy', { ownLocus: true, viewportOverride: { chrom: 'T2', start: 2000, end: 3000 } }),
      source('src', 'matCopy', { collapsed: true }),
    ] } as never);
    useBrowserStore.getState().clearHistory();
    popOutPaths('host', ['host']);
    await releaseHeld();
    expect(panelOf('src')?.liftLink?.liftPanelId).toBe('host');
    expect(viewOf('src')).toEqual({ chrom: 'S', start: 4000, end: 6000 });
    expect(recorded('src')).toEqual({ chrom: 'S', start: 4000, end: 6000 });
    useBrowserStore.getState().undo();
    expect(panelOf('src')?.collapsed).toBe(true);
    expect(viewOf('src')).toEqual({ chrom: 'S2', start: 1000, end: 2000 });
    useBrowserStore.getState().redo();
    expect(panelOf('src')?.collapsed).toBe(false);
    expect(viewOf('src')).toEqual({ chrom: 'S', start: 4000, end: 6000 });
  });
});
