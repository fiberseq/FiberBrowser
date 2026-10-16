import { useMemo } from 'react';
import { useBrowserStore } from '../../../stores/browserStore';
import { getLayerColor, getCanonicalLayerGroups, type LayerEntry } from '../../../utils/layerColors';

/**
 * Reusable layer selector for analysis panels.
 *
 * Shows the set of available annotation layers (auto-discovered from the
 * current dataset via enabledModTypes in the store) as clickable chips or
 * a dropdown. Used by every analysis panel so users can target a specific
 * annotation class for metaprofiles, clustering, co-accessibility, etc.
 */
export interface LayerSelectorProps {
  value: string | null;                      // selected layer name, null = default/all
  onChange: (layer: string | null) => void;
  availableLayers?: string[];                // override auto-detection (optional)
  showAllOption?: boolean;                   // show a default/all option
  allLabel?: string;                         // label for the null/all option
  variant?: 'chips' | 'dropdown';            // UI style
  className?: string;
  title?: string;                            // section title label
  /** Adds an "All FP" chip that unions footprint-type layers (nuc/tf +
   *  custom) while excluding FIRE/accessibility + modifications. The sentinel value
   *  'all_fp' is sent to the backend which expands it server-side. Only
   *  meaningful on panels where the accessibility-vs-FP distinction matters. */
  showAllFpOption?: boolean;
}

export function LayerSelector({
  value,
  onChange,
  availableLayers,
  showAllOption = true,
  allLabel = 'All',
  variant = 'chips',
  className = '',
  title,
  showAllFpOption = false,
}: LayerSelectorProps) {
  // Pull canonical layer list from datasets — same dedup + naming as
  // ViewSection (FP/Nuc collapsed, FIRE aliasing internal MSP, TF only when explicit, etc.).
  // If the caller passes availableLayers explicitly, build entries from those
  // names while still using canonical labels.
  const datasets = useBrowserStore(s => s.datasets);
  const groups = useMemo(() => {
    const canonical = getCanonicalLayerGroups(datasets);
    if (!availableLayers) return canonical;
    const allow = new Set(availableLayers);
    if (allow.has('msp')) allow.add('fire');
    return {
      standard: canonical.standard.filter(e => allow.has(e.key)),
      tfInference: canonical.tfInference.filter(e => allow.has(e.key)),
      strandRescue: canonical.strandRescue.filter(e => allow.has(e.key)),
      derived: canonical.derived.filter(e => allow.has(e.key)),
    };
  }, [datasets, availableLayers]);
  const entries = useMemo(
    () => [...groups.standard, ...groups.tfInference, ...groups.strandRescue, ...groups.derived],
    [groups],
  );

  if (!entries.length) return null;

  // "All FP" is only meaningful when at least one footprint-type layer
  // is present (nuc / footprint / tf / any custom non-modification).
  const NON_FP_KEYS = new Set([
    'msp', 'fire', 'm6a', 'mod', 'm5c', 'deam', 'ddda_mcg', 'ddda_mcg_hemi',
  ]);
  const hasFpLayer = entries.some(e => !NON_FP_KEYS.has(e.key));
  const renderAllFp = showAllFpOption && hasFpLayer;

  const renderChip = ({ key, label, title: entryTitle, color: entryColor }: LayerEntry) => {
    const isActive = value === key || (value === 'msp' && key === 'fire');
    const color = entryColor ?? getLayerColor(key);
    return (
      <button
        key={key}
        onClick={() => onChange(key)}
        className={`px-1.5 py-0.5 rounded text-[11px] flex items-center gap-1 ${
          isActive
            ? 'bg-gray-200 dark:bg-gray-700'
            : 'hover:bg-gray-100 dark:hover:bg-gray-800 opacity-70'
        }`}
        title={entryTitle}
      >
        <span
          className="inline-block w-2 h-2 rounded-sm"
          style={{ background: color }}
        />
        <span className={isActive ? 'text-gray-800 dark:text-gray-200' : 'text-gray-600 dark:text-gray-400'}>
          {label}
        </span>
      </button>
    );
  };

  if (variant === 'dropdown') {
    return (
      <div className={`flex items-center gap-1.5 ${className}`}>
        {title && <span className="text-[11px] text-gray-500 dark:text-gray-400">{title}</span>}
        <select
          value={value === 'msp' ? 'fire' : (value ?? '')}
          onChange={e => onChange(e.target.value || null)}
          className="input-tool text-xs py-0.5"
        >
          {showAllOption && <option value="">{allLabel}</option>}
          {renderAllFp && <option value="all_fp">All FP</option>}
          {groups.derived.length > 0 || groups.tfInference.length > 0 || groups.strandRescue.length > 0 ? (
            <>
              {groups.standard.length > 0 && (
                <optgroup label="Standard layers">
                  {groups.standard.map(({ key, label }) => (
                    <option key={key} value={key}>{label}</option>
                  ))}
                </optgroup>
              )}
              {groups.strandRescue.length > 0 && (
                <optgroup label="Molecular refinement">
                  {groups.strandRescue.map(({ key, label }) => (
                    <option key={key} value={key}>{label}</option>
                  ))}
                </optgroup>
              )}
              {groups.tfInference.length > 0 && (
                <optgroup label="TF inference (added layers)">
                  {groups.tfInference.map(({ key, label }) => (
                    <option key={key} value={key}>{label}</option>
                  ))}
                </optgroup>
              )}
              {groups.derived.length > 0 && (
                <optgroup label="Derived layers">
                  {groups.derived.map(({ key, label }) => (
                    <option key={key} value={key}>{label}</option>
                  ))}
                </optgroup>
              )}
            </>
          ) : (
            entries.map(({ key, label }) => (
              <option key={key} value={key}>{label}</option>
            ))
          )}
        </select>
      </div>
    );
  }

  // Chips variant
  return (
    <div className={`flex items-center gap-1 flex-wrap ${className}`}>
      {title && <span className="text-[11px] text-gray-500 dark:text-gray-400 mr-1">{title}</span>}
      {showAllOption && (
        <button
          onClick={() => onChange(null)}
          className={`px-1.5 py-0.5 rounded text-[11px] ${
            value === null
              ? 'bg-gray-200 text-gray-800 dark:bg-gray-700 dark:text-gray-200'
              : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
          }`}
          title={allLabel}
        >
          {allLabel}
        </button>
      )}
      {renderAllFp && (
        <button
          onClick={() => onChange('all_fp')}
          className={`px-1.5 py-0.5 rounded text-[11px] ${
            value === 'all_fp'
              ? 'bg-gray-200 text-gray-800 dark:bg-gray-700 dark:text-gray-200'
              : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
          }`}
          title="All footprint-type layers (nuc + TF + custom) — excludes FIRE/accessibility and base modifications"
        >
          All FP
        </button>
      )}
      {groups.standard.map(renderChip)}
      {groups.tfInference.length > 0 && (
        <span className="basis-full mt-0.5 text-[11px] text-violet-500 dark:text-violet-400">
          TF inference · added layers
        </span>
      )}
      {groups.tfInference.map(renderChip)}
      {groups.strandRescue.length > 0 && (
        <span className="basis-full mt-0.5 text-[11px] text-violet-500 dark:text-violet-400">
          Molecular refinement
        </span>
      )}
      {groups.strandRescue.map(renderChip)}
      {groups.derived.length > 0 && (
        <span className="basis-full mt-0.5 text-[11px] text-gray-400 dark:text-gray-500">
          Derived layers
        </span>
      )}
      {groups.derived.map(renderChip)}
    </div>
  );
}
