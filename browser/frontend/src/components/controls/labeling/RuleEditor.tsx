import { useEffect, useRef, useState, type DragEvent } from 'react';
import type { ColorRule, Gene } from '../../../types';
import { getLayerColor, getLayerLabel } from '../../../utils/layerColors';
import {
  COLOR_RULE_GRADIENT_SCALE_OPTIONS,
  RECENT_RULE_COLORS_UPDATED_EVENT,
  loadRecentRuleColors,
  normalizeRuleGradient,
  normalizeRuleHexColor,
  saveRecentRuleColor,
} from '../../../utils/ruleColors';
import { ConditionEditor } from './ConditionEditor';
import { QualityGateEditor } from './QualityGateEditor';
import { CLEARED_NUC_CONDITIONS, NucConditionEditor, describeNucConditions } from './NucConditionEditor';
import { ruleHasNucConditions } from '../../../utils/ruleMatching';
import { AnalysisButton } from '../shared';
import { DisclosureChevron } from '../../ui/Disclosure';
import { Trash } from '../../ui/Icons';

export interface OrthogonalTrackInfo {
  index: number;
  label: string;
  renderMode: 'signal' | 'annotation';
  category?: string;
}

interface RuleEditorProps {
  rule: ColorRule;
  index: number;
  onUpdate: (updates: Partial<ColorRule>) => void;
  onRemove: () => void;
  onDragStart: (event: DragEvent, index: number) => void;
  onDragOver: (event: DragEvent) => void;
  onDrop: (event: DragEvent, index: number) => void;
  orthogonalTracks: OrthogonalTrackInfo[];
  genes?: Gene[];
  availableLayers: string[];
  layerLabelByKey?: Record<string, string>;
  /** Open the full editor straight away (e.g. a rule just added). */
  defaultExpanded?: boolean;
}

/** One-line reading of a rule's conditions, for the collapsed row. */
function describeConditions(rule: ColorRule): string {
  const parts = (rule.conditions ?? []).map(condition => {
    const not = condition.negate ? 'not ' : '';
    switch (condition.target) {
      case 'gene': return `${not}in ${condition.geneName || (condition.geneId ? 'gene' : 'any gene')}`;
      case 'peak': return `${not}in peaks`;
      case 'track': return `${not}in track`;
      case 'motif': return `${not}in motif`;
      case 'region': return `${not}in ${condition.regionLabel || 'region'}`;
      default: return '';
    }
  }).filter(Boolean);
  const gates = rule.qualityGates?.length ?? 0;
  if (gates) parts.push(`${gates} quality gate${gates === 1 ? '' : 's'}`);
  const nuc = describeNucConditions(rule);
  if (nuc) parts.push(nuc);
  return parts.join(', ');
}

