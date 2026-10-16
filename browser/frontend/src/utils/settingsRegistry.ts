/**
 * Every setting the command palette and the settings search can find: the
 * settings components' own definitions (`defineSettings` next to each control)
 * and the window chrome's (utils/chromeSettings). settingsRegistry.test fails
 * when a settings component defines settings that are not listed here, or
 * when a control in the settings sidebar has no setting.
 */
import type { SettingDef } from './settingsCatalog';
import { SIGNAL_FILTER_SETTINGS } from '../components/controls/sidebar/view/SignalReadFilters';
import { GAP_FILTER_SETTINGS } from '../components/controls/sidebar/view/GapReadFilters';
import { FOOTPRINT_FILTER_SETTINGS } from '../components/controls/sidebar/view/FootprintReadFilters';
import { CIGAR_SETTINGS } from '../components/controls/sidebar/view/CigarDisplaySettings';
import { SV_SETTINGS } from '../components/controls/sidebar/view/SvDisplaySettings';
import { DISPLAY_TOGGLE_SETTINGS } from '../components/controls/sidebar/view/DisplayFeatureToggles';
import { READ_LIMIT_SETTINGS } from '../components/controls/sidebar/view/ReadDisplayLimits';
import { READ_SEPARATOR_SETTINGS } from '../components/controls/sidebar/view/ReadSeparatorSettings';
import { UI_SCALE_SETTINGS } from '../components/controls/sidebar/view/UiScaleSettings';
import { PERFORMANCE_SETTINGS } from '../components/controls/sidebar/view/PerformanceSettings';
import { PANEL_LAUNCHER_SETTINGS } from '../components/controls/sidebar/view/PanelLauncherSettings';
import { PREVIEW_SETTINGS } from '../components/controls/sidebar/view/PreviewFeaturesSettings';
import { LEGACY_LAYER_SETTINGS } from '../components/controls/sidebar/view/LegacyLayerInferenceSettings';
import { LAYER_CACHE_SETTINGS } from '../components/controls/sidebar/view/LayerCacheSettings';
import { NAVIGATION_SETTINGS } from '../components/controls/sidebar/view/NavigationSettings';
import { PEAK_SETTINGS } from '../components/controls/sidebar/analysis/PeakDetectionSettings';
import { APP_SETTINGS } from '../components/controls/sidebar/analysis/AppSettings';
import { REPRODUCIBILITY_SETTINGS } from '../components/controls/sidebar/analysis/ReproducibilitySettings';
import { LOAD_PATH_SETTINGS } from '../components/controls/sidebar/file/LoadLocalFileSettings';
import { REMOTE_URL_SETTINGS } from '../components/controls/sidebar/file/RemoteUrlSettings';
import { SESSION_SETTINGS } from '../components/controls/sidebar/file/SessionPersistenceControls';
import { REFERENCE_PAIR_SETTINGS } from '../components/controls/sidebar/genome/ReferencePairs';
import { CATALOG_DATASET_SETTINGS } from '../components/controls/sidebar/catalog/CatalogDatasetGroups';
import { CATALOG_TRACK_SETTINGS } from '../components/controls/sidebar/catalog/CatalogReferenceTracks';
import { TOOLBAR_SETTINGS, WINDOW_SETTINGS } from './chromeSettings';

/** In sidebar order (section by section), then the window chrome. */
const GROUPS: ReadonlyArray<Record<string, SettingDef>> = [
  // Data & Sessions
  LOAD_PATH_SETTINGS, REMOTE_URL_SETTINGS, CATALOG_DATASET_SETTINGS, CATALOG_TRACK_SETTINGS, SESSION_SETTINGS,
  // Reference & Tracks
  REFERENCE_PAIR_SETTINGS,
  // Reads & Display
  UI_SCALE_SETTINGS, PERFORMANCE_SETTINGS, PANEL_LAUNCHER_SETTINGS, PREVIEW_SETTINGS, READ_LIMIT_SETTINGS, READ_SEPARATOR_SETTINGS, DISPLAY_TOGGLE_SETTINGS,
  LEGACY_LAYER_SETTINGS, LAYER_CACHE_SETTINGS, NAVIGATION_SETTINGS,
  GAP_FILTER_SETTINGS, FOOTPRINT_FILTER_SETTINGS, SIGNAL_FILTER_SETTINGS, SV_SETTINGS, CIGAR_SETTINGS,
  // Analysis & Reproducibility
  REPRODUCIBILITY_SETTINGS, PEAK_SETTINGS, APP_SETTINGS,
  // Toolbar, top bar, side rail
  TOOLBAR_SETTINGS, WINDOW_SETTINGS,
];

const extra: SettingDef[] = [];

/**
 * Add settings defined outside these modules (a plugin, a panel's own
 * settings). Returns the function that removes them.
 */
export function registerSettings(settings: Record<string, SettingDef> | SettingDef[]): () => void {
  const list = Array.isArray(settings) ? settings : Object.values(settings);
  extra.push(...list);
  return () => {
    for (const setting of list) {
      const at = extra.indexOf(setting);
      if (at >= 0) extra.splice(at, 1);
    }
  };
}

export function allSettings(): SettingDef[] {
  return [...GROUPS.flatMap(group => Object.values(group)), ...extra];
}

export function findSetting(id: string): SettingDef | undefined {
  return allSettings().find(setting => setting.id === id);
}
