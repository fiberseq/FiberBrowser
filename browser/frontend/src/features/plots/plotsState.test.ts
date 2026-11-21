/**
 * The Gallery and the session: packed matrices round-trip; explicit keeping (one working card per plot, updated in
 * place by settings changes, pans and re-runs; Keep, Duplicate and Compare add Gallery cards; versions under a kept
 * card; closing a plot drops its working card, with an undo); old sessions' auto-cards load as kept (starred) or older
 * auto-saved (capped, cleared in one go); rename, delete, Replace; the session carries the Gallery and the builder and
 * restores them; Open restores the browser state as one undo step and puts the plot back drawn from its data.
 */
import '../testSetup';
import { beforeEach, describe, expect, it } from 'vitest';
import { useBrowserStore } from '../../stores/browserStore';
import { applyImportedState, collectFrontendState } from '../../api/session';
import { DEFAULT_FOLLOW_DELAY_MS, newPlot } from './plotModel';
import { emptyPlotsWorkspace, normalizeFollowDelay, normalizePlotsWorkspace } from './plotsState';
import {
  clearLegacy, closeWorking, duplicateEntry, emptyGallery, keepEntry, keptEntries, legacyEntries, normalizeGallery, packMatrix, recordInGallery, removeEntry,
  replaceEntry, restoreWorking, setCap, unpackMatrix, updateEntry, useGalleryStore, workingEntries, workingFor, workingIsKept, type GalleryInput,
} from './gallery';
import { closePlotCard, keepPlotEntry, openEntry, recordResult, remakeEntry, undoClosePlot, useGallerySeed } from './galleryActions';
import { useWorkspaceStore } from './workspace';

const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const sizeData = (n: number, v = 2) => ({
  matrix: [[v, v * 2, null], [0, v / 3, v]], size_min: 10, size_max: 30, size_bin: 10, pos_bin: 10, mode: 'span', normalization: 'row',
  row_min_footprints: 20, sigma_size_bp: 10, sigma_pos_bp: 20, group_by: 'all', n_reads: n, n_footprints: n * 10,
}) as never;
const input = (key: string, patch: Partial<GalleryInput> = {}): GalleryInput => ({
  plot: newPlot(), computedFor: { chrom: 'chr1', start: 100, end: 2100, genome: null }, requestKey: key,
  byPanel: { p1: { '-1': sizeData(10) } }, items: [{ id: 'p1|all', title: 'D1' }], thumb: '', datasets: ['D1'], ...patch,
});

describe('packed matrices', () => {
  it('round-trip within 16-bit precision, blanks kept', () => {
    const m = [[1.5, null, 1000], [0, 3.25, -2]];
    const back = unpackMatrix(packMatrix(m));
    expect(back[0][1]).toBeNull();
    for (const [i, j] of [[0, 0], [0, 2], [1, 0], [1, 1], [1, 2]]) expect(back[i][j]!).toBeCloseTo(m[i][j]!, 1);
    expect(Math.abs(back[1][1]! - 3.25)).toBeLessThan(1002 / 65534 + 1e-9);
    expect(unpackMatrix(packMatrix([[4, 4], [null, 4]]))).toEqual([[4, 4], [null, 4]]);
    expect(unpackMatrix(packMatrix([]))).toEqual([]);
  });
});

