/**
 * What a click on a shared geometry does, wherever it is (the panel's lanes and rows, the geometry track above the
 * reads, a saved entry): a plain click focuses it (its carriers highlighted in the reads, other patches dimmed in the
 * patch lane, as a click on a footprint class highlights it); shift / ctrl / cmd adds it to (or takes it out of) the
 * main toolbar's selection for Cluster, Sort and Filter (geoHub.geoFeatureRef: the hub hit's identity).
 */
import { useBrowserStore } from '../../stores/browserStore';
import { useReadActionsStore } from '../../stores/readActionsStore';
import { geoFocusKey, useNucGeoFocusStore } from '../../stores/nucGeoFocusStore';
import { geoFeatureRef, geoKindOf } from './geoHub';
import type { NucGeoRun } from './geoRuns';
import type { NucGeometryResult, NucGeometryRow } from './types';

export const rootNumberOf = (g: NucGeometryRow, index: number) => g.rootNumber ?? (g.parentIndex != null ? g.parentIndex + 1 : index + 1);
export const focusKeyOf = (G: readonly NucGeometryRow[], index: number) => geoFocusKey(geoKindOf(G[index]), rootNumberOf(G[index], index));

/** Read names per dataset carrying (fully or partly) the given geometries (1-based indices in the list). */
export function carriersOf(res: NucGeometryResult, indices: Set<number>, partly: boolean): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [ds, a] of Object.entries(res.assignments)) {
    const names = new Set<string>();
    for (const [q, list] of Object.entries(a.carried)) if (list.some(i => indices.has(i))) names.add(q);
    if (partly) for (const [q, list] of Object.entries(a.partial ?? {})) if (list.some(i => indices.has(i))) names.add(q);
    out[ds] = [...names];
  }
  return out;
}

/** Highlight the carriers of the focused geometries (with the geometries folded into them), each dataset's own: a
 * read name shared by two datasets is outlined only in the dataset whose molecule carries it. */
export function highlightFocused(res: NucGeometryResult): void {
  const G = res.geometries;
  const keys = useNucGeoFocusStore.getState().focused;
  if (!keys.size) { useReadActionsStore.getState().clearHighlight(); return; }
  const picked = new Set<number>();
  G.forEach((_g, j) => { if (keys.has(focusKeyOf(G, j))) picked.add(j + 1); });
  const byDataset = carriersOf(res, picked, true);
  const ids = [...new Set(Object.values(byDataset).flat())];
  if (!ids.length) { useReadActionsStore.getState().clearHighlight(); return; }
  const scopedRows = Object.fromEntries(Object.entries(byDataset).map(([ds, names]) =>
    [ds, new Set(names.flatMap(q => [q, `name:${q}`]))]));
  useReadActionsStore.getState().highlightReads(ids, { scopedRows });
}

/** Focus a geometry (its root; additive toggles it among the focused): its carriers, with the geometries folded into
 * it, highlighted in the reads. */
export function focusGeometry(res: NucGeometryResult, index: number, additive = false): void {
  useNucGeoFocusStore.getState().focus(focusKeyOf(res.geometries, index), additive);
  highlightFocused(res);
}

/**
 * A new analysis renumbers geometries: a focus names `${kind}:${root}`, which may now be another geometry. The
 * focused root geometries are matched again by their stable id (geometryId); when every one is still there the focus
 * moves to their new numbers and their carriers are highlighted again, else the focus and its highlight are cleared.
 */
export function refocusAfter(prev: NucGeometryResult | null, next: NucGeometryResult): void {
  const st = useNucGeoFocusStore.getState();
  if (!st.focused.size) return;
  // The focused geometries themselves (each focus names a root): never the geometries folded into them, which an
  // unfold would turn into focuses of their own, and whose disappearance must not clear a surviving root's focus.
  const gids = prev ? prev.geometries.filter((g, j) => g.parentIndex == null && st.focused.has(focusKeyOf(prev.geometries, j)))
    .map(g => g.geometryId) : [];
  const at = gids.map(id => next.geometries.findIndex(g => g.geometryId === id));
  if (!gids.length || at.some(i => i < 0)) {
    st.clear();
    useReadActionsStore.getState().clearHighlight();
    return;
  }
  const keys = new Set(at.map(i => focusKeyOf(next.geometries, i)));
  const same = keys.size === st.focused.size && [...keys].every(k => st.focused.has(k));
  if (!same) useNucGeoFocusStore.setState({ focused: keys });
  highlightFocused(next);
}

/** Add a geometry to (or take it out of) the toolbar's selection. */
export function toggleGeometrySelection(run: NucGeoRun, index: number): void {
  const s = useBrowserStore.getState();
  s.selectFeature(geoFeatureRef(s, run, run.result.geometries[index], index), true);
}

/** A click: shift / ctrl / cmd selects (the toolbar's selection), else focus. */
export function clickGeometry(run: NucGeoRun | null, res: NucGeometryResult, index: number,
  e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey?: boolean }): void {
  if ((e.shiftKey || e.ctrlKey || e.metaKey) && run) { toggleGeometrySelection(run, index); return; }
  focusGeometry(res, index, Boolean(e.altKey));
}
