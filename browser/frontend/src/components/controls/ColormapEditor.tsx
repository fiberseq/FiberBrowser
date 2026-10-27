import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../stores/browserStore';
import type { ColorRule, OverlapCondition, Colormap, QualityGate } from '../../types';
import { DEFAULT_COLORMAP } from '../../types';
import { getCanonicalLayerEntries, getLayerColor } from '../../utils/layerColors';
import { consumeRequestedTab, normalizeRequestedTab } from '../../utils/requestedTabs';
import { AnalysisButton, AnalysisCard, AnalysisPanelHeader, AnalysisPanelShell } from './shared';
import { Plus, Tag } from '../ui/Icons';
import type { AnalysisStatusKind } from './shared';
import { PresetsTab } from './labeling/PresetsTab';
import type { PresetMessage } from './labeling/PresetsTab';
import { QualityTab } from './labeling/QualityTab';
import type { QualityPreset } from './labeling/QualityTab';
import { RuleEditor } from './labeling/RuleEditor';
import type { OrthogonalTrackInfo } from './labeling/RuleEditor';
import { useRememberedState } from '../../hooks/useRememberedState';
import { NUC_SIZE_LAYER, NUC_UNDRAWN_LAYERS, nucSizeClassRules } from '../../utils/nucLayers';
import { ruleHasNucConditions } from '../../utils/ruleMatching';

// Generate a short unique ID
function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

function normalizeHexColorValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback;
}

/** Back-fill missing Colormap fields on an imported JSON so pre-v2.3.0
 *  files (no `qualityGates`, `tfOverlay`, or `qualityFilters`) still load
 *  without crashing downstream readers.
 */
function hydrateImportedColormap(imported: Partial<Colormap>): Colormap | null {
  if (!imported || !Array.isArray(imported.rules)) return null;
  const rules = imported.rules.map((r: Partial<ColorRule>) => ({
    id: (r.id as string) || uid(),
    name: r.name || 'Rule',
    color: r.color || '#888888',
    ...(r.colorMode ? { colorMode: r.colorMode } : {}),
    ...(r.gradient ? { gradient: r.gradient } : {}),
    opacity: Math.max(0, Math.min(1, Number.isFinite(Number(r.opacity)) ? Number(r.opacity) : 1)),
    sizeMin: r.sizeMin ?? 1,
    sizeMax: (r.sizeMax as number | null | undefined) === undefined ? null : (r.sizeMax as number | null),
    targetLayers: r.targetLayers ?? [],
    conditions: (r.conditions ?? []) as OverlapCondition[],
    // qualityGates is optional; preserve when present, default [] otherwise
    // so consumers that assume an array work.
    qualityGates: (r.qualityGates ?? []) as QualityGate[],
    requireAnnotationName: r.requireAnnotationName === true,
    // Nucleosome size conditions (kept only when set).
    ...(Array.isArray(r.nucCoarse) && r.nucCoarse.length ? { nucCoarse: r.nucCoarse.map(Number).filter(Number.isFinite) } : {}),
    ...(Array.isArray(r.nucNamed) && r.nucNamed.length ? { nucNamed: r.nucNamed.map(Number).filter(Number.isFinite) } : {}),
    ...(r.zMin != null && Number.isFinite(Number(r.zMin)) ? { zMin: Number(r.zMin) } : {}),
    ...(r.zMax != null && Number.isFinite(Number(r.zMax)) ? { zMax: Number(r.zMax) } : {}),
    ...(typeof r.nucTf === 'boolean' ? { nucTf: r.nucTf } : {}),
    enabled: r.enabled !== false,
  })) as ColorRule[];
  const noReadBackgroundColor = /^#[0-9a-fA-F]{6}$/.test(imported.noReadBackgroundColor ?? '')
    ? imported.noReadBackgroundColor
    : (imported.backgroundColor ?? DEFAULT_COLORMAP.noReadBackgroundColor ?? DEFAULT_COLORMAP.backgroundColor ?? '#ffffff');
  return {
    name: imported.name || 'Imported',
    backgroundColor: noReadBackgroundColor,
    readBackgroundColor: imported.readBackgroundColor ?? DEFAULT_COLORMAP.readBackgroundColor,
    noReadBackgroundColor,
    rules,
    qualityShading: imported.qualityShading ?? DEFAULT_COLORMAP.qualityShading,
    tfOverlay: imported.tfOverlay ?? DEFAULT_COLORMAP.tfOverlay,
    layerOpacities: imported.layerOpacities ?? DEFAULT_COLORMAP.layerOpacities,
    layerBackgroundOpacities: imported.layerBackgroundOpacities ?? DEFAULT_COLORMAP.layerBackgroundOpacities,
    displaySmoothing: imported.displaySmoothing ?? DEFAULT_COLORMAP.displaySmoothing,
    qualityFilters: imported.qualityFilters ?? DEFAULT_COLORMAP.qualityFilters,
    edgeAmbiguity: imported.edgeAmbiguity ?? DEFAULT_COLORMAP.edgeAmbiguity,
  };
}

