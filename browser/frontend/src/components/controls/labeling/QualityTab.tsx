import type { ColormapQualityShading, DisplaySmoothingConfig, LayerOpacityMap, LayerQualityFilter, TfOverlayConfig } from '../../../types';
import { getLayerLabel } from '../../../utils/layerColors';
import { AnalysisButton } from '../shared';
import { useBrowserStore } from '../../../stores/browserStore';
import { Plus, Trash } from '../../ui/Icons';
import { ClassSupportCutoff } from '../quality/QualityQuickControls';

export type QualityPreset = Pick<LayerQualityFilter, 'layer' | 'qualityName' | 'minValue'> & {
  id: string;
  label: string;
  description: string;
  requiresLayer?: string;
};

export function QualityTab({
  qualityShading,
  tfOverlay,
  layerOpacities,
  displaySmoothing,
  qualityFilters,
  enabledQualityFilterCount,
  availableQualityPresets,
  qualityFilterMatchesPreset,
  addQualityPreset,
  addQualityFilter,
  updateQualityFilter,
  removeQualityFilter,
  setQualityShading,
  setTfOverlay,
  setDisplaySmoothing,
  setLayerOpacity,
  hasTfLayer,
  hasFireLayer,
  allLayerNames,
  qualityFilterLayerNames,
  layerLabelByKey,
}: {
  qualityShading: ColormapQualityShading;
  tfOverlay: TfOverlayConfig;
  layerOpacities: LayerOpacityMap;
  displaySmoothing: DisplaySmoothingConfig;
  qualityFilters: LayerQualityFilter[];
  enabledQualityFilterCount: number;
  availableQualityPresets: QualityPreset[];
  qualityFilterMatchesPreset: (preset: QualityPreset) => boolean;
  addQualityPreset: (preset: QualityPreset) => void;
  addQualityFilter: (filter: LayerQualityFilter) => void;
  updateQualityFilter: (index: number, partial: Partial<LayerQualityFilter>) => void;
  removeQualityFilter: (index: number) => void;
  setQualityShading: (shading: Partial<ColormapQualityShading>) => void;
  setTfOverlay: (partial: Partial<TfOverlayConfig>) => void;
  setDisplaySmoothing: (smoothing: Partial<DisplaySmoothingConfig>) => void;
  setLayerOpacity: (layer: string, opacity: number) => void;
  hasTfLayer: boolean;
  hasFireLayer: boolean;
  allLayerNames: string[];
  qualityFilterLayerNames: string[];
  layerLabelByKey: Record<string, string>;
}) {
  const qs = qualityShading;
  const tfo = tfOverlay;
  const smoothing = displaySmoothing ?? { enabled: false, sigmaX: 0, sigmaY: 0 };
  const strandRescueLayerNames = allLayerNames.filter(layer => layer === 'nuc_sr' || layer === 'tf_sr');
  const opacityLayerNames = Array.from(new Set([
    ...['nuc', 'tf', 'fire'].filter(layer => allLayerNames.includes(layer)),
    ...allLayerNames.filter(layer => !['nuc', 'tf', 'fire'].includes(layer)),
  ]));
  const opacityFor = (layer: string) => {
    const fallback = layer === 'nuc' ? 1
      : layer === 'tf' ? 0.9
      : layer === 'nuc_sr' || layer === 'tf_sr' ? 0.9
      : layer === 'fire' ? 0.55
      : 0.65;
    return Math.max(0, Math.min(1, layerOpacities[layer] ?? fallback));
  };

  const showDetails = useBrowserStore(state => state.showAnalysisDetails);
  return (
    <div className="space-y-2">
      {showDetails && strandRescueLayerNames.length > 0 && (
        <div className="rounded border border-violet-200 bg-violet-50/70 p-2 dark:border-violet-900/60 dark:bg-violet-950/20">
          <div className="text-xs font-semibold text-violet-900 dark:text-violet-200">Consensus-refinement quality</div>
          <div className="text-[11px] text-violet-800/80 dark:text-violet-200/80">
            q0 is producer-declared support for the selected state, action, or configuration; its exact calibration is declared in the BAM header. q1 and q2 describe left/right edge marginals. fq is producer-declared consensus-state assignment support, with calibration documented by the assignment receipt. Decision and population-level evidence may be stricter and are declared separately. These are optional analysis filters, not baseline-HMM validity tests. Unnamed (255,0,0) shadow calls are unchanged context.
          </div>
        </div>
      )}

      {availableQualityPresets.length > 0 && (
        <div className="border rounded p-3 dark:border-white/10">
          <div className="text-xs font-semibold text-gray-600 dark:text-gray-400">Common cutoffs</div>
          <div className="text-[11px] text-gray-500 mb-2">
            One click adds the filter below, where you can change it.
          </div>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-2">
            {availableQualityPresets.map(preset => {
              const active = qualityFilterMatchesPreset(preset);
              return (
                <button
                  key={preset.id}
                  onClick={() => addQualityPreset(preset)}
                  disabled={active}
                  className={`text-left rounded border px-2 py-1.5 transition-colors ${
                    active
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-950/20 dark:text-emerald-200 cursor-default'
                      : 'border-gray-200 bg-white hover:bg-gray-50 text-gray-700 dark:border-white/10 dark:bg-white/5 dark:text-gray-200 dark:hover:bg-white/10'
                  }`}
                  title={preset.description}
                >
                  <div className="text-[11px] font-semibold">
                    {active ? 'Active: ' : ''}{preset.label}
                  </div>
                  <div className="text-[11px] opacity-75">
                    {layerLabelByKey[preset.layer] ?? getLayerLabel(preset.layer)} · {preset.description}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="border rounded p-3 dark:border-white/10">
        <div className="mb-2 flex flex-wrap items-start justify-between gap-x-2 gap-y-1">
          <div className="min-w-[12rem] flex-1">
            <div className="text-xs font-semibold text-gray-600 dark:text-gray-400">Quality filters</div>
            <div
              className="text-[11px] text-gray-500"
              title="A filter on a layer that has no such score removes all of that layer's calls rather than being ignored."
            >
              Calls below a cutoff are left out of everything: the reads drawn, scans, clusters, profiles, read stats and exports. Set them here; the toolbar's Quality group shows what they keep.
            </div>
          </div>
          <AnalysisButton
            onClick={() => addQualityFilter({
              layer: hasFireLayer ? 'fire' : (allLayerNames[0] ?? '*'),
              qualityName: hasFireLayer ? 'aq' : 'nq',
              minValue: hasFireLayer ? 230 : 128,
              enabled: true,
            })}
            theme="amber"
            variant="soft"
            className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap"
            data-testid="quality-add-filter"
          >
            <Plus size={12} aria-hidden="true" />
            Add filter
          </AnalysisButton>
        </div>
        <div className="mb-2 empty:hidden"><ClassSupportCutoff /></div>
        {qualityFilters.length === 0 ? (
          <div className="text-xs text-ink-secondary italic">No filters: every call is drawn and counted.</div>
        ) : (
          <div className="space-y-1">
            {qualityFilters.map((f, i) => (
              <div key={i} className="flex flex-wrap items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  checked={f.enabled}
                  onChange={e => updateQualityFilter(i, { enabled: e.target.checked })}
                  className="rounded border-gray-300 dark:border-white/20"
                />
                <select
                  value={f.layer}
                  onChange={e => updateQualityFilter(i, { layer: e.target.value })}
                  className="input-tool text-xs min-w-0 max-w-[9rem]"
                  title="Layer to filter"
                >
                  <option value="*">All layers</option>
                  {qualityFilterLayerNames.map(l => (
                    <option key={l} value={l}>{layerLabelByKey[l] ?? getLayerLabel(l)}</option>
                  ))}
                </select>
                <select
                  value={f.qualityName}
                  onChange={e => updateQualityFilter(i, { qualityName: e.target.value })}
                  className="input-tool text-xs min-w-0 max-w-[11rem]"
                  title="Quality dimension"
                >
                  <optgroup label="Footprint classes">
                    <option value="q0">class support (q0)</option>
                    <option value="q1">class left edge (q1)</option>
                    <option value="q2">class right edge (q2)</option>
                    <option value="fq">class geometry (fq)</option>
                  </optgroup>
                  <optgroup label="Accessibility and edges">
                    <option value="aq">accessibility, FIRE (aq)</option>
                    <option value="lq">left edge (lq)</option>
                    <option value="rq">right edge (rq)</option>
                    <option value="el">TF left edge (el)</option>
                    <option value="er">TF right edge (er)</option>
                  </optgroup>
                  <optgroup label="Call scores (rarely useful as cutoffs: most calls score high)">
                    <option value="nq">nuc call score (nq)</option>
                    <option value="tq">TF call score (tq)</option>
                    <option value="op">informative opportunities (op)</option>
                  </optgroup>
                </select>
                <span className="text-gray-500">≥</span>
                <input
                  type="number"
                  value={f.minValue}
                  onChange={e => updateQualityFilter(i, { minValue: Math.max(0, Math.min(255, parseInt(e.target.value) || 0)) })}
                  className="input-tool w-16 text-xs"
                  min={0} max={255} step={5}
                  aria-label="Cutoff (0-255)"
                />
                <button
                  type="button"
                  onClick={() => removeQualityFilter(i)}
                  className="ml-auto rounded p-1 text-ink-muted hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20 dark:hover:text-red-300"
                  title="Remove this filter"
                  aria-label="Remove filter"
                  data-testid="quality-remove-filter"
                >
                  <Trash size={13} aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="border rounded p-3 dark:border-white/10">
        <div className="text-xs font-semibold mb-1 text-gray-600 dark:text-gray-400">Quality shading</div>
        <div className="text-[11px] text-gray-500 mb-2">Display only: fades or outlines calls by their score; nothing is removed from analyses.</div>
        <div className="flex items-center gap-3 flex-wrap text-xs">
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={qs.enabled}
              onChange={e => setQualityShading({ enabled: e.target.checked })}
              className="rounded border-gray-300 dark:border-white/20"
            />
            Enable
          </label>
          <label className="flex items-center gap-1">
            Mode:
            <select
              value={qs.mode}
              onChange={e => setQualityShading({ mode: e.target.value as ColormapQualityShading['mode'] })}
              className="input-tool text-xs"
            >
              <option value="quality">Quality</option>
              <option value="overlap_count">Overlap Count</option>
            </select>
          </label>
          <label className="flex items-center gap-1">
            Viz:
            <select
              value={qs.vizMode}
              onChange={e => setQualityShading({ vizMode: e.target.value as ColormapQualityShading['vizMode'] })}
              className="input-tool text-xs"
            >
              <option value="opacity">Opacity</option>
              <option value="border">Border</option>
              <option value="both">Both</option>
            </select>
          </label>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={qs.invert}
              onChange={e => setQualityShading({ invert: e.target.checked })}
              className="rounded border-gray-300 dark:border-white/20"
            />
            Invert
          </label>
        </div>
        {qs.enabled && (
          <div className="flex items-center gap-2 mt-2 text-xs">
            <label className="flex items-center gap-1">
              Min opacity:
              <input
                type="number"
                value={qs.minOpacity}
                onChange={e => setQualityShading({ minOpacity: Math.max(0, Math.min(1, parseFloat(e.target.value) || 0)) })}
                className="input-tool w-14 text-xs"
                min={0} max={1} step={0.05}
              />
            </label>
            <label className="flex items-center gap-1">
              Max opacity:
              <input
                type="number"
                value={qs.maxOpacity}
                onChange={e => setQualityShading({ maxOpacity: Math.max(0, Math.min(1, parseFloat(e.target.value) || 1)) })}
                className="input-tool w-14 text-xs"
                min={0} max={1} step={0.05}
              />
            </label>
          </div>
        )}
      </div>

      {opacityLayerNames.length > 0 && (
        <div className="border rounded p-3 dark:border-white/10">
          <div className="text-xs font-semibold mb-1 text-gray-600 dark:text-gray-400">Layer opacity</div>
          <div className="text-[11px] text-gray-500 mb-2">
            Visual only. FIRE/MSP draws below nuc, TF, and custom overlays.
          </div>
          <div className="space-y-2">
            {opacityLayerNames.map(layer => {
              const value = opacityFor(layer);
              return (
                <label key={layer} className="grid grid-cols-[4.5rem_1fr_2.5rem] items-center gap-2 text-xs">
                  <span className="text-gray-600 dark:text-gray-300">{layerLabelByKey[layer] ?? getLayerLabel(layer)}</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={value}
                    onChange={e => setLayerOpacity(layer, parseFloat(e.target.value))}
                  />
                  <span className="text-right tabular-nums text-gray-500">{Math.round(value * 100)}%</span>
                </label>
              );
            })}
          </div>
        </div>
      )}

      <div className="border rounded p-3 dark:border-white/10">
        <div className="text-xs font-semibold mb-1 text-gray-600 dark:text-gray-400">Layer smoothing</div>
        <div className="text-[11px] text-gray-500 mb-2">
          Visual-only Gaussian blur on rendered read layers. Larger values are slower.
        </div>
        <div className="space-y-2 text-xs">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={smoothing.enabled}
              onChange={e => setDisplaySmoothing({ enabled: e.target.checked })}
              className="rounded border-gray-300 dark:border-white/20"
            />
            Enable smoothing
          </label>
          <label className="grid grid-cols-[4rem_1fr_3rem] items-center gap-2">
            <span className="text-gray-600 dark:text-gray-300">X sigma</span>
            <input
              type="range"
              min={0}
              max={10}
              step={0.5}
              value={smoothing.sigmaX}
              onChange={e => setDisplaySmoothing({ sigmaX: parseFloat(e.target.value) })}
            />
            <span className="text-right tabular-nums text-gray-500">{smoothing.sigmaX.toFixed(1)}px</span>
          </label>
          <label className="grid grid-cols-[4rem_1fr_3rem] items-center gap-2">
            <span className="text-gray-600 dark:text-gray-300">Y sigma</span>
            <input
              type="range"
              min={0}
              max={10}
              step={0.5}
              value={smoothing.sigmaY}
              onChange={e => setDisplaySmoothing({ sigmaY: parseFloat(e.target.value) })}
            />
            <span className="text-right tabular-nums text-gray-500">{smoothing.sigmaY.toFixed(1)}px</span>
          </label>
          <AnalysisButton
            type="button"
            onClick={() => setDisplaySmoothing({ enabled: false, sigmaX: 0, sigmaY: 0 })}
            variant="outline"
          >
            Reset smoothing
          </AnalysisButton>
        </div>
      </div>

      {hasTfLayer && (
        <div className="border rounded p-3 dark:border-white/10">
          <div className="text-xs font-semibold mb-2 text-gray-600 dark:text-gray-400">
            TF overlay
            <span className="ml-2 text-[11px] text-ink-secondary font-normal">display controls for v3 TF calls</span>
          </div>
          <div className="flex items-center gap-3 flex-wrap text-xs">
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={tfo.enabled}
                onChange={e => setTfOverlay({ enabled: e.target.checked })}
                className="rounded border-gray-300 dark:border-white/20"
              />
              Enable
            </label>
            <label className="flex items-center gap-1">
              Color:
              <input
                type="color"
                value={tfo.color}
                onChange={e => setTfOverlay({ color: e.target.value })}
                className="w-6 h-5 rounded border-gray-300 dark:border-white/20 cursor-pointer"
              />
            </label>
            <label className="flex items-center gap-1" title="Minimum tq (TF significance) to display; 0 shows all">
              Min tq:
              <input
                type="number"
                value={tfo.minTq}
                onChange={e => setTfOverlay({ minTq: Math.max(0, Math.min(255, parseInt(e.target.value) || 0)) })}
                className="input-tool w-14 text-xs"
                min={0} max={255} step={5}
              />
            </label>
            <label className="flex items-center gap-1">
              Opacity:
              <input
                type="number"
                value={tfo.minOpacity}
                onChange={e => setTfOverlay({ minOpacity: Math.max(0, Math.min(1, parseFloat(e.target.value) || 0)) })}
                className="input-tool w-14 text-xs"
                min={0} max={1} step={0.05}
              />
              <span className="text-gray-400">-</span>
              <input
                type="number"
                value={tfo.maxOpacity}
                onChange={e => setTfOverlay({ maxOpacity: Math.max(0, Math.min(1, parseFloat(e.target.value) || 1)) })}
                className="input-tool w-14 text-xs"
                min={0} max={1} step={0.05}
              />
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
