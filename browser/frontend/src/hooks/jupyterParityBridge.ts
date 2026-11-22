/**
 * The notebook link for settings added since 3.0 (API parity, 3.1.1): read filters (Min footprints with its
 * "All reads, including uncalled" choice, footprint quality, the duplicate and QC-fail toggles), the default
 * metaprofile's follow mode, layer colours (the session's and the saved defaults), Quantify a window, Plots and the
 * workspace. `applyParitySettings` applies a notebook's `settings_update`; `paritySnapshot` reports them back
 * (BrowserClient.get_browser_settings). Kept apart from jupyterStateBridge so each setting lives in one place.
 */
import { useBrowserStore, type BrowserState } from '../stores/browserStore';
import type { BrowserSettingsSnapshot, JupyterState } from '../api/jupyter';
import { applyFollowActiveLayers, followsActiveLayers, isDefaultMetaprofile } from '../utils/defaultMetaprofile';
import { normalizeLayerColorMap, normalizeLayerHex, layerColorKey } from '../utils/layerColors';
import { useWorkspaceStore, openPlots, setWorkspace, type WorkspaceView } from '../features/plots/workspace';
import { useGalleryStore } from '../features/plots/gallery';
import { metaLocusSessionPayload } from '../features/metaLocus/metaLocusStore';
import { normalizePlotsWorkspace } from '../features/plots/plotsState';

type SettingsUpdate = NonNullable<JupyterState['settings_update']>;
type ParityKeys =
  | 'min_footprints' | 'min_fp_quality' | 'show_duplicate_reads' | 'show_qc_fail_reads'
  | 'metaprofile_follow_active_layers' | 'layer_color_overrides' | 'user_layer_colors'
  | 'window_quant' | 'plots_workspace' | 'plots_gallery' | 'workspace' | 'meta_locus' | 'reversed';
export type ParitySnapshot = Pick<BrowserSettingsSnapshot, ParityKeys>;

const WORKSPACES: readonly WorkspaceView[] = ['browser', 'plots', 'hub'];

/** Merge a notebook's colour map (null forgets a layer) into the current one; bad colours are skipped. */
export function mergeLayerColors(
  current: Record<string, string> | undefined,
  patch: Record<string, string | null> | null | undefined,
  replace = false,
): Record<string, string> {
  const next: Record<string, string> = replace ? {} : { ...(current ?? {}) };
  for (const [key, value] of Object.entries(patch ?? {})) {
    const k = layerColorKey(key);
    if (!k) continue;
    if (value === null) { delete next[k]; continue; }
    const hex = normalizeLayerHex(value);
    if (hex) next[k] = hex;
  }
  return normalizeLayerColorMap(next);
}

/** The default metaprofile with follow mode on or off (on: its layer sources follow the toggles again at once). */
export function setMetaprofileFollow(state: Pick<BrowserState, 'compositeTracks' | 'enabledModTypes' | 'datasets'>, on: boolean) {
  const idx = state.compositeTracks.findIndex(isDefaultMetaprofile);
  if (idx < 0) return state.compositeTracks;
  const track = state.compositeTracks[idx];
  if (followsActiveLayers(track) === on) return state.compositeTracks;
  const next = [...state.compositeTracks];
  next[idx] = { ...track, followActiveLayers: on };
  return on ? applyFollowActiveLayers(next, state.enabledModTypes, state.datasets) : next;
}