// Peak layer labels
const PEAK_LAYER_LABELS: Record<number, string> = {
  0: 'Strong',
  1: 'Medium',
  2: 'Weak',
  3: 'Rare',
};

const COLORMAP_TAB_STORAGE_KEY = 'fiberbrowser_colormap_tab';
const COLORMAP_TAB_KEYS = ['rules', 'quality', 'presets'] as const;
type ColormapEditorTab = typeof COLORMAP_TAB_KEYS[number];

// 'presets' stays a valid requested tab (old links); it opens Rules with the
// Presets section expanded.
const COLORMAP_TABS: Array<{ key: ColormapEditorTab; label: string }> = [
  { key: 'rules', label: 'Rules' },
  { key: 'quality', label: 'Quality' },
];

function normalizeColormapTab(tab: string | null | undefined, fallback: ColormapEditorTab = 'rules'): ColormapEditorTab {
  return normalizeRequestedTab(tab, COLORMAP_TAB_KEYS, fallback);
}

function consumeRequestedColormapTab(): ColormapEditorTab {
  return consumeRequestedTab(COLORMAP_TAB_STORAGE_KEY, COLORMAP_TAB_KEYS, 'rules');
}

// Baseline call scores (tq, nq) score most calls high, so they are not
// offered as one-click thresholds; they remain in the Quality tab's filter list.
const QUALITY_PRESETS: QualityPreset[] = [
  {
    id: 'fire-aq-230',
    label: 'Accessibility (FIRE) aq >= 230',
    description: 'Published high-confidence FIRE precision cutoff, about 0.9 probability.',
    layer: 'fire',
    qualityName: 'aq',
    minValue: 230,
    requiresLayer: 'fire',
  },
  {
    id: 'tf-sr-q0-128',
    label: 'TF class support (q0) >= 128',
    description: 'Review-tier population configuration support. Unnamed shadow calls remain baseline context.',
    layer: 'tf_sr',
    qualityName: 'q0',
    minValue: 128,
    requiresLayer: 'tf_sr',
  },
  {
    id: 'nuc-sr-q0-128',
    label: 'Nuc class support (q0) >= 128',
    description: 'Review-tier population configuration support for nucleosome consensus actions.',
    layer: 'nuc_sr',
    qualityName: 'q0',
    minValue: 128,
    requiresLayer: 'nuc_sr',
  },
];

/**
 * Inline version of the colormap editor — renders without modal wrapper.
 * Used inside analysis panel slots in TrackContainer.
 */
