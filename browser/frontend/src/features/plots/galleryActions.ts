/**
 * Gallery actions that touch the browser: record a plot's result with the browser state it was made in, Open an
 * entry (go back to where you were: the browser state restored as one undo step, the plot back in the builder, drawn
 * at once from its stored data), and Remake (the same settings on the current view).
 */
import { create } from 'zustand';
import { useBrowserStore } from '../../stores/browserStore';
import { seedHistoryBaseline, serializeState } from '../../stores/historySlice';
import type { FootprintSizeEntry } from '../../components/controls/cluster-detail/useFootprintSizeData';
import type { ProfileEntry } from './useProfileData';
import type { HeatmapEntry } from './heatmapData';
import type { BedEntry } from './bedData';
import type { DiffEntry } from './differentialData';
import { unpackHeatmap } from './HeatmapPlot';
import { coaccFromSupplied } from './CoaccPlot';
import { closeWorking, duplicateEntry, entryState, keepEntry, recordInGallery, restoreWorking, unpackByPanel, unpackProfile, useGalleryStore, workingFor, type GalleryEntry, type GalleryInput } from './gallery';
import { newPlotId, plotDisplayName } from './plotModel';
import { setPlotsTab } from './workspace';

/** The stored result the builder's plot draws from after an Open (consumed by the size plot; not saved). */
export const useGallerySeed = create<{
  seed: FootprintSizeEntry | null;
  set: (seed: FootprintSizeEntry | null) => void;
  /** A metaprofile's stored result (profile types). */
  profileSeed: ProfileEntry | null;
  /** A heatmap's stored result. */
  heatmapSeed: HeatmapEntry | null;
  /** A BED region-set plot's stored result. */
  bedSeed: BedEntry | null;
  /** A differential plot's stored result. */
  diffSeed: DiffEntry | null;
  /** A supplied plot's series (its card's, exactly). */
  suppliedSeed: import('./gallery').SuppliedData | null;
  /** A co-accessibility card's matrices. */
  coaccSeed: import('./CoaccPlot').CoaccEntry | null;
  /** The plot the seeds belong to (Open, Undo close): it draws from them until something changes. */
  seedFor: string | null;
}>(set => ({
  seedFor: null,
  coaccSeed: null,
  suppliedSeed: null,
  diffSeed: null,
  heatmapSeed: null,
  bedSeed: null,
  seed: null,
  set: seed => set({ seed }),
  profileSeed: null,
}));

/** The browser state a Gallery entry keeps: the undo/session serialized state, without the Plots builder. */
export function captureBrowserState(): Record<string, unknown> {
  const state = serializeState(useBrowserStore.getState()) as unknown as Record<string, unknown>;
  const { plotsWorkspace: _omit, ...rest } = state;
  return rest;
}

/**
 * Record a result on its plot's working card (gallery.ts): updated in place, never a new Gallery card.
 */
export function recordResult(input: GalleryInput, _opts: { following?: boolean } = {}): { entry: GalleryEntry | null; created: boolean } {
  const { gallery, entry, created } = recordInGallery(useGalleryStore.getState(), input, captureBrowserState());
  if (gallery !== useGalleryStore.getState()) useGalleryStore.setState(gallery, true);
  return { entry, created };
}

/** Keep: save this plot to the Gallery (a frozen copy of its working card; the plot carries on). */
export function keepPlotEntry(id: string, name?: string): GalleryEntry | null {
  const { gallery, kept } = keepEntry(useGalleryStore.getState(), id, name);
  if (kept) useGalleryStore.setState(gallery, true);
  return kept;
}

/** Kept for old callers: Snapshot is Keep. */
export const snapshotEntry = (id: string): GalleryEntry | null => keepPlotEntry(id);

/** Duplicate: a kept copy of a card. */
export function duplicateGalleryEntry(id: string): GalleryEntry | null {
  const { gallery, kept } = duplicateEntry(useGalleryStore.getState(), id);
  if (kept) useGalleryStore.setState(gallery, true);
  return kept;
}

/** The last closed plot's working card (for the toast's Undo). */
let lastClosed: { entry: GalleryEntry; state: unknown } | null = null;

/** Close a plot: its working card goes (kept copies stay). Returns whether there was one (offer Undo). */
export function closePlotCard(plotId: string): GalleryEntry | null {
  const g = useGalleryStore.getState();
  const { gallery, removed } = closeWorking(g, plotId);
  if (!removed) return null;
  lastClosed = { entry: removed, state: g.states[removed.stateId] };
  useGalleryStore.setState(gallery, true);
  return removed;
}

/** Undo the last close: the working card back, and its plot back in the builder. */
export function undoClosePlot(): boolean {
  if (!lastClosed) return false;
  const { entry, state } = lastClosed;
  lastClosed = null;
  useGalleryStore.setState(g => restoreWorking(g, entry, state), true);
  const st = useBrowserStore.getState();
  if (st.plotsWorkspace.current.id !== entry.plotId) {
    useGallerySeed.setState({ ...seedsOf(entry) });
    st.setPlotsWorkspace(ws => ({ ...ws, current: { ...entry.plot, size: { ...entry.plot.size } }, openedFrom: entry.parentId }));
  }
  return true;
}

