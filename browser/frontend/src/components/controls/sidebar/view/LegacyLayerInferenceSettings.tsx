import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../../../stores/browserStore';
import { HelpIcon } from '../../../ui/Tooltip';
import { defineSettings, inSidebar, settingAnchor, settingGroupAnchor, storeToggle } from '../../../../utils/settingsCatalog';

export const LEGACY_LAYER_SETTINGS = defineSettings({
  inference: {
    id: 'view.legacy-layer-inference',
    label: 'Infer TF, nuc, and FIRE layers for legacy footprint-only datasets',
    keywords: ['legacy layer inference', 'older files', 'old bam', 'footprint-only'],
    location: inSidebar('view.display'),
    toggle: storeToggle('legacyLayerInference', 'setLegacyLayerInference'),
  },
  nucCutoff: {
    id: 'view.legacy-nuc-cutoff',
    label: 'Legacy layer inference: nuc cutoff (bp)',
    keywords: ['nucleosome size', 'older files', 'legacy'],
    location: inSidebar('view.display'),
  },
});

export function LegacyLayerInferenceSettings() {
  const {
    legacyLayerInference,
    legacyNucMinSize,
    setLegacyLayerInference,
    setLegacyNucMinSize,
  } = useBrowserStore(useShallow(s => ({
    legacyLayerInference: s.legacyLayerInference,
    legacyNucMinSize: s.legacyNucMinSize,
    setLegacyLayerInference: s.setLegacyLayerInference,
    setLegacyNucMinSize: s.setLegacyNucMinSize,
  })));

  return (
    <div
      className="rounded-md border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5 px-2 py-1.5 space-y-1"
      {...settingGroupAnchor(LEGACY_LAYER_SETTINGS.inference, LEGACY_LAYER_SETTINGS.nucCutoff)}
    >
      <div className="flex items-center gap-1">
        <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
          Legacy Layer Inference
        </span>
        <HelpIcon position="left" text="For legacy BAM/BigBed files with one footprint stream, infer TF (< cutoff), nucleosome (>= cutoff), and FIRE/MSP gaps between adjacent inferred nucleosomes. Explicit TF/FIRE/nuc channels always win." />
      </div>
      <label className="flex items-center gap-1.5 text-[12px] text-slate-700 dark:text-slate-300 cursor-pointer" {...settingAnchor(LEGACY_LAYER_SETTINGS.inference)}>
        <input
          type="checkbox"
          checked={legacyLayerInference}
          onChange={e => setLegacyLayerInference(e.target.checked)}
          className="w-3.5 h-3.5 rounded border-gray-300 dark:border-white/20"
        />
        <span>{LEGACY_LAYER_SETTINGS.inference.label}</span>
      </label>
      <div className="flex items-center gap-2 text-[12px] text-slate-600 dark:text-slate-300" {...settingAnchor(LEGACY_LAYER_SETTINGS.nucCutoff)}>
        <span>nuc cutoff</span>
        <input
          type="number"
          min={1}
          max={500}
          step={5}
          value={legacyNucMinSize}
          disabled={!legacyLayerInference}
          onChange={e => setLegacyNucMinSize(Number(e.target.value) || 90)}
          className="input-tool w-20 text-[12px]"
        />
        <span>bp</span>
      </div>
      <div className="text-[11px] text-slate-500 dark:text-slate-400">
        MSP/FIRE inference uses gaps of any size, but only when both flanking footprints are at least the cutoff.
      </div>
    </div>
  );
}