export function ColormapEditorInline() {
  const {
    activeColormap, setActiveColormap,
    updateColormapRule, addColormapRule, removeColormapRule, reorderColormapRules,
    setReadBackgroundColor, setNoReadBackgroundColor, setDisplaySmoothing, setQualityShading,
    setEdgeAmbiguity,
    setTfOverlay, setLayerOpacity, setLayerBackgroundOpacity,
    addQualityFilter, updateQualityFilter, removeQualityFilter,
    savedColormaps, saveColormap, loadColormap, deleteColormap,
    setDefaultColormap,
    orthogonalTracks, enabledModTypes, datasets, genes, toggleModType,
  } = useBrowserStore(useShallow(s => ({
    activeColormap: s.activeColormap, setActiveColormap: s.setActiveColormap,
    updateColormapRule: s.updateColormapRule, addColormapRule: s.addColormapRule, removeColormapRule: s.removeColormapRule, reorderColormapRules: s.reorderColormapRules,
    setReadBackgroundColor: s.setReadBackgroundColor, setNoReadBackgroundColor: s.setNoReadBackgroundColor, setDisplaySmoothing: s.setDisplaySmoothing, setQualityShading: s.setQualityShading,
    setEdgeAmbiguity: s.setEdgeAmbiguity,
    setTfOverlay: s.setTfOverlay, setLayerOpacity: s.setLayerOpacity, setLayerBackgroundOpacity: s.setLayerBackgroundOpacity,
    addQualityFilter: s.addQualityFilter, updateQualityFilter: s.updateQualityFilter, removeQualityFilter: s.removeQualityFilter,
    savedColormaps: s.savedColormaps, saveColormap: s.saveColormap, loadColormap: s.loadColormap, deleteColormap: s.deleteColormap,
    setDefaultColormap: s.setDefaultColormap,
    orthogonalTracks: s.orthogonalTracks, enabledModTypes: s.enabledModTypes, datasets: s.datasets, genes: s.genes,
    toggleModType: s.toggleModType,
  })));

  const trackInfos: OrthogonalTrackInfo[] = orthogonalTracks.map(t => ({
    index: t.index,
    label: t.label,
    renderMode: t.renderMode,
    category: t.category,
  }));

  const [saveName, setSaveName] = useState(activeColormap.name);
  const [showLoadMenu, setShowLoadMenu] = useState(false);
  const [activeTab, setActiveTab] = useRememberedState<ColormapEditorTab>('colormap:tab', consumeRequestedColormapTab, COLORMAP_TAB_STORAGE_KEY);
  const [selectedGeneRuleId, setSelectedGeneRuleId] = useState('');
  const [presetMessage, setPresetMessage] = useState<PresetMessage | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragIndexRef = useRef<number | null>(null);
  const showPresetMessage = useCallback((kind: AnalysisStatusKind, text: string) => {
    setPresetMessage({ kind, text });
  }, []);

  useEffect(() => {
    const handleOpenTab = (event: Event) => {
      const tab = (event as CustomEvent<{ tab?: string }>).detail?.tab;
      setActiveTab(normalizeColormapTab(tab, activeTab));
    };
    window.addEventListener('fiberbrowser:open-colormap-tab', handleOpenTab);
    return () => window.removeEventListener('fiberbrowser:open-colormap-tab', handleOpenTab);
  }, [activeTab]);

  const qs = activeColormap.qualityShading;
  const tfo = activeColormap.tfOverlay;
  const edgeAmb = activeColormap.edgeAmbiguity ?? DEFAULT_COLORMAP.edgeAmbiguity;
  const layerOpacities = activeColormap.layerOpacities ?? DEFAULT_COLORMAP.layerOpacities;
  const layerBackgroundOpacities = activeColormap.layerBackgroundOpacities ?? DEFAULT_COLORMAP.layerBackgroundOpacities;
  const qualityFilters = activeColormap.qualityFilters;
  // v3 feature detection — show controls when corresponding layer present
  const hasTfLayer = 'tf' in enabledModTypes;
  // Canonical layer set — same dedup + naming as ViewSection / LayerSelector.
  // Drives both the quality-filter layer dropdown and the per-rule
  // targetLayers chip selector so they show "Nuc / TF / FIRE / ..."
  // instead of duplicated "footprint + nuc" or internal "msp" entries.
  // Nucleosome marks, array segments and scalar groups are never painted as
  // layers: no rule targets them and they have no opacity of their own.
  const layerEntries = useMemo(
    () => getCanonicalLayerEntries(datasets).filter(entry => !NUC_UNDRAWN_LAYERS.has(entry.key)),
    [datasets],
  );
  const allLayerNames = useMemo(() => layerEntries.map(e => e.key), [layerEntries]);
  const hasFireLayer = allLayerNames.includes('fire');
  const layerLabelByKey = useMemo(
    () => Object.fromEntries(layerEntries.map(e => [e.key, e.label])),
    [layerEntries]
  );
  const normalizedReadBackgroundColor = normalizeHexColorValue(
    activeColormap.readBackgroundColor,
    DEFAULT_COLORMAP.readBackgroundColor ?? '#f1f5f9'
  );
  const normalizedNoReadBackgroundColor = normalizeHexColorValue(
    activeColormap.noReadBackgroundColor ?? activeColormap.backgroundColor,
    DEFAULT_COLORMAP.noReadBackgroundColor ?? DEFAULT_COLORMAP.backgroundColor ?? '#ffffff'
  );
  const [readBackgroundDraft, setReadBackgroundDraft] = useState(normalizedReadBackgroundColor);
  const [noReadBackgroundDraft, setNoReadBackgroundDraft] = useState(normalizedNoReadBackgroundColor);
  useEffect(() => {
    setReadBackgroundDraft(normalizedReadBackgroundColor);
  }, [normalizedReadBackgroundColor]);
  useEffect(() => {
    setNoReadBackgroundDraft(normalizedNoReadBackgroundColor);
  }, [normalizedNoReadBackgroundColor]);
  const updateReadBackgroundDraft = (value: string) => {
    setReadBackgroundDraft(value);
    if (/^#[0-9a-fA-F]{6}$/.test(value)) setReadBackgroundColor(value);
  };
  const updateNoReadBackgroundDraft = (value: string) => {
    setNoReadBackgroundDraft(value);
    if (/^#[0-9a-fA-F]{6}$/.test(value)) setNoReadBackgroundColor(value);
  };
  const baselineLayerNames = useMemo(() => Array.from(new Set([
    ...['nuc', 'tf', 'fire'].filter(layer => allLayerNames.includes(layer)),
    ...allLayerNames.filter(layer => !['nuc', 'tf', 'fire'].includes(layer)),
  ])), [allLayerNames]);
  const layerBackgroundOpacityFor = (layer: string) => {
    const value = layerBackgroundOpacities[layer] ?? 1;
    return Math.max(0, Math.min(1, Number.isFinite(Number(value)) ? Number(value) : 1));
  };
  const layerSwatchColor = (layer: string) => (
    layerEntries.find(entry => entry.key === layer)?.color ?? getLayerColor(layer)
  );
  const qualityFilterLayerNames = useMemo(() => {
    const names = [...allLayerNames];
    for (const filter of qualityFilters) {
      if (filter.layer !== '*' && !names.includes(filter.layer)) names.push(filter.layer);
    }
    return names;
  }, [allLayerNames, qualityFilters]);
  const viewportGenes = useMemo(
    () => genes
      .filter(g => g.biotype === 'protein_coding' || g.biotype === 'mRNA' || !g.biotype)
      .slice()
      .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)),
    [genes]
  );
  const selectedGeneForRule = viewportGenes.find(g => g.id === selectedGeneRuleId) ?? viewportGenes[0];
  const enabledRuleCount = activeColormap.rules.filter(rule => rule.enabled).length;
  const enabledQualityFilterCount = qualityFilters.filter(filter => filter.enabled).length;
  const availableQualityPresets = useMemo(
    () => QUALITY_PRESETS.filter(preset => !preset.requiresLayer || allLayerNames.includes(preset.requiresLayer)),
    [allLayerNames]
  );
  const qualityFilterMatchesPreset = useCallback((preset: QualityPreset) => (
    qualityFilters.some(filter =>
      filter.layer === preset.layer &&
      filter.qualityName === preset.qualityName &&
      filter.minValue === preset.minValue &&
      filter.enabled
    )
  ), [qualityFilters]);
  const addQualityPreset = useCallback((preset: QualityPreset) => {
    addQualityFilter({
      layer: preset.layer,
      qualityName: preset.qualityName,
      minValue: preset.minValue,
      enabled: true,
    });
  }, [addQualityFilter]);

  const handleDragStart = useCallback((e: React.DragEvent, index: number) => {
    dragIndexRef.current = index;
    e.dataTransfer.effectAllowed = 'move';
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, targetIndex: number) => {
    e.preventDefault();
    const fromIndex = dragIndexRef.current;
    if (fromIndex !== null && fromIndex !== targetIndex) {
      reorderColormapRules(fromIndex, targetIndex);
    }
    dragIndexRef.current = null;
  }, [reorderColormapRules]);

  const [newRuleId, setNewRuleId] = useState<string | null>(null);
  const handleAddRule = useCallback(() => {
    const id = uid();
    setNewRuleId(id);
    addColormapRule({
      id,
      name: 'New Rule',
      color: '#888888',
      opacity: 1,
      sizeMin: 1,
      sizeMax: null,
      targetLayers: [],
      conditions: [],
      enabled: true,
    });
  }, [addColormapRule]);

  const handleAddPol2GeneExclusionRule = useCallback(() => {
    if (!selectedGeneForRule) return;
    const id = uid();
    setNewRuleId(id);
    addColormapRule({
      id,
      name: `Pol II not ${selectedGeneForRule.name || selectedGeneForRule.id}`,
      color: '#ff69b4',
      opacity: 1,
      sizeMin: 35,
      sizeMax: 65,
      targetLayers: [],
      conditions: [{
        target: 'gene',
        geneId: selectedGeneForRule.id,
        geneName: selectedGeneForRule.name,
        negate: true,
      }],
      enabled: true,
    });
  }, [addColormapRule, selectedGeneForRule]);

  // Nucleosome size classes read the scan's size marks: the Size classes layer must be on for them to show.
  const hasNucSizeMarks = datasets.some(d => !!d.available_layers?.[NUC_SIZE_LAYER]);
  const nucRulesEnabled = activeColormap.rules.some(rule => rule.enabled && ruleHasNucConditions(rule));
  const nucSizeLayerOn = !!(enabledModTypes as Record<string, boolean>)[NUC_SIZE_LAYER];
  const handleAddNucSizeClasses = useCallback(() => {
    // At the top: the default Nucleosome rule (90 bp and up) would win over rules below it.
    const template = nucSizeClassRules();
    const ids = new Set(template.map(rule => rule.id));
    setActiveColormap({
      ...activeColormap,
      rules: [...template, ...activeColormap.rules.filter(rule => !ids.has(rule.id))],
    });
    if (hasNucSizeMarks && !nucSizeLayerOn) toggleModType(NUC_SIZE_LAYER as never, true);
  }, [activeColormap, setActiveColormap, hasNucSizeMarks, nucSizeLayerOn, toggleModType]);

  const handleExportJSON = useCallback(() => {
    const json = JSON.stringify(activeColormap, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeColormap.name.replace(/\s+/g, '_')}_labeling_quality.json`;
    a.click();
    URL.revokeObjectURL(url);
    showPresetMessage('success', `Exported "${activeColormap.name}" as reproducible JSON.`);
  }, [activeColormap, showPresetMessage]);

  const handleImportJSON = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result as string) as Partial<Colormap>;
        const hydrated = hydrateImportedColormap(parsed);
        if (!hydrated) {
          showPresetMessage('error', 'Invalid Labeling & Quality JSON: missing `rules` array.');
          return;
        }
        setActiveColormap(hydrated);
        setSaveName(hydrated.name);
        showPresetMessage('success', `Imported "${hydrated.name}" with ${hydrated.rules.length} rule${hydrated.rules.length === 1 ? '' : 's'}.`);
      } catch (err) {
        console.error('Failed to import Labeling & Quality preset:', err);
        showPresetMessage('error', 'Invalid Labeling & Quality JSON file.');
      }
    };
    reader.onerror = () => {
      showPresetMessage('error', `Could not read ${file.name}.`);
    };
    reader.readAsText(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [setActiveColormap, showPresetMessage]);

  return (
    <div>
      <AnalysisPanelShell
        tabs={COLORMAP_TABS}
        activeTab={activeTab === 'presets' ? 'rules' : activeTab}
        onTabChange={setActiveTab}
        theme="slate"
        layout="standard"
        bodyMode="none"
        header={
          <AnalysisPanelHeader
            detail="Colours footprints by size, layer and position. Quality filters (Quality tab) also change which reads are analysed."
            theme="slate"
          />
        }
      >
        {(activeTab === 'rules' || activeTab === 'presets') && (
          <div className="space-y-3">
            <AnalysisCard
              title={<>Rules <span className="ml-1 text-[11px] font-normal text-ink-muted">top matching rule wins · drag to reorder</span></>}
              icon={<Tag size={15} />}
              actions={(
                <AnalysisButton
                  onClick={handleAddRule}
                  theme="slate"
                  variant="soft"
                  size="sm"
                  data-copilot-anchor="colormap-add-rule"
                  className="inline-flex items-center gap-1 whitespace-nowrap"
                >
                  <Plus size={12} aria-hidden="true" />
                  Add rule
                </AnalysisButton>
              )}
            >
              {viewportGenes.length > 0 && (
                <div className="flex items-center gap-2 flex-wrap rounded bg-white/70 dark:bg-black/10 border border-slate-200 dark:border-white/10 px-2 py-1.5 text-[11px]">
                  <span className="font-medium text-gray-600 dark:text-gray-300">Quick add:</span>
                  <span className="text-gray-500">Pol II footprints NOT in</span>
                  <select
                    value={selectedGeneForRule?.id ?? ''}
                    onChange={e => setSelectedGeneRuleId(e.target.value)}
                    className="input-tool text-[11px] max-w-[180px]"
                  >
                    {viewportGenes.map(g => (
                      <option key={g.id} value={g.id}>{g.name || g.id}</option>
                    ))}
                  </select>
                  <AnalysisButton
                    onClick={handleAddPol2GeneExclusionRule}
                    theme="slate"
                    variant="soft"
                  >
                    add rule
                  </AnalysisButton>
                </div>
              )}
              <div
                className="flex items-center gap-2 flex-wrap rounded bg-white/70 dark:bg-black/10 border border-slate-200 dark:border-white/10 px-2 py-1.5 text-[11px]"
                data-testid="nuc-size-classes-template"
              >
                <span className="font-medium text-gray-600 dark:text-gray-300">Template:</span>
                <AnalysisButton
                  onClick={handleAddNucSizeClasses}
                  theme="slate"
                  variant="soft"
                  title="Add one rule per coarse size class at the top (short amber, mono green, long teal, multi (2) blue, multi (3+) violet, can't tell grey, edge-truncated light grey), on nucleosome calls only. Needs a nucleosome scan."
                  data-testid="add-nuc-size-classes"
                >
                  Add nucleosome size classes
                </AnalysisButton>
                <span className="text-gray-500">colours nucleosome calls by a scan's coarse size class</span>
              </div>
              {nucRulesEnabled && !nucSizeLayerOn && (
                <div className="flex items-center gap-2 flex-wrap rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-200" data-testid="nuc-size-layer-off">
                  {hasNucSizeMarks ? (
                    <>
                      <span>Nucleosome size classes are off: rules with nucleosome conditions match nothing.</span>
                      <AnalysisButton onClick={() => toggleModType(NUC_SIZE_LAYER as never, true)} theme="amber" variant="soft">
                        Turn on
                      </AnalysisButton>
                    </>
                  ) : (
                    <span>No loaded dataset has nucleosome size marks: run a nucleosome scan for rules with nucleosome conditions to match.</span>
                  )}
                </div>
              )}
              <div>
                {activeColormap.rules.map((rule, i) => (
                  <RuleEditor
                    key={rule.id}
                    rule={rule}
                    index={i}
                    onUpdate={updates => updateColormapRule(rule.id, updates)}
                    onRemove={() => removeColormapRule(rule.id)}
                    onDragStart={handleDragStart}
                    onDragOver={handleDragOver}
                    onDrop={handleDrop}
                    orthogonalTracks={trackInfos}
                    genes={genes}
                    availableLayers={allLayerNames}
                    layerLabelByKey={layerLabelByKey}
                    defaultExpanded={rule.id === newRuleId}
                  />
                ))}
              </div>
            </AnalysisCard>

            <details className="rounded border border-slate-200 dark:border-white/10 bg-white dark:bg-dark-surface" data-testid="labeling-display-options">
              <summary className="cursor-pointer px-2 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-300">Display options</summary>
              <div className="space-y-2 px-2 pb-2">
            <div className="space-y-2">
              <div className="text-[11px] text-gray-500">
                Background colours, how strongly intervals no rule matches are drawn (0% hides them), and how footprint edges are drawn.
              </div>

              <div className="grid grid-cols-[repeat(auto-fit,minmax(15rem,1fr))] gap-2 text-xs">
                <div className="rounded border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5 p-2 space-y-1.5">
                  <div className="text-[11px] font-semibold text-gray-600 dark:text-gray-300">Background colors</div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="w-20 shrink-0 text-gray-600 dark:text-gray-300">Read extent</span>
                    <input
                      type="color"
                      value={normalizedReadBackgroundColor}
                      onChange={e => setReadBackgroundColor(e.target.value)}
                      className="w-7 h-6 rounded border-gray-300 dark:border-white/20 cursor-pointer"
                      title="Background drawn across each read's aligned extent"
                    />
                    <input
                      type="text"
                      value={readBackgroundDraft}
                      onChange={e => updateReadBackgroundDraft(e.target.value)}
                      onBlur={() => setReadBackgroundDraft(normalizedReadBackgroundColor)}
                      className="input-tool text-xs w-[76px] min-w-0 font-mono"
                      placeholder="#f1f5f9"
                    />
                    <AnalysisButton type="button" onClick={() => setReadBackgroundColor('#f1f5f9')} variant="outline">
                      Light
                    </AnalysisButton>
                    <AnalysisButton type="button" onClick={() => setReadBackgroundColor('#111827')} variant="outline">
                      Dark
                    </AnalysisButton>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="w-20 shrink-0 text-gray-600 dark:text-gray-300">Canvas</span>
                    <input
                      type="color"
                      value={normalizedNoReadBackgroundColor}
                      onChange={e => setNoReadBackgroundColor(e.target.value)}
                      className="w-7 h-6 rounded border-gray-300 dark:border-white/20 cursor-pointer"
                      title="Background drawn where no read occupies the row"
                    />
                    <input
                      type="text"
                      value={noReadBackgroundDraft}
                      onChange={e => updateNoReadBackgroundDraft(e.target.value)}
                      onBlur={() => setNoReadBackgroundDraft(normalizedNoReadBackgroundColor)}
                      className="input-tool text-xs w-[76px] min-w-0 font-mono"
                      placeholder="#ffffff"
                    />
                    <AnalysisButton type="button" onClick={() => setNoReadBackgroundColor('#ffffff')} variant="outline">
                      White
                    </AnalysisButton>
                    <AnalysisButton type="button" onClick={() => setNoReadBackgroundColor('#000000')} variant="outline">
                      Black
                    </AnalysisButton>
                  </div>
                </div>

                {baselineLayerNames.length > 0 && (
                  <div className="rounded border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5 p-2 space-y-1.5">
                    <div className="text-[11px] font-semibold text-gray-600 dark:text-gray-300">Unmatched layer opacity</div>
                    {/* One grid for every row, so the name column is as wide as the
                        longest layer name (it was a fixed 72 px that cut names off). */}
                    <div className="grid grid-cols-[0.75rem_minmax(0,max-content)_minmax(2.5rem,1fr)_2.25rem_auto] items-center gap-x-1.5 gap-y-1.5 text-xs" data-testid="unmatched-layer-opacity">
                      {baselineLayerNames.map(layer => {
                        const value = layerBackgroundOpacityFor(layer);
                        const hidden = value <= 0;
                        return (
                          <div key={layer} className="contents">
                            <span
                              className="h-3 w-3 rounded-sm border border-gray-300 dark:border-white/20"
                              style={{ background: layerSwatchColor(layer) }}
                              aria-hidden="true"
                            />
                            <span className="truncate text-gray-600 dark:text-gray-300" title={layerLabelByKey[layer] ?? layer} data-testid="unmatched-layer-name">{layerLabelByKey[layer] ?? layer}</span>
                            <input
                              type="range"
                              min={0}
                              max={1}
                              step={0.05}
                              value={value}
                              onChange={e => setLayerBackgroundOpacity(layer, parseFloat(e.target.value))}
                              className="w-full min-w-0"
                              title={`Default opacity for ${layerLabelByKey[layer] ?? layer} intervals that do not match a rule`}
                            />
                            <span className="text-right tabular-nums text-gray-500">{Math.round(value * 100)}%</span>
                            <AnalysisButton
                              type="button"
                              onClick={() => setLayerBackgroundOpacity(layer, hidden ? 1 : 0)}
                              theme={hidden ? 'amber' : 'slate'}
                              variant={hidden ? 'soft' : 'outline'}
                              className="px-1.5"
                              title={hidden ? 'Show unmatched intervals for this layer' : 'Hide unmatched intervals for this layer'}
                            >
                              {hidden ? 'Show' : 'Hide'}
                            </AnalysisButton>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              <div className="rounded border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5 p-2 space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                  <div className="text-[11px] font-semibold text-gray-600 dark:text-gray-300">Edge ambiguity</div>
                  <div className="flex items-center gap-3 text-[11px]">
                    <label className="flex items-center gap-1 text-gray-600 dark:text-gray-300">
                      <input
                        type="checkbox"
                        checked={edgeAmb.applyNuc}
                        onChange={e => setEdgeAmbiguity({ applyNuc: e.target.checked })}
                        className="rounded border-gray-300 dark:border-white/20"
                      />
                      Nuc
                    </label>
                    <label className="flex items-center gap-1 text-gray-600 dark:text-gray-300">
                      <input
                        type="checkbox"
                        checked={edgeAmb.applyTf}
                        onChange={e => setEdgeAmbiguity({ applyTf: e.target.checked })}
                        className="rounded border-gray-300 dark:border-white/20"
                      />
                      TF
                    </label>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  {(['soft', 'strict', 'loose'] as const).map(mode => (
                    <AnalysisButton
                      key={mode}
                      type="button"
                      onClick={() => setEdgeAmbiguity({ mode })}
                      theme={edgeAmb.mode === mode ? 'amber' : 'slate'}
                      variant={edgeAmb.mode === mode ? 'soft' : 'outline'}
                      className="flex-1 capitalize"
                      title={
                        mode === 'soft'
                          ? 'Fade each footprint edge in proportion to its el/er confidence'
                          : mode === 'strict'
                            ? 'Draw the conservative span with crisp edges (ignore el/er)'
                            : 'Extend each edge outward to its liberal boundary (up to maxGap bp)'
                      }
                    >
                      {mode}
                    </AnalysisButton>
                  ))}
                </div>
                <div className="text-[11px] text-gray-500">
                  Soft = fade fuzzy edges · Strict = crisp conservative span · Loose = extend to liberal boundary. Uses el/er (TF) and lq/rq (nuc) edge scores.
                </div>
              </div>
            </div>

              </div>
            </details>

            <details open={activeTab === 'presets' || undefined} className="rounded border border-slate-200 dark:border-white/10 bg-white dark:bg-dark-surface">
              <summary className="cursor-pointer px-2 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-300">Presets: save, load, import, export</summary>
              <div className="px-2 pb-2">
          <PresetsTab
            saveName={saveName}
            setSaveName={setSaveName}
            showLoadMenu={showLoadMenu}
            setShowLoadMenu={setShowLoadMenu}
            presetMessage={presetMessage}
            showPresetMessage={showPresetMessage}
            savedColormaps={savedColormaps}
            saveColormap={saveColormap}
            loadColormap={loadColormap}
            deleteColormap={deleteColormap}
            setDefaultColormap={setDefaultColormap}
            handleExportJSON={handleExportJSON}
            fileInputRef={fileInputRef}
            handleImportJSON={handleImportJSON}
            onResetDefault={() => {
              setActiveColormap(DEFAULT_COLORMAP);
              setSaveName(DEFAULT_COLORMAP.name);
              showPresetMessage('info', 'Reset to the built-in labeling/quality defaults.');
            }}
          />
              </div>
            </details>
          </div>
        )}

        {activeTab === 'quality' && (
          <QualityTab
            qualityShading={qs}
            tfOverlay={tfo}
            layerOpacities={layerOpacities}
            displaySmoothing={activeColormap.displaySmoothing ?? DEFAULT_COLORMAP.displaySmoothing}
            qualityFilters={qualityFilters}
            enabledQualityFilterCount={enabledQualityFilterCount}
            availableQualityPresets={availableQualityPresets}
            qualityFilterMatchesPreset={qualityFilterMatchesPreset}
            addQualityPreset={addQualityPreset}
            addQualityFilter={addQualityFilter}
            updateQualityFilter={updateQualityFilter}
            removeQualityFilter={removeQualityFilter}
            setQualityShading={setQualityShading}
            setTfOverlay={setTfOverlay}
            setDisplaySmoothing={setDisplaySmoothing}
            setLayerOpacity={setLayerOpacity}
            hasTfLayer={hasTfLayer}
            hasFireLayer={hasFireLayer}
            allLayerNames={allLayerNames}
            qualityFilterLayerNames={qualityFilterLayerNames}
            layerLabelByKey={layerLabelByKey}
          />
        )}

      </AnalysisPanelShell>
    </div>
  );
}
