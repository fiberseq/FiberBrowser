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

  if (state.settings_update) {
    const store = useBrowserStore.getState();
    if (state.settings_update.analysis_sample_seed != null) {
      store.setAnalysisSampleSeed(state.settings_update.analysis_sample_seed);
    }
    if ('analysis_sample_count' in state.settings_update) {
      store.setAnalysisSampleCount(state.settings_update.analysis_sample_count ?? null);
    }
    if ('display_sample_count' in state.settings_update) {
      store.setDownsampleCount(state.settings_update.display_sample_count ?? null);
    }
    if (state.settings_update.read_display_mode === 'sample' || state.settings_update.read_display_mode === 'all') {
      store.setReadDisplayMode(state.settings_update.read_display_mode);
    }
    if (state.settings_update.all_reads_display_cap != null) {
      store.setAllReadsDisplayCap(state.settings_update.all_reads_display_cap);
    }
    if ('background_read_cap' in state.settings_update) {
      store.setBackgroundReadCap(state.settings_update.background_read_cap ?? null);
    }
    if (state.settings_update.spanning_only != null) {
      store.setSpanningOnly(state.settings_update.spanning_only);
    }
    if (typeof state.settings_update.peaks_locked === 'boolean') {
      store.setPeaksLocked(state.settings_update.peaks_locked);
    }
    if (Array.isArray(state.settings_update.peak_rules)) {
      store.setPeakRules(state.settings_update.peak_rules);
    }
    if (state.settings_update.peaks_by_rule && typeof state.settings_update.peaks_by_rule === 'object') {
      useBrowserStore.setState(keepMatched(useBrowserStore.getState(), { peaksByRule: state.settings_update.peaks_by_rule } as any));
    }
    if (Array.isArray(state.settings_update.selected_peaks)) {
      useBrowserStore.setState({ selectedPeaks: new Set(state.settings_update.selected_peaks) } as any);
    }
    if (state.settings_update.peak_modes && typeof state.settings_update.peak_modes === 'object') {
      useBrowserStore.setState({ peakModes: state.settings_update.peak_modes } as any);
    }
    if (Array.isArray(state.settings_update.cluster_feature_rules)) {
      store.setClusterFeatureRules(state.settings_update.cluster_feature_rules);
    }
    if (Array.isArray(state.settings_update.analysis_sort_rules)) {
      store.setAnalysisSortRules(state.settings_update.analysis_sort_rules);
    }
    if (Array.isArray(state.settings_update.analysis_filter_rules)) {
      store.setAnalysisFilterRules(state.settings_update.analysis_filter_rules);
    }
    if (state.settings_update.active_colormap) {
      store.setActiveColormap(state.settings_update.active_colormap);
    }
    if (state.settings_update.cluster_method != null) {
      store.setClusterMethod(state.settings_update.cluster_method);
    }
    if (state.settings_update.cluster_k != null) {
      store.setClusterK(state.settings_update.cluster_k);
    }
    if (state.settings_update.small_footprint_threshold_bp != null) {
      store.setSubnucleosomalThreshold(state.settings_update.small_footprint_threshold_bp);
    }
    if (state.settings_update.accessibility_threshold != null) {
      store.setAccessibilityThreshold(state.settings_update.accessibility_threshold);
    }
    if (Array.isArray(state.settings_update.capture_regions)) {
      store.setCaptureRegions(state.settings_update.capture_regions);
    }
    if (state.settings_update.capture_padding != null) {
      store.setCapturePadding(state.settings_update.capture_padding);
    }
    if (Array.isArray(state.settings_update.catalog)) {
      store.setCatalog(state.settings_update.catalog);
    }
    if (Array.isArray(state.settings_update.composite_tracks)) {
      store.setCompositeTracks(state.settings_update.composite_tracks);
    }
    if (Array.isArray(state.settings_update.saved_tracks)) {
      store.setSavedTracks(state.settings_update.saved_tracks);
    }
    if (Array.isArray(state.settings_update.footprint_groups)) {
      store.setFootprintGroups(state.settings_update.footprint_groups);
    }
    if (Array.isArray(state.settings_update.selected_genes)) {
      store.setSelectedGenes(state.settings_update.selected_genes);
    }
    if (state.settings_update.transcription_state_filters && typeof state.settings_update.transcription_state_filters === 'object') {
      store.setTranscriptionStateFilters(state.settings_update.transcription_state_filters);
    }
    if (Array.isArray(state.settings_update.primer_saved_primers)) {
      useBrowserStore.setState(current => ({
        primer: { ...current.primer, savedPrimers: state.settings_update!.primer_saved_primers! },
      }) as any);
    }
    if (state.settings_update.primer_mode === 'standard' || state.settings_update.primer_mode === 'dafc' || state.settings_update.primer_mode === '4c') {
      store.setPrimerMode(state.settings_update.primer_mode);
    }
    if (state.settings_update.primer_cart_track_display === 'off' || state.settings_update.primer_cart_track_display === 'all' || state.settings_update.primer_cart_track_display === 'imported' || state.settings_update.primer_cart_track_display === 'design') {
      store.setCartTrackDisplay(state.settings_update.primer_cart_track_display);
    }
    if (state.settings_update.enabled_mod_types && typeof state.settings_update.enabled_mod_types === 'object') {
      const enabledModTypes = normalizeLayerToggleMap(state.settings_update.enabled_mod_types as Record<string, boolean>);
      useBrowserStore.setState({
        enabledModTypes: { ...store.enabledModTypes, ...(enabledModTypes ?? {}) },
      } as any);
    }
    if (state.settings_update.enabled_meta_profiles && typeof state.settings_update.enabled_meta_profiles === 'object') {
      const enabledMetaProfiles = normalizeLayerToggleMap(state.settings_update.enabled_meta_profiles as Record<string, boolean>);
      useBrowserStore.setState({
        enabledMetaProfiles: { ...store.enabledMetaProfiles, ...(enabledMetaProfiles ?? {}) },
      } as any);
    }
    if (state.settings_update.cached_layer_types && typeof state.settings_update.cached_layer_types === 'object') {
      const cachedLayerTypes = normalizeLayerToggleMap(state.settings_update.cached_layer_types as Record<string, boolean>);
      useBrowserStore.setState({
        cachedLayerTypes: { ...store.cachedLayerTypes, ...(cachedLayerTypes ?? {}) },
      } as any);
    }
    if (typeof state.settings_update.legacy_layer_inference === 'boolean') {
      store.setLegacyLayerInference(state.settings_update.legacy_layer_inference);
    }
    if (state.settings_update.legacy_nuc_min_size != null) {
      store.setLegacyNucMinSize(state.settings_update.legacy_nuc_min_size);
    }
    if ('click_target_layer' in state.settings_update) {
      store.setClickTargetLayer(normalizeAnnotationLayer(state.settings_update.click_target_layer));
    }
    if ('footprint_analysis_layer' in state.settings_update) {
      store.setFootprintAnalysisLayer(normalizeAnnotationLayer(state.settings_update.footprint_analysis_layer));
    }
    if ('coacc_settings' in state.settings_update) {
      applyCoaccSettings(state.settings_update.coacc_settings);
    }
    if (typeof state.settings_update.fill_read_height === 'boolean') {
      store.setFillReadHeight(state.settings_update.fill_read_height);
    }
    if ('read_row_height' in state.settings_update) {
      const next = state.settings_update.read_row_height === 'auto'
        ? 'auto'
        : Number(state.settings_update.read_row_height);
      if (next === 'auto' || (typeof next === 'number' && Number.isFinite(next))) {
        store.setReadRowHeight(next as number | 'auto');
      }
    }
    if (typeof state.settings_update.show_coverage_histogram === 'boolean') {
      store.setShowCoverageHistogram(state.settings_update.show_coverage_histogram);
    }
    if (state.settings_update.max_region_for_reads != null) {
      store.setMaxRegionForReads(state.settings_update.max_region_for_reads);
    }
    if (typeof state.settings_update.show_genome_overview === 'boolean') {
      useBrowserStore.setState({ showGenomeOverview: state.settings_update.show_genome_overview } as any);
    }
    if (Array.isArray(state.settings_update.hidden_strip_panels)) {
      store.setHiddenStripPanels(state.settings_update.hidden_strip_panels);
    }
    // Queued opens/closes in order (a single open_panel/close_panel from an
    // older server too).
    const panelOps: Array<['open' | 'close', string]> = [...(state.settings_update.panel_ops ?? [])];
    if (state.settings_update.close_panel) panelOps.push(['close', state.settings_update.close_panel]);
    if (state.settings_update.open_panel) panelOps.push(['open', state.settings_update.open_panel]);
    for (const [verb, panelType] of panelOps) {
      if (verb === 'open') {
        useBrowserStore.getState().openAnalysisPanel(panelType as any);
      } else {
        const panel = findOpenAnalysisPanel(useBrowserStore.getState().panels, panelType);
        if (panel) useBrowserStore.getState().closeAnalysisPanel(panel.id);
      }
    }
  }

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
