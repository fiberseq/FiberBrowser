import { isScannedRule, keepMatched } from '../utils/matchedRegions';
import { useBrowserStore } from '../stores/browserStore';
import { applyCoaccSettings, type SerializedCoaccSettings } from '../stores/coaccStore';
import { executeBrowserActions } from '../actions/browserActions';
import type { BrowserSettingsSnapshot, JupyterState } from '../api/jupyter';
import { importPeakEntriesToBrowser } from '../utils/peakImport';
import { buildSessionManifest } from '../utils/sessionManifest';
import {
  findOpenAnalysisPanel,
  isAnalysisPanel,
  normalizeAnalysisPanelContentTypes,
} from '../plugins/registry';
import type { ParsedPeakBedEntry } from '../utils/peakBed';
import { normalizeAnnotationLayer, normalizeLayerToggleMap } from '../utils/layerAliases';
import { applyDefaultMetaprofileToggles } from '../utils/defaultMetaprofile';
import { keepPickedSourceColors } from '../stores/compositeTracksSlice';
import { applyFollowFirst, applyParitySettings } from './jupyterParityBridge';

type BrowserSettingsSource = Omit<BrowserSettingsSnapshot, 'selected_read_ids'> & {
  selected_peaks_set: Set<number>;
  selected_read_ids: Record<string, Set<string>>;
  panels: Array<{ id: string; contentType: string; collapsed?: boolean }>;
  hidden_strip_panels_set: Set<string>;
};

export function serializeSelectedReadIds(
  selectedReadIds: Record<string, Set<string>>,
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(selectedReadIds)
      .map(([datasetId, ids]) => [datasetId, [...ids]])
      .filter(([, ids]) => (ids as string[]).length > 0),
  ) as Record<string, string[]>;
}

export function buildJupyterBrowserSettingsPayload(
  browserSettingsSnapshot: BrowserSettingsSource,
  coaccSettingsSnapshot: SerializedCoaccSettings,
): BrowserSettingsSnapshot {
  const {
    selected_peaks_set,
    selected_read_ids,
    panels,
    hidden_strip_panels_set,
    ...snapshot
  } = browserSettingsSnapshot;
  const activeQualityFilters = (snapshot.active_colormap?.qualityFilters ?? [])
    .filter((filter: any) => filter?.enabled)
    .map((filter: any) => ({
      layer: filter.layer,
      quality_name: filter.qualityName,
      min_value: filter.minValue,
    }))
    .map((filter: any) => ({
      ...filter,
      layer: filter.layer === '*' ? '*' : normalizeAnnotationLayer(filter.layer) ?? '*',
    }));

  return {
    ...snapshot,
    selected_peaks: [...selected_peaks_set],
    selected_peak_count: selected_peaks_set.size,
    selected_read_ids: serializeSelectedReadIds(selected_read_ids),
    active_quality_filters: activeQualityFilters,
    coacc_settings: coaccSettingsSnapshot,
    session_manifest: buildSessionManifest(useBrowserStore.getState()),
    active_panels: panels
      .filter(panel => isAnalysisPanel(panel.contentType) && !panel.collapsed)
      .map(panel => ({ id: panel.id, content_type: panel.contentType })),
    hidden_strip_panels: normalizeAnalysisPanelContentTypes(hidden_strip_panels_set),
  };
}

function selectedReadIdsFromJupyter(state: JupyterState): Record<string, Set<string>> | null {
  const selectedByDataset = state.selected_read_ids ?? {};
  const entries = Object.entries(selectedByDataset);
  if (entries.length > 0) {
    return Object.fromEntries(
      entries.map(([datasetId, ids]) => [datasetId, new Set(ids)]),
    ) as Record<string, Set<string>>;
  }

  if (state.selected_reads?.length) {
    const datasetId = useBrowserStore.getState().datasets[0]?.id;
    if (datasetId) {
      return { [datasetId]: new Set(state.selected_reads) };
    }
  }

  return null;
}

type SettingsUpdate = NonNullable<JupyterState['settings_update']>;

