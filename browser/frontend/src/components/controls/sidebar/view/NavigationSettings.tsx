import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../../../stores/browserStore';
import { SidebarSubSection } from '../../SidebarSubSection';
import { defineSettings, inSidebar, settingAnchor } from '../../../../utils/settingsCatalog';

export const NAVIGATION_SETTINGS = defineSettings({
  autozoomDistance: {
    id: 'view.autozoom-distance',
    label: 'Autozoom search distance (bp)',
    keywords: ['autozoom', 'spanning reads', 'best window', 'navigation'],
    location: inSidebar('view.navigation'),
  },
});

interface NavigationSettingsProps {
  onAutozoom: () => void;
}

export function NavigationSettings({ onAutozoom }: NavigationSettingsProps) {
  const {
    autozoomDistance, setAutozoomDistance,
  } = useBrowserStore(useShallow(s => ({
    autozoomDistance: s.autozoomDistance, setAutozoomDistance: s.setAutozoomDistance,
  })));

  return (
    <SidebarSubSection
      id="view.navigation"
      label="Navigation"
      helpText="Autozoom: jump to a nearby window with many reads spanning it."
      persist
    >
      <div className="space-y-2">
        <div className="flex items-center gap-2" {...settingAnchor(NAVIGATION_SETTINGS.autozoomDistance)}>
          <span className="text-[13px] text-gray-600 dark:text-gray-400">&plusmn;</span>
          <input
            type="number" min={100} max={50000} step={100}
            value={autozoomDistance}
            onChange={e => setAutozoomDistance(parseInt(e.target.value, 10) || 1000)}
            className="input-tool w-16 text-xs"
            title="Search distance from viewport center (bp)"
          />
          <span className="text-xs text-gray-500 dark:text-gray-400">bp</span>
          <button
            onClick={onAutozoom}
            className="btn-tool bg-teal-500 text-white border border-teal-600 hover:bg-teal-600 text-xs"
            title="Find viewport window with most spanning reads"
          >
            Autozoom
          </button>
        </div>
      </div>
    </SidebarSubSection>
  );
}
