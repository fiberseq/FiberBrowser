import { allPreviewFeatures, setPreviewsEnabled, usePreviewsEnabled, previewsEnabled } from '../../../../utils/previewFeatures';
import { defineSettings, inSidebar } from '../../../../utils/settingsCatalog';
import { SidebarSettingToggle } from '../shared/SidebarSetting';

export const PREVIEW_SETTINGS = defineSettings({
  show: {
    id: 'view.preview-features',
    label: 'Show preview features',
    keywords: ['preview', 'experimental', 'beta', 'insert expanded', 'alt allele', 'alternate allele', 'footprint classes',
      'find classes', 'consensus', 'labs'],
    location: inSidebar('view.display'),
    toggle: { get: () => previewsEnabled(), set: on => setPreviewsEnabled(on) },
  },
});

/**
 * Settings › Reads & Display › Read Display: Show preview features (off by default; utils/previewFeatures). Kept on
 * this computer for every port and build, not in sessions.
 */
export function PreviewFeaturesSettings() {
  const on = usePreviewsEnabled();
  const features = allPreviewFeatures().filter(f => !f.labelOnly);
  return (
    <div data-testid="preview-features-setting">
      <SidebarSettingToggle
        setting={PREVIEW_SETTINGS.show}
        checked={on}
        onChange={setPreviewsEnabled}
        helpText={`Released features that are still in Preview, each with a Preview badge and its known limitations: ${features.map(f => f.label).join(', ') || 'none in this build'}. Off: their menus, tiles and buttons are hidden; sessions that use them keep everything. Remembered on this computer, not in sessions.`}
      />
      {/* What the switch controls, in both states (usability round 2, N8): off, what turning it on adds. */}
      {features.length > 0 && (
        <div className="ml-5 mt-0.5 text-[11px] leading-4 text-ink-secondary" data-testid="preview-features-list-block">
          <div data-testid="preview-features-list-heading">{on ? 'Shown now:' : 'Turning it on adds:'}</div>
          <ul className="list-disc pl-4" data-testid="preview-features-list" data-state={on ? 'on' : 'off'}>
            {features.map(f => <li key={f.id}><span className="font-medium">{f.label}</span>: {f.summary}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}
