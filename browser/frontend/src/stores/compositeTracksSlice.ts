import type { BrowserState } from './browserStore';
import type {
  CompositeTrack, CompositeKind, CompositeScaleMode,
  TrackSource, SourceRef,
} from '../types/dataset';
import { DEFAULT_METAPROFILE_ID } from '../types/dataset';
import type { SubTrackType, SubTrackConfig, PanelConfig } from '../types';
import { TRACK_COLORS } from '../components/tracks/TrackContainerConstants';
import { getLayerColor, getMetaprofileSourceEntries } from '../utils/layerColors';

// ============================================================
// COMPOSITE TRACKS SLICE — the cart. Each entry is a CompositeTrack with
// 1..N sources sharing a y-axis. Composites map to `composite-${id}` entries
// in every dataset panel's subTracks array (mirroring the existing
// `ortho-${index}` projection in setOrthogonalTracks).
// ============================================================

export interface CompositeTracksSlice {
  compositeTracks: CompositeTrack[];

  /** Replace whole array (used by session restore / migration). Also rebuilds
   *  per-panel subTracks. */
  setCompositeTracks: (tracks: CompositeTrack[]) => void;

  addComposite: (track: Omit<CompositeTrack, 'id'> & { id?: string }) => string;
  removeComposite: (id: string) => void;
  updateComposite: (id: string, patch: Partial<CompositeTrack>) => void;
  /** Reorder composites in the cart, mirrored into every dataset panel's
   *  subTracks. Non-composite subTracks (axis/reads/...) keep their
   *  absolute positions. */
  reorderComposites: (fromIndex: number, toIndex: number) => void;

  addSourceTo: (compositeId: string, source: Omit<TrackSource, 'id'> & { id?: string }) => string;
  removeSourceFrom: (compositeId: string, sourceId: string) => void;
  updateSource: (compositeId: string, sourceId: string, patch: Partial<TrackSource>) => void;

  /** Bulk show/hide all composites. */
  setAllCompositesVisible: (visible: boolean) => void;

  /** Idempotent: ensure a non-removable default metaprofile composite exists.
   *  Strips the legacy `meta` slot from every panel so the old MetaTrack
   *  doesn't double-render alongside it. Safe to call repeatedly. */
  seedDefaultMetaprofile: () => void;

  /** Compute the union [min,max] of visible sources across the targeted
   *  composites (selected ones if `selectedOnly`, otherwise all visible),
   *  then stamp yMin/yMax onto each and set scaleMode='group'. Sources are
   *  resolved against the current `orthogonalTracks` and `datasetProfiles`. */
  applyGroupAutoscale: (selectedOnly?: boolean) => void;
}

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

function compositeSubType(id: string): SubTrackType {
  return `composite-${id}` as SubTrackType;
}

function isCompositeType(t: SubTrackType): boolean {
  return typeof t === 'string' && t.startsWith('composite-');
}

/** Insert composite slots in every dataset panel's subTracks, slotting just
 *  before `reads` (matching ortho behavior). Removes stale composite-* entries
 *  that no longer exist, and also strips legacy `ortho-${index}` slots whose
 *  underlying track is now covered by a composite (prevents the same bigwig
 *  rendering twice on sessions migrated from before the cart refactor). */
function syncPanelsForComposites(
  panels: BrowserState['panels'],
  composites: CompositeTrack[],
  resolveOrthoIndexFromComposite?: (c: CompositeTrack) => number[],
): BrowserState['panels'] {
  const allCompTypes = new Set(composites.map(c => compositeSubType(c.id)));
  const compositeOrder = composites.map(c => compositeSubType(c.id));
  // Set of legacy `ortho-${idx}` types that are now covered by a composite.
  const coveredOrtho = new Set<string>();
  if (resolveOrthoIndexFromComposite) {
    for (const c of composites) {
      for (const idx of resolveOrthoIndexFromComposite(c)) {
        coveredOrtho.add(`ortho-${idx}`);
      }
    }
  }
  let anyPanelChanged = false;
  const result = (panels as PanelConfig[]).map(panel => {
    if (panel.contentType !== 'dataset') return panel;
    const existingComposite = (panel.subTracks ?? []).filter(st => isCompositeType(st.type));
    const nonComposite = (panel.subTracks ?? []).filter(st =>
      !isCompositeType(st.type) && !coveredOrtho.has(st.type as string)
    );
    const newComposite: SubTrackConfig[] = compositeOrder.map(t => {
      const existing = existingComposite.find(st => st.type === t);
      return existing ?? { type: t, visible: true };
    });
    const readsIdx = nonComposite.findIndex(st => st.type === 'reads');
    let merged: SubTrackConfig[];
    if (readsIdx >= 0) {
      merged = [
        ...nonComposite.slice(0, readsIdx),
        ...newComposite,
        ...nonComposite.slice(readsIdx),
      ];
    } else {
      merged = [...nonComposite, ...newComposite];
    }
    merged = merged.filter(st => !isCompositeType(st.type) || allCompTypes.has(st.type));
    // Only return a new panel object when the subTracks list actually
    // changed. Otherwise the panels array reference churns and forces
    // panels-derived useMemos (including getTargetDatasetIds) to recompute
    // — that re-fires the FootprintAnalysisPanel effect and produces a
    // tight load loop when fetches are flowing.
    const sameLength = merged.length === panel.subTracks.length;
    const sameContent = sameLength && merged.every((st, i) => st === panel.subTracks[i]);
    if (sameContent) return panel;
    anyPanelChanged = true;
    return { ...panel, subTracks: merged };
  }) as BrowserState['panels'];
  // Preserve outer-array identity when nothing changed, so panels-subscribed
  // selectors (`s => s.panels`) don't see a spurious new reference.
  return anyPanelChanged ? result : panels;
}

