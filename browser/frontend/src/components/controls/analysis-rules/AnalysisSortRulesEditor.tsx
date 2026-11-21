import { useMemo, useRef, useState, type ChangeEvent } from 'react';
import { RuleEditorHeader, RulePresetsMenu } from './RuleEditorHeader';
import type {
  AnalysisRuleScope,
  AnalysisRuleScopeKind,
  AnalysisSortMetric,
  AnalysisSortRule,
  AnalysisSortRuleSet,
  ClusterFeatureRuleTerm,
  ColorRule,
  FootprintGroup,
  Gene,
  TranscriptionStateRuleKind,
} from '../../../types';
import {
  DEFAULT_ANALYSIS_RULE_SCOPE,
  TRANSCRIPTION_STATE_RULE_OPTIONS,
  buildAnalysisSortRuleAutoName,
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
  rules: AnalysisSortRule[];
  savedRuleSets: AnalysisSortRuleSet[];
  activeLabelRules: ColorRule[];
  footprintGroups: FootprintGroup[];
  selectedGenes?: Gene[];
  layerOptions: LayerOption[];
  className?: string;
  listClassName?: string;
  onAddRule: (rule: AnalysisSortRule) => void;
  onUpdateRule: (id: string, updates: Partial<AnalysisSortRule>) => void;
  onRemoveRule: (id: string) => void;
  onSetRules: (rules: AnalysisSortRule[]) => void;
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

const METRIC_OPTIONS: Array<{ value: AnalysisSortMetric; label: string }> = [
  { value: 'count', label: 'Count' },
  { value: 'occupancy', label: 'Occupancy' },
  { value: 'rate', label: 'FP rate' },
  { value: 'accessibility', label: 'Accessibility' },
];

/** The metric a term is measured by: a molecule metric's value, a hub term's count (else the rule's own). */
function metricForSource(source: ClusterFeatureRuleTerm['source'] | undefined, metric: AnalysisSortMetric): AnalysisSortMetric {
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
    id: uid('sort_term'),
    source: 'layer',
    layer: layerOptions[0]?.value ?? null,
    sizeMin: 0,
    sizeMax: null,
    qualityGates: [],
  };
}

function defaultRule(layerOptions: LayerOption[]): AnalysisSortRule {
  const terms = [defaultLayerTerm(layerOptions)];
  const base = {
    id: uid('sort_rule'),
    name: '',
    autoName: '',
    nameEdited: false,
    enabled: true,
    scope: { ...DEFAULT_ANALYSIS_RULE_SCOPE },
    terms,
    metric: 'count' as const,
    descending: true,
  };
  const autoName = buildAnalysisSortRuleAutoName(base, layerLabelMap(layerOptions));
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
  rule: AnalysisSortRule,
  termId: string,
  updates: Partial<ClusterFeatureRuleTerm>,
): AnalysisSortRule {
  return {
    ...rule,
    terms: rule.terms.map(term => term.id === termId ? { ...term, ...updates } : term),
  };
}