describe('Gallery: explicit keeping', () => {
  const at = (start: number) => ({ chrom: 'chr1', start, end: start + 2000, genome: null });
  const plot = newPlot();

  it('10 settings changes plus pans leave 0 Gallery cards and 1 working card; Keep adds exactly 1', () => {
    let g = emptyGallery();
    let p = plot;
    for (let i = 0; i < 10; i++) {
      p = { ...p, type: i % 2 ? 'vplot' : 'size-enrichment', size: { ...p.size, sigmaPosBp: 10 + i } };
      g = recordInGallery(g, input(`set${i}`, { plot: p, computedFor: at(100) }), { v: i }).gallery;
      for (const start of [600, 1100]) g = recordInGallery(g, input(`set${i}@${start}`, { plot: p, computedFor: at(start) }), { v: start }).gallery;
    }
    expect(keptEntries(g)).toHaveLength(0);
    expect(workingEntries(g)).toHaveLength(1);
    expect(workingFor(g, plot.id)).toMatchObject({ requestKey: 'set9@1100', computedFor: at(1100) });
    // Its old browser states went with the updates.
    expect(Object.keys(g.states)).toHaveLength(1);
    const k = keepEntry(g, workingFor(g, plot.id)!.id);
    g = k.gallery;
    expect(keptEntries(g)).toHaveLength(1);
    expect(workingEntries(g)).toHaveLength(1);
    expect(k.kept).toMatchObject({ status: 'kept', starred: true, requestKey: 'set9@1100', parentId: null });
    expect(workingIsKept(workingFor(g, plot.id))).toBe(true);
    // The working plot carries on: the kept copy stays frozen.
    g = recordInGallery(g, input('later', { plot: p, computedFor: at(5000) }), {}).gallery;
    expect(keptEntries(g)[0].requestKey).toBe('set9@1100');
    expect(workingIsKept(workingFor(g, plot.id))).toBe(false);
  });

  it('the same request with the same settings again changes nothing', () => {
    const a = recordInGallery(emptyGallery(), input('k1', { plot }), {});
    expect(a.created).toBe(true);
    const b = recordInGallery(a.gallery, input('k1', { plot }), {});
    expect(b.gallery).toBe(a.gallery);
    expect(b.created).toBe(false);
  });

  it('versions: a plot opened from a kept card keeps as a version under it; Replace swaps it in', () => {
    let g = recordInGallery(emptyGallery(), input('orig', { plot }), {}).gallery;
    const orig = keepEntry(g, g.entries[0].id, 'Original');
    g = orig.gallery;
    const opened = newPlot();
    g = recordInGallery(g, input('v2', { plot: opened, parentId: orig.kept!.id }), {}).gallery;
    const v = keepEntry(g, workingFor(g, opened.id)!.id);
    g = v.gallery;
    expect(v.kept!.parentId).toBe(orig.kept!.id);
    expect(keptEntries(g)).toHaveLength(2);
    // Replace original: the working plot's content takes the kept card's place, name and id; the working card stays.
    g = recordInGallery(g, input('v3', { plot: opened, parentId: orig.kept!.id }), {}).gallery;
    g = replaceEntry(g, orig.kept!.id, workingFor(g, opened.id)!.id);
    expect(g.entries.find(e => e.id === orig.kept!.id)).toMatchObject({ name: 'Original', status: 'kept', requestKey: 'v3' });
    expect(workingFor(g, opened.id)).not.toBeNull();
  });

  it('Duplicate adds a kept copy; delete removes a card and its unused state', () => {
    let g = recordInGallery(emptyGallery(), input('k', { plot }), { s: 1 }).gallery;
    const d = duplicateEntry(g, g.entries[0].id);
    g = d.gallery;
    expect(keptEntries(g)).toHaveLength(1);
    expect(d.kept!.status).toBe('kept');
    g = removeEntry(g, d.kept!.id);
    expect(keptEntries(g)).toHaveLength(0);
    expect(Object.keys(g.states)).toHaveLength(1);
  });

  it('closing a plot drops its working card (kept copies stay); undo brings it back', () => {
    let g = recordInGallery(emptyGallery(), input('k', { plot }), { s: 1 }).gallery;
    g = keepEntry(g, g.entries[0].id).gallery;
    const c = closeWorking(g, plot.id);
    expect(workingEntries(c.gallery)).toHaveLength(0);
    expect(keptEntries(c.gallery)).toHaveLength(1);
    g = restoreWorking(c.gallery, c.removed!, { s: 1 });
    expect(workingFor(g, plot.id)?.id).toBe(c.removed!.id);
  });

  it('a card\'s name is its plot\'s name: renaming the card renames the plot it carries', () => {
    let g = recordInGallery(emptyGallery(), input('k', { plot }), {}).gallery;
    g = updateEntry(g, g.entries[0].id, { name: 'Promoters' });
    expect(g.entries[0].name).toBe('Promoters');
    expect(g.entries[0].plot.name).toBe('Promoters');
  });

  it('an old session: starred auto-cards load kept, the rest as older auto-saved (capped, cleared in one go)', () => {
    const e = (id: string, starred: boolean) => ({ ...plain(recordInGallery(emptyGallery(), input(id, { plot }), { x: 1 }).gallery.entries[0]), id, starred, status: undefined, plotId: undefined });
    const states = plain(recordInGallery(emptyGallery(), input('k', { plot }), { x: 1 }).gallery.states);
    const raw = { version: 1, cap: 2, liveId: 'a', entries: [e('a', true), e('b', false), e('c', false), e('d', false)], states };
    let g = normalizeGallery(raw);
    expect(keptEntries(g).map(x => x.id)).toEqual(['a']);
    expect(legacyEntries(g).map(x => x.id)).toEqual(['c', 'd']);
    expect(workingEntries(g)).toHaveLength(0);
    g = clearLegacy(g);
    expect(g.entries.map(x => x.id)).toEqual(['a']);
    // The cap applies only to the legacy group: kept cards have none.
    let many = emptyGallery();
    for (let i = 0; i < 60; i++) {
      many = recordInGallery(many, input(`k${i}`, { plot }), {}).gallery;
      many = keepEntry(many, workingFor(many, plot.id)!.id).gallery;
    }
    expect(keptEntries(setCap(many, 1))).toHaveLength(60);
  });

  it('a stored Gallery normalises: entries without their browser state or data are left out', () => {
    const g = recordInGallery(emptyGallery(), input('k', { plot }), { x: 1 }).gallery;
    const raw = plain(g) as unknown as Record<string, unknown>;
    (raw.entries as unknown[]).push({ id: 'bad' }, { ...(raw.entries as Record<string, unknown>[])[0], id: 'orphan', stateId: 'missing' });
    const back = normalizeGallery(raw);
    expect(back.entries.map(e => e.requestKey)).toEqual(['k']);
    expect(back.entries[0].status).toBe('working');
    expect(normalizeGallery(null).entries).toEqual([]);
  });
});

