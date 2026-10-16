import { usePanelLauncherStore, type PanelLauncherMode } from '../../../../stores/panelLauncherStore';
import { defineSettings, inSidebar } from '../../../../utils/settingsCatalog';
import { SidebarSettingRow } from '../shared/SidebarSetting';

export const PANEL_LAUNCHER_SETTINGS = defineSettings({
  mode: {
    id: 'view.panel-launcher',
    label: 'Analysis panels in the sidebar rail',
    keywords: [
      'analysis strip', 'panel strip', 'panel buttons', 'chips', 'side rail', 'sidebar rail', 'launcher',
      'panels on the side', 'move panels', 'tray', 'more room for reads', 'layout', 'classic', 'old layout',
    ],
    location: inSidebar('view.display'),
    toggle: {
      get: () => usePanelLauncherStore.getState().mode === 'rail',
      set: on => usePanelLauncherStore.getState().setMode(on ? 'rail' : 'strip'),
    },
  },
});

const OPTIONS: Array<{ value: PanelLauncherMode; label: string; title: string }> = [
  { value: 'rail', label: 'Sidebar rail', title: 'Panel tiles in the rail at the right edge, under the settings icons (the default); the reads get the full height' },
  { value: 'strip', label: 'Strip (classic)', title: 'The classic row of panel buttons above the reads' },
];

/** Settings › Reads & Display › Read Display: where the analysis panel buttons are, the rail (default) or the classic strip (per viewer, not saved in sessions). */
export function PanelLauncherSettings() {
  const mode = usePanelLauncherStore(s => s.mode);
  const setMode = usePanelLauncherStore(s => s.setMode);
  return (
    <SidebarSettingRow
      setting={PANEL_LAUNCHER_SETTINGS.mode}
      label="Analysis panels"
      helpText="Where the analysis panel buttons are: coloured tiles in the sidebar rail at the right edge (the default), or the classic strip of buttons above the reads. Remembered on this computer, not in sessions."
    >
      <div
        role="radiogroup"
        aria-label="Analysis panels"
        onKeyDown={e => {
          // Radio keys: the arrows choose (and focus) the other option.
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
          e.preventDefault();
          e.stopPropagation();
          const at = OPTIONS.findIndex(o => o.value === mode);
          const next = OPTIONS[(at + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? OPTIONS.length - 1 : 1)) % OPTIONS.length];
          setMode(next.value);
          (e.currentTarget.querySelector(`[data-testid="panel-launcher-${next.value}"]`) as HTMLElement | null)?.focus();
        }}
        className="flex flex-1 overflow-hidden rounded-md border border-slate-200 dark:border-white/10" data-testid="panel-launcher-setting">
        {OPTIONS.map(option => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={mode === option.value}
            tabIndex={mode === option.value ? 0 : -1}
            title={option.title}
            onClick={() => setMode(option.value)}
            data-testid={`panel-launcher-${option.value}`}
            className={`flex-1 whitespace-nowrap px-2 py-[3px] text-[11px] font-medium transition-colors ${mode === option.value
              ? 'bg-brand-600 text-white dark:bg-brand-500'
              : 'text-gray-600 hover:bg-gray-900/[0.05] dark:text-gray-300 dark:hover:bg-white/10'}`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </SidebarSettingRow>
  );
}
