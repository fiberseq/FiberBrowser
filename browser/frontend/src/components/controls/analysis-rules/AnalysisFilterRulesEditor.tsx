import { useMemo, useRef, useState, type ChangeEvent } from 'react';
import { RuleEditorHeader, RulePresetsMenu } from './RuleEditorHeader';
import type {
  AnalysisFilterMetric,
  AnalysisFilterOperator,
  AnalysisFilterRule,
  AnalysisFilterRuleSet,
  AnalysisRuleScope,
  AnalysisRuleScopeKind,
  ClusterFeatureRuleTerm,
  ColorRule,
  FootprintGroup,
  Gene,
  TranscriptionStateRuleKind,
} from '../../../types';
import {
  DEFAULT_ANALYSIS_RULE_SCOPE,
  TRANSCRIPTION_STATE_RULE_OPTIONS,
  buildAnalysisFilterRuleAutoName,
  normalizeAnalysisRuleScope,
  normalizeTranscriptionStateRuleKind,
  summarizeAnalysisRuleScope,
} from '../../../utils/analysisRules';
import { AnalysisButton } from '../shared';
import {
  HubHitsControls,
  MoleculeMetricSelect,
  MoleculeMetricUnit,
  hubHitsTerm,
  hubSourceNote,
  layerFreeScope,
  moleculeMetricTerm,
  useHubSelectionHits,
} from './RuleTermSources';

interface LayerOption {
  value: string;
  label: string;
}

interface Props {
  rules: AnalysisFilterRule[];
  savedRuleSets: AnalysisFilterRuleSet[];
  activeLabelRules: ColorRule[];
  footprintGroups: FootprintGroup[];
  selectedGenes?: Gene[];
  layerOptions: LayerOption[];
  className?: string;
  listClassName?: string;
  onAddRule: (rule: AnalysisFilterRule) => void;
  onUpdateRule: (id: string, updates: Partial<AnalysisFilterRule>) => void;
  onRemoveRule: (id: string) => void;
  onSetRules: (rules: AnalysisFilterRule[]) => void;
  onSaveRuleSet: (name: string) => void;
  onLoadRuleSet: (name: string) => void;
  onDeleteRuleSet: (name: string) => void;
  onSetDefaultRuleSet: (name: string | null) => void;
}

const SCOPE_OPTIONS: Array<{ value: AnalysisRuleScopeKind; label: string }> = [
  { value: 'selectedPeaks', label: 'Selected peaks' },
  { value: 'allPeaks', label: 'All peaks' },
  { value: 'currentWindow', label: 'Current window' },
  { value: 'gene', label: 'Selected gene' },
];

const GENE_PART_OPTIONS: Array<{ value: NonNullable<AnalysisRuleScope['genePart']>; label: string }> = [
  { value: 'full', label: 'Full' },
  { value: 'tss', label: 'TSS' },
  { value: 'geneBody', label: 'Body' },
  { value: 'exon', label: 'Exon' },
  { value: 'intron', label: 'Intron' },
];

const METRIC_OPTIONS: Array<{ value: AnalysisFilterMetric; label: string }> = [
  { value: 'count', label: 'Count' },
  { value: 'occupancy', label: 'Occupancy' },
  { value: 'rate', label: 'FP rate' },
  { value: 'accessibility', label: 'Accessibility' },
];

const OPERATOR_OPTIONS: Array<{ value: AnalysisFilterOperator; label: string }> = [
  { value: 'gte', label: '>=' },
  { value: 'gt', label: '>' },
  { value: 'lte', label: '<=' },
  { value: 'lt', label: '<' },
  { value: 'eq', label: '=' },
  { value: 'between', label: 'between' },
];

/** The metric a term is measured by: a molecule metric's value, a hub term's count (else the rule's own). */
function metricForSource(source: ClusterFeatureRuleTerm['source'] | undefined, metric: AnalysisFilterMetric): AnalysisFilterMetric {
  if (source === 'molecule_metric') return 'value';
  if (source === 'feature_hub') return 'count';
  return metric === 'value' ? 'count' : metric;
}

