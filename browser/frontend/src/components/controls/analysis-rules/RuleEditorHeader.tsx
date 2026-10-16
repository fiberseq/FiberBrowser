import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AnalysisButton, type AnalysisTheme } from '../shared';
import { ChevronDown, Plus, Star, Trash } from '../../ui/Icons';

/**
 * The top of every rule list in the Rules panel (Peaks, Cluster, Sort, Filter):
 * a title and one plain sentence, then the same two controls on every tab, an
 * "Add rule" button in the panel's colour and one "Presets" menu that holds
 * save, load, default, export and import.
 */
export function RuleEditorHeader({
  title,
  description,
  theme = 'violet',
  onAdd,
  addAnchor,
  addTour,
  presets,
}: {
  title: string;
  description: ReactNode;
  theme?: AnalysisTheme;
  onAdd: () => void;
  /** data-copilot-anchor of the Add rule button (the tour and Copilot ring it). */
  addAnchor?: string;
  addTour?: string;
  presets: ReactNode;
}) {
  return (
    <div className="mb-2 flex flex-wrap items-start justify-between gap-x-2 gap-y-1" data-testid="rule-editor-header">
      <div className="min-w-[12rem] flex-1">
        <div className="font-semibold text-gray-700 dark:text-gray-200">{title}</div>
        <div className="text-[11px] text-gray-500 dark:text-gray-400">{description}</div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <AnalysisButton
          theme={theme}
          variant="soft"
          onClick={onAdd}
          data-copilot-anchor={addAnchor}
          data-tour={addTour}
          data-testid="rule-add-button"
          className="inline-flex items-center gap-1 whitespace-nowrap"
        >
          <Plus size={12} aria-hidden="true" />
          Add rule
        </AnalysisButton>
        {presets}
      </div>
    </div>
  );
}

export interface RulePresetsMenuProps {
  /** What the presets hold, for messages and tooltips ("cluster rules"). */
  noun: string;
  savedNames: string[];
  /** Name suggested when saving (the last loaded or saved preset). */
  suggestedName?: string;
  onSave: (name: string) => void;
  onLoad: (name: string) => void;
  onDelete: (name: string) => void;
  /** Omit when this kind of preset has no default (Peaks). */
  onSetDefault?: (name: string | null) => void;
  onExportJson: () => void;
  onImportJson: () => void;
  /** Extra menu items (e.g. peak BED import and export), shown before the JSON items. */
  extra?: (close: () => void) => ReactNode;
  /** Short feedback after an action ("Saved …"). */
  onMessage?: (text: string) => void;
  dataTour?: string;
}

export function RulePresetsMenu({
  noun,
  savedNames,
  suggestedName = '',
  onSave,
  onLoad,
  onDelete,
  onSetDefault,
  onExportJson,
  onImportJson,
  extra,
  onMessage,
  dataTour,
}: RulePresetsMenuProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(suggestedName);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { setName(suggestedName); }, [suggestedName]);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    // Escape closes the menu and nothing else: caught on the way down and
    // stopped, so the app's own Escape shortcut (clear peaks, clusters) never sees it.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);
  const close = () => setOpen(false);
  const say = (text: string) => onMessage?.(text);
  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onSave(trimmed);
    say(`Saved "${trimmed}".`);
    close();
  };

  return (
    <div ref={ref} className="relative">
      <AnalysisButton
        variant="neutral"
        onClick={() => setOpen(value => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Save, load, export or import sets of ${noun}`}
        data-tour={dataTour}
        data-testid="rule-presets-button"
        className="inline-flex items-center gap-1 whitespace-nowrap"
      >
        Presets
        <ChevronDown size={12} aria-hidden="true" />
      </AnalysisButton>
      {open && (
        <div role="menu" className="fb-menu min-w-[16rem]" data-testid="rule-presets-menu">
          <div className="px-3 pb-1.5 pt-1">
            <div className="mb-1 text-[11px] text-ink-muted">Save the current {noun} as</div>
            <div className="flex items-center gap-1">
              <input
                type="text"
                value={name}
                onChange={event => setName(event.target.value)}
                onKeyDown={event => { if (event.key === 'Enter') save(); }}
                placeholder="Preset name"
                aria-label="Preset name"
                className="input-tool min-w-0 flex-1 text-xs"
              />
              <AnalysisButton variant="primary" theme="slate" onClick={save} disabled={!name.trim()}>
                Save
              </AnalysisButton>
            </div>
          </div>
          {savedNames.length > 0 && (
            <>
              <div className="fb-menu-sep" />
              <div className="px-3 pb-0.5 pt-1 text-[11px] text-ink-muted">Load a saved preset</div>
              <div className="max-h-40 overflow-y-auto">
                {savedNames.map(saved => (
                  <div key={saved} className="flex items-center gap-1 pr-2 hover:bg-gray-100 dark:hover:bg-white/10">
                    <button
                      type="button"
                      role="menuitem"
                      className="min-w-0 flex-1 truncate px-3 py-1.5 text-left text-gray-700 dark:text-gray-200"
                      onClick={() => { onLoad(saved); setName(saved); say(`Loaded "${saved}".`); close(); }}
                      title={`Replace the current ${noun} with "${saved}"`}
                    >
                      {saved}
                    </button>
                    {onSetDefault && (
                      <button
                        type="button"
                        className="rounded p-1 text-ink-muted hover:bg-white hover:text-amber-600 dark:hover:bg-white/10"
                        onClick={() => { onSetDefault(saved); say(`"${saved}" now loads when the app opens.`); }}
                        title={`Load "${saved}" when the app opens`}
                        aria-label={`Make ${saved} the default`}
                      >
                        <Star size={12} aria-hidden="true" />
                      </button>
                    )}
                    <button
                      type="button"
                      className="rounded p-1 text-ink-muted hover:bg-white hover:text-red-600 dark:hover:bg-white/10"
                      onClick={() => { onDelete(saved); say(`Deleted "${saved}".`); }}
                      title={`Delete the preset "${saved}"`}
                      aria-label={`Delete preset ${saved}`}
                    >
                      <Trash size={12} aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
              {onSetDefault && (
                <button
                  type="button"
                  role="menuitem"
                  className="fb-menu-item text-[12px]"
                  onClick={() => { onSetDefault(null); say('No preset loads when the app opens.'); close(); }}
                >
                  Don't load a preset when the app opens
                </button>
              )}
            </>
          )}
          {extra && (
            <>
              <div className="fb-menu-sep" />
              {extra(close)}
            </>
          )}
          <div className="fb-menu-sep" />
          <button type="button" role="menuitem" className="fb-menu-item" onClick={() => { close(); onExportJson(); }}>
            Export as JSON
          </button>
          <button type="button" role="menuitem" className="fb-menu-item" onClick={() => { close(); onImportJson(); }}>
            Import JSON…
          </button>
        </div>
      )}
    </div>
  );
}
