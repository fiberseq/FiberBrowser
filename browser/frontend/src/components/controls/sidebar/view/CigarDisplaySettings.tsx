import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../../../stores/browserStore';
import { defineSettings, inSidebar, settingAnchor, settingGroupAnchor, type SettingDef } from '../../../../utils/settingsCatalog';

type CigarType = 'mismatches' | 'insertions' | 'deletions';

const hasBam = () => useBrowserStore.getState().datasets.some(dataset => dataset.data_type === 'bam');
const cigarSetting = (type: CigarType, id: string, label: string, keywords: string[]): SettingDef => ({
  id,
  label,
  keywords: ['cigar', 'alignment', ...keywords],
  location: inSidebar('view.advanced'),
  toggle: {
    get: () => Boolean(useBrowserStore.getState().enabledCigarTypes[type]),
    set: on => useBrowserStore.getState().toggleCigarType(type, on),
  },
  hiddenReason: () => (hasBam() ? null : 'shown with a BAM loaded'),
});

export const CIGAR_SETTINGS = defineSettings({
  mismatches: cigarSetting('mismatches', 'view.cigar-mismatches', 'CIGAR mismatches', ['mis', 'snp', 'substitutions', 'small variants']),
  insertions: cigarSetting('insertions', 'view.cigar-insertions', 'Show small insertions (CIGAR)', ['ins', 'indel', 'small indels', 'show small indels']),
  deletions: cigarSetting('deletions', 'view.cigar-deletions', 'Show small deletions (CIGAR)', ['del', 'indel', 'small indels', 'show small indels']),
});

export function CigarDisplaySettings() {
  const {
    datasets,
    enabledCigarTypes,
    toggleCigarType,
  } = useBrowserStore(useShallow(s => ({
    datasets: s.datasets,
    enabledCigarTypes: s.enabledCigarTypes,
    toggleCigarType: s.toggleCigarType,
  })));

  const hasBam = datasets.some(dataset => dataset.data_type === 'bam');
  if (!hasBam) return null;

  return (
    <div className="pt-1" {...settingGroupAnchor(CIGAR_SETTINGS.mismatches, CIGAR_SETTINGS.insertions, CIGAR_SETTINGS.deletions)}>
      <div className="text-[11px] text-ink-secondary font-medium mb-0.5" title="Every CIGAR mismatch, insertion and deletion, whatever its size (SVs above the min size are drawn by SV display)">Small indels (CIGAR)</div>
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-1 text-[13px] cursor-pointer" {...settingAnchor(CIGAR_SETTINGS.mismatches)}>
          <input
            type="checkbox"
            checked={enabledCigarTypes.mismatches}
            onChange={e => toggleCigarType('mismatches', e.target.checked)}
            className="rounded border-gray-300 dark:border-white/20"
          />
          <span className="text-red-600">Mis</span>
        </label>
        <label className="flex items-center gap-1 text-[13px] cursor-pointer" {...settingAnchor(CIGAR_SETTINGS.insertions)}>
          <input
            type="checkbox"
            checked={enabledCigarTypes.insertions}
            onChange={e => toggleCigarType('insertions', e.target.checked)}
            className="rounded border-gray-300 dark:border-white/20"
          />
          <span className="text-purple-600">Ins</span>
        </label>
        <label className="flex items-center gap-1 text-[13px] cursor-pointer" {...settingAnchor(CIGAR_SETTINGS.deletions)}>
          <input
            type="checkbox"
            checked={enabledCigarTypes.deletions}
            onChange={e => toggleCigarType('deletions', e.target.checked)}
            className="rounded border-gray-300 dark:border-white/20"
          />
          <span className="text-gray-600 dark:text-gray-400">Del</span>
        </label>
      </div>
    </div>
  );
}
