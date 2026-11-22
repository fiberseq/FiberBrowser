import { useEffect, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../stores/browserStore';
import { defaultMetaprofileTogglesKey, togglesFromKey } from '../utils/defaultMetaprofile';
import { isPublicMode } from '../utils/publicMode';
import { useCoaccStore } from '../stores/coaccStore';
import { getJupyterState, syncJupyterBrowserSettings } from '../api/jupyter';
import { FRONTEND_DIAGNOSTICS } from '../utils/diagnostics';
import {
  applyJupyterStateToBrowser,
  buildJupyterBrowserSettingsPayload,
} from './jupyterStateBridge';
import { metaprofileFollowFlag, paritySnapshot } from './jupyterParityBridge';
import { useWorkspaceStore } from '../features/plots/workspace';
import { useGalleryStore } from '../features/plots/gallery';
import { useMetaLocusStore } from '../features/metaLocus/metaLocusStore';

const DEBUG = FRONTEND_DIAGNOSTICS;

/**
 * Polls the Jupyter integration state with exponential backoff.
 * Polls quickly (500ms) when changes detected, slows down (up to 5s) when idle.
 */
export function useJupyterPolling() {
  // Rendered figures and public servers have no notebook to talk to.
  const isRenderMode = (typeof window !== 'undefined' && !!window.__FIBERBROWSER_RENDER_MODE) || isPublicMode();
  const jupyterVersion = useBrowserStore(s => s.jupyterVersion);
  const browserSettingsSnapshot = useBrowserStore(useShallow(s => ({
    analysis_sample_seed: s.analysisSampleSeed,
    analysis_sample_count: s.analysisSampleCount,
    display_sample_count: s.downsampleCount,
    read_display_mode: s.readDisplayMode,
    all_reads_display_cap: s.allReadsDisplayCap,
    background_read_cap: s.backgroundReadCap,
    spanning_only: s.spanningOnly,
    peaks_locked: s.peaksLocked,
    peak_rules: s.peakRules,
    selected_peaks_set: s.selectedPeaks,
    peak_modes: s.peakModes,
    peaks_by_rule: s.peaksByRule,
    cluster_feature_rules: s.clusterFeatureRules,
    analysis_sort_rules: s.analysisSortRules,
    analysis_filter_rules: s.analysisFilterRules,
    capture_regions: s.captureRegions,
    capture_padding: s.capturePadding,
    catalog: s.catalog,
    composite_tracks: s.compositeTracks,
    saved_tracks: s.savedTracks,
    footprint_groups: s.footprintGroups,
    selected_genes: s.selectedGenes,
    transcription_state_filters: s.transcriptionStateFilters,
    primer_saved_primers: s.primer.savedPrimers,
    primer_mode: s.primer.mode,
    primer_cart_track_display: s.primer.cartTrackDisplay,
    enabled_mod_types: s.enabledModTypes,
    // Reported for the Python client: what the default metaprofile shows (it follows the layers).
    // A string here so the shallow selector stays stable; expanded to a map when sent.
    enabled_meta_profiles: defaultMetaprofileTogglesKey(s),
    cached_layer_types: s.cachedLayerTypes,
    legacy_layer_inference: s.legacyLayerInference,
    legacy_nuc_min_size: s.legacyNucMinSize,
    click_target_layer: s.clickTargetLayer,
    footprint_analysis_layer: s.footprintAnalysisLayer,
    fill_read_height: s.fillReadHeight,
    read_row_height: s.readRowHeight,
    show_coverage_histogram: s.showCoverageHistogram,
    max_region_for_reads: s.maxRegionForReads,
    show_genome_overview: s.showGenomeOverview,
    panels: s.panels,
    hidden_strip_panels_set: s.hiddenStripPanels,
    cluster_assignments: s.clusterAssignments,
    cluster_order: s.clusterOrder,
    read_sort_order: s.readSortOrder,
    active_colormap: s.activeColormap,
    cluster_method: s.clusterMethod,
    cluster_k: s.clusterK,
    small_footprint_threshold_bp: s.subnucleosomalThreshold,
    accessibility_threshold: s.accessibilityThreshold,
    selected_peak_count: s.selectedPeaks.size,
    selected_read_ids: s.selectedReadIds,
    // 3.1.1 parity settings (reported through paritySnapshot; listed here so a change re-syncs).
    parity_min_footprints: s.minFootprints,
    parity_min_fp_quality: s.minFpQuality,
    parity_show_duplicate_reads: s.showDuplicateReads,
    parity_show_qc_fail_reads: s.showQcFailReads,
    parity_follow: metaprofileFollowFlag(s),
    parity_layer_colors: s.layerColorOverrides,
    parity_user_layer_colors: s.userLayerColors,
    parity_window_quant: s.windowQuant,
    parity_plots_workspace: s.plotsWorkspace,
    parity_reversed: s.isReversed,
  })));
  // Plots, the Gallery and the meta-locus keep their own stores.
  const workspaceView = useWorkspaceStore(s => s.view);
  const galleryEntries = useGalleryStore(s => (s as unknown as { entries?: unknown }).entries);
  const metaLocusKey = useMetaLocusStore(s => `${s.spec?.bed_path ?? ''}|${s.status?.pool_id ?? ''}|${s.seed}|${s.count}|${s.view?.extra_entries?.length ?? 0}`);
  const coaccSettingsSnapshot = useCoaccStore(useShallow(s => ({
    coaccTrackMode: s.coaccTrackMode,
    coaccSignalType: s.coaccSignalType,
    coaccLayer: s.coaccLayer,
    coaccNormalization: s.coaccNormalization,
    coaccScaling: s.coaccScaling,
    coaccColormap: s.coaccColormap,
    coaccMinCoverage: s.coaccMinCoverage,
    coaccBinSize: s.coaccBinSize,
    coaccArcThreshold: s.coaccArcThreshold,
    coaccArcMaxArcs: s.coaccArcMaxArcs,
    coaccArcMinDistance: s.coaccArcMinDistance,
    coaccV4cViewpoint: s.coaccV4cViewpoint,
  })));
  const jupyterPollIntervalRef = useRef(1500);

  useEffect(() => {
    if (isRenderMode) return;
    let idleHandle: number | null = null;
    const w = window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const timeoutId = setTimeout(() => {
      const run = () => {
        const {
          parity_min_footprints: _a, parity_min_fp_quality: _b, parity_show_duplicate_reads: _c, parity_show_qc_fail_reads: _d,
          parity_follow: _e, parity_layer_colors: _f, parity_user_layer_colors: _g, parity_window_quant: _h, parity_plots_workspace: _i, parity_reversed: _j,
          ...settings
        } = browserSettingsSnapshot;
        syncJupyterBrowserSettings({
          ...buildJupyterBrowserSettingsPayload({ ...settings, enabled_meta_profiles: togglesFromKey(settings.enabled_meta_profiles) }, coaccSettingsSnapshot),
          ...paritySnapshot(),
        }).catch(() => {
          // Best-effort mirror for notebooks; polling still handles commands.
        });
      };
      idleHandle = w.requestIdleCallback
        ? w.requestIdleCallback(run, { timeout: 4000 })
        : window.setTimeout(run, 0);
    }, 2000);
    return () => {
      clearTimeout(timeoutId);
      if (idleHandle === null) return;
      if (w.cancelIdleCallback) w.cancelIdleCallback(idleHandle);
      else clearTimeout(idleHandle);
    };
  }, [browserSettingsSnapshot, coaccSettingsSnapshot, isRenderMode, workspaceView, galleryEntries, metaLocusKey]);

  useEffect(() => {
    if (isRenderMode) return;
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout>;

    const pollJupyter = async () => {
      try {
        const state = await getJupyterState();

        if (cancelled) return;

        // Only update if version changed
        if (state.version !== jupyterVersion) {
          // Reset to fast polling when changes detected
          jupyterPollIntervalRef.current = 1500;

          applyJupyterStateToBrowser(state, DEBUG);
        } else {
          // No changes - increase poll interval with exponential backoff (up to 5s max)
          jupyterPollIntervalRef.current = Math.min(
            jupyterPollIntervalRef.current * 1.5,
            5000
          );
        }
      } catch {
        // Server not available - use longer interval
        jupyterPollIntervalRef.current = Math.min(jupyterPollIntervalRef.current * 2, 5000);
      }

      // Schedule next poll with dynamic interval
      if (!cancelled) {
        timeoutId = setTimeout(pollJupyter, jupyterPollIntervalRef.current);
      }
    };

    // Initial poll
    pollJupyter();

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [jupyterVersion, isRenderMode]);
}
