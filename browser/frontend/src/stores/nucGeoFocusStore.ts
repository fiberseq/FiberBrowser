/**
 * The nucleosome panel's focused shared geometries (a click on a geometry, as a click on a footprint class): the read
 * lane's patches of other geometries dim and the focused ones are outlined. Keys are `${kind}:${root}` (the root's
 * number within its kind, as the nucpatch layer's quality bytes carry it).
 */
import { create } from 'zustand';
import type { NucPatchKind } from '../utils/nucLayers';

export const geoFocusKey = (kind: NucPatchKind, root: number) => `${kind}:${root}`;

interface NucGeoFocusState {
  focused: ReadonlySet<string>;
  /** Focus one geometry (additive: toggle it in the set). */
  focus: (key: string, additive?: boolean) => void;
  clear: () => void;
}

export const useNucGeoFocusStore = create<NucGeoFocusState>(set => ({
  focused: new Set(),
  focus: (key, additive = false) => set(s => {
    if (!additive) return { focused: s.focused.size === 1 && s.focused.has(key) ? new Set() : new Set([key]) };
    const next = new Set(s.focused);
    if (next.has(key)) next.delete(key); else next.add(key);
    return { focused: next };
  }),
  // (No new Set when already empty: every read canvas redraws on a new focus object.)
  clear: () => set(s => (s.focused.size ? { focused: new Set() } : {})),
}));
