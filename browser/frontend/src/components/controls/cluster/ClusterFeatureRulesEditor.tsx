import { useMemo, useRef, useState, type ChangeEvent } from 'react';
import { RuleEditorHeader, RulePresetsMenu } from '../analysis-rules/RuleEditorHeader';
import type { AnalysisRuleScope, AnalysisRuleScopeKind, ClusterFeatureRule, ClusterFeatureRuleSet, ClusterFeatureRuleTerm, ColorRule, FootprintGroup, Gene, QualityGate } from '../../../types';
import {
  DEFAULT_ANALYSIS_RULE_SCOPE,
  buildClusterFeatureRuleAutoName,
  normalizeAnalysisRuleScope,
  summarizeAnalysisRuleScope,
} from '../../../utils/analysisRules';
import { AnalysisButton } from '../shared';
import { QualityGateEditor } from '../labeling/QualityGateEditor';

interface LayerOption {
  value: string;
  label: string;
}

interface Props {
  rules: ClusterFeatureRule[];
  savedRuleSets: ClusterFeatureRuleSet[];
  activeLabelRules: ColorRule[];
  footprintGroups: FootprintGroup[];
  selectedGenes?: Gene[];
  layerOptions: LayerOption[];
  title?: string;
  description?: string;
  className?: string;
  listClassName?: string;
  onAddRule: (rule: ClusterFeatureRule) => void;
  onUpdateRule: (id: string, updates: Partial<ClusterFeatureRule>) => void;
  onRemoveRule: (id: string) => void;
  onSetRules: (rules: ClusterFeatureRule[]) => void;
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

function defaultLayerTerm(layerOptions: LayerOption[]): ClusterFeatureRuleTerm {
  return {
    id: uid('term'),
    source: 'layer',
    layer: layerOptions[0]?.value ?? null,
    sizeMin: 0,
    sizeMax: null,
    qualityGates: [],
  };
}

function defaultRule(layerOptions: LayerOption[]): ClusterFeatureRule {
  const terms = [defaultLayerTerm(layerOptions)];
  const layerLabels = layerLabelMap(layerOptions);
  const base = {
    id: uid('cluster_rule'),
    name: '',
    autoName: '',
    nameEdited: false,
    enabled: true,
    scope: { ...DEFAULT_ANALYSIS_RULE_SCOPE },
    terms,
  };
  const autoName = buildClusterFeatureRuleAutoName(base, layerLabels);
  return { ...base, name: autoName, autoName };
}

function updateTerm(
  rule: ClusterFeatureRule,
  termId: string,
  updates: Partial<ClusterFeatureRuleTerm>,
): ClusterFeatureRule {
  return {
    ...rule,
    terms: rule.terms.map(term => term.id === termId ? { ...term, ...updates } : term),
  };
}

function sizeMaxText(sizeMax: number | null | undefined): string {
  return sizeMax == null ? '' : String(sizeMax);
}

function parseSizeMax(value: string): number | null {
  if (value.trim() === '') return null;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function layerLabelMap(layerOptions: LayerOption[]): Record<string, string> {
  return Object.fromEntries(layerOptions.map(option => [option.value, option.label]));
}

function labelRuleSummary(rule: ColorRule | undefined): string {
  if (!rule) return 'No label rule selected';
  const layers = (rule.targetLayers ?? []).length > 0 ? rule.targetLayers.join(', ') : 'all layers';
  const max = rule.sizeMax == null ? 'any' : `${rule.sizeMax}`;
  return `${rule.sizeMin}-${max} bp, ${layers}`;
}

function groupSummary(group: FootprintGroup | undefined): string {
  if (!group) return 'No cart class selected';
  if (group.consensusStateId) return 'Exact primary assignment · saved analysis · dataset-specific';
  const max = group.sizeMax == null ? 'any' : `${group.sizeMax}`;
  return `${group.sizeMin}-${max} bp, ${group.layer ?? 'primary'}`;
}

export function ClusterFeatureRulesEditor({
  rules,
  savedRuleSets,
  activeLabelRules,
  footprintGroups,
  selectedGenes = [],
  layerOptions,
  title = 'Cluster rules',
  description = 'Each rule is a way to group reads; choose it in the toolbar\'s Cluster group.',
  className = '',
  listClassName = 'max-h-[360px] space-y-2 overflow-y-auto pr-1',
  onAddRule,
  onUpdateRule,
  onRemoveRule,
  onSetRules,
  onSaveRuleSet,
  onLoadRuleSet,
  onDeleteRuleSet,
  onSetDefaultRuleSet,
}: Props) {
  const [presetName, setPresetName] = useState('Cluster feature rules');
  const [message, setMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const ruleLayerLabels = useMemo(() => layerLabelMap(layerOptions), [layerOptions]);

  const prepareRuleUpdate = (
    rule: ClusterFeatureRule,
    updates: Partial<ClusterFeatureRule>,
  ): Partial<ClusterFeatureRule> => {
    const next = { ...rule, ...updates };
    const autoName = buildClusterFeatureRuleAutoName(next, ruleLayerLabels);
    return {
      ...updates,
      autoName,
      ...(next.nameEdited === false ? { name: autoName } : {}),
    };
  };

  const updateRule = (rule: ClusterFeatureRule, updates: Partial<ClusterFeatureRule>) => {
    onUpdateRule(rule.id, prepareRuleUpdate(rule, updates));
  };

  const updateRuleTerm = (
    rule: ClusterFeatureRule,
    termId: string,
    updates: Partial<ClusterFeatureRuleTerm>,
  ) => {
    updateRule(rule, { terms: updateTerm(rule, termId, updates).terms });
  };

  const updateRuleScope = (
    rule: ClusterFeatureRule,
    updates: Partial<AnalysisRuleScope>,
  ) => {
    const current = normalizeAnalysisRuleScope(rule.scope);
    const next = normalizeAnalysisRuleScope({ ...current, ...updates });
    if (updates.kind === 'gene') {
      const gene = selectedGenes.find(candidate => candidate.id === next.geneId) ?? selectedGenes[0];
      next.geneId = gene?.id ?? null;
      next.geneName = gene?.name ?? null;
    }
    updateRule(rule, { scope: next });
  };

  const showMessage = (text: string) => {
    setMessage(text);
    window.setTimeout(() => setMessage(null), 2200);
  };

  const applyLabelRule = (rule: ClusterFeatureRule, term: ClusterFeatureRuleTerm, labelRuleId: string) => {
    const labelRule = activeLabelRules.find(candidate => candidate.id === labelRuleId);
    if (!labelRule) return;
    updateRuleTerm(rule, term.id, {
      source: 'label_rule',
      labelRuleId,
      labelRuleName: labelRule.name,
      rule: snapshotLabelRule(labelRule),
    });
  };

  const applyFootprintGroup = (rule: ClusterFeatureRule, term: ClusterFeatureRuleTerm, groupId: string) => {
    const group = footprintGroups.find(candidate => candidate.id === groupId);
    if (!group) return;
    updateRuleTerm(rule, term.id, {
      source: group.consensusStateId ? 'footprint_class' : 'footprint_group',
      footprintGroupId: groupId,
      footprintGroupName: group.name,
      group: snapshotFootprintGroup(group),
    });
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify({ name: presetName || 'Cluster feature rules', rules }, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'cluster_feature_rules.json';
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
      onSetRules(importedRules as ClusterFeatureRule[]);
      showMessage('Imported cluster feature rules.');
    } catch (err) {
      console.error('Cluster feature rule import failed:', err);
      showMessage('Import failed.');
    } finally {
      event.target.value = '';
    }
  };

  return (
    <div className={`text-xs ${className}`}>
      <RuleEditorHeader
        title={title}
        description={description}
        onAdd={() => onAddRule(defaultRule(layerOptions))}
        addAnchor="analysis-rules-add-cluster-rule"
        presets={(
          <RulePresetsMenu
            noun="cluster rules"
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
            No custom cluster feature rules yet.
          </div>
        )}

        {rules.map(rule => {
          const scope = normalizeAnalysisRuleScope(rule.scope);
          const suggestedName = rule.autoName || buildClusterFeatureRuleAutoName(rule, ruleLayerLabels);
          return (
          <div key={rule.id} className="rounded border border-gray-200 bg-gray-50 p-2 dark:border-white/10 dark:bg-white/[0.03]">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={rule.enabled}
                onChange={event => onUpdateRule(rule.id, { enabled: event.target.checked })}
                className="rounded border-gray-300 dark:border-white/20"
                title="Enable this cluster feature rule"
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
                className="input-tool w-48 text-xs"
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
              <span className="text-[11px] text-gray-500">{rule.terms.length} term{rule.terms.length === 1 ? '' : 's'}</span>
              <AnalysisButton
                className="ml-auto"
                variant="outline"
                onClick={() => updateRule(rule, { terms: [...rule.terms, defaultLayerTerm(layerOptions)] })}
              >
                Add term
              </AnalysisButton>
              <AnalysisButton
                variant="dangerOutline"
                onClick={() => onRemoveRule(rule.id)}
                title="Remove cluster feature rule"
              >
                Remove
              </AnalysisButton>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-1.5 rounded bg-white px-1.5 py-1 ring-1 ring-gray-200 dark:bg-black/10 dark:ring-white/10">
              <span className="text-[11px] font-medium text-gray-400">Scope</span>
              <select
                value={scope.kind}
                onChange={event => updateRuleScope(rule, { kind: event.target.value as AnalysisRuleScopeKind })}
                className="input-tool text-xs"
                title="Where this rule contributes features"
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
                    title="Minimum peak level"
                  >
                    <option value="">Any</option>
                    {[0, 1, 2, 3].map(level => <option key={level} value={level}>L{level}</option>)}
                  </select>
                  <span className="text-gray-400">to</span>
                  <select
                    value={scope.peakLevelMax == null ? '' : String(scope.peakLevelMax)}
                    onChange={event => updateRuleScope(rule, { peakLevelMax: event.target.value === '' ? null : Number(event.target.value) })}
                    className="input-tool text-xs"
                    title="Maximum peak level"
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
                    title="Selected gene source from the transcription panel"
                  >
                    {selectedGenes.length === 0 && <option value="">No selected genes</option>}
                    {selectedGenes.map(gene => (
                      <option key={gene.id} value={gene.id}>{gene.name || gene.id}</option>
                    ))}
                  </select>
                  <select
                    value={scope.genePart ?? 'full'}
                    onChange={event => updateRuleScope(rule, { genePart: event.target.value as AnalysisRuleScope['genePart'] })}
                    className="input-tool text-xs"
                  >
                    {GENE_PART_OPTIONS.map(option => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </>
              )}
              <span className="ml-auto text-[11px] text-gray-500 dark:text-gray-400">
                {summarizeAnalysisRuleScope(scope)}
              </span>
            </div>

            <div className="mt-2 space-y-1.5">
              {rule.terms.map(term => {
                const selectedLabelRule = activeLabelRules.find(candidate => candidate.id === term.labelRuleId) ?? term.rule;
                const selectedGroup = footprintGroups.find(candidate => candidate.id === term.footprintGroupId) ?? term.group;
                return (
                  <div key={term.id} className="rounded bg-white p-1.5 ring-1 ring-gray-200 dark:bg-black/10 dark:ring-white/10">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <select
                        value={term.source}
                        onChange={event => {
                          const source = event.target.value as ClusterFeatureRuleTerm['source'];
                          if (source === 'label_rule' && activeLabelRules[0]) {
                            applyLabelRule(rule, term, activeLabelRules[0].id);
                          } else if (source === 'footprint_group' && footprintGroups[0]) {
                            applyFootprintGroup(rule, term, footprintGroups[0].id);
                          } else if (source === 'footprint_class' && footprintGroups.some(g=>g.consensusStateId)) {
                            applyFootprintGroup(rule, term, footprintGroups.find(g=>g.consensusStateId)!.id);
                          } else {
                            updateRuleTerm(rule, term.id, {
                              source: 'layer',
                              layer: layerOptions[0]?.value ?? null,
                            });
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
                        <option value="footprint_class" disabled={!footprintGroups.some(g=>g.consensusStateId)}>
                          Footprint class{!footprintGroups.some(g=>g.consensusStateId) ? ' (add classes to Cart)' : ''}
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
                            title="Minimum footprint size"
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

                      {(term.source === 'footprint_group' || term.source === 'footprint_class') && (
                        <>
                          <select
                            value={term.footprintGroupId ?? ''}
                            onChange={event => applyFootprintGroup(rule, term, event.target.value)}
                            className="input-tool max-w-[220px] text-xs"
                          >
                            {footprintGroups.length === 0 && <option value="">No cart classes</option>}
                            {selectedGroup && !footprintGroups.some(g=>g.id===term.footprintGroupId) &&
                              <option value={term.footprintGroupId}>{selectedGroup.name} (saved reference)</option>}
                            {footprintGroups.filter(group=>term.source !== 'footprint_class' || group.consensusStateId).map(group => (
                              <option key={group.id} value={group.id}>{group.name}{group.consensusStateId && group.sourceDatasetId ? ` · ${group.sourceDatasetId}` : ''}</option>
                            ))}
                          </select>
                          <span className="text-[11px] text-gray-500">{groupSummary(selectedGroup)}</span>
                        </>
                      )}

                      <AnalysisButton
                        variant="dangerOutline"
                        className="ml-auto px-1 py-0"
                        onClick={() => updateRule(rule, { terms: rule.terms.filter(candidate => candidate.id !== term.id) })}
                      >
                        x
                      </AnalysisButton>
                    </div>

                    {term.source === 'layer' && (
                      <div className="mt-1 space-y-1 pl-1">
                        {(term.qualityGates ?? []).map((gate: QualityGate, gateIndex: number) => (
                          <QualityGateEditor
                            key={gateIndex}
                            gate={gate}
                            onChange={newGate => {
                              const next = [...(term.qualityGates ?? [])];
                              next[gateIndex] = newGate;
                              updateRuleTerm(rule, term.id, { qualityGates: next });
                            }}
                            onRemove={() => updateRuleTerm(rule, term.id, {
                              qualityGates: (term.qualityGates ?? []).filter((_, indexToKeep) => indexToKeep !== gateIndex),
                            })}
                          />
                        ))}
                        <AnalysisButton
                          variant="outline"
                          onClick={() => updateRuleTerm(rule, term.id, {
                            qualityGates: [...(term.qualityGates ?? []), { qualityName: term.layer === 'tf' ? 'tq' : 'aq', minValue: 230 }],
                          })}
                        >
                          Add quality gate
                        </AnalysisButton>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          );
        })}
      </div>

      <input ref={fileInputRef} type="file" accept=".json" onChange={importJson} className="hidden" />
    </div>
  );
}
