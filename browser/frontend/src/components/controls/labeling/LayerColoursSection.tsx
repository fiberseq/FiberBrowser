/**
 * Labels → Layer colours: one colour per layer of the loaded datasets (built-in layers and extra MA-tag groups), used
 * by every view (read track, metaprofile, cluster profiles, Plots, graph panel, figures). Each row has a picker and a
 * Reset; the section has Reset all, and "Save as my default colours" (kept on this computer, for new sessions).
 * State and precedence: features/layerColours/state.ts.
 */
import { useMemo, useState } from 'react';
import { useBrowserStore } from '../../../stores/browserStore';
import { getCanonicalLayerEntries, getDefaultLayerColor, getLayerColor, getLayerLabel, layerColorKey } from '../../../utils/layerColors';
import { similarColorPairs, type ColorVision } from '../../../utils/colorDistance';
import {
  clearSavedLayerColorDefaults, layerColorSource, resetAllLayerColors, resetLayerColor, saveLayerColorsAsDefault,
  setLayerColorOverride, useEffectiveLayerColors,
} from '../../../features/layerColours/state';
import { AnalysisButton, AnalysisStatus } from '../shared';

export interface LayerColourRow {
  key: string;
  label: string;
  /** Not a layer of the loaded datasets (a colour kept for it; shown so it can be reset). */
  absent?: boolean;
}

/** The rows: the loaded datasets' layers (canonical keys), then layers with a colour set but not loaded. */
export function layerColourRows(
  datasets: Parameters<typeof getCanonicalLayerEntries>[0],
  colored: Iterable<string> = [],
): LayerColourRow[] {
  const rows: LayerColourRow[] = [];
  const seen = new Set<string>();
  for (const entry of getCanonicalLayerEntries(datasets)) {
    const key = layerColorKey(entry.key);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ key, label: entry.label || getLayerLabel(key) });
  }
  for (const raw of colored) {
    const key = layerColorKey(raw);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ key, label: getLayerLabel(key), absent: true });
  }
  return rows;
}

const VISION_LABEL: Record<ColorVision, string> = {
  normal: '', deuteranopia: ' for red–green colour-blind viewers (deuteranopia)', protanopia: ' for red–green colour-blind viewers (protanopia)',
};

export interface LayerColoursSectionProps {
  /** ΔE below which two active layers count as nearly identical (normal vision). */
  similarThreshold?: number;
  /** The same under simulated deuteranopia / protanopia. */
  dichromatThreshold?: number;
}