// ----------------------------------------------------------------------
// Slice
// ----------------------------------------------------------------------

/** Return a resolver that maps a CompositeTrack to the backend ortho indices
 *  it covers (via catalog → orthogonalTracks lookup). Used to strip legacy
 *  ortho-* slots that the composite has taken over. */
function makeOrthoResolver(state: BrowserState): (c: CompositeTrack) => number[] {
  return (c) => {
    const out: number[] = [];
    for (const src of c.sources) {
      const ref = src.ref;
      if (ref.kind === 'metaprofile') continue;
      const entry = state.catalog?.find(e => e.id === ref.catalogEntryId);
      if (!entry) continue;
      // Prefer the explicit trackIndex stamped at register time — multiple
      // catalog entries may share a URL, so path matching is ambiguous.
      if (typeof entry.trackIndex === 'number'
          && state.orthogonalTracks.some(t => t.index === entry.trackIndex)) {
        out.push(entry.trackIndex);
        continue;
      }
      const target = entry.path ?? entry.url;
      if (!target) continue;
      const ortho = state.orthogonalTracks.find(t => t.path === target);
      if (ortho) out.push(ortho.index);
    }
    return out;
  };
}

function normalizeMetaprofileSourceId(ruleId: string): string {
  return ruleId === 'mod' ? 'm6a' : ruleId;
}

function defaultMetaprofileSourceVisible(ruleId: string): boolean {
  return ruleId === 'nuc' || ruleId === 'footprint' || ruleId === 'tf';
}

function reconcileDefaultMetaprofileSources(state: BrowserState, existingSources: TrackSource[] = []): TrackSource[] {
  const entries = getMetaprofileSourceEntries(state.datasets);
  if (entries.length === 0) {
    return existingSources.filter(s =>
      s.ref.kind !== 'metaprofile' || !['subnuc', 'mod'].includes(s.ref.ruleId)
    );
  }

  const existingById = new Map<string, TrackSource>();
  const preserved: TrackSource[] = [];
  for (const source of existingSources) {
    if (source.ref.kind !== 'metaprofile') {
      preserved.push(source);
      continue;
    }
    const id = normalizeMetaprofileSourceId(source.ref.ruleId);
    if (source.ref.ruleId === 'subnuc') continue;
    if (!existingById.has(id)) existingById.set(id, source);
  }

  const desiredIds = new Set(entries.map(e => e.key));
  const desiredSources = entries.map(entry => {
    const existing = existingById.get(entry.key);
    if (existing) {
      return existing.ref.kind === 'metaprofile' && existing.ref.ruleId === entry.key
        ? existing
        : { ...existing, ref: { kind: 'metaprofile' as const, ruleId: entry.key } };
    }
    return {
      id: crypto.randomUUID(),
      ref: { kind: 'metaprofile' as const, ruleId: entry.key },
      color: getLayerColor(entry.key),
      visible: defaultMetaprofileSourceVisible(entry.key),
      negate: false,
      scale: 1,
    };
  });

  for (const source of existingSources) {
    if (source.ref.kind !== 'metaprofile') continue;
    const id = normalizeMetaprofileSourceId(source.ref.ruleId);
    if (source.ref.ruleId === 'subnuc' || source.ref.ruleId === 'mod' || desiredIds.has(id)) continue;
    preserved.push(source);
  }

  return [...desiredSources, ...preserved];
}