export function AnalysisSortRulesEditor({
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
  const [presetName, setPresetName] = useState('Sort rules');
  const [message, setMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const ruleLayerLabels = useMemo(() => layerLabelMap(layerOptions), [layerOptions]);
  const hub = useHubSelectionHits();

  const showMessage = (text: string) => {
    setMessage(text);
    window.setTimeout(() => setMessage(null), 2200);
  };

  const prepareRuleUpdate = (
    rule: AnalysisSortRule,
    updates: Partial<AnalysisSortRule>,
  ): Partial<AnalysisSortRule> => {
    const next = { ...rule, ...updates };
    const metric = metricForSource(next.terms[0]?.source, next.metric);
    if (metric !== next.metric) {
      next.metric = metric;
      updates = { ...updates, metric };
    }
    const autoName = buildAnalysisSortRuleAutoName(next, ruleLayerLabels);
    return {
      ...updates,
      autoName,
      ...(next.nameEdited === false ? { name: autoName } : {}),
    };
  };

  const updateRule = (rule: AnalysisSortRule, updates: Partial<AnalysisSortRule>) => {
    onUpdateRule(rule.id, prepareRuleUpdate(rule, updates));
  };

  const updateRuleTerm = (
    rule: AnalysisSortRule,
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

  const updateRuleScope = (rule: AnalysisSortRule, updates: Partial<AnalysisRuleScope>) => {
    const current = normalizeAnalysisRuleScope(rule.scope);
    const next = normalizeAnalysisRuleScope({ ...current, ...updates });
    if (updates.kind === 'gene') {
      const gene = selectedGenes.find(candidate => candidate.id === next.geneId) ?? selectedGenes[0];
      next.geneId = gene?.id ?? null;
      next.geneName = gene?.name ?? null;
    }
    updateRule(rule, { scope: next });
  };

  const applyLabelRule = (rule: AnalysisSortRule, term: ClusterFeatureRuleTerm, labelRuleId: string) => {
    const labelRule = activeLabelRules.find(candidate => candidate.id === labelRuleId);
    if (!labelRule) return;
    updateRuleTerm(rule, term.id, {
      source: 'label_rule',
      labelRuleId,
      labelRuleName: labelRule.name,
      rule: snapshotLabelRule(labelRule),
    });
  };

  const applyFootprintGroup = (rule: AnalysisSortRule, term: ClusterFeatureRuleTerm, groupId: string) => {
    const group = footprintGroups.find(candidate => candidate.id === groupId);
    if (!group) return;
    updateRuleTerm(rule, term.id, {
      source: 'footprint_group',
      footprintGroupId: groupId,
      footprintGroupName: group.name,
      group: snapshotFootprintGroup(group),
    });
  };

  const geneScopeForRule = (rule: AnalysisSortRule): AnalysisRuleScope => {
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
	    rule: AnalysisSortRule,
	    term: ClusterFeatureRuleTerm,
	    stateKind?: TranscriptionStateRuleKind,
	  ) => {
	    if (selectedGenes.length === 0) {
	      showMessage('Select a gene before using Pol II state rules.');
	      return;
	    }
	    updateRule(rule, {
	      metric: 'count',
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
    const blob = new Blob([JSON.stringify({ name: presetName || 'Sort rules', rules }, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'analysis_sort_rules.json';
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
      onSetRules(importedRules as AnalysisSortRule[]);
      showMessage('Imported sort rules.');
    } catch (err) {
      console.error('Sort rule import failed:', err);
      showMessage('Import failed.');
    } finally {
      event.target.value = '';
    }
  };

  return (
    <div className={`text-xs ${className}`}>
      <RuleEditorHeader
        title="Sort rules"
        description="Each rule is a way to order reads; choose it in the toolbar's Sort group."
        onAdd={() => onAddRule(defaultRule(layerOptions))}
        addAnchor="analysis-rules-add-sort-rule"
        presets={(
          <RulePresetsMenu
            noun="sort rules"
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
        <div className="mb-2 rounded bg-blue-50 px-2 py-1 text-[11px] text-blue-700 dark:bg-blue-900/20 dark:text-blue-300">
          {message}
        </div>
      )}

      <div className={listClassName}>
        {rules.length === 0 && (
          <div className="rounded border border-dashed border-gray-200 p-3 text-[11px] text-gray-500 dark:border-white/10 dark:text-gray-400">
            No custom sort rules yet.
          </div>
        )}

        {rules.map(rule => {
          const scope = normalizeAnalysisRuleScope(rule.scope);
          const suggestedName = rule.autoName || buildAnalysisSortRuleAutoName(rule, ruleLayerLabels);
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
                  title="Enable this sort rule"
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
                  title="Remove sort rule"
                >
                  Remove
                </AnalysisButton>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-1.5 rounded bg-white px-1.5 py-1 ring-1 ring-gray-200 dark:bg-black/10 dark:ring-white/10">
                <span className="text-[11px] font-medium text-gray-400">Sort</span>
                {term.source === 'molecule_metric' ? (
                  <MoleculeMetricUnit metric={term.moleculeMetric} />
                ) : term.source === 'feature_hub' ? (
                  <span className="text-[11px] text-gray-500" title="Number of the hits where the read is in the chosen state">hits in state</span>
                ) : (
                  <select
                    value={rule.metric}
                    onChange={event => updateRule(rule, { metric: event.target.value as AnalysisSortMetric })}
                    className="input-tool text-xs"
                  >
                    {METRIC_OPTIONS.map(option => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                )}
                <select
                  value={rule.descending ? 'desc' : 'asc'}
                  onChange={event => updateRule(rule, { descending: event.target.value !== 'asc' })}
                  className="input-tool text-xs"
                >
                  <option value="desc">High to low</option>
                  <option value="asc">Low to high</option>
                </select>
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
	                    <span className="text-[11px] text-gray-500">per molecule; reads without a value sort last</span>
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
