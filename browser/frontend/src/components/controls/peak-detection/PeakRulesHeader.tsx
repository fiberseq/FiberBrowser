import type { PeakRulePreset } from '../../../types';
import type { AnalysisTheme } from '../shared';
import { RuleEditorHeader, RulePresetsMenu } from '../analysis-rules/RuleEditorHeader';

interface PeakRulesHeaderProps {
  savedPeakPresets: PeakRulePreset[];
  totalPeaks: number;
  selectedPeakCount: number;
  /** The panel's colour: violet inside Rules, indigo in the stand-alone Peaks panel. */
  theme?: AnalysisTheme;
  onAddRule: () => void;
  onSavePreset: (name: string) => void;
  onLoadPreset: (name: string) => void;
  onDeletePreset: (name: string) => void;
  onImportPeakBed: () => void;
  onExportPeakBed: (selectedOnly: boolean) => void;
  onImportJson: () => void;
  onExportJson: () => void;
  onResetDefaults: () => void;
}

/** Peaks tab header: the same Add rule and Presets controls as the other Rules tabs. */
export function PeakRulesHeader({
  savedPeakPresets,
  totalPeaks,
  selectedPeakCount,
  theme = 'violet',
  onAddRule,
  onSavePreset,
  onLoadPreset,
  onDeletePreset,
  onImportPeakBed,
  onExportPeakBed,
  onImportJson,
  onExportJson,
  onResetDefaults,
}: PeakRulesHeaderProps) {
  return (
    <RuleEditorHeader
      title="Peak rules"
      description="Each rule finds peaks in one signal; Scan runs every ticked rule."
      theme={theme}
      onAdd={onAddRule}
      addTour="peak-add-rule"
      presets={(
        <RulePresetsMenu
          noun="peak rules"
          savedNames={savedPeakPresets.map(preset => preset.name)}
          onSave={onSavePreset}
          onLoad={onLoadPreset}
          onDelete={onDeletePreset}
          onExportJson={onExportJson}
          onImportJson={onImportJson}
          dataTour="peak-presets"
          extra={close => (
            <>
              <button
                type="button"
                role="menuitem"
                className="fb-menu-item"
                onClick={() => { close(); onImportPeakBed(); }}
                title="Load BED3/BED6 or FiberBrowser BED6+ peaks as locked imported peaks on the current chromosome"
                data-tour="peak-import-bed"
              >
                Import peaks from BED…
              </button>
              <button
                type="button"
                role="menuitem"
                className="fb-menu-item disabled:cursor-not-allowed disabled:opacity-40"
                onClick={() => { close(); onExportPeakBed(false); }}
                disabled={totalPeaks === 0}
              >
                Export all peaks as BED
              </button>
              <button
                type="button"
                role="menuitem"
                className="fb-menu-item disabled:cursor-not-allowed disabled:opacity-40"
                onClick={() => { close(); onExportPeakBed(true); }}
                disabled={selectedPeakCount === 0}
              >
                Export selected peaks as BED
              </button>
              <div className="fb-menu-sep" />
              <button
                type="button"
                role="menuitem"
                className="fb-menu-item text-amber-700 dark:text-amber-300"
                onClick={() => { close(); onResetDefaults(); }}
              >
                Reset to the default peak rules
              </button>
            </>
          )}
        />
      )}
    />
  );
}