export function RuleEditor({
  rule,
  index,
  onUpdate,
  onRemove,
  onDragStart,
  onDragOver,
  onDrop,
  orthogonalTracks,
  genes = [],
  availableLayers,
  layerLabelByKey,
  defaultExpanded = false,
}: RuleEditorProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  // The nucleosome section shows once added, or whenever the rule sets a nucleosome condition.
  const [nucOpen, setNucOpen] = useState(false);
  const hasNuc = ruleHasNucConditions(rule);
  const isFireAliasPair = (a: string, b: string) =>
    (a === 'fire' && b === 'msp') || (a === 'msp' && b === 'fire');
  const targetIncludesLayer = (targets: string[], layer: string) =>
    targets.some(target => target === layer || isFireAliasPair(target, layer));
  const toggleTargetLayer = (layer: string) => {
    const current = rule.targetLayers ?? [];
    const next = targetIncludesLayer(current, layer)
      ? current.filter(currentLayer => currentLayer !== layer && !isFireAliasPair(currentLayer, layer))
      : [...current, layer];
    onUpdate({ targetLayers: next });
  };
  const opacity = Math.max(0, Math.min(1, rule.opacity ?? 1));
  const isHiddenByOpacity = opacity <= 0;
  const baseColor = normalizeRuleHexColor(rule.color);
  const isGradient = rule.colorMode === 'size_gradient';
  const gradient = normalizeRuleGradient(rule.gradient, baseColor, rule.sizeMin, rule.sizeMax);
  const pendingGradient = isGradient ? gradient : { ...gradient, startColor: baseColor };
  const [recentColors, setRecentColors] = useState<string[]>(() => loadRecentRuleColors());
  const [recentColorTarget, setRecentColorTarget] = useState<'solid' | 'start' | 'end'>(isGradient ? 'start' : 'solid');
  const recentColorSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const handleRecentColorsUpdated = (event: Event) => {
      const colors = (event as CustomEvent<string[]>).detail;
      setRecentColors(Array.isArray(colors) ? colors : loadRecentRuleColors());
    };
    window.addEventListener(RECENT_RULE_COLORS_UPDATED_EVENT, handleRecentColorsUpdated);
    return () => window.removeEventListener(RECENT_RULE_COLORS_UPDATED_EVENT, handleRecentColorsUpdated);
  }, []);
  useEffect(() => {
    if (!isGradient && recentColorTarget !== 'solid') setRecentColorTarget('solid');
    if (isGradient && recentColorTarget === 'solid') setRecentColorTarget('start');
  }, [isGradient, recentColorTarget]);
  useEffect(() => () => {
    if (recentColorSaveTimerRef.current !== null) {
      clearTimeout(recentColorSaveTimerRef.current);
    }
  }, []);
  const rememberColor = (color: string, immediate = false) => {
    const normalized = normalizeRuleHexColor(color, '');
    if (!/^#[0-9a-fA-F]{6}$/.test(normalized)) return;
    if (recentColorSaveTimerRef.current !== null) {
      clearTimeout(recentColorSaveTimerRef.current);
      recentColorSaveTimerRef.current = null;
    }
    const commit = () => {
      recentColorSaveTimerRef.current = null;
      setRecentColors(saveRecentRuleColor(normalized));
    };
    if (immediate) {
      commit();
    } else {
      recentColorSaveTimerRef.current = setTimeout(commit, 350);
    }
  };
  const updateHexColor = (value: string, apply: (color: string) => void) => {
    if (/^#[0-9a-fA-F]{6}$/.test(value)) {
      const color = value.toLowerCase();
      apply(color);
    }
  };
  const parseGradientSize = (value: string): number | null => {
    if (value.trim() === '' || value.trim() === '∞') return null;
    const next = parseInt(value, 10);
    return Number.isFinite(next) && next >= 0 ? next : null;
  };
  const setSolidColor = (color: string) => {
    const normalized = normalizeRuleHexColor(color, baseColor);
    onUpdate({ color: normalized });
    rememberColor(normalized);
  };
  const setGradientStartColor = (color: string) => {
    const normalized = normalizeRuleHexColor(color, gradient.startColor);
    onUpdate({
      color: normalized,
      gradient: { ...gradient, startColor: normalized },
    });
    rememberColor(normalized);
  };
  const setGradientEndColor = (color: string) => {
    const normalized = normalizeRuleHexColor(color, gradient.endColor);
    onUpdate({
      gradient: { ...gradient, endColor: normalized },
    });
    rememberColor(normalized);
  };
  const applyRecentColor = (color: string) => {
    if (!isGradient || recentColorTarget === 'solid') {
      setSolidColor(color);
      rememberColor(color, true);
    } else if (recentColorTarget === 'end') {
      setGradientEndColor(color);
      rememberColor(color, true);
    } else {
      setGradientStartColor(color);
      rememberColor(color, true);
    }
  };
  const setColorMode = (mode: 'solid' | 'size_gradient') => {
    if (mode === 'size_gradient') {
      onUpdate({
        colorMode: 'size_gradient',
        color: pendingGradient.startColor,
        gradient: pendingGradient,
      });
    } else {
      onUpdate({ colorMode: 'solid', color: isGradient ? gradient.startColor : baseColor });
    }
  };

  const sizeText = `${rule.sizeMin}–${rule.sizeMax === null ? '∞' : rule.sizeMax} bp`;
  const layerText = (rule.targetLayers ?? []).length === 0
    ? 'all layers'
    : (rule.targetLayers ?? []).map(layer => layerLabelByKey?.[layer] ?? getLayerLabel(layer)).join(', ');
  const conditionText = describeConditions(rule);
  const swatch = isGradient
    ? `linear-gradient(90deg, ${gradient.startColor}, ${gradient.endColor})`
    : baseColor;

  if (!expanded) {
    return (
      <div
        className="mb-1 flex items-center gap-2 rounded border bg-white px-2 py-1 text-xs dark:border-white/10 dark:bg-dark-surface"
        data-copilot-anchor={`color-rule-${rule.id}`}
        data-testid="labeling-rule-row"
        draggable
        onDragStart={event => onDragStart(event, index)}
        onDragOver={onDragOver}
        onDrop={event => onDrop(event, index)}
      >
        <span className="cursor-grab select-none text-gray-400" title="Drag to reorder (top rule wins)">≡</span>
        <input
          type="checkbox"
          checked={rule.enabled}
          onChange={event => onUpdate({ enabled: event.target.checked })}
          className="rounded border-gray-300 dark:border-white/20"
          aria-label={`Use rule ${rule.name}`}
        />
        <span className="h-3 w-5 flex-shrink-0 rounded-sm border border-black/10" style={{ background: swatch, opacity: isHiddenByOpacity ? 0.25 : 1 }} />
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="flex min-w-0 flex-1 items-baseline gap-2 text-left"
          title={`${rule.name || 'Untitled'} · ${sizeText} · ${layerText}${conditionText ? ` · ${conditionText}` : ''} (click to edit)`}
        >
          {/* In a narrow panel the name keeps its room; the layer text gives way first. */}
          <span className={`min-w-[3rem] truncate font-medium ${rule.enabled ? 'text-gray-800 dark:text-gray-100' : 'text-gray-400'}`}>{rule.name || 'Untitled'}</span>
          <span className="whitespace-nowrap text-[11px] text-gray-500 tabular-nums">{sizeText}</span>
          <span className="min-w-0 flex-1 truncate text-[11px] text-gray-400">{layerText}{conditionText ? ` · ${conditionText}` : ''}</span>
        </button>
        <button type="button" onClick={() => setExpanded(true)} className="text-gray-400 hover:text-gray-600" aria-label="Edit rule" aria-expanded={false} data-tour="labeling-rule-edit"><DisclosureChevron open={false} size={11} /></button>
        <button type="button" onClick={onRemove} className="rounded p-1 text-ink-muted hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20 dark:hover:text-red-300" title="Remove rule" aria-label="Remove rule"><Trash size={12} aria-hidden="true" /></button>
      </div>
    );
  }

  return (
    <div
      data-testid="labeling-rule-row"
      className="border rounded p-2 mb-2 bg-white dark:bg-dark-surface dark:border-white/10"
      // Per-row Copilot anchor — lets the spotlight ring the specific
      // color rule when the planner emits remove_color_rule / toggle_color_rule
      // with a rule_id. Falls back to the panel header when the row's id
      // doesn't match any anchor selector.
      data-copilot-anchor={`color-rule-${rule.id}`}
      draggable
      onDragStart={event => onDragStart(event, index)}
      onDragOver={onDragOver}
      onDrop={event => onDrop(event, index)}
    >
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => setExpanded(false)} className="text-gray-500 hover:text-gray-700" aria-label="Collapse rule" title="Done"><DisclosureChevron open size={11} /></button>
        <span className="cursor-grab text-gray-400 select-none" title="Drag to reorder">≡</span>
        <input
          type="checkbox"
          checked={rule.enabled}
          onChange={event => onUpdate({ enabled: event.target.checked })}
          className="rounded border-gray-300 dark:border-white/20"
        />
        <input
          type="text"
          value={rule.name}
          onChange={event => onUpdate({ name: event.target.value })}
          className="input-tool text-xs w-24"
          placeholder="Name"
        />
        <input
          type="number"
          value={rule.sizeMin}
          onChange={event => onUpdate({ sizeMin: Math.max(0, parseInt(event.target.value) || 0) })}
          className="input-tool text-xs w-12"
          min={0}
          title="Min footprint size (bp)"
          data-tour="labeling-size-range"
        />
        <span className="text-gray-400 text-xs">–</span>
        <input
          type="text"
          value={rule.sizeMax === null ? '∞' : rule.sizeMax}
          onChange={event => {
            const value = event.target.value;
            if (value === '' || value === '∞') {
              onUpdate({ sizeMax: null });
            } else {
              const next = parseInt(value);
              if (!isNaN(next) && next > 0) onUpdate({ sizeMax: next });
            }
          }}
          className="input-tool text-xs w-12"
          title="Max footprint size (bp), empty or ∞ for no limit"
        />
        <span className="text-gray-400 text-[11px]">bp</span>
        <button type="button" onClick={onRemove} className="ml-auto rounded p-1 text-ink-muted hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20 dark:hover:text-red-300" title="Remove rule" aria-label="Remove rule"><Trash size={12} aria-hidden="true" /></button>
      </div>

      <div className="mt-1.5 ml-6 flex items-center gap-2 flex-wrap text-[11px]" data-tour="labeling-rule-color">
        <span className="text-gray-500 w-10">Color</span>
        <div className="inline-flex overflow-hidden rounded border border-gray-200 dark:border-white/10">
          <button
            type="button"
            onClick={() => setColorMode('solid')}
            className={`px-2 py-0.5 ${!isGradient ? 'bg-gray-200 text-gray-800 dark:bg-gray-700 dark:text-gray-200' : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'}`}
          >
            Solid
          </button>
          <button
            type="button"
            onClick={() => setColorMode('size_gradient')}
            className={`px-2 py-0.5 border-l border-gray-200 dark:border-white/10 ${isGradient ? 'bg-gray-200 text-gray-800 dark:bg-gray-700 dark:text-gray-200' : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'}`}
          >
            Gradient
          </button>
        </div>

        {isGradient ? (
          <>
            <span
              className="inline-block h-4 w-16 rounded-sm border border-gray-200 dark:border-white/10"
              style={{ background: `linear-gradient(90deg, ${gradient.startColor}, ${gradient.endColor})` }}
              title="Gradient preview"
            />
            <span className="text-gray-500">Start</span>
            <input
              type="color"
              value={gradient.startColor}
              onFocus={() => setRecentColorTarget('start')}
              onChange={event => setGradientStartColor(event.target.value)}
              className="w-6 h-6 border-0 p-0 cursor-pointer"
              title="Start color"
            />
            <input
              type="text"
              value={gradient.startColor}
              onFocus={() => setRecentColorTarget('start')}
              onChange={event => updateHexColor(event.target.value, setGradientStartColor)}
              className="input-tool text-[11px] w-[72px] font-mono"
              placeholder="#000000"
            />
            <span className="text-gray-400">End</span>
            <input
              type="color"
              value={gradient.endColor}
              onFocus={() => setRecentColorTarget('end')}
              onChange={event => setGradientEndColor(event.target.value)}
              className="w-6 h-6 border-0 p-0 cursor-pointer"
              title="End color"
            />
            <input
              type="text"
              value={gradient.endColor}
              onFocus={() => setRecentColorTarget('end')}
              onChange={event => updateHexColor(event.target.value, setGradientEndColor)}
              className="input-tool text-[11px] w-[72px] font-mono"
              placeholder="#000000"
            />
            <span className="text-gray-400">bp</span>
            <input
              type="number"
              value={gradient.sizeMin ?? ''}
              onChange={event => onUpdate({ gradient: { ...gradient, sizeMin: parseGradientSize(event.target.value) } })}
              className="input-tool text-[11px] w-12"
              min={0}
              title="Gradient start size. Smaller matching footprints use the start color."
            />
            <span className="text-gray-400">–</span>
            <input
              type="text"
              value={gradient.sizeMax == null ? '' : gradient.sizeMax}
              onChange={event => onUpdate({ gradient: { ...gradient, sizeMax: parseGradientSize(event.target.value) } })}
              className="input-tool text-[11px] w-12"
              title="Gradient end size. Larger matching footprints use the end color."
            />
            <select
              value={gradient.scale}
              onChange={event => onUpdate({ gradient: { ...gradient, scale: event.target.value as typeof gradient.scale } })}
              className="input-tool text-[11px] w-20"
              title="Gradient scale"
            >
              {COLOR_RULE_GRADIENT_SCALE_OPTIONS.map(option => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </>
        ) : (
          <>
            <input
              type="color"
              value={baseColor}
              onFocus={() => setRecentColorTarget('solid')}
              onChange={event => setSolidColor(event.target.value)}
              className="w-6 h-6 border-0 p-0 cursor-pointer"
              title="Choose color"
            />
            <input
              type="text"
              value={baseColor}
              onFocus={() => setRecentColorTarget('solid')}
              onChange={event => updateHexColor(event.target.value, setSolidColor)}
              className="input-tool text-[11px] w-[72px] font-mono"
              placeholder="#000000"
            />
          </>
        )}
      </div>

      {recentColors.length > 0 && (
        <div className="mt-1 ml-6 flex items-center gap-1 flex-wrap text-[11px]">
          <span className="text-gray-500 w-10">Recent</span>
          {isGradient && (
            <div className="inline-flex overflow-hidden rounded border border-gray-200 dark:border-white/10 mr-1">
              <button
                type="button"
                onClick={() => setRecentColorTarget('start')}
                className={`px-1.5 py-0.5 ${recentColorTarget === 'start' ? 'bg-gray-200 text-gray-800 dark:bg-gray-700 dark:text-gray-200' : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'}`}
              >
                Start
              </button>
              <button
                type="button"
                onClick={() => setRecentColorTarget('end')}
                className={`px-1.5 py-0.5 border-l border-gray-200 dark:border-white/10 ${recentColorTarget === 'end' ? 'bg-gray-200 text-gray-800 dark:bg-gray-700 dark:text-gray-200' : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'}`}
              >
                End
              </button>
            </div>
          )}
          {recentColors.map(color => (
            <button
              key={color}
              type="button"
              onClick={() => applyRecentColor(color)}
              className="h-4 w-4 rounded-sm border border-gray-300 dark:border-white/20 hover:ring-1 hover:ring-slate-400"
              style={{ background: color }}
              title={color}
            />
          ))}
        </div>
      )}

      <div className="mt-1.5 ml-6 grid grid-cols-[4rem_1fr_2.5rem_auto] items-center gap-2 text-[11px]">
        <span className="text-gray-500">Opacity</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={opacity}
          onChange={event => onUpdate({ opacity: parseFloat(event.target.value) })}
          title="Visual opacity for footprints matched by this rule. 0 hides them while keeping the rule active."
        />
        <span className="text-right tabular-nums text-gray-500">{Math.round(opacity * 100)}%</span>
        <AnalysisButton
          type="button"
          onClick={() => onUpdate({ opacity: isHiddenByOpacity ? 1 : 0 })}
          theme={isHiddenByOpacity ? 'amber' : 'slate'}
          variant={isHiddenByOpacity ? 'soft' : 'outline'}
          className="px-1.5"
          title={isHiddenByOpacity ? 'Restore visible opacity to 100%' : 'Set rule opacity to 0% to hide matching footprints'}
        >
          {isHiddenByOpacity ? 'Show' : 'Hide'}
        </AnalysisButton>
      </div>

      {availableLayers.length > 1 && (
        <div className="mt-1.5 ml-6 flex items-center gap-1 flex-wrap" data-tour="labeling-target-layers">
          <span className="text-[11px] text-gray-500">Layers:</span>
          <button
            onClick={() => onUpdate({ targetLayers: [] })}
            className={`px-1.5 py-0.5 rounded text-[11px] ${
              (rule.targetLayers ?? []).length === 0
                ? 'bg-gray-200 text-gray-800 dark:bg-gray-700 dark:text-gray-200'
                : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
            }`}
            title="Apply this rule to all layers (default)"
          >
            All
          </button>
          {availableLayers.map(layerName => {
            const isActive = targetIncludesLayer(rule.targetLayers ?? [], layerName);
            const label = layerLabelByKey?.[layerName] ?? getLayerLabel(layerName);
            return (
              <button
                key={layerName}
                onClick={() => toggleTargetLayer(layerName)}
                className={`px-1.5 py-0.5 rounded text-[11px] flex items-center gap-1 ${
                  isActive
                    ? 'bg-gray-200 dark:bg-gray-700'
                    : 'hover:bg-gray-100 dark:hover:bg-gray-800 opacity-70'
                }`}
                title={isActive ? `Applies to ${label} layer` : `Click to target ${label} layer`}
              >
                <span
                  className="inline-block w-2 h-2 rounded-sm"
                  style={{ background: getLayerColor(layerName) }}
                />
                <span className={isActive ? 'text-gray-800 dark:text-gray-200' : 'text-gray-600 dark:text-gray-400'}>
                  {label}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {(rule.qualityGates ?? []).length > 0 && (
        <div className="mt-1.5 ml-6 space-y-1">
          {(rule.qualityGates ?? []).map((gate, gateIndex) => (
            <QualityGateEditor
              key={gateIndex}
              gate={gate}
              onChange={newGate => {
                const next = [...(rule.qualityGates ?? [])];
                next[gateIndex] = newGate;
                onUpdate({ qualityGates: next });
              }}
              onRemove={() => {
                onUpdate({ qualityGates: (rule.qualityGates ?? []).filter((_, indexToKeep) => indexToKeep !== gateIndex) });
              }}
            />
          ))}
        </div>
      )}

      <div className="mt-1.5 ml-6 space-y-1">
        {rule.conditions.length === 0 && (rule.qualityGates ?? []).length === 0 && !hasNuc && (
          <span className="text-[11px] text-gray-400">(no conditions — matches all)</span>
        )}
        {(hasNuc || nucOpen) && (
          <NucConditionEditor
            rule={rule}
            onUpdate={onUpdate}
            onRemove={() => { setNucOpen(false); onUpdate(CLEARED_NUC_CONDITIONS); }}
          />
        )}
        {(rule.conditions ?? []).map((condition, conditionIndex) => (
          <ConditionEditor
            key={conditionIndex}
            condition={condition}
            onChange={newCondition => {
              const next = [...rule.conditions];
              next[conditionIndex] = newCondition;
              onUpdate({ conditions: next });
            }}
            onRemove={() => {
              onUpdate({ conditions: rule.conditions.filter((_, indexToKeep) => indexToKeep !== conditionIndex) });
            }}
            orthogonalTracks={orthogonalTracks}
            genes={genes}
          />
        ))}
        <div className="flex items-center gap-3">
          <AnalysisButton
            onClick={() => onUpdate({ conditions: [...rule.conditions, { target: 'gene' }] })}
            theme="slate"
            variant="soft"
            data-tour="labeling-add-condition"
          >
            + Add condition
          </AnalysisButton>
          <AnalysisButton
            onClick={() => onUpdate({
              qualityGates: [...(rule.qualityGates ?? []), { qualityName: 'aq', minValue: 230 }],
            })}
            theme="slate"
            variant="soft"
            title="Gate this rule on a per-interval quality score (aq for FIRE, tq for TF, lq/rq for nucleosome edges, etc.)"
            data-tour="labeling-add-gate"
          >
            + Add quality gate
          </AnalysisButton>
          {!hasNuc && !nucOpen && (
            <AnalysisButton
              onClick={() => setNucOpen(true)}
              theme="slate"
              variant="soft"
              title="Match nucleosome calls by size class or z, from a nucleosome scan's size marks"
              data-testid="labeling-add-nuc-condition"
            >
              + Nucleosome class
            </AnalysisButton>
          )}
        </div>
      </div>
    </div>
  );
}