export function createCompositeTracksSlice(
  set: (partial: Partial<BrowserState> | ((state: BrowserState) => Partial<BrowserState>)) => void,
  get: () => BrowserState,
): CompositeTracksSlice {
  const ensureCartBaseline = () => {
    const state = get();
    if ((state._historyStack?.length ?? 0) === 0) {
      state.pushSnapshot?.('Before track cart change', { kind: 'layout' });
    }
  };

  const pushCartHistory = (label: string, coalesceKey?: string, coalesceMs = 1200) => {
    get().pushSnapshot?.(label, {
      kind: 'layout',
      coalesceKey,
      coalesceMs,
    });
  };

  return {
    compositeTracks: [],

    setCompositeTracks: (tracks) => set(state => ({
      compositeTracks: tracks,
      panels: syncPanelsForComposites(state.panels, tracks, makeOrthoResolver(state)),
    })),

    addComposite: (track) => {
      const id = track.id ?? crypto.randomUUID();
      const full: CompositeTrack = {
        id,
        label: track.label,
        kind: track.kind,
        sources: track.sources ?? [],
        scaleMode: track.scaleMode ?? 'auto',
        yMin: track.yMin,
        yMax: track.yMax,
        logScale: track.logScale ?? false,
        scaleGroup: track.scaleGroup,
        visible: track.visible ?? true,
        groupAutoscaleSelected: track.groupAutoscaleSelected ?? false,
        showAxes: track.showAxes ?? true,
        overlayGroup: track.overlayGroup,
        annotationStyle: track.annotationStyle,
      };
      ensureCartBaseline();
      set(state => {
        const next = [...state.compositeTracks, full];
        return { compositeTracks: next, panels: syncPanelsForComposites(state.panels, next, makeOrthoResolver(state)) };
      });
      pushCartHistory(`Add track ${full.label || 'track'}`);
      return id;
    },

    removeComposite: (id) => {
      // Non-removable tracks (default metaprofile) can only be hidden.
      const target = get().compositeTracks.find(c => c.id === id);
      if (!target || target.removable === false) return;
      ensureCartBaseline();
      set(state => {
        const next = state.compositeTracks.filter(c => c.id !== id);
        return { compositeTracks: next, panels: syncPanelsForComposites(state.panels, next, makeOrthoResolver(state)) };
      });
      pushCartHistory(`Delete track ${target.label || 'track'}`);
    },

    updateComposite: (id, patch) => {
      const target = get().compositeTracks.find(c => c.id === id);
      if (!target) return;
      const keys = Object.keys(patch) as Array<keyof CompositeTrack>;
      const changed = keys.some(key => target[key] !== patch[key]);
      if (!changed) return;
      ensureCartBaseline();
      set(state => ({
        compositeTracks: state.compositeTracks.map(c => c.id === id ? { ...c, ...patch } : c),
      }));
      const visibleChange = keys.length === 1 && keys[0] === 'visible';
      const label = visibleChange
        ? `${patch.visible ? 'Show' : 'Hide'} track ${target.label || 'track'}`
        : `Edit track ${target.label || 'track'}`;
      const keyLabel = keys.sort().join(',');
      pushCartHistory(label, visibleChange ? undefined : `track:${id}:${keyLabel}`, visibleChange ? 1200 : 2500);
    },

    reorderComposites: (fromIndex, toIndex) => {
      const current = get().compositeTracks;
      if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= current.length || toIndex >= current.length) return;
      ensureCartBaseline();
      set(state => {
        const next = [...state.compositeTracks];
        const [moved] = next.splice(fromIndex, 1);
        next.splice(toIndex, 0, moved);
        return { compositeTracks: next, panels: syncPanelsForComposites(state.panels, next, makeOrthoResolver(state)) };
      });
      pushCartHistory('Reorder track cart', 'track-cart:reorder', 2500);
    },

    addSourceTo: (compositeId, source) => {
      const sid = source.id ?? crypto.randomUUID();
      // Default color: rotate against existing source colors in this composite.
      const composite = get().compositeTracks.find(c => c.id === compositeId);
      const existingColors = new Set((composite?.sources ?? []).map(s => s.color));
      let color = source.color;
      if (!color) {
        color = TRACK_COLORS.find(c => !existingColors.has(c)) ?? TRACK_COLORS[(composite?.sources.length ?? 0) % TRACK_COLORS.length];
      }
      const full: TrackSource = {
        id: sid,
        ref: source.ref,
        color,
        visible: source.visible ?? true,
        negate: source.negate ?? false,
        scale: source.scale ?? 1,
      };
      ensureCartBaseline();
      set(state => ({
        compositeTracks: state.compositeTracks.map(c =>
          c.id === compositeId ? { ...c, sources: [...c.sources, full] } : c
        ),
      }));
      pushCartHistory(`Add source to ${composite?.label || 'track'}`);
      return sid;
    },

    removeSourceFrom: (compositeId, sourceId) => {
      const composite = get().compositeTracks.find(c => c.id === compositeId);
      const source = composite?.sources.find(s => s.id === sourceId);
      if (!composite || !source) return;
      ensureCartBaseline();
      set(state => ({
        compositeTracks: state.compositeTracks.map(c =>
          c.id === compositeId ? { ...c, sources: c.sources.filter(s => s.id !== sourceId) } : c
        ),
      }));
      pushCartHistory(`Remove source from ${composite.label || 'track'}`);
    },

    updateSource: (compositeId, sourceId, patch) => {
      const composite = get().compositeTracks.find(c => c.id === compositeId);
      const source = composite?.sources.find(s => s.id === sourceId);
      if (!composite || !source) return;
      const keys = Object.keys(patch) as Array<keyof TrackSource>;
      const changed = keys.some(key => source[key] !== patch[key]);
      if (!changed) return;
      ensureCartBaseline();
      set(state => ({
        compositeTracks: state.compositeTracks.map(c =>
          c.id === compositeId
            ? { ...c, sources: c.sources.map(s => s.id === sourceId ? { ...s, ...patch } : s) }
            : c
        ),
      }));
      const visibleChange = keys.length === 1 && keys[0] === 'visible';
      const label = visibleChange
        ? `${patch.visible ? 'Show' : 'Hide'} source in ${composite.label || 'track'}`
        : `Edit source in ${composite.label || 'track'}`;
      pushCartHistory(label, visibleChange ? undefined : `track-source:${compositeId}:${sourceId}:${keys.sort().join(',')}`, visibleChange ? 1200 : 2500);
    },

    setAllCompositesVisible: (visible) => {
      if (get().compositeTracks.every(c => c.visible === visible)) return;
      ensureCartBaseline();
      set(state => ({
        compositeTracks: state.compositeTracks.map(c => ({ ...c, visible })),
      }));
      pushCartHistory(visible ? 'Show all tracks' : 'Hide all tracks');
    },

    seedDefaultMetaprofile: () => set(state => {
      const existing = state.compositeTracks.find(c => c.id === DEFAULT_METAPROFILE_ID);
      // Always strip legacy `meta` slots from panels — the default metaprofile
      // composite (whether seeded now or already present) replaces them.
      let panelsChanged = false;
      const strippedPanels = state.panels.map(p => {
        if (p.contentType !== 'dataset' || !p.subTracks) return p;
        const next = p.subTracks.filter(st => st.type !== 'meta');
        if (next.length === p.subTracks.length) return p;
        panelsChanged = true;
        return { ...p, subTracks: next };
      }) as BrowserState['panels'];
      const panelsAfterStrip = panelsChanged ? strippedPanels : state.panels;

      if (existing) {
        const nextSources = reconcileDefaultMetaprofileSources(state, existing.sources);
        const sourcesChanged =
          nextSources.length !== existing.sources.length ||
          nextSources.some((source, i) => source !== existing.sources[i]);
        if (!sourcesChanged) {
          return panelsChanged ? { panels: panelsAfterStrip } : {};
        }
        return {
          compositeTracks: state.compositeTracks.map(c =>
            c.id === DEFAULT_METAPROFILE_ID ? { ...c, sources: nextSources } : c
          ),
          ...(panelsChanged ? { panels: panelsAfterStrip } : {}),
        };
      }

      const sources = reconcileDefaultMetaprofileSources(state);

      const seeded: CompositeTrack = {
        id: DEFAULT_METAPROFILE_ID,
        label: 'Metaprofile',
        kind: 'metaprofile',
        sources,
        scaleMode: 'per-source',
        logScale: false,
        visible: true,
        groupAutoscaleSelected: false,
        showAxes: true,
        removable: false,
      };

      const nextComposites = [seeded, ...state.compositeTracks];
      const nextPanels = syncPanelsForComposites(panelsAfterStrip, nextComposites, makeOrthoResolver(state));
      return { compositeTracks: nextComposites, panels: nextPanels };
    }),

    applyGroupAutoscale: (selectedOnly = true) => {
      const state = get();
      const targets = state.compositeTracks.filter(c =>
        c.visible && (selectedOnly ? c.groupAutoscaleSelected : true)
      );
      if (targets.length < 2) return;
      // Resolve every visible source's values via the same lookup as the
      // renderer. Anchor at zero (so positive-only data baselines at the
      // bottom). Apply per-source negate/scale before scanning.
      let dataMin = Infinity;
      let dataMax = -Infinity;
      for (const c of targets) {
        for (const src of c.sources) {
          if (!src.visible) continue;
          let values: number[] = [];
          const ref = src.ref;
          if (ref.kind === 'metaprofile') {
            // The track draws this source in every panel of its dataset (every
            // dataset panel when it names none), each from its own profile.
            values = metaprofileKeysFor(state, ref.datasetId)
              .flatMap(key => metaprofileValues(state.datasetProfiles?.[key], ref.ruleId));
          } else {
            const entry = state.catalog?.find(e => e.id === ref.catalogEntryId);
            if (!entry) continue;
            let ortho = typeof entry.trackIndex === 'number'
              ? state.orthogonalTracks.find(t => t.index === entry.trackIndex)
              : undefined;
            if (!ortho) {
              const target = entry.path ?? entry.url;
              if (target) ortho = state.orthogonalTracks.find(t => t.path === target);
            }
            values = ortho ? (state.orthogonalTrackData[ortho.index]?.values ?? ortho.values ?? []) : [];
          }
          for (const raw of values) {
            if (raw == null || isNaN(raw)) continue;
            let v = raw * (src.scale ?? 1);
            if (src.negate) v = -v;
            if (v < dataMin) dataMin = v;
            if (v > dataMax) dataMax = v;
          }
        }
      }
      if (!isFinite(dataMin)) return;
      const yMin = Math.min(0, dataMin);
      const yMax = Math.max(0, dataMax);
      const ids = new Set(targets.map(c => c.id));
      // The renderer compares against yMin/yMax in the track's displayed
      // space: a log track gets the shared range signed-log transformed (the
      // transform is monotonic, so it's the same range on the log axis).
      const signedLog = (v: number) => (v < 0 ? -1 : 1) * Math.log10(Math.abs(v) + 1);
      set(s => ({
        compositeTracks: s.compositeTracks.map(c =>
          ids.has(c.id)
            ? { ...c, scaleMode: 'group', yMin: c.logScale ? signedLog(yMin) : yMin, yMax: c.logScale ? signedLog(yMax) : yMax }
            : c
        ),
      }));
    },
  };
}