/** Apply the parity part of a notebook's settings update. */
export function applyParitySettings(update: SettingsUpdate): void {
  const store = useBrowserStore.getState();
  if (typeof update.min_footprints === 'number' && Number.isFinite(update.min_footprints)) {
    store.setMinFootprints(Math.max(-1, Math.round(update.min_footprints)));
  }
  if (typeof update.min_fp_quality === 'number' && Number.isFinite(update.min_fp_quality)) {
    store.setMinFpQuality(Math.max(0, Math.min(255, Math.round(update.min_fp_quality))));
  }
  if (typeof update.show_duplicate_reads === 'boolean') store.setShowDuplicateReads(update.show_duplicate_reads);
  if (typeof update.show_qc_fail_reads === 'boolean') store.setShowQcFailReads(update.show_qc_fail_reads);
  if (typeof update.metaprofile_follow_active_layers === 'boolean' && !update.metaprofile_follow_first) {
    const s = useBrowserStore.getState();
    const next = setMetaprofileFollow(s, update.metaprofile_follow_active_layers);
    if (next !== s.compositeTracks) useBrowserStore.setState({ compositeTracks: next });
  }
  if (update.layer_color_overrides || update.replace_layer_color_overrides) {
    const s = useBrowserStore.getState();
    const next = mergeLayerColors(s.layerColorOverrides, update.layer_color_overrides, update.replace_layer_color_overrides === true);
    if (JSON.stringify(next) !== JSON.stringify(s.layerColorOverrides ?? {})) {
      s.pushSnapshot?.('Before layer colour change', { kind: 'labeling' });
      useBrowserStore.setState({ layerColorOverrides: next } as Partial<BrowserState>);
      useBrowserStore.getState().pushSnapshot?.('Layer colours from Python', { kind: 'labeling' });
    }
  }
  if (update.user_layer_colors) {
    const s = useBrowserStore.getState();
    // The store's persist hook writes the saved defaults back (analysis preferences, this origin's storage).
    useBrowserStore.setState({ userLayerColors: mergeLayerColors(s.userLayerColors, update.user_layer_colors) } as Partial<BrowserState>);
  }
  if (update.window_quant && typeof update.window_quant === 'object') {
    const wq = update.window_quant as Record<string, unknown>;
    const s = useBrowserStore.getState();
    if ('window' in wq) s.setQuantWindow?.((wq.window ?? null) as never);
    if (wq.spec && typeof wq.spec === 'object') s.updateQuantSpec?.(wq.spec as never);
    if (wq.axis && typeof wq.axis === 'object') s.setQuantAxis?.(wq.axis as never);
    // By presence: an explicit null (open_quantify(None)) closes the card.
    const openIn = 'open_in' in wq ? wq.open_in : wq.openIn;
    if (openIn === 'cluster' || openIn === 'track' || openIn === null) s.setQuantOpen?.(openIn);
  }
  if (Array.isArray(update.plots_region_sets)) {
    // A replayed snapshot's BED region sets, before its plot (a BED plot names its sets by id).
    const s = useBrowserStore.getState() as unknown as { plotsWorkspace?: unknown; setPlotsWorkspace?: (ws: unknown) => void };
    const ws = normalizePlotsWorkspace({ ...(s.plotsWorkspace as object ?? {}), regionSets: update.plots_region_sets });
    s.setPlotsWorkspace?.(ws);
  }
  if (update.plot && typeof update.plot === 'object') {
    // A spec naming only `sources` (several layers in one plot): `source` follows the first, as a chip click sets
    // them; otherwise the default `source` would win over the list (plotModel.plotSources).
    const plot = { ...(update.plot as Record<string, unknown>) };
    if (Array.isArray(plot.sources) && plot.sources.length && plot.source === undefined) plot.source = plot.sources[0];
    openPlots(plot as never);
  }
  if (typeof update.workspace === 'string' && WORKSPACES.includes(update.workspace as WorkspaceView)) {
    setWorkspace(update.workspace as WorkspaceView);
    if (update.workspace !== useWorkspaceStore.getState().view) {
      // The hub workspace is experimental (off by default): say why it did not open; the snapshot reports the view.
      useBrowserStore.getState().setError?.('The feature hub workspace is experimental: turn it on in Settings › Read Display › Experimental.');
    }
  }
  if (typeof update.reversed === 'boolean' && useBrowserStore.getState().isReversed !== update.reversed) {
    useBrowserStore.getState().toggleReversed();
  }
}

/** A merged summary (no ordered calls) asking for the follow switch before its toggles: apply it first. */
export function applyFollowFirst(update: SettingsUpdate): void {
  if (!update.metaprofile_follow_first || typeof update.metaprofile_follow_active_layers !== 'boolean') return;
  const s = useBrowserStore.getState();
  const next = setMetaprofileFollow(s, update.metaprofile_follow_active_layers);
  if (next !== s.compositeTracks) useBrowserStore.setState({ compositeTracks: next });
}

/** The default metaprofile's follow mode (null: no default metaprofile yet). */
export function metaprofileFollowFlag(state: Pick<BrowserState, 'compositeTracks'>): boolean | null {
  const track = state.compositeTracks.find(isDefaultMetaprofile);
  return track ? followsActiveLayers(track) : null;
}

/** The Gallery's cards without their data (names, kept or working, the plot they belong to). */
export function gallerySummary(): ParitySnapshot['plots_gallery'] {
  const g = useGalleryStore.getState() as unknown as { entries?: Array<{ id: string; name: string; status: string; plotId?: string | null }> };
  return (g.entries ?? []).map(e => ({ id: e.id, name: e.name, status: e.status, plot_id: e.plotId ?? null }));
}

/** What the notebook reads back for the parity settings (stores other than the browser store read here). */
export function paritySnapshot(state: BrowserState = useBrowserStore.getState()): ParitySnapshot {
  return {
    min_footprints: state.minFootprints,
    min_fp_quality: state.minFpQuality,
    show_duplicate_reads: state.showDuplicateReads,
    show_qc_fail_reads: state.showQcFailReads,
    metaprofile_follow_active_layers: metaprofileFollowFlag(state),
    layer_color_overrides: { ...(state.layerColorOverrides ?? {}) },
    user_layer_colors: { ...(state.userLayerColors ?? {}) },
    window_quant: state.windowQuant ? { ...(state.windowQuant as unknown as Record<string, unknown>) } : undefined,
    plots_workspace: state.plotsWorkspace ? { ...(state.plotsWorkspace as unknown as Record<string, unknown>) } : undefined,
    plots_gallery: gallerySummary(),
    workspace: useWorkspaceStore.getState().view,
    meta_locus: metaLocusSessionPayload() as unknown as Record<string, unknown> | null,
    reversed: state.isReversed,
  };
}