/** A BED card's stored result as the BED plot takes it (its request key is the stable one, without the refresh counter). */
function bedSeedOf(entry: GalleryEntry): BedEntry | null {
  const empty = { binBp: 10, groups: [] as never[] };
  const prof = entry.profile ? unpackProfile(entry.profile) : empty;
  const heat = entry.heatmap ? unpackHeatmap(entry.heatmap, entry.requestKey, entry.computedFor) : null;
  return {
    key: entry.requestKey, stableKey: entry.requestKey, counts: [], countsText: entry.note ?? '', seeded: true,
    profile: { key: entry.requestKey, locus: entry.computedFor, binBp: prof.binBp, groups: prof.groups, seeded: true },
    heatmap: heat ?? { key: entry.requestKey, locus: entry.computedFor, mode: 'features', binBp: prof.binBp, start: 0, groups: [], features: [], seeded: true },
  };
}

/** The stored results a card's plot draws from at once (no request until something changes). */
function seedsOf(entry: GalleryEntry, plotId: string = entry.plotId ?? entry.plot.id) {
  return {
    seedFor: plotId,
    seed: { key: entry.requestKey, locus: entry.computedFor, byPanel: unpackByPanel(entry.data), seeded: true } as FootprintSizeEntry,
    profileSeed: entry.profile ? { key: entry.requestKey, locus: entry.computedFor, seeded: true, ...unpackProfile(entry.profile) } : null,
    heatmapSeed: entry.heatmap ? unpackHeatmap(entry.heatmap, entry.requestKey, entry.computedFor) : null,
    bedSeed: entry.plot.where === 'bed' ? bedSeedOf(entry) : null,
    suppliedSeed: entry.supplied ?? null,
    coaccSeed: entry.plot.type === 'co-accessibility' && !entry.plot.supplied && entry.supplied ? coaccFromSupplied(entry.requestKey, entry.computedFor, entry.supplied) : null,
    diffSeed: entry.diff ? { key: entry.requestKey, locus: entry.computedFor, rows: entry.diff.rows, groups: entry.diff.groups, test: entry.diff.test, density: entry.diff.density, seeded: true } : null,
  };
}

/**
 * Open: restore the browser state the card was made in (one undo step) and put its plot in the builder. A kept card
 * opens as a new working plot (a version of the card: keeping it again adds a version under it); a working card is
 * its plot, back in the builder.
 */
export function openEntry(id: string): boolean {
  const g = useGalleryStore.getState();
  const entry = g.entries.find(e => e.id === id);
  if (!entry) return false;
  const saved = entryState(g, entry) as Record<string, unknown> | undefined;
  const s = useBrowserStore.getState();
  const working = entry.status === 'working';
  const plot = { ...entry.plot, ...(working ? {} : { id: newPlotId() }), size: { ...entry.plot.size } };
  const ws = { ...s.plotsWorkspace, current: plot, openedFrom: working ? entry.parentId : entry.id };
  setPlotsTab('plot');
  useGallerySeed.setState(seedsOf(entry, plot.id));
  if (saved) {
    seedHistoryBaseline(s, 'Before opening a plot', 'analysis');
    const st = useBrowserStore.getState();
    st.pushSerializedSnapshot(`Open plot: ${plotDisplayName(entry.plot)}`, { ...saved, plotsWorkspace: ws } as never, { kind: 'analysis' });
    const now = useBrowserStore.getState();
    now.restoreSnapshot(now._historyPointer, { restoreViewport: true });
  }
  useBrowserStore.getState().setPlotsWorkspace(ws);
  // The opened plot has its card at once (drawn from the stored data): a kept card's plot is a working card under it.
  if (!working && !workingFor(useGalleryStore.getState(), plot.id)) {
    const { gallery } = recordInGallery(useGalleryStore.getState(), {
      plot, computedFor: entry.computedFor, requestKey: entry.requestKey, byPanel: unpackByPanel(entry.data), items: entry.items, thumb: entry.thumb,
      datasets: entry.datasets, parentId: entry.status === 'kept' ? entry.id : null, name: entry.name,
      ...(entry.profile ? { profile: entry.profile } : {}), ...(entry.heatmap ? { heatmap: entry.heatmap } : {}), ...(entry.note != null ? { note: entry.note } : {}),
      ...(entry.diff ? { diff: entry.diff } : {}), ...(entry.supplied ? { supplied: entry.supplied } : {}),
    }, saved ?? null);
    useGalleryStore.setState(gallery, true);
  }
  return true;
}

/**
 * Remake: the card's settings on the current browser view (a BED or feature-set plot keeps its set), as a new plot
 * (its own working card; the plot it replaces in the builder is closed, with an undo). It used to reuse the card's plot id and settings: on the view the plot already showed nothing
 * changed (same request, the newest card already answered it), and it stayed on the Gallery tab, so it looked dead.
 */
export function remakeEntry(id: string): boolean {
  const entry = useGalleryStore.getState().entries.find(e => e.id === id);
  if (!entry) return false;
  // Supplied series come from a panel's run: Plots cannot redo them elsewhere, so Re-run opens the card.
  if (entry.supplied) return openEntry(id);
  const plotId = newPlotId();
  useGallerySeed.setState({ seed: null, profileSeed: null, heatmapSeed: null, bedSeed: null, diffSeed: null, coaccSeed: null, seedFor: null });
  useBrowserStore.getState().setPlotsWorkspace(ws => ({
    ...ws, openedFrom: null,
    current: { ...entry.plot, id: plotId, size: { ...entry.plot.size }, pinned: entry.plot.where === 'view' ? null : entry.plot.pinned },
  }));
  setPlotsTab('plot');
  return true;
}