/** One notebook settings call (BrowserClient.set_*), applied as the browser's own controls would apply it. */
export function applySettingsUpdate(update: SettingsUpdate): void {
    const store = useBrowserStore.getState();
    if (update.analysis_sample_seed != null) {
      store.setAnalysisSampleSeed(update.analysis_sample_seed);
    }
    if ('analysis_sample_count' in update) {
      store.setAnalysisSampleCount(update.analysis_sample_count ?? null);
    }
    if ('display_sample_count' in update) {
      store.setDownsampleCount(update.display_sample_count ?? null);
    }
    if (update.read_display_mode === 'sample' || update.read_display_mode === 'all') {
      store.setReadDisplayMode(update.read_display_mode);
    }
    if (update.all_reads_display_cap != null) {
      store.setAllReadsDisplayCap(update.all_reads_display_cap);
    }
    if ('background_read_cap' in update) {
      store.setBackgroundReadCap(update.background_read_cap ?? null);
    }
    if (update.spanning_only != null) {
      store.setSpanningOnly(update.spanning_only);
    }
    if (typeof update.peaks_locked === 'boolean') {
      store.setPeaksLocked(update.peaks_locked);
    }
    if (Array.isArray(update.peak_rules)) {
      store.setPeakRules(update.peak_rules);
    }
    if (update.peaks_by_rule && typeof update.peaks_by_rule === 'object') {
      useBrowserStore.setState(keepMatched(useBrowserStore.getState(), { peaksByRule: update.peaks_by_rule } as any));
    }
    if (Array.isArray(update.selected_peaks)) {
      useBrowserStore.setState({ selectedPeaks: new Set(update.selected_peaks) } as any);
    }
    if (update.peak_modes && typeof update.peak_modes === 'object') {
      useBrowserStore.setState({ peakModes: update.peak_modes } as any);
    }
    if (Array.isArray(update.cluster_feature_rules)) {
      store.setClusterFeatureRules(update.cluster_feature_rules);
    }
    if (Array.isArray(update.analysis_sort_rules)) {
      store.setAnalysisSortRules(update.analysis_sort_rules);
    }
    if (Array.isArray(update.analysis_filter_rules)) {
      store.setAnalysisFilterRules(update.analysis_filter_rules);
    }
    if (update.active_colormap) {
      store.setActiveColormap(update.active_colormap);
    }
    if (update.cluster_method != null) {
      store.setClusterMethod(update.cluster_method);
    }
    if (update.cluster_k != null) {
      store.setClusterK(update.cluster_k);
    }
    if (update.small_footprint_threshold_bp != null) {
      store.setSubnucleosomalThreshold(update.small_footprint_threshold_bp);
    }
    if (update.accessibility_threshold != null) {
      store.setAccessibilityThreshold(update.accessibility_threshold);
    }
    if (Array.isArray(update.capture_regions)) {
      store.setCaptureRegions(update.capture_regions);
    }
    if (update.capture_padding != null) {
      store.setCapturePadding(update.capture_padding);
    }
    if (Array.isArray(update.catalog)) {
      store.setCatalog(update.catalog);
    }
    if (Array.isArray(update.composite_tracks)) {
      // A colour the notebook changed on a default-coloured source is the user's choice (keepPickedSourceColors).
      store.setCompositeTracks(keepPickedSourceColors(update.composite_tracks, store.compositeTracks ?? []));
    }
    if (Array.isArray(update.saved_tracks)) {
      store.setSavedTracks(update.saved_tracks);
    }
    if (Array.isArray(update.footprint_groups)) {
      store.setFootprintGroups(update.footprint_groups);
    }
    if (Array.isArray(update.selected_genes)) {
      store.setSelectedGenes(update.selected_genes);
    }
    if (update.transcription_state_filters && typeof update.transcription_state_filters === 'object') {
      store.setTranscriptionStateFilters(update.transcription_state_filters);
    }
    if (Array.isArray(update.primer_saved_primers)) {
      useBrowserStore.setState(current => ({
        primer: { ...current.primer, savedPrimers: update.primer_saved_primers! },
      }) as any);
    }
    if (update.primer_mode === 'standard' || update.primer_mode === 'dafc' || update.primer_mode === '4c') {
      store.setPrimerMode(update.primer_mode);
    }
    if (update.primer_cart_track_display === 'off' || update.primer_cart_track_display === 'all' || update.primer_cart_track_display === 'imported' || update.primer_cart_track_display === 'design') {
      store.setCartTrackDisplay(update.primer_cart_track_display);
    }
    // A merged summary that switched follow mode before these toggles: the switch first (jupyterParityBridge).
    applyFollowFirst(update);
    if (update.enabled_mod_types && typeof update.enabled_mod_types === 'object') {
      const enabledModTypes = normalizeLayerToggleMap(update.enabled_mod_types as Record<string, boolean>);
      useBrowserStore.setState({
        enabledModTypes: { ...store.enabledModTypes, ...(enabledModTypes ?? {}) },
      } as any);
    }
    // settings_update.enabled_meta_profiles (set_metaprofile_layers): explicit settings for the default
    // metaprofile's sources. A change switches it to manual, as a hand edit does; a map that matches what it
    // shows (a replayed snapshot) keeps it following (utils/defaultMetaprofile.ts).
    if (update.enabled_meta_profiles && typeof update.enabled_meta_profiles === 'object') {
      const toggles = normalizeLayerToggleMap(update.enabled_meta_profiles as Record<string, boolean>) ?? {};
      const current = useBrowserStore.getState().compositeTracks;
      const next = applyDefaultMetaprofileToggles(current, toggles);
      if (next !== current) useBrowserStore.setState({ compositeTracks: next });
    }
    if (update.cached_layer_types && typeof update.cached_layer_types === 'object') {
      const cachedLayerTypes = normalizeLayerToggleMap(update.cached_layer_types as Record<string, boolean>);
      useBrowserStore.setState({
        cachedLayerTypes: { ...store.cachedLayerTypes, ...(cachedLayerTypes ?? {}) },
      } as any);
    }
    if (typeof update.legacy_layer_inference === 'boolean') {
      store.setLegacyLayerInference(update.legacy_layer_inference);
    }
    if (update.legacy_nuc_min_size != null) {
      store.setLegacyNucMinSize(update.legacy_nuc_min_size);
    }
    if ('click_target_layer' in update) {
      store.setClickTargetLayer(normalizeAnnotationLayer(update.click_target_layer));
    }
    if ('footprint_analysis_layer' in update) {
      store.setFootprintAnalysisLayer(normalizeAnnotationLayer(update.footprint_analysis_layer));
    }
    if ('coacc_settings' in update) {
      applyCoaccSettings(update.coacc_settings);
    }
    if (typeof update.fill_read_height === 'boolean') {
      store.setFillReadHeight(update.fill_read_height);
    }
    if ('read_row_height' in update) {
      const next = update.read_row_height === 'auto'
        ? 'auto'
        : Number(update.read_row_height);
      if (next === 'auto' || (typeof next === 'number' && Number.isFinite(next))) {
        store.setReadRowHeight(next as number | 'auto');
      }
    }
    if (typeof update.show_coverage_histogram === 'boolean') {
      store.setShowCoverageHistogram(update.show_coverage_histogram);
    }
    if (update.max_region_for_reads != null) {
      store.setMaxRegionForReads(update.max_region_for_reads);
    }
    if (typeof update.show_genome_overview === 'boolean') {
      useBrowserStore.setState({ showGenomeOverview: update.show_genome_overview } as any);
    }
    if (Array.isArray(update.hidden_strip_panels)) {
      store.setHiddenStripPanels(update.hidden_strip_panels);
    }
    // Queued opens/closes in order (a single open_panel/close_panel from an
    // older server too).
    const panelOps: Array<['open' | 'close', string]> = [...(update.panel_ops ?? [])];
    if (update.close_panel) panelOps.push(['close', update.close_panel]);
    if (update.open_panel) panelOps.push(['open', update.open_panel]);
    for (const [verb, panelType] of panelOps) {
      if (verb === 'open') {
        useBrowserStore.getState().openAnalysisPanel(panelType as any);
      } else {
        const panel = findOpenAnalysisPanel(useBrowserStore.getState().panels, panelType);
        if (panel) useBrowserStore.getState().closeAnalysisPanel(panel.id);
      }
    }
    // Read filters, metaprofile follow mode, layer colours, Quantify a window, Plots, workspace (3.1.1).
    applyParitySettings(update);
  }

