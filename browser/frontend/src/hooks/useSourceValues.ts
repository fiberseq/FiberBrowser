import { useShallow } from 'zustand/react/shallow';
import { useMemo } from 'react';
import { useBrowserStore } from '../stores/browserStore';
import type { CatalogEntry, OrthogonalTrack, SourceRef } from '../types/dataset';

const EMPTY_VALUES: number[] = [];
const SOURCE_SLOT_WIDTH = 3;

export interface SourceValues {
  values: number[];
  ready: boolean;
  /** Optional per-source label override (used by metaprofile rule lookups). */
  fallbackLabel?: string;
}

type SourceValueSlot = number[] | boolean | string | undefined;
type SourceResolverState = Pick<ReturnType<typeof useBrowserStore.getState>, 'catalog' | 'orthogonalTracks' | 'orthogonalTrackData' | 'datasetProfiles' | 'datasets'>;

function pushSourceSlot(out: SourceValueSlot[], values: number[] | undefined, ready: boolean, fallbackLabel?: string): void {
  out.push(values && values.length > 0 ? values : EMPTY_VALUES, ready, fallbackLabel);
}

/**
 * Resolve SourceRefs to a shallow-comparable flat slot array.
 *
 * - bigwig/bigbed/online → look up the catalog entry, find the matching
 *   `orthogonalTracks[].path` (resolved lazily because backend track indices
 *   are unstable across restarts), return its values.
 * - metaprofile → look up `datasetProfiles[panelDatasetId].rules[ruleId]`,
 *   falling back to `.layers[ruleId]` and the special `mod`/`fire` builtins.
 *
 * Keeping values/ready/label as primitive array slots lets Zustand suppress
 * re-renders when unrelated orthogonal tracks refresh.
 */
export interface SourcePanelContext {
  /** The panel's per-panel state key (a copy at another locus has its own profile). */
  stateKey?: string;
  /** The panel shows its own region: track data fetched for the main view doesn't apply. */
  ownView?: boolean;
}

export function selectSourceValueSlots(
  s: SourceResolverState,
  refs: SourceRef[],
  panelDatasetId?: string,
  panel: SourcePanelContext = {},
): SourceValueSlot[] {
  let catalogById: Map<string, CatalogEntry> | null = null;
  let orthogonalByIndex: Map<number, OrthogonalTrack> | null = null;
  let orthogonalByPath: Map<string, OrthogonalTrack> | null = null;

  const getCatalogById = () => {
    catalogById ??= new Map(s.catalog.map(entry => [entry.id, entry]));
    return catalogById;
  };
  const getOrthogonalByIndex = () => {
    orthogonalByIndex ??= new Map(s.orthogonalTracks.map(track => [track.index, track]));
    return orthogonalByIndex;
  };
  const getOrthogonalByPath = () => {
    if (!orthogonalByPath) {
      const map = new Map<string, OrthogonalTrack>();
      for (const track of s.orthogonalTracks) {
        if (track.path && !map.has(track.path)) map.set(track.path, track);
      }
      orthogonalByPath = map;
    }
    return orthogonalByPath;
  };

  const out: SourceValueSlot[] = [];
  for (const ref of refs) {
    if (ref.kind === 'metaprofile') {
      const datasetId = ref.datasetId ?? panelDatasetId ?? s.datasets[0]?.id;
      if (!datasetId) {
        pushSourceSlot(out, EMPTY_VALUES, false);
        continue;
      }
      // Another dataset's profile is for the main view, not this panel's region.
      if (panel.ownView && datasetId !== panelDatasetId) {
        pushSourceSlot(out, EMPTY_VALUES, true);
        continue;
      }
      // ReadTrack stores each panel's profile under its state key.
      const profileKey = panel.stateKey && datasetId === panelDatasetId ? panel.stateKey : datasetId;
      const dsProfiles = s.datasetProfiles?.[profileKey];
      if (!dsProfiles) {
        pushSourceSlot(out, EMPTY_VALUES, false);
        continue;
      }
      const profileId = ref.ruleId === 'mod' ? 'm6a' : ref.ruleId;
      const layerVals = dsProfiles.layers?.[profileId] ?? (profileId === 'm6a' ? dsProfiles.layers?.mod : undefined);
      if (layerVals && layerVals.length > 0) {
        pushSourceSlot(out, layerVals, true);
        continue;
      }
      if (profileId === 'm6a' && dsProfiles.mod && dsProfiles.mod.length > 0) {
        pushSourceSlot(out, dsProfiles.mod, true);
        continue;
      }
      if (profileId === 'fire' && dsProfiles.fire && dsProfiles.fire.length > 0) {
        pushSourceSlot(out, dsProfiles.fire, true);
        continue;
      }
      const ruleVals = dsProfiles.rules?.[profileId];
      if (ruleVals && ruleVals.length > 0) {
        pushSourceSlot(out, ruleVals, true);
        continue;
      }
      if (profileId === 'nuc') {
        const footprintVals = dsProfiles.layers?.footprint ?? dsProfiles.rules?.footprint;
        if (footprintVals && footprintVals.length > 0) {
          pushSourceSlot(out, footprintVals, true);
          continue;
        }
      }
      // A computed profile without this layer is "no data", not "computing".
      pushSourceSlot(out, EMPTY_VALUES, true);
      continue;
    }

    if (panel.ownView) {
      // Catalog tracks are fetched for the main view's region only.
      pushSourceSlot(out, EMPTY_VALUES, true);
      continue;
    }
    const entry = getCatalogById().get(ref.catalogEntryId);
    if (!entry) {
      pushSourceSlot(out, EMPTY_VALUES, false);
      continue;
    }

    let ortho: OrthogonalTrack | undefined;
    if (typeof entry.trackIndex === 'number') {
      ortho = getOrthogonalByIndex().get(entry.trackIndex);
    }
    if (!ortho) {
      const target = entry.path ?? entry.url;
      if (!target) {
        pushSourceSlot(out, EMPTY_VALUES, false);
        continue;
      }
      ortho = getOrthogonalByPath().get(target);
    }
    if (!ortho) {
      pushSourceSlot(out, EMPTY_VALUES, false);
      continue;
    }
    const values = s.orthogonalTrackData[ortho.index]?.values ?? ortho.values ?? EMPTY_VALUES;
    pushSourceSlot(out, values, values.length > 0, ortho.label);
  }
  return out;
}

export function sourceValueSlotsToValues(slots: SourceValueSlot[]): SourceValues[] {
  const result: SourceValues[] = [];
  for (let i = 0; i < slots.length; i += SOURCE_SLOT_WIDTH) {
    result.push({
      values: (slots[i] as number[] | undefined) ?? EMPTY_VALUES,
      ready: Boolean(slots[i + 1]),
      fallbackLabel: slots[i + 2] as string | undefined,
    });
  }
  return result;
}

/** Resolve N source refs in a single store subscription — stable hook count
 *  even when the sources array changes shape. */
export function useResolvedSources(refs: SourceRef[], panelDatasetId?: string, panel?: SourcePanelContext): SourceValues[] {
  const stateKey = panel?.stateKey;
  const ownView = panel?.ownView;
  const slots = useBrowserStore(useShallow(s => selectSourceValueSlots(s, refs, panelDatasetId, { stateKey, ownView })));
  return useMemo(() => sourceValueSlotsToValues(slots), [slots]);
}

export function useSourceValues(ref: SourceRef, panelDatasetId?: string): SourceValues {
  return useResolvedSources([ref], panelDatasetId)[0] ?? { values: [], ready: false };
}
