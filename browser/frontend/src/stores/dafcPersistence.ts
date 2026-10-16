import { useDafcStore } from './dafcStore';

/**
 * JSON-safe, user-controlled contact-map state. Server handles and caches are
 * deliberately excluded; the session bundle stores source paths separately.
 */
const DAFC_STATE_KEYS = [
  'dafcChrom', 'dafcStart', 'dafcEnd', 'dafcResolution',
  'dafcXStart', 'dafcXEnd', 'dafcYStart', 'dafcYEnd', 'dafcSelection',
  'contactMode', 'contactModeOverride', 'splitViewMode', 'splitViewLinked',
  'microcTrackMode', 'microcMinDistance', 'microcMaxDistance', 'microcResolution',
  'arcStrengthFilter', 'arcStrengthFilterMax', 'filterByPeaks',
  'matrixScaling', 'matrixColormap', 'matrixNormalization', 'matrixFocusRegion',
  'matrixValueMin', 'matrixValueMax', 'arcDisplayMode', 'arcMergeBinSize',
  'arcNormalization', 'arcMinCount', 'arcOEFloor', 'arcAccCorrect', 'arcAccLog',
  'v4cNormalization', 'v4cSmoothing', 'v4cMinCount', 'v4cViewpoint',
  // Live linked-session IDs, server registries, reads, and derived segment sets
  // are deliberately excluded: they are process-local resources, not portable
  // browser state. The split-view presentation settings below are portable.
  'linkedSplitMode',
  'xViewport', 'yViewport', 'linkedSortBy', 'xViewportFilter', 'yViewportFilter',
  'showUnlinkedReads', 'highlightLinkedMolecules', 'showGeneAnnotations',
  'dafcFollowBrowser',
] as const;

export type SerializedDafcSettings = Record<(typeof DAFC_STATE_KEYS)[number], unknown>;

export function serializeDafcSettings(): Partial<SerializedDafcSettings> {
  const state = useDafcStore.getState() as unknown as Record<string, unknown>;
  const serialized: Record<string, unknown> = {};
  for (const key of DAFC_STATE_KEYS) {
    const value = state[key];
    serialized[key] = value instanceof Set ? [...value] : value;
  }
  return serialized as Partial<SerializedDafcSettings>;
}

export function applyDafcSettings(
  settings: unknown,
  options: { availableResolutions?: number[] } = {},
): void {
  if (!settings || typeof settings !== 'object') return;
  const source = settings as Record<string, unknown>;
  const partial: Record<string, unknown> = {};
  for (const key of DAFC_STATE_KEYS) {
    if (!(key in source)) continue;
    if (
      (key === 'dafcResolution' || key === 'microcResolution')
      && source[key] != null
      && options.availableResolutions?.length
      && !options.availableResolutions.includes(Number(source[key]))
    ) {
      // Keep the resolution selected by the freshly loaded contact source.
      // A session may be opened against a replaced .mcool with a new ladder.
      if (key === 'microcResolution') partial.microcResolution = null;
      continue;
    }
    partial[key] = source[key];
  }
  useDafcStore.setState(partial as never);
}
