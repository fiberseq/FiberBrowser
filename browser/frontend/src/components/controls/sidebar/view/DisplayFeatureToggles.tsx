import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../../../stores/browserStore';
import { SidebarSettingToggle } from '../shared/SidebarSetting';
import { defineSettings, inSidebar, storeToggle } from '../../../../utils/settingsCatalog';
import { useRunResultStore } from '../../../../stores/runResultStore';

export const DISPLAY_TOGGLE_SETTINGS = defineSettings({
  fillReadHeight: {
    id: 'view.fill-read-height',
    label: 'Fill read height',
    keywords: ['row height', 'stretch rows', 'sparse reads', 'fill'],
    location: inSidebar('view.display'),
    toggle: storeToggle('fillReadHeight', 'setFillReadHeight'),
  },
  showCoverageHistogram: {
    id: 'view.coverage-histogram',
    label: 'Coverage histogram',
    keywords: ['coverage', 'depth', 'histogram'],
    location: inSidebar('view.display'),
    toggle: storeToggle('showCoverageHistogram', 'setShowCoverageHistogram'),
  },
  showReadTooltip: {
    id: 'view.read-hover-tooltip',
    label: 'Read hover tooltip',
    keywords: ['tooltip', 'hover', 'read info', 'popup'],
    location: inSidebar('view.display'),
    toggle: storeToggle('showReadTooltip', 'setShowReadTooltip'),
  },
  showHiddenTrackStrip: {
    id: 'view.hidden-track-strip',
    label: 'Minimized tracks strip',
    keywords: ['hide', 'picker', 'restore tracks'],
    location: inSidebar('view.display'),
    toggle: storeToggle('showHiddenTrackStrip', 'setShowHiddenTrackStrip'),
  },
  runSummaries: {
    id: 'view.run-summaries',
    label: 'Notes after Cluster, Sort and Filter',
    keywords: ['cluster result', 'status line', 'clustered reads', 'run summary', 'message'],
    location: inSidebar('view.display'),
    toggle: { get: () => useRunResultStore.getState().showSummaries, set: on => useRunResultStore.getState().setShowSummaries(on) },
  },
  footprintCrossHighlight: {
    id: 'view.cross-read-highlight',
    label: 'Cross-read highlight',
    keywords: ['overlapping footprints', 'highlight', 'other reads'],
    location: inSidebar('view.display'),
    toggle: storeToggle('footprintCrossHighlight', 'setFootprintCrossHighlight'),
  },
});

export function DisplayFeatureToggles() {
  const {
    fillReadHeight, setFillReadHeight,
    showReadTooltip, setShowReadTooltip,
    showCoverageHistogram, setShowCoverageHistogram,
    footprintCrossHighlight, setFootprintCrossHighlight,
  } = useBrowserStore(useShallow(s => ({
    fillReadHeight: s.fillReadHeight, setFillReadHeight: s.setFillReadHeight,
    showReadTooltip: s.showReadTooltip, setShowReadTooltip: s.setShowReadTooltip,
    showCoverageHistogram: s.showCoverageHistogram, setShowCoverageHistogram: s.setShowCoverageHistogram,
    footprintCrossHighlight: s.footprintCrossHighlight, setFootprintCrossHighlight: s.setFootprintCrossHighlight,
  })));
  const showHiddenTrackStrip = useBrowserStore(s => s.showHiddenTrackStrip);
  const setShowHiddenTrackStrip = useBrowserStore(s => s.setShowHiddenTrackStrip);
  const showSummaries = useRunResultStore(s => s.showSummaries);
  const setShowSummaries = useRunResultStore(s => s.setShowSummaries);

  return (
    <>
      <SidebarSettingToggle
        setting={DISPLAY_TOGGLE_SETTINGS.fillReadHeight}
        checked={fillReadHeight}
        onChange={setFillReadHeight}
        title="Expand sparse read rows to fill each dataset track; dense tracks use the selected row height"
      />
      <SidebarSettingToggle
        setting={DISPLAY_TOGGLE_SETTINGS.showCoverageHistogram}
        checked={showCoverageHistogram}
        onChange={setShowCoverageHistogram}
        helpText="Show read coverage distribution above tracks."
      />
      <SidebarSettingToggle
        setting={DISPLAY_TOGGLE_SETTINGS.showReadTooltip}
        checked={showReadTooltip}
        onChange={setShowReadTooltip}
        title="Show read info tooltip on hover"
      />
      <SidebarSettingToggle
        setting={DISPLAY_TOGGLE_SETTINGS.showHiddenTrackStrip}
        checked={showHiddenTrackStrip}
        onChange={setShowHiddenTrackStrip}
        title="Show minimized tracks above every panel. Tracks in this panel can restore them when the strip is hidden."
      />
      <SidebarSettingToggle
        setting={DISPLAY_TOGGLE_SETTINGS.runSummaries}
        checked={showSummaries}
        onChange={setShowSummaries}
        title="Show notes and summaries after Cluster, Sort and Filter. Off: only refusals pop up; Cluster notes stay in Cluster detail."
      />
      <SidebarSettingToggle
        setting={DISPLAY_TOGGLE_SETTINGS.footprintCrossHighlight}
        checked={footprintCrossHighlight}
        onChange={setFootprintCrossHighlight}
        title="When a footprint is selected (⌘/Ctrl-click), highlight overlapping footprints on other reads"
        tone="emerald"
      />
    </>
  );
}