export function LayerColoursSection({ similarThreshold = 10, dichromatThreshold = 6 }: LayerColoursSectionProps = {}) {
  const datasets = useBrowserStore(s => s.datasets);
  const session = useBrowserStore(s => s.layerColorOverrides) ?? {};
  const saved = useBrowserStore(s => s.userLayerColors) ?? {};
  const effective = useEffectiveLayerColors();
  const [message, setMessage] = useState<string | null>(null);
  const rows = useMemo(() => layerColourRows(datasets, Object.keys(effective)), [datasets, effective]);
  const state = { layerColorOverrides: session, userLayerColors: saved };

  // Soft warning: two loaded layers, at least one recoloured by the user, that look (nearly) the same.
  const similar = useMemo(() => {
    const active = rows.filter(r => !r.absent).map(r => ({ key: r.key, color: getLayerColor(r.key) }));
    return similarColorPairs(active, { threshold: similarThreshold, dichromatThreshold })
      .filter(p => effective[p.a] || effective[p.b]);
  }, [rows, effective, similarThreshold, dichromatThreshold]);
  const labelOf = (key: string) => rows.find(r => r.key === key)?.label ?? getLayerLabel(key);
  const hasSession = Object.keys(session).length > 0;
  const hasSaved = Object.keys(saved).length > 0;

  if (!rows.length) {
    return <div className="text-[11px] text-gray-500" data-testid="layer-colours-empty">Load a dataset to set its layers' colours.</div>;
  }
  return (
    <div className="space-y-2" data-testid="layer-colours-section">
      <div className="text-[11px] text-gray-500" data-testid="layer-colours-precedence">
        This session's colours win over your saved defaults; a layer with neither uses its built-in colour.
      </div>
      <ul className="space-y-1">
        {rows.map(row => {
          const color = getLayerColor(row.key);
          const source = layerColorSource(state, row.key);
          return (
            <li key={row.key} className="flex items-center gap-2 text-xs" data-testid={`layer-colour-row-${row.key}`}>
              <input
                type="color"
                value={color}
                aria-label={`${row.label} colour`}
                data-testid={`layer-colour-input-${row.key}`}
                className="h-5 w-7 cursor-pointer rounded border border-gray-300 bg-transparent p-0 dark:border-white/20"
                onChange={e => setLayerColorOverride(row.key, e.target.value)}
              />
              <span className={`min-w-0 flex-1 truncate ${row.absent ? 'text-gray-400' : 'text-gray-700 dark:text-gray-200'}`} title={row.absent ? `${row.label} (not in the loaded datasets)` : row.key}>
                {row.label}
                {row.absent && <span className="ml-1 text-[10px] text-gray-400">not loaded</span>}
              </span>
              {source !== 'builtin' && (
                <span className="text-[10px] text-gray-500" data-testid={`layer-colour-source-${row.key}`}>
                  {source === 'session' ? 'this session' : 'your default'}
                </span>
              )}
              <AnalysisButton
                theme="slate" size="sm" variant="quiet"
                disabled={source !== 'session'}
                data-testid={`layer-colour-reset-${row.key}`}
                title={source === 'session'
                  ? (saved[row.key] ? 'Back to your saved default colour' : `Back to the built-in colour (${getDefaultLayerColor(row.key)})`)
                  : source === 'default' ? 'Your saved default colour (change it here, or clear your defaults below)' : 'The built-in colour'}
                onClick={() => resetLayerColor(row.key)}
              >
                Reset
              </AnalysisButton>
            </li>
          );
        })}
      </ul>
      {similar.length > 0 && (
        <div data-testid="layer-colours-similar">
          <AnalysisStatus kind="warning" compact>
            {similar.map(p => `${labelOf(p.a)} and ${labelOf(p.b)} look nearly the same${VISION_LABEL[p.vision]}`).join('; ')}.
          </AnalysisStatus>
        </div>
      )}
      {message && <div data-testid="layer-colours-message"><AnalysisStatus kind="success" compact>{message}</AnalysisStatus></div>}
      <div className="flex flex-wrap items-center gap-2">
        <AnalysisButton theme="slate" size="sm" disabled={!hasSession} data-testid="layer-colour-reset-all"
          title="Remove this session's layer colours (your saved defaults stay)"
          onClick={() => { resetAllLayerColors(); setMessage(null); }}>
          Reset all
        </AnalysisButton>
        <AnalysisButton theme="slate" size="sm" variant="primary" disabled={!hasSession && !hasSaved} data-testid="layer-colour-save-default"
          title="New sessions start with the colours shown here (kept on this computer)"
          onClick={() => { const n = Object.keys(saveLayerColorsAsDefault()).length; setMessage(n ? `Saved ${n} layer colour${n === 1 ? '' : 's'} as your defaults.` : 'Your defaults are the built-in colours.'); }}>
          Save as my default colours
        </AnalysisButton>
        {hasSaved && (
          <AnalysisButton theme="slate" size="sm" variant="quiet" data-testid="layer-colour-clear-default"
            title="Forget your saved default colours (this session's own colours stay)"
            onClick={() => { clearSavedLayerColorDefaults(); setMessage('Cleared your saved default colours.'); }}>
            Clear my defaults
          </AnalysisButton>
        )}
      </div>
    </div>
  );
}
