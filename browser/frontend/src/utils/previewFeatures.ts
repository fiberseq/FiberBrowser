/**
 * Preview features (ARCHITECTURE.md, "Preview features"): released, but off until the user turns on Settings → Show
 * preview features. A feature is described once (`registerPreviewFeature`: label, known limitations, what graduates
 * it); the registrations that are its entry points carry `preview: '<id>'` (an analysis panel, a read-menu
 * contribution, a track kind or a track-menu item, a panel-header extension, a split hook, the SV row's selection).
 * With the switch off those entry points are hidden; the feature still registers, so sessions, undo and crash recovery
 * keep its state, and a session that uses it says so in one line with an offer to turn previews on.
 *
 * The switch is kept on this computer (utils/analysisPreferences: `show_preview_features` in
 * ~/.fiberhmm/analysis_preferences.json, so every port and build sees it), with this origin's storage as the fallback
 * (a public server, a tour tab, an unreachable server).
 *
 * No store imports: the registries (plugins/registry, read menus, tracks) read it.
 */
import { create } from 'zustand';

export interface PreviewFeature {
  /** What registrations name it by ('variants'). */
  id: string;
  /** Its name in badges, notes and Settings ("Variants panel"). */
  label: string;
  /** One line: what it does. */
  summary: string;
  /** Known limitations, one sentence each. */
  limitations: string[];
  /** What it takes to graduate from Preview to a supported feature. */
  graduation: string;
  /**
   * Labelled only: its Preview badge marks it, but Settings → Show preview features neither lists nor hides it (a
   * section of a supported panel, such as the Footprints panel's footprint classes).
   */
  labelOnly?: boolean;
  /** Whether a (saved or current) browser state uses it: a session that does says so while previews are off. */
  inUse?: (state: PreviewUsageState) => boolean;
}

/** The parts of a browser state a Preview feature looks at (`inUse`). */
export interface PreviewUsageState {
  panels?: ReadonlyArray<Record<string, unknown>>;
  selectedFeatures?: ReadonlyArray<{ kind?: unknown }>;
}

export const PREVIEW_STORAGE_KEY = 'fiberbrowser_show_preview_features';
/** Its field in the server's analysis preferences (services/analysis_preferences.py). */
export const PREVIEW_PREFERENCE_FIELD = 'show_preview_features';

const features = new Map<string, PreviewFeature>();

/** Describe a Preview feature (once; a later call replaces it). */
export function registerPreviewFeature(feature: PreviewFeature): void {
  features.set(feature.id, feature);
}

export function getPreviewFeature(id: string | null | undefined): PreviewFeature | undefined {
  return id ? features.get(id) : undefined;
}

export function allPreviewFeatures(): PreviewFeature[] {
  return [...features.values()];
}

/** The switch's value when nothing was chosen: set by the release pack (setPreviewDefault). */
let defaultOn = false;

/** The user's own choice on this origin (null: none yet). */
function storedSwitch(): boolean | null {
  try {
    const v = localStorage.getItem(PREVIEW_STORAGE_KEY);
    return v === 'true' ? true : v === 'false' ? false : null;
  } catch { return null; }
}

/** Whether the user chose (on this origin): a choice is kept by the server even when it equals the default. */
export function previewChoiceStored(): boolean {
  return storedSwitch() !== null;
}

/** What the switch is when nothing was chosen. */
export function previewDefault(): boolean {
  return defaultOn;
}

/**
 * The build's default for Settings → Show preview features (the release pack: on). A choice the user made (this origin's
 * storage, or the server's preference applied later) still wins.
 */
export function setPreviewDefault(on: boolean): void {
  defaultOn = on;
  if (storedSwitch() === null) usePreviewStore.setState({ enabled: on });
}

interface PreviewState {
  /** Settings → Show preview features (on in the release unless the user chooses otherwise). */
  enabled: boolean;
  setEnabled: (on: boolean) => void;
}

export const usePreviewStore = create<PreviewState>(set => ({
  enabled: storedSwitch() ?? defaultOn,
  setEnabled: on => {
    try { localStorage.setItem(PREVIEW_STORAGE_KEY, String(on)); } catch { /* private mode: this page only */ }
    set({ enabled: on });
  },
}));

export function previewsEnabled(): boolean {
  return usePreviewStore.getState().enabled;
}

export function setPreviewsEnabled(on: boolean): void {
  if (usePreviewStore.getState().enabled !== on) usePreviewStore.getState().setEnabled(on);
}

/** The switch, for components that show or hide preview entry points (re-renders when it flips). */
export function usePreviewsEnabled(): boolean {
  return usePreviewStore(s => s.enabled);
}

/** Whether an entry point of this Preview feature is hidden now (no id: never). */
export function previewHidden(id: string | null | undefined): boolean {
  return Boolean(id) && !usePreviewStore.getState().enabled;
}

/** The Preview features a state uses. */
export function previewFeaturesInUse(state: PreviewUsageState | null | undefined): PreviewFeature[] {
  if (!state) return [];
  return allPreviewFeatures().filter(f => {
    try { return Boolean(f.inUse?.(state)); } catch { return false; }
  });
}

/** The one-line offer a state that uses Preview features gives while they are off (null: none). */
export function previewSessionNote(state: PreviewUsageState | null | undefined): string | null {
  if (previewsEnabled()) return null;
  const labels = previewFeaturesInUse(state).map(f => f.label);
  if (!labels.length) return null;
  return `This session uses Preview features (${labels.join(', ')}): its panels and results are kept; turn on Settings → Show preview features to work with them.`;
}

/** Tests: the switch back to its default. */
export function resetPreviewsForTests(on = false): void {
  defaultOn = false;
  usePreviewStore.setState({ enabled: on });
}
