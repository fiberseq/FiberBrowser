import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { Colormap } from '../../../types';
import { AnalysisButton, AnalysisStatus } from '../shared';
import type { AnalysisStatusKind } from '../shared';
import { ChevronDown, Trash } from '../../ui/Icons';

export type PresetMessage = {
  kind: AnalysisStatusKind;
  text: string;
};

export function PresetsTab({
  saveName,
  setSaveName,
  showLoadMenu,
  setShowLoadMenu,
  presetMessage,
  showPresetMessage,
  savedColormaps,
  saveColormap,
  loadColormap,
  deleteColormap,
  setDefaultColormap,
  handleExportJSON,
  fileInputRef,
  handleImportJSON,
  onResetDefault,
}: {
  saveName: string;
  setSaveName: Dispatch<SetStateAction<string>>;
  showLoadMenu: boolean;
  setShowLoadMenu: Dispatch<SetStateAction<boolean>>;
  presetMessage: PresetMessage | null;
  showPresetMessage: (kind: AnalysisStatusKind, text: string) => void;
  savedColormaps: Colormap[];
  saveColormap: (name: string) => void;
  loadColormap: (name: string) => void;
  deleteColormap: (name: string) => void;
  setDefaultColormap: (name: string | null) => void;
  handleExportJSON: () => void;
  fileInputRef: RefObject<HTMLInputElement>;
  handleImportJSON: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onResetDefault: () => void;
}) {
  return (
    <div className="space-y-2">
      <div className="border rounded p-3 dark:border-white/10">
        <div className="text-xs font-semibold mb-1 text-gray-600 dark:text-gray-400">Save, Export, Restore</div>
        <div className="text-[11px] text-gray-500 mb-2">
          Presets include labeling rules, gene/track conditions, quality gates, analysis quality filters, and display shading.
        </div>
        {presetMessage && (
          <AnalysisStatus kind={presetMessage.kind} compact className="mb-2">
            {presetMessage.text}
          </AnalysisStatus>
        )}
        <div className="flex items-center gap-2 flex-wrap">
          <input
            type="text"
            value={saveName}
            onChange={e => setSaveName(e.target.value)}
            className="input-tool text-xs w-36"
            placeholder="Preset name"
          />
          <AnalysisButton
            onClick={() => {
              const name = saveName.trim();
              if (!name) {
                showPresetMessage('warning', 'Enter a preset name before saving.');
                return;
              }
              saveColormap(name);
              showPresetMessage('success', `Saved "${name}" to the local preset library.`);
            }}
            theme="slate"
            variant="primary"
            size="sm"
            title="Save current labeling/quality preset to local library"
          >
            Save
          </AnalysisButton>

          <div className="relative">
            <AnalysisButton
              onClick={() => setShowLoadMenu(!showLoadMenu)}
              variant="outline"
              size="sm"
              title="Load a saved preset"
            >
              <span className="inline-flex items-center gap-1">Load<ChevronDown size={11} aria-hidden="true" /></span>
            </AnalysisButton>
            {showLoadMenu && (
              <div className="absolute top-full left-0 mt-1 bg-white dark:bg-dark-surface border dark:border-white/10 rounded shadow-lg z-10 min-w-[180px]">
                {savedColormaps.length === 0 && (
                  <div className="px-3 py-2 text-xs text-ink-secondary">No saved presets</div>
                )}
                {savedColormaps.map(cm => (
                  <div key={cm.name} className="flex items-center gap-1 px-2 py-1 hover:bg-gray-100 dark:hover:bg-white/5">
                    <button
                      onClick={() => {
                        loadColormap(cm.name);
                        setSaveName(cm.name);
                        setShowLoadMenu(false);
                        showPresetMessage('success', `Loaded "${cm.name}" from the local preset library.`);
                      }}
                      className="flex-1 text-left text-xs truncate"
                    >
                      {cm.name}
                    </button>
                    <AnalysisButton
                      onClick={() => {
                        setDefaultColormap(cm.name);
                        showPresetMessage('success', `"${cm.name}" will load by default.`);
                      }}
                      theme="blue"
                      variant="outline"
                      className="px-1 py-0"
                      title="Set as default preset"
                    >
                      def
                    </AnalysisButton>
                    <button
                      type="button"
                      onClick={() => {
                        deleteColormap(cm.name);
                        showPresetMessage('info', `Deleted local preset "${cm.name}".`);
                      }}
                      className="rounded p-1 text-ink-muted hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20 dark:hover:text-red-300"
                      title={`Delete the preset "${cm.name}"`}
                      aria-label={`Delete preset ${cm.name}`}
                    >
                      <Trash size={12} aria-hidden="true" />
                    </button>
                  </div>
                ))}
                <div className="border-t dark:border-white/10 px-2 py-1">
                  <AnalysisButton
                    onClick={() => {
                      setDefaultColormap(null);
                      setShowLoadMenu(false);
                      showPresetMessage('info', 'Cleared the default labeling/quality preset.');
                    }}
                    variant="outline"
                    className="px-1.5 py-0"
                  >
                    Clear default
                  </AnalysisButton>
                </div>
              </div>
            )}
          </div>

          <AnalysisButton onClick={handleExportJSON} variant="outline" size="sm" title="Export as reproducible JSON file">
            Export JSON
          </AnalysisButton>
          <AnalysisButton onClick={() => fileInputRef.current?.click()} theme="slate" variant="soft" size="sm" title="Import from JSON file">
            Import JSON
          </AnalysisButton>
          <input ref={fileInputRef} type="file" accept=".json" onChange={handleImportJSON} className="hidden" />

          <AnalysisButton
            onClick={onResetDefault}
            theme="amber"
            variant="outline"
            size="sm"
            title="Reset to default labeling/quality preset"
          >
            Reset
          </AnalysisButton>
        </div>
      </div>
    </div>
  );
}
