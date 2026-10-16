import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../../../stores/browserStore';
import { SidebarSettingRow } from '../shared/SidebarSetting';
import type { ReadSeparatorMode } from '../../../../stores/uiSlice';
import { defineSettings, inSidebar, settingGroupAnchor } from '../../../../utils/settingsCatalog';

export const READ_SEPARATOR_SETTINGS = defineSettings({
  mode: {
    id: 'view.read-separator-mode',
    label: 'Read separators: mode',
    keywords: ['row lines', 'separator', 'lines between reads', 'auto', 'fixed', 'off'],
    location: inSidebar('view.display'),
  },
  minHeight: {
    id: 'view.read-separator-start',
    label: 'Read separators: start at row height',
    keywords: ['row lines', 'separator', 'min height'],
    location: inSidebar('view.display'),
    hiddenReason: () => (useBrowserStore.getState().readSeparatorMode === 'off' ? 'shown when separators are on' : null),
  },
  width: {
    id: 'view.read-separator-width',
    label: 'Read separators: width',
    keywords: ['row lines', 'separator', 'line width', 'thickness'],
    location: inSidebar('view.display'),
    hiddenReason: () => (useBrowserStore.getState().readSeparatorMode === 'fixed' ? null : 'shown in Fixed mode'),
  },
});

export function ReadSeparatorSettings() {
  const {
    readSeparatorMode, setReadSeparatorMode,
    readSeparatorMinHeight, setReadSeparatorMinHeight,
    readSeparatorWidth, setReadSeparatorWidth,
  } = useBrowserStore(useShallow(s => ({
    readSeparatorMode: s.readSeparatorMode, setReadSeparatorMode: s.setReadSeparatorMode,
    readSeparatorMinHeight: s.readSeparatorMinHeight, setReadSeparatorMinHeight: s.setReadSeparatorMinHeight,
    readSeparatorWidth: s.readSeparatorWidth, setReadSeparatorWidth: s.setReadSeparatorWidth,
  })));

  return (
    <div
      className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5 dark:border-white/10 dark:bg-white/[0.04]"
      {...settingGroupAnchor(READ_SEPARATOR_SETTINGS.mode, READ_SEPARATOR_SETTINGS.minHeight, READ_SEPARATOR_SETTINGS.width)}
    >
      <div className="mb-1 text-[11px] font-medium text-slate-700 dark:text-slate-200">Read separators</div>
      <SidebarSettingRow
        setting={READ_SEPARATOR_SETTINGS.mode}
        label="Mode"
        helpText="Controls whether row separators appear between manually enlarged reads."
      >
        <select
          value={readSeparatorMode}
          onChange={e => setReadSeparatorMode(e.target.value as ReadSeparatorMode)}
          className="input-tool flex-1 text-xs"
        >
          <option value="auto">Auto</option>
          <option value="fixed">Fixed</option>
          <option value="off">Off</option>
        </select>
      </SidebarSettingRow>
      {readSeparatorMode !== 'off' && (
        <SidebarSettingRow
          setting={READ_SEPARATOR_SETTINGS.minHeight}
          label="Start at"
          helpText="Minimum read row height, in pixels, before separators are drawn."
        >
          <input
            type="number"
            min={0.5}
            max={50}
            step={0.5}
            value={readSeparatorMinHeight}
            onChange={e => setReadSeparatorMinHeight(parseFloat(e.target.value))}
            className="input-tool w-20 text-xs"
          />
        </SidebarSettingRow>
      )}
      {readSeparatorMode === 'fixed' && (
        <SidebarSettingRow
          setting={READ_SEPARATOR_SETTINGS.width}
          label="Width"
          helpText="Fixed separator width in pixels."
        >
          <input
            type="number"
            min={0}
            max={10}
            step={0.25}
            value={readSeparatorWidth}
            onChange={e => setReadSeparatorWidth(parseFloat(e.target.value))}
            className="input-tool w-20 text-xs"
          />
        </SidebarSettingRow>
      )}
    </div>
  );
}
