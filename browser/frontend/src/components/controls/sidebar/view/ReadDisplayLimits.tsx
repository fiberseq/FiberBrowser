import { useShallow } from 'zustand/react/shallow';
import { READ_LIMIT_OPTIONS, formatLimitBp } from '../../../../utils/readLimit';
import { useBrowserStore } from '../../../../stores/browserStore';
import { SidebarSettingRow } from '../shared/SidebarSetting';
import { defineSettings, inSidebar, settingGroupAnchor } from '../../../../utils/settingsCatalog';

export const READ_LIMIT_SETTINGS = defineSettings({
  readLoad: {
    id: 'view.read-load',
    label: 'Read load',
    keywords: ['how many reads', 'memory', 'performance', 'low', 'balanced', 'high', 'full', 'read cap'],
    location: inSidebar('view.display'),
  },
  displayMax: {
    id: 'view.display-max',
    label: 'Display max',
    keywords: ['maximum rows', 'read cap', 'draw limit', 'exact limits'],
    location: inSidebar('view.display'),
  },
  metaprofileCap: {
    id: 'view.metaprofile-read-cap',
    label: 'Metaprofile read cap',
    keywords: ['metaprofile', 'background reads', 'exact limits'],
    location: inSidebar('view.display'),
  },
  showReadsUpTo: {
    id: 'view.show-reads-up-to',
    label: 'Show reads up to',
    keywords: ['max region', 'zoomed out', 'viewport size', 'coverage instead', 'read window'],
    location: inSidebar('view.display'),
  },
});

export function ReadDisplayLimits() {
  const {
    maxRegionForReads, setMaxRegionForReads,
    allReadsDisplayCap, setAllReadsDisplayCap,
    backgroundReadCap, setBackgroundReadCap,
  } = useBrowserStore(useShallow(s => ({
    maxRegionForReads: s.maxRegionForReads, setMaxRegionForReads: s.setMaxRegionForReads,
    allReadsDisplayCap: s.allReadsDisplayCap, setAllReadsDisplayCap: s.setAllReadsDisplayCap,
    backgroundReadCap: s.backgroundReadCap, setBackgroundReadCap: s.setBackgroundReadCap,
  })));

  const presets: { label: string; display: number; profile: number | null; title: string }[] = [
    { label: 'Low', display: 1_000, profile: 500, title: 'Lowest memory and fastest navigation' },
    { label: 'Balanced', display: 2_000, profile: 1_000, title: 'Default: compact display, stable metaprofiles' },
    { label: 'High', display: 5_000, profile: 2_000, title: 'More reads drawn, for large screens' },
    { label: 'Full', display: 10_000, profile: null, title: 'All reads in metaprofiles; still limits All-mode drawing' },
  ];
  const active = presets.find(p => p.display === allReadsDisplayCap && p.profile === backgroundReadCap);

  return (
    <>
      <SidebarSettingRow
        setting={READ_LIMIT_SETTINGS.readLoad}
        helpText="How many reads the browser keeps for drawing and metaprofiles. Clustering and analyses are not affected."
      >
        <div className="flex flex-wrap gap-1" role="group" aria-label="Read load">
          {presets.map(p => (
            <button
              key={p.label}
              type="button"
              aria-pressed={active === p}
              className={`btn-tool-default text-[11px] ${active === p ? 'ring-1 ring-blue-400 bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-200' : ''}`}
              onClick={() => { setAllReadsDisplayCap(p.display); setBackgroundReadCap(p.profile); }}
              title={`${p.title} (draw up to ${p.display.toLocaleString()}; metaprofiles ${p.profile == null ? 'all reads' : `up to ${p.profile.toLocaleString()}`})`}
            >
              {p.label}
            </button>
          ))}
          {!active && <span className="self-center text-[11px] text-gray-500">custom</span>}
        </div>
      </SidebarSettingRow>

      <details className="text-[11px]" {...settingGroupAnchor(READ_LIMIT_SETTINGS.displayMax, READ_LIMIT_SETTINGS.metaprofileCap)}>
        <summary className="cursor-pointer text-gray-500 dark:text-gray-400">Exact limits</summary>
        <div className="mt-1 space-y-1">
      <SidebarSettingRow
        setting={READ_LIMIT_SETTINGS.displayMax}
        helpText="Maximum rows the browser can draw. Fit mode usually draws fewer so the viewport does not scroll; All mode draws up to this cap."
      >
        <input
          type="number"
          min={100}
          max={200000}
          step={1000}
          value={allReadsDisplayCap}
          onChange={e => setAllReadsDisplayCap(parseInt(e.target.value, 10))}
          className="input-tool w-24 text-xs"
        />
      </SidebarSettingRow>

      <SidebarSettingRow
        setting={READ_LIMIT_SETTINGS.metaprofileCap}
        helpText="Maximum reads retained for browser-side metaprofiles. Empty means no cap. This does not affect clustering or backend analyses."
      >
        <input
          type="number"
          min={100}
          max={1000000}
          step={1000}
          value={backgroundReadCap ?? ''}
          placeholder="none"
          onChange={e => {
            const raw = e.target.value.trim();
            setBackgroundReadCap(raw ? parseInt(raw, 10) : null);
          }}
          className="input-tool w-24 text-xs"
        />
      </SidebarSettingRow>
        </div>
      </details>

      <SidebarSettingRow
        setting={READ_LIMIT_SETTINGS.showReadsUpTo}
        helpText="Maximum viewport size for rendering individual reads. Beyond this, a coverage histogram is shown instead."
      >
        <select
          data-tour="read-window-setting"
          value={maxRegionForReads}
          onChange={e => setMaxRegionForReads(parseInt(e.target.value))}
          className="input-tool flex-1 text-xs"
        >
          {READ_LIMIT_OPTIONS.map(bp => <option key={bp} value={bp}>{formatLimitBp(bp)}</option>)}
        </select>
      </SidebarSettingRow>
    </>
  );
}