describe('builder state', () => {
  it('normalises: bad parts fall back, the delay is clamped', () => {
    const ws = normalizePlotsWorkspace({ current: 'junk', followDelayMs: 99999, openedFrom: 7 });
    expect(ws.followDelayMs).toBe(5000);
    expect(ws.openedFrom).toBeNull();
    expect(normalizeFollowDelay('x')).toBe(DEFAULT_FOLLOW_DELAY_MS);
  });
});

describe('session, Open and Remake', () => {
  beforeEach(() => {
    useBrowserStore.setState({ plotsWorkspace: emptyPlotsWorkspace(), _historyStack: [], _historyPointer: -1, _lastRestoreTime: 0, _historyPaused: false } as never);
    useGalleryStore.setState(emptyGallery(), true);
    useGallerySeed.getState().set(null);
  });

  it('the session carries the Gallery (data, thumbnails, states) and the builder, and restores them', () => {
    useBrowserStore.getState().setViewport('chr1', 1000, 3000);
    recordResult(input('k1', { thumb: 'data:image/jpeg;base64,AAAA' }));
    keepPlotEntry(useGalleryStore.getState().entries[0].id, 'Kept');
    useBrowserStore.getState().setPlotsWorkspace(ws => ({ ...ws, followDelayMs: 750 }));
    const gallery = plain(useGalleryStore.getState());
    const frontend = plain(collectFrontendState());
    expect(frontend.plotsGallery).toEqual(gallery);
    expect((frontend.plotsWorkspace as { followDelayMs: number }).followDelayMs).toBe(750);
    // The Gallery is not inside the browser states it keeps.
    expect(JSON.stringify(Object.values(gallery.states))).not.toContain('plotsGallery');

    useGalleryStore.setState(emptyGallery(), true);
    applyImportedState({ success: true, viewport: { chrom: 'chr1', start: 0, end: 5000 }, datasets: [], frontend });
    expect(plain(useGalleryStore.getState())).toEqual(gallery);
    expect(keptEntries(useGalleryStore.getState())[0]).toMatchObject({ name: 'Kept', starred: true, thumb: 'data:image/jpeg;base64,AAAA' });
    expect(useBrowserStore.getState().plotsWorkspace.followDelayMs).toBe(750);
  });

  it('a session without a Gallery resets it', () => {
    recordResult(input('k1'));
    applyImportedState({ success: true, viewport: { chrom: 'chr1', start: 0, end: 5000 }, datasets: [], frontend: {} });
    expect(useGalleryStore.getState().entries).toEqual([]);
    expect(useBrowserStore.getState().plotsWorkspace.followDelayMs).toBe(DEFAULT_FOLLOW_DELAY_MS);
  });

  it('Open goes back to where the plot was made (one undo step) and draws it from its data', () => {
    useBrowserStore.getState().setViewport('chr1', 1000, 3000);
    const made = newPlot({ name: 'At A', type: 'vplot' });
    const entry = keepPlotEntry(recordResult(input('kA', { plot: made })).entry!.id)!;
    // Move on and change the builder.
    useBrowserStore.getState().setViewport('chr1', 50000, 52000);
    useBrowserStore.getState().pushSnapshot('Navigate', { kind: 'navigation' });
    useBrowserStore.getState().updateCurrentPlot({ type: 'size-enrichment', name: 'other' });
    expect(openEntry(entry.id)).toBe(true);
    const s = useBrowserStore.getState();
    expect([s.chrom, Math.round(s.start), Math.round(s.end)]).toEqual(['chr1', 1000, 3000]);
    expect(s.plotsWorkspace.current).toMatchObject({ name: 'At A', type: 'vplot' });
    // A kept card opens as a new working plot under it (a version when kept again).
    expect(s.plotsWorkspace.current.id).not.toBe(made.id);
    expect(workingFor(useGalleryStore.getState(), s.plotsWorkspace.current.id)).toMatchObject({ parentId: entry.id, requestKey: 'kA' });
    expect(s.plotsWorkspace.openedFrom).toBe(entry.id);
    expect(useGallerySeed.getState().seed).toMatchObject({ key: 'kA', seeded: true });
    expect(useGallerySeed.getState().seed!.byPanel.p1['-1'].n_reads).toBe(10);
    s.undo();
    const back = useBrowserStore.getState();
    expect([Math.round(back.start), Math.round(back.end)]).toEqual([50000, 52000]);
  });

  it('Re-run makes a new plot with its own working card and shows the plot; no Gallery card', () => {
    useBrowserStore.getState().setViewport('chr1', 1000, 3000);
    const made = newPlot({ name: 'Made' });
    const { entry } = recordResult(input('kA', { plot: made }), { following: true });
    useWorkspaceStore.setState({ plotsTab: 'gallery' });
    remakeEntry(entry!.id);
    const current = useBrowserStore.getState().plotsWorkspace.current;
    expect(current.id).not.toBe(made.id);
    expect(useWorkspaceStore.getState().plotsTab).toBe('plot');
    expect(recordResult(input('kA', { plot: current })).created).toBe(true);
    expect(keptEntries(useGalleryStore.getState())).toHaveLength(0);
  });

  it('closing a plot: its working card goes, Undo brings the card and the plot back', () => {
    const plot = newPlot({ name: 'Mine' });
    useBrowserStore.getState().setPlotsWorkspace(ws => ({ ...ws, current: plot }));
    recordResult(input('k1', { plot }));
    useBrowserStore.getState().setPlotsWorkspace(ws => ({ ...ws, current: newPlot() }));
    expect(closePlotCard(plot.id)).not.toBeNull();
    expect(workingEntries(useGalleryStore.getState())).toHaveLength(0);
    expect(undoClosePlot()).toBe(true);
    expect(workingFor(useGalleryStore.getState(), plot.id)).not.toBeNull();
    expect(useBrowserStore.getState().plotsWorkspace.current.id).toBe(plot.id);
    expect(useGallerySeed.getState().seedFor).toBe(plot.id);
  });

  it('Remake re-runs the settings on the current view (no restore)', () => {
    useBrowserStore.getState().setViewport('chr1', 1000, 3000);
    const entry = recordResult(input('kA', { plot: newPlot({ name: 'Made', pinned: { chrom: 'chr1', start: 1000, end: 3000, genome: null } }) })).entry!;
    useBrowserStore.getState().setViewport('chr1', 50000, 52000);
    remakeEntry(entry.id);
    const s = useBrowserStore.getState();
    expect(Math.round(s.start)).toBe(50000);
    expect(s.plotsWorkspace.current).toMatchObject({ name: 'Made', pinned: null });
    expect(s.plotsWorkspace.current.id).not.toBe(entry.plot.id);
    expect(s.plotsWorkspace.openedFrom).toBeNull();
    expect(useGallerySeed.getState().seed).toBeNull();
  });
});
