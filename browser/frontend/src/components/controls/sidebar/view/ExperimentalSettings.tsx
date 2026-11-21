import { hubWorkspaceEnabled, setHubWorkspaceEnabled, useHubWorkspaceEnabled } from '../../../../features/plots/hubWorkspaceFlag';
import { defineSettings, inSidebar } from '../../../../utils/settingsCatalog';
import { SidebarSettingToggle } from '../shared/SidebarSetting';

export const EXPERIMENTAL_SETTINGS = defineSettings({
  hubWorkspace: {
    id: 'view.experimental.hub-workspace',
    label: 'Experimental: Feature hub workspace',
    keywords: ['experimental', 'hub', 'feature hub', 'workspace', 'full window'],
    location: inSidebar('view.display'),
    toggle: { get: () => hubWorkspaceEnabled(), set: on => setHubWorkspaceEnabled(on) },
  },
});

/**
 * Settings › Reads & Display › Read Display › Experimental: work in progress, off by default (features/plots/
 * hubWorkspaceFlag). Remembered on this computer's browser storage, not in sessions.
 */
export function ExperimentalSettings() {
  const hub = useHubWorkspaceEnabled();
  return (
    <div data-testid="experimental-settings">
      <SidebarSettingToggle
        setting={EXPERIMENTAL_SETTINGS.hubWorkspace}
        checked={hub}
        onChange={on => setHubWorkspaceEnabled(on)}
        helpText="The Feature hub full window, as a workspace beside Browser and Plots (H). Still being worked on. Off: the docked Feature hub panel works as before."
      />
    </div>
  );
}