function uid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function snapshotLabelRule(rule: ColorRule): ColorRule {
  return {
    ...rule,
    targetLayers: [...(rule.targetLayers ?? [])],
    conditions: [...(rule.conditions ?? [])],
    qualityGates: [...(rule.qualityGates ?? [])],
  };
}

function snapshotFootprintGroup(group: FootprintGroup): FootprintGroup {
  return {
    ...group,
    conditions: [...(group.conditions ?? [])],
  };
}

function layerLabelMap(layerOptions: LayerOption[]): Record<string, string> {
  return Object.fromEntries(layerOptions.map(option => [option.value, option.label]));
}

function defaultLayerTerm(layerOptions: LayerOption[]): ClusterFeatureRuleTerm {
  return {
    id: uid('filter_term'),
    source: 'layer',
    layer: layerOptions[0]?.value ?? null,
    sizeMin: 0,
    sizeMax: null,
    qualityGates: [],
  };
}

function defaultRule(layerOptions: LayerOption[]): AnalysisFilterRule {
  const terms = [defaultLayerTerm(layerOptions)];
  const base = {
    id: uid('filter_rule'),
    name: '',
    autoName: '',
    nameEdited: false,
    enabled: true,
    scope: { ...DEFAULT_ANALYSIS_RULE_SCOPE },
    terms,
    metric: 'count' as const,
    operator: 'gte' as const,
    threshold: 1,
  };
  const autoName = buildAnalysisFilterRuleAutoName(base, layerLabelMap(layerOptions));
  return { ...base, name: autoName, autoName };
}

function sizeMaxText(sizeMax: number | null | undefined): string {
  return sizeMax == null ? '' : String(sizeMax);
}