/** The profiles a metaprofile source is drawn from: each (matching) dataset panel's, under its state key. */
function metaprofileKeysFor(state: BrowserState, datasetId: string | undefined): string[] {
  const keys = new Set<string>();
  for (const p of state.panels) {
    if (p.contentType !== 'dataset' || !p.datasetId) continue;
    if (datasetId && p.datasetId !== datasetId) continue;
    keys.add(p.stateKey ?? p.datasetId);
  }
  if (keys.size === 0) {
    const fallback = datasetId ?? state.datasets[0]?.id;
    if (fallback) keys.add(fallback);
  }
  return [...keys];
}

/** A profile's values for a metaprofile rule, looked up as the track renders them. */
function metaprofileValues(dsp: BrowserState['datasetProfiles'][string] | undefined, ruleId: string): number[] {
  if (!dsp) return [];
  const profileId = ruleId === 'mod' ? 'm6a' : ruleId;
  return dsp.rules?.[ruleId]
    ?? dsp.layers?.[profileId]
    ?? (profileId === 'm6a' ? dsp.layers?.mod ?? dsp.mod : ruleId === 'fire' ? dsp.fire : undefined)
    ?? [];
}

// ----------------------------------------------------------------------
// Helpers used by other modules
// ----------------------------------------------------------------------

/** Build a fresh 1-source signal CompositeTrack from a catalog entry id. */
export function makeOneSourceComposite(opts: {
  catalogEntryId: string;
  label: string;
  kind: CompositeKind;
  refKind: 'bigwig' | 'bigbed' | 'online';
  color?: string;
  scaleMode?: CompositeScaleMode;
}): Omit<CompositeTrack, 'id'> {
  const ref: SourceRef = { kind: opts.refKind, catalogEntryId: opts.catalogEntryId };
  return {
    label: opts.label,
    kind: opts.kind,
    sources: [{
      id: crypto.randomUUID(),
      ref,
      color: opts.color ?? TRACK_COLORS[0],
      visible: true,
      negate: false,
      scale: 1,
    }],
    scaleMode: opts.scaleMode ?? 'auto',
    logScale: false,
    visible: true,
    groupAutoscaleSelected: false,
    showAxes: true,
    ...(opts.kind === 'annotation'
      ? {
          annotationStyle: {
            scoreMin: 0,
            scoreMax: 1,
            scoreScale: 'linear',
            strandMode: 'split',
            showScoreLegend: true,
          },
        }
      : {}),
  };
}
