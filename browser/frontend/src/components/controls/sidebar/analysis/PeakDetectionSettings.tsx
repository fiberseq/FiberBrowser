import { useBrowserStore } from '../../../../stores/browserStore';
import { SidebarSubSection } from '../../SidebarSubSection';
import { SidebarSettingToggle } from '../shared/SidebarSetting';
import { defineSettings, inSidebar, storeToggle } from '../../../../utils/settingsCatalog';

export const PEAK_SETTINGS = defineSettings({
  lockPeaks: {
    id: 'analysis.lock-peaks',
    label: 'Lock current peaks',
    keywords: ['freeze peaks', 'keep peaks', 'autoscan', 'rescan', 'peak lock'],
    location: inSidebar('analysis.peaks'),
    toggle: storeToggle('peaksLocked', 'setPeaksLocked'),
  },
});

export function PeakDetectionSettings() {
  const peakRules = useBrowserStore(s => s.peakRules);
  const peaksByRule = useBrowserStore(s => s.peaksByRule);
  const selectedPeaks = useBrowserStore(s => s.selectedPeaks);
  const peaksLocked = useBrowserStore(s => s.peaksLocked);
  const setPeaksLocked = useBrowserStore(s => s.setPeaksLocked);
  const openAnalysisPanel = useBrowserStore(s => s.openAnalysisPanel);
  const totalPeaks = Object.values(peaksByRule).reduce((sum, peaks) => sum + peaks.length, 0);
  const openPeakRules = () => {
    window.sessionStorage.setItem('fiberbrowser_analysis_rules_tab', 'peaks');
    openAnalysisPanel('cluster-features');
    window.dispatchEvent(new CustomEvent('fiberbrowser:open-analysis-rules-tab', { detail: { tab: 'peaks' } }));
  };

  return (
    <SidebarSubSection
      id="analysis.peaks"
      label="Peak Detection"
      helpText="Configure peak rules, preserve/reload peak sets, and lock current peaks for reproducible clustering"
      defaultOpen
      persist
    >
      <div className="space-y-1">
        <div className="flex items-center gap-1.5 text-[13px] text-gray-500 dark:text-gray-400">
          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${peaksLocked ? 'bg-amber-500' : totalPeaks > 0 ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'}`} />
          <span className="flex-1">
            {totalPeaks > 0
              ? `${totalPeaks} peak${totalPeaks !== 1 ? 's' : ''} from ${peakRules.length} rule${peakRules.length !== 1 ? 's' : ''}`
              : `${peakRules.length} peak rule${peakRules.length !== 1 ? 's' : ''}`}
          </span>
          {selectedPeaks.size > 0 && (
            <span className="px-1.5 py-0.5 bg-rose-100 dark:bg-rose-900/30 text-rose-600 dark:text-rose-400 rounded text-[11px] font-medium">
              {selectedPeaks.size} selected
            </span>
          )}
        </div>
        <SidebarSettingToggle
          setting={PEAK_SETTINGS.lockPeaks}
          checked={peaksLocked}
          onChange={setPeaksLocked}
          title="Freeze current detected/imported peaks across viewport changes and autoscan refreshes"
          tone="blue"
        />
        <button
          onClick={openPeakRules}
          className="w-full px-2 py-1 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 rounded text-xs hover:bg-blue-100 dark:hover:bg-blue-900/30 transition-colors"
        >
          Open peak rules…
        </button>
      </div>
    </SidebarSubSection>
  );
}