function parseSizeMax(value: string): number | null {
  if (value.trim() === '') return null;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function labelRuleSummary(rule: ColorRule | undefined): string {
  if (!rule) return 'No label rule selected';
  const layers = (rule.targetLayers ?? []).length > 0 ? rule.targetLayers.join(', ') : 'all layers';
  const max = rule.sizeMax == null ? 'any' : `${rule.sizeMax}`;
  return `${rule.sizeMin}-${max} bp, ${layers}`;
}

function groupSummary(group: FootprintGroup | undefined): string {
  if (!group) return 'No cart class selected';
  const max = group.sizeMax == null ? 'any' : `${group.sizeMax}`;
  return `${group.sizeMin}-${max} bp, ${group.layer ?? 'primary'}`;
}

function updateTerm(
  rule: AnalysisFilterRule,
  termId: string,
  updates: Partial<ClusterFeatureRuleTerm>,
): AnalysisFilterRule {
  return {
    ...rule,
    terms: rule.terms.map(term => term.id === termId ? { ...term, ...updates } : term),
  };
}

export function AnalysisFilterRulesEditor({
  rules,
  savedRuleSets,
  activeLabelRules,
  footprintGroups,
  selectedGenes = [],
  layerOptions,
  className = '',
  listClassName = 'max-h-[420px] space-y-2 overflow-y-auto pr-1',
  onAddRule,
  onUpdateRule,
  onRemoveRule,
  onSetRules,
  onSaveRuleSet,
  onLoadRuleSet,
  onDeleteRuleSet,
  onSetDefaultRuleSet,
}: Props) {
  const [presetName, setPresetName] = useState('Filter rules');
  const [message, setMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const ruleLayerLabels = useMemo(() => layerLabelMap(layerOptions), [layerOptions]);
  const hub = useHubSelectionHits();

  const showMessage = (text: string) => {
    setMessage(text);
    window.setTimeout(() => setMessage(null), 2200);
  };

  const prepareRuleUpdate = (
    rule: AnalysisFilterRule,
    updates: Partial<AnalysisFilterRule>,
  ): Partial<AnalysisFilterRule> => {
    const next = { ...rule, ...updates };
    const metric = metricForSource(next.terms[0]?.source, next.metric);
    if (metric !== next.metric) {
      next.metric = metric;
      updates = { ...updates, metric };
    }
    const autoName = buildAnalysisFilterRuleAutoName(next, ruleLayerLabels);
    return {
      ...updates,
      autoName,
      ...(next.nameEdited === false ? { name: autoName } : {}),
    };
  };

  const updateRule = (rule: AnalysisFilterRule, updates: Partial<AnalysisFilterRule>) => {
    onUpdateRule(rule.id, prepareRuleUpdate(rule, updates));
  };

  const updateRuleTerm = (
    rule: AnalysisFilterRule,
    termId: string,
    updates: Partial<ClusterFeatureRuleTerm>,
  ) => {
    const next = updateTerm(rule, termId, updates).terms;
    updateRule(rule, {
      terms: next.some(term => term.id === termId)
        ? next
        : [{ ...defaultLayerTerm(layerOptions), id: termId, ...updates }],
    });
  };

  const updateRuleScope = (rule: AnalysisFilterRule, updates: Partial<AnalysisRuleScope>) => {
    const current = normalizeAnalysisRuleScope(rule.scope);
    const next = normalizeAnalysisRuleScope({ ...current, ...updates });
    if (updates.kind === 'gene') {
      const gene = selectedGenes.find(candidate => candidate.id === next.geneId) ?? selectedGenes[0];
      next.geneId = gene?.id ?? null;
      next.geneName = gene?.name ?? null;
    }
    updateRule(rule, { scope: next });
  };

  const applyLabelRule = (rule: AnalysisFilterRule, term: ClusterFeatureRuleTerm, labelRuleId: string) => {
    const labelRule = activeLabelRules.find(candidate => candidate.id === labelRuleId);
    if (!labelRule) return;
    updateRuleTerm(rule, term.id, {
      source: 'label_rule',
      labelRuleId,
      labelRuleName: labelRule.name,
      rule: snapshotLabelRule(labelRule),
    });
  };

  const applyFootprintGroup = (rule: AnalysisFilterRule, term: ClusterFeatureRuleTerm, groupId: string) => {
    const group = footprintGroups.find(candidate => candidate.id === groupId);
    if (!group) return;
    updateRuleTerm(rule, term.id, {
      source: 'footprint_group',
      footprintGroupId: groupId,
      footprintGroupName: group.name,
      group: snapshotFootprintGroup(group),
    });
  };

  const geneScopeForRule = (rule: AnalysisFilterRule): AnalysisRuleScope => {
    const scope = normalizeAnalysisRuleScope(rule.scope);
    if (scope.kind === 'gene') return { ...scope, genePart: 'full' };
    const gene = selectedGenes[0];
    return {
      ...scope,
      kind: 'gene',
      geneId: gene?.id ?? null,
      geneName: gene?.name ?? null,
      genePart: 'full',
    };
  };

	  const applyTranscriptionState = (
	    rule: AnalysisFilterRule,
	    term: ClusterFeatureRuleTerm,
	    stateKind?: TranscriptionStateRuleKind,
	  ) => {
	    if (selectedGenes.length === 0) {
	      showMessage('Select a gene before using Pol II state rules.');
	      return;
	    }
	    updateRule(rule, {
	      metric: 'count',
      operator: 'gte',
      threshold: 1,
      scope: geneScopeForRule(rule),
      terms: [{
        ...term,
        source: 'transcription_state',
        transcriptionState: normalizeTranscriptionStateRuleKind(stateKind ?? term.transcriptionState),
        layer: null,
        sizeMin: 0,
        sizeMax: null,
        qualityGates: [],
      }],
    });
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify({ name: presetName || 'Filter rules', rules }, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'analysis_filter_rules.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const importJson = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const importedRules = Array.isArray(parsed) ? parsed : parsed.rules;
      if (!Array.isArray(importedRules)) throw new Error('Missing rules array');
      onSetRules(importedRules as AnalysisFilterRule[]);
      showMessage('Imported filter rules.');
    } catch (err) {
      console.error('Filter rule import failed:', err);
      showMessage('Import failed.');
    } finally {
      event.target.value = '';
    }
  };

  return (
    <div className={`text-xs ${className}`}>
      <RuleEditorHeader
        title="Filter rules"
        description="Each rule keeps only the reads that match it; choose it in the toolbar's Filter group."
        onAdd={() => onAddRule(defaultRule(layerOptions))}
        addAnchor="analysis-rules-add-filter-rule"
        presets={(
          <RulePresetsMenu
            noun="filter rules"
            savedNames={savedRuleSets.map(set => set.name)}
            suggestedName={presetName}
            onSave={name => { onSaveRuleSet(name); setPresetName(name); }}
            onLoad={name => { onLoadRuleSet(name); setPresetName(name); }}
            onDelete={onDeleteRuleSet}
            onSetDefault={onSetDefaultRuleSet}
            onExportJson={exportJson}
            onImportJson={() => fileInputRef.current?.click()}
            onMessage={showMessage}
          />
        )}
      />

      {message && (
        <div className="mb-2 rounded bg-emerald-50 px-2 py-1 text-[11px] text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300">
          {message}
        </div>
      )}

      <div className={listClassName}>
        {rules.length === 0 && (
          <div className="rounded border border-dashed border-gray-200 p-3 text-[11px] text-gray-500 dark:border-white/10 dark:text-gray-400">
            No custom filter rules yet.
          </div>
        )}

        {rules.map(rule => {
          const scope = normalizeAnalysisRuleScope(rule.scope);
          const suggestedName = rule.autoName || buildAnalysisFilterRuleAutoName(rule, ruleLayerLabels);
          const term = rule.terms[0] ?? defaultLayerTerm(layerOptions);
          const selectedLabelRule = activeLabelRules.find(candidate => candidate.id === term.labelRuleId) ?? term.rule;
          const selectedGroup = footprintGroups.find(candidate => candidate.id === term.footprintGroupId) ?? term.group;

          return (
            <div key={rule.id} className="rounded border border-gray-200 bg-gray-50 p-2 dark:border-white/10 dark:bg-white/[0.03]">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="checkbox"
                  checked={rule.enabled}
                  onChange={event => onUpdateRule(rule.id, { enabled: event.target.checked })}
                  className="rounded border-gray-300 dark:border-white/20"
                  title="Enable this filter rule"
                />
                <input
                  type="text"
                  value={rule.name}
                  onChange={event => {
                    const name = event.target.value;
                    if (name.trim().length === 0) {
                      onUpdateRule(rule.id, { name: suggestedName, autoName: suggestedName, nameEdited: false });
                      return;
                    }
                    onUpdateRule(rule.id, { name, nameEdited: true });
                  }}
                  className="input-tool w-56 text-xs"
                  placeholder={suggestedName}
                />
                {rule.nameEdited && (
                  <AnalysisButton
                    variant="outline"
                    onClick={() => onUpdateRule(rule.id, { name: suggestedName, autoName: suggestedName, nameEdited: false })}
                    title="Use the generated rule name"
                  >
                    Use suggested
                  </AnalysisButton>
                )}
                <AnalysisButton
                  className="ml-auto"
                  variant="dangerOutline"
                  onClick={() => onRemoveRule(rule.id)}
                  title="Remove filter rule"
                >
                  Remove
                </AnalysisButton>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-1.5 rounded bg-white px-1.5 py-1 ring-1 ring-gray-200 dark:bg-black/10 dark:ring-white/10">
                <span className="text-[11px] font-medium text-gray-400">Keep</span>
                {term.source === 'molecule_metric' ? (
                  <MoleculeMetricUnit metric={term.moleculeMetric} />
                ) : term.source === 'feature_hub' ? (
                  <span className="text-[11px] text-gray-500" title="Number of the hits where the read is in the chosen state">hits in state</span>
                ) : (
                  <select
                    value={rule.metric}
                    onChange={event => updateRule(rule, { metric: event.target.value as AnalysisFilterMetric })}
                    className="input-tool text-xs"
                  >
                    {METRIC_OPTIONS.map(option => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                )}
                <select
                  value={rule.operator}
                  onChange={event => {
                    const operator = event.target.value as AnalysisFilterOperator;
                    updateRule(rule, operator === 'between' && rule.thresholdMax == null
                      ? { operator, thresholdMax: rule.threshold }
                      : { operator });
                  }}
                  className="input-tool text-xs"
                >
                  {OPERATOR_OPTIONS.map(option => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
                <input
                  type="number"
                  step="0.01"
                  value={rule.threshold}
                  onChange={event => updateRule(rule, { threshold: Number(event.target.value) || 0 })}
                  className="input-tool w-20 text-xs"
                  title={rule.operator === 'between' ? 'Lower bound (inclusive)' : 'Metric threshold'}
                />
                {rule.operator === 'between' && (
                  <>
                    <span className="text-gray-400">and</span>
                    <input
                      type="number"
                      step="0.01"
                      value={rule.thresholdMax ?? rule.threshold}
                      onChange={event => updateRule(rule, { thresholdMax: Number(event.target.value) || 0 })}
                      className="input-tool w-20 text-xs"
                      title="Upper bound (inclusive)"
                    />
                  </>
                )}
                <label
                  className="ml-auto flex items-center gap-1 text-[11px] text-gray-500 dark:text-gray-400"
                  title="Keep only reads that also pass the panel's current filter, instead of replacing it"
                >
                  <input
                    type="checkbox"
                    checked={rule.combine === 'and'}
                    onChange={event => updateRule(rule, { combine: event.target.checked ? 'and' : 'replace' })}
                    className="rounded border-gray-300 dark:border-white/20"
                  />
                  Within the current filter (AND)
                </label>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-1.5 rounded bg-white px-1.5 py-1 ring-1 ring-gray-200 dark:bg-black/10 dark:ring-white/10">
                <span className="text-[11px] font-medium text-gray-400">Source</span>
	                <select
	                  value={term.source}
	                  onChange={event => {
	                    const source = event.target.value as ClusterFeatureRuleTerm['source'];
	                    if (source === 'label_rule' && activeLabelRules[0]) {
	                      applyLabelRule(rule, term, activeLabelRules[0].id);
	                    } else if (source === 'footprint_group' && footprintGroups[0]) {
	                      applyFootprintGroup(rule, term, footprintGroups[0].id);
	                    } else if (source === 'transcription_state') {
	                      applyTranscriptionState(rule, term);
	                    } else if (source === 'molecule_metric') {
	                      updateRule(rule, { scope: layerFreeScope(rule.scope), terms: [moleculeMetricTerm(term)] });
	                    } else if (source === 'feature_hub') {
	                      if (hub.hits.length === 0) {
	                        showMessage(`Hub hits: ${hubSourceNote(hub)}.`);
	                        return;
	                      }
	                      updateRule(rule, { scope: layerFreeScope(rule.scope), terms: [hubHitsTerm(term, hub.hits)] });
	                    } else {
	                      updateRule(rule, { terms: [{ ...term, source: 'layer', layer: layerOptions[0]?.value ?? null }] });
	                    }
	                  }}
	                  className="input-tool text-xs"
	                >
                  <option value="layer">Layer</option>
	                  <option value="label_rule" disabled={activeLabelRules.length === 0}>
	                    Label rule{activeLabelRules.length === 0 ? ' (none defined)' : ''}
	                  </option>
	                  <option value="footprint_group" disabled={footprintGroups.length === 0}>
	                    Footprint cart{footprintGroups.length === 0 ? ' (empty)' : ''}
	                  </option>
		                  <option value="transcription_state" disabled={selectedGenes.length === 0}>
		                    Pol II state {selectedGenes.length === 0 ? '(select gene first)' : '(Pause/PIC/Elongating)'}
		                  </option>
	                  <option value="molecule_metric">Molecule metric</option>
	                  <option value="feature_hub" disabled={hub.hits.length === 0 && term.source !== 'feature_hub'}>
	                    Hub hits{hub.hits.length === 0 ? ` (${hubSourceNote(hub)})` : ''}
	                  </option>
	                </select>

                {term.source === 'layer' && (
                  <>
                    <select
                      value={term.layer ?? ''}
                      onChange={event => updateRuleTerm(rule, term.id, { layer: event.target.value || null })}
                      className="input-tool text-xs"
                    >
                      {layerOptions.map(option => (
                        <option key={option.value || 'primary'} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                    <input
                      type="number"
                      min={0}
                      value={term.sizeMin ?? 0}
                      onChange={event => updateRuleTerm(rule, term.id, { sizeMin: Math.max(0, parseInt(event.target.value, 10) || 0) })}
                      className="input-tool w-14 text-xs"
                      title="Minimum footprint size for count metric"
                    />
                    <span className="text-gray-400">to</span>
                    <input
                      type="text"
                      value={sizeMaxText(term.sizeMax)}
                      onChange={event => updateRuleTerm(rule, term.id, { sizeMax: parseSizeMax(event.target.value) })}
                      className="input-tool w-14 text-xs"
                      placeholder="any"
                      title="Maximum footprint size, blank for no maximum"
                    />
                    <span className="text-[11px] text-gray-400">bp</span>
                  </>
                )}

                {term.source === 'label_rule' && (
                  <>
                    <select
                      value={term.labelRuleId ?? ''}
                      onChange={event => applyLabelRule(rule, term, event.target.value)}
                      className="input-tool max-w-[220px] text-xs"
                    >
                      {activeLabelRules.length === 0 && <option value="">No label rules</option>}
                      {activeLabelRules.map(labelRule => (
                        <option key={labelRule.id} value={labelRule.id}>{labelRule.name}</option>
                      ))}
                    </select>
                    <span className="text-[11px] text-gray-500">{labelRuleSummary(selectedLabelRule)}</span>
                  </>
                )}

	                {term.source === 'footprint_group' && (
	                  <>
	                    <select
	                      value={term.footprintGroupId ?? ''}
                      onChange={event => applyFootprintGroup(rule, term, event.target.value)}
                      className="input-tool max-w-[220px] text-xs"
                    >
                      {footprintGroups.length === 0 && <option value="">No cart classes</option>}
                      {footprintGroups.map(group => (
                        <option key={group.id} value={group.id}>{group.name}</option>
                      ))}
	                    </select>
	                    <span className="text-[11px] text-gray-500">{groupSummary(selectedGroup)}</span>
	                  </>
	                )}

	                {term.source === 'transcription_state' && (
	                  <>
	                    <select
	                      value={normalizeTranscriptionStateRuleKind(term.transcriptionState)}
	                      onChange={event => applyTranscriptionState(rule, term, event.target.value as TranscriptionStateRuleKind)}
	                      className="input-tool text-xs"
	                    >
	                      {TRANSCRIPTION_STATE_RULE_OPTIONS.map(option => (
	                        <option key={option.value} value={option.value}>{option.label}</option>
	                      ))}
	                    </select>
	                    <span className="text-[11px] text-gray-500">uses Transcription panel definitions</span>
	                  </>
	                )}

	                {term.source === 'molecule_metric' && (
	                  <>
	                    <MoleculeMetricSelect
	                      value={term.moleculeMetric}
	                      onChange={metric => updateRuleTerm(rule, term.id, { moleculeMetric: metric })}
	                    />
	                    <span className="text-[11px] text-gray-500">per molecule; reads without a value never pass</span>
	                  </>
	                )}

	                {term.source === 'feature_hub' && (
	                  <HubHitsControls
	                    term={term}
	                    hub={hub}
	                    onSnapshot={() => updateRuleTerm(rule, term.id, { hubHits: hub.hits })}
	                    onState={state => updateRuleTerm(rule, term.id, { hubState: state })}
	                  />
	                )}
	              </div>

              <div className="mt-2 flex flex-wrap items-center gap-1.5 rounded bg-white px-1.5 py-1 ring-1 ring-gray-200 dark:bg-black/10 dark:ring-white/10">
                <span className="text-[11px] font-medium text-gray-400">Scope</span>
	                <select
	                  value={scope.kind}
	                  onChange={event => updateRuleScope(rule, { kind: event.target.value as AnalysisRuleScopeKind })}
	                  className="input-tool text-xs"
	                  disabled={term.source === 'transcription_state'}
	                >
                  {SCOPE_OPTIONS.map(option => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
                {(scope.kind === 'selectedPeaks' || scope.kind === 'allPeaks') && (
                  <>
                    <span className="text-[11px] text-gray-400">levels</span>
                    <select
                      value={scope.peakLevelMin == null ? '' : String(scope.peakLevelMin)}
                      onChange={event => updateRuleScope(rule, { peakLevelMin: event.target.value === '' ? null : Number(event.target.value) })}
                      className="input-tool text-xs"
                    >
                      <option value="">Any</option>
                      {[0, 1, 2, 3].map(level => <option key={level} value={level}>L{level}</option>)}
                    </select>
                    <span className="text-gray-400">to</span>
                    <select
                      value={scope.peakLevelMax == null ? '' : String(scope.peakLevelMax)}
                      onChange={event => updateRuleScope(rule, { peakLevelMax: event.target.value === '' ? null : Number(event.target.value) })}
                      className="input-tool text-xs"
                    >
                      <option value="">Any</option>
                      {[0, 1, 2, 3].map(level => <option key={level} value={level}>L{level}</option>)}
                    </select>
                  </>
                )}
                {scope.kind === 'gene' && (
                  <>
                    <select
                      value={scope.geneId ?? ''}
                      onChange={event => {
                        const gene = selectedGenes.find(candidate => candidate.id === event.target.value);
                        updateRuleScope(rule, { geneId: gene?.id ?? null, geneName: gene?.name ?? null });
                      }}
                      className="input-tool max-w-[180px] text-xs"
                      disabled={selectedGenes.length === 0}
                    >
                      {selectedGenes.length === 0 && <option value="">No selected genes</option>}
                      {selectedGenes.map(gene => (
                        <option key={gene.id} value={gene.id}>{gene.name || gene.id}</option>
                      ))}
                    </select>
	                    {term.source === 'transcription_state' ? (
	                      <span className="text-[11px] text-gray-500">state windows</span>
	                    ) : (
	                      <select
	                        value={scope.genePart ?? 'full'}
	                        onChange={event => updateRuleScope(rule, { genePart: event.target.value as AnalysisRuleScope['genePart'] })}
	                        className="input-tool text-xs"
	                      >
	                        {GENE_PART_OPTIONS.map(option => (
	                          <option key={option.value} value={option.value}>{option.label}</option>
	                        ))}
	                      </select>
	                    )}
	                  </>
	                )}
                <span className="ml-auto text-[11px] text-gray-500 dark:text-gray-400">
                  {summarizeAnalysisRuleScope(scope)}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <input ref={fileInputRef} type="file" accept=".json" onChange={importJson} className="hidden" />
    </div>
  );
}