export function applyJupyterStateToBrowser(state: JupyterState, debug = false): void {
  useBrowserStore.getState().setJupyterVersion(state.version);
  useBrowserStore.getState().setJupyterHighlights(state.highlights || []);
  useBrowserStore.getState().setJupyterMarkers(state.markers || []);
  useBrowserStore.getState().setJupyterFootprintColors(state.footprint_colors || []);
  useBrowserStore.getState().setJupyterReadOrder(state.read_order || {});
  useBrowserStore.getState().setJupyterReadFilter(state.read_filter || {});
  useBrowserStore.getState().setJupyterPushedReads(state.pushed_reads || null);

  if (state.goto) {
    useBrowserStore.getState().setViewport(state.goto.chrom, state.goto.start, state.goto.end);
  }

  const selectedReadIds = selectedReadIdsFromJupyter(state);
  if (selectedReadIds) {
    useBrowserStore.setState(current => ({
      selectedReadIds: {
        ...current.selectedReadIds,
        ...selectedReadIds,
      },
    }) as any);
  }

  if (state.peak_import?.peaks?.length) {
    const targetChrom = state.peak_import.chrom || state.goto?.chrom || useBrowserStore.getState().chrom;
    const entries = state.peak_import.peaks.map(peak => ({
      ...peak,
      chrom: (peak.chrom as string | undefined) || targetChrom,
    })) as ParsedPeakBedEntry[];
    const result = importPeakEntriesToBrowser({
      entries,
      chrom: targetChrom,
      label: state.peak_import.label || undefined,
      lock: state.peak_import.lock ?? true,
      select: state.peak_import.select ?? true,
      replaceExisting: state.peak_import.replace_existing ?? true,
    });
    if (debug) {
      console.log(
        `Jupyter imported ${result.imported} peak(s) on ${result.chrom}` +
        (result.skipped ? `; skipped ${result.skipped}` : ''),
      );
    }
  }

  if (state.peak_rules_update) {
    const store = useBrowserStore.getState();
    const rules = state.peak_rules_update.rules || [];
    if (rules.length) {
      store.setPeakRules(rules);
    }
    if (state.peak_rules_update.clear_peaks ?? true) {
      store.clearPeaksByRule();
      store.clearPeakSignalCache();
    }
    if (typeof state.peak_rules_update.lock === 'boolean') {
      store.setPeaksLocked(state.peak_rules_update.lock);
    }
    if (state.peak_rules_update.rescan && rules.length && !useBrowserStore.getState().peaksLocked) {
      for (const rule of rules) {
        if (rule.enabled && isScannedRule(rule)) {
          window.dispatchEvent(new CustomEvent('fiberhmm:rescan-rule', { detail: { ruleId: rule.id } }));
        }
      }
    }
    if (debug) {
      console.log(`Jupyter applied ${rules.length} peak rule(s)`);
    }
  }

  // The notebook's settings calls one by one, in order (settings_updates); an older server sends one merged update.
  const settingsCalls = state.settings_updates?.length ? state.settings_updates : (state.settings_update ? [state.settings_update] : []);
  for (const call of settingsCalls) applySettingsUpdate(call);

  if (state.refresh) {
    if (debug) console.log('Jupyter requested refresh');
    // e.g. after client.load_gtf(): refetch genes, tracks and reads for this view.
    useBrowserStore.getState().triggerRefresh();
  }

  if (state.browser_actions?.length) {
    const actions = state.browser_actions
      .map(item => item.action)
      .filter((action): action is { type: string; [key: string]: unknown } => (
        Boolean(action && typeof action === 'object' && typeof action.type === 'string')
      ));
    if (actions.length) {
      void executeBrowserActions(actions).then(messages => {
        if (debug) console.log(`Executed ${messages.length} queued browser action(s):`, messages);
      }).catch(err => {
        console.error('Queued browser action failed:', err);
      });
    }
  }
}
