import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../../../stores/browserStore';
import { SidebarSubSection } from '../../SidebarSubSection';
import { DisplayFeatureToggles } from './DisplayFeatureToggles';
import { LEGACY_LAYER_SETTINGS, LegacyLayerInferenceSettings } from './LegacyLayerInferenceSettings';
import { LAYER_CACHE_SETTINGS, LayerCacheSettings } from './LayerCacheSettings';
import { settingGroupAnchor } from '../../../../utils/settingsCatalog';
import { ReadDisplayLimits } from './ReadDisplayLimits';
import { ReadSeparatorSettings } from './ReadSeparatorSettings';
import { UiScaleSettings } from './UiScaleSettings';
import { PanelLauncherSettings } from './PanelLauncherSettings';
import { PreviewFeaturesSettings } from './PreviewFeaturesSettings';
import { PerformanceSettings } from './PerformanceSettings';

export function DisplaySettings() {
  const datasets = useBrowserStore(useShallow(s => s.datasets));
  const openAnalysisPanel = useBrowserStore(s => s.openAnalysisPanel);

  const hasToolbarLayerControls = datasets.some(d =>
    d.available_layers && Object.values(d.available_layers).some(Boolean)
  );

  return (
    <SidebarSubSection
      id="view.display"
      label="Read Display"
      helpText="Controls for drawn reads, row density, coverage summaries, and hover behavior"
      defaultOpen
      persist
    >
      <div className="space-y-1.5">
        <UiScaleSettings />
        <PerformanceSettings />
        <PanelLauncherSettings />
        <PreviewFeaturesSettings />
        {hasToolbarLayerControls && (
          <div className="rounded-md bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 px-2 py-1 text-[11px] text-slate-600 dark:text-slate-300">
            <div>
              Full-length and layer controls are in the top toolbar. Motif and metaprofile tracks are in Tracks.
            </div>
            <button
              type="button"
              onClick={() => openAnalysisPanel('track-browser')}
              className="mt-1 text-[11px] font-medium text-slate-700 underline-offset-2 hover:underline dark:text-slate-200"
            >
              Open Tracks
            </button>
          </div>
        )}

        <ReadDisplayLimits />
        <ReadSeparatorSettings />
        <DisplayFeatureToggles />
        <details
          className="text-[12px]"
          {...settingGroupAnchor(LEGACY_LAYER_SETTINGS.inference, LEGACY_LAYER_SETTINGS.nucCutoff, LAYER_CACHE_SETTINGS.layerCache)}
        >
          <summary className="cursor-pointer text-gray-500">Advanced: older files and caching</summary>
          <div className="mt-1.5 space-y-1.5">
            <LegacyLayerInferenceSettings />
            <LayerCacheSettings />
          </div>
        </details>
      </div>
    </SidebarSubSection>
  );
}
