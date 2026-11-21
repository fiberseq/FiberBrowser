import { openLabelingPanel } from '../../utils/openLabeling';
import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../stores/browserStore';
import { getCanonicalLayerEntries } from '../../utils/layerColors';
import { AnalysisPanelHeader, AnalysisPanelShell } from './shared';
import { ClusterFeatureRulesEditor } from './cluster/ClusterFeatureRulesEditor';
import { AnalysisFilterRulesEditor } from './analysis-rules/AnalysisFilterRulesEditor';
import { AnalysisSortRulesEditor } from './analysis-rules/AnalysisSortRulesEditor';
import { PeakDetectionPanel } from './PeakDetectionPanel';
import { useRememberedState } from '../../hooks/useRememberedState';

const MOLECULE_SCALAR_GROUPS = new Set(['nucmol', 'nfrmol']);

const ANALYSIS_RULE_TABS = [
  { key: 'peaks' as const, label: 'Peaks' },
  { key: 'cluster' as const, label: 'Cluster' },
  { key: 'sort' as const, label: 'Sort' },
  { key: 'filter' as const, label: 'Filter' },
];

type AnalysisRuleTab = typeof ANALYSIS_RULE_TABS[number]['key'];

function normalizeAnalysisRuleTab(value: unknown): AnalysisRuleTab | null {
  return ANALYSIS_RULE_TABS.some(tab => tab.key === value) ? value as AnalysisRuleTab : null;
}

function countPhrase(count: number, kind: string): string {
  return `${count === 0 ? 'no' : count} ${kind} rule${count === 1 ? '' : 's'}`;
}

/** The Rules header with analysis details on, as a sentence:
 *  "The toolbar uses 2 peak rules, no cluster rules, no sort rules and 1 filter rule." */
export function describeRuleCounts(counts: { peak: number; cluster: number; sort: number; filter: number }): string {
  return `The toolbar uses ${countPhrase(counts.peak, 'peak')}, ${countPhrase(counts.cluster, 'cluster')}, ${countPhrase(counts.sort, 'sort')} and ${countPhrase(counts.filter, 'filter')}.`;
}

export function ClusterFeatureRulesPanel({ isFullView }: { isFullView?: boolean }) {
  const showDetails = useBrowserStore(s => s.showAnalysisDetails);
  const [activeTab, setActiveTab] = useRememberedState<AnalysisRuleTab>('cluster-features:tab', () => {
    if (typeof window === 'undefined') return 'cluster';
    return normalizeAnalysisRuleTab(window.sessionStorage.getItem('fiberbrowser_analysis_rules_tab')) ?? 'cluster';
  });
  const {
    clusterFeatureRules,
    savedClusterFeatureRuleSets,
    analysisSortRules,
    savedAnalysisSortRuleSets,
    analysisFilterRules,
    savedAnalysisFilterRuleSets,
    addClusterFeatureRule,
    updateClusterFeatureRule,
    removeClusterFeatureRule,
    setClusterFeatureRules,
    saveClusterFeatureRuleSet,
    loadClusterFeatureRuleSet,
    deleteClusterFeatureRuleSet,
    setDefaultClusterFeatureRuleSet,
    addAnalysisSortRule,
    updateAnalysisSortRule,
    removeAnalysisSortRule,
    setAnalysisSortRules,
    saveAnalysisSortRuleSet,
    loadAnalysisSortRuleSet,
    deleteAnalysisSortRuleSet,
    setDefaultAnalysisSortRuleSet,
    addAnalysisFilterRule,
    updateAnalysisFilterRule,
    removeAnalysisFilterRule,
    setAnalysisFilterRules,
    saveAnalysisFilterRuleSet,
    loadAnalysisFilterRuleSet,
    deleteAnalysisFilterRuleSet,
    setDefaultAnalysisFilterRuleSet,
    activeColormap,
    footprintGroups,
    selectedGenes,
    peakRules,
    datasets,
  } = useBrowserStore(useShallow(s => ({
    clusterFeatureRules: s.clusterFeatureRules,
    savedClusterFeatureRuleSets: s.savedClusterFeatureRuleSets,
    analysisSortRules: s.analysisSortRules,
    savedAnalysisSortRuleSets: s.savedAnalysisSortRuleSets,
    analysisFilterRules: s.analysisFilterRules,
    savedAnalysisFilterRuleSets: s.savedAnalysisFilterRuleSets,
    addClusterFeatureRule: s.addClusterFeatureRule,
    updateClusterFeatureRule: s.updateClusterFeatureRule,
    removeClusterFeatureRule: s.removeClusterFeatureRule,
    setClusterFeatureRules: s.setClusterFeatureRules,
    saveClusterFeatureRuleSet: s.saveClusterFeatureRuleSet,
    loadClusterFeatureRuleSet: s.loadClusterFeatureRuleSet,
    deleteClusterFeatureRuleSet: s.deleteClusterFeatureRuleSet,
    setDefaultClusterFeatureRuleSet: s.setDefaultClusterFeatureRuleSet,
    addAnalysisSortRule: s.addAnalysisSortRule,
    updateAnalysisSortRule: s.updateAnalysisSortRule,
    removeAnalysisSortRule: s.removeAnalysisSortRule,
    setAnalysisSortRules: s.setAnalysisSortRules,
    saveAnalysisSortRuleSet: s.saveAnalysisSortRuleSet,
    loadAnalysisSortRuleSet: s.loadAnalysisSortRuleSet,
    deleteAnalysisSortRuleSet: s.deleteAnalysisSortRuleSet,
    setDefaultAnalysisSortRuleSet: s.setDefaultAnalysisSortRuleSet,
    addAnalysisFilterRule: s.addAnalysisFilterRule,
    updateAnalysisFilterRule: s.updateAnalysisFilterRule,
    removeAnalysisFilterRule: s.removeAnalysisFilterRule,
    setAnalysisFilterRules: s.setAnalysisFilterRules,
    saveAnalysisFilterRuleSet: s.saveAnalysisFilterRuleSet,
    loadAnalysisFilterRuleSet: s.loadAnalysisFilterRuleSet,
    deleteAnalysisFilterRuleSet: s.deleteAnalysisFilterRuleSet,
    setDefaultAnalysisFilterRuleSet: s.setDefaultAnalysisFilterRuleSet,
    activeColormap: s.activeColormap,
    footprintGroups: s.footprintGroups,
    selectedGenes: s.selectedGenes,
    peakRules: s.peakRules,
    datasets: s.datasets,
  })));

  useEffect(() => {
    const handler = (event: Event) => {
      const requested = (event as CustomEvent<{ tab?: string }>).detail?.tab;
      // Labeling is its own panel now; older links still ask Rules for it.
      if (requested === 'labeling') { openLabelingPanel(); return; }
      const tab = normalizeAnalysisRuleTab(requested);
      if (tab) setActiveTab(tab);
    };
    window.addEventListener('fiberbrowser:open-analysis-rules-tab', handler);
    return () => window.removeEventListener('fiberbrowser:open-analysis-rules-tab', handler);
  }, []);

  const handleTabChange = (tab: AnalysisRuleTab) => {
    setActiveTab(tab);
    window.sessionStorage.setItem('fiberbrowser_analysis_rules_tab', tab);
  };

  const layerOptions = useMemo(() => {
    const out = [{ value: '', label: 'Primary FP' }];
    const seen = new Set(['']);
    for (const entry of getCanonicalLayerEntries(datasets)) {
      const value = entry.key === 'footprint' ? '' : entry.key;
      // Per-molecule scalar groups are molecule metric terms, not layers.
      if (seen.has(value) || MOLECULE_SCALAR_GROUPS.has(value)) continue;
      seen.add(value);
      out.push({ value, label: entry.label });
    }
    return out;
  }, [datasets]);

  const enabledRuleCount = clusterFeatureRules.filter(rule => rule.enabled).length;
  const enabledPeakRuleCount = peakRules.filter(rule => rule.enabled).length;
  const enabledSortRuleCount = analysisSortRules.filter(rule => rule.enabled).length;
  const enabledFilterRuleCount = analysisFilterRules.filter(rule => rule.enabled).length;

  return (
    <AnalysisPanelShell
      tabs={ANALYSIS_RULE_TABS}
      activeTab={activeTab}
      onTabChange={handleTabChange}
      theme="violet"
      isFullView={isFullView}
      layout="standard"
      className={isFullView ? 'flex h-full min-h-0 flex-col' : ''}
      bodyMode={isFullView ? 'fill' : 'none'}
      bodyClassName={isFullView ? 'min-h-0' : ''}
      header={
        <AnalysisPanelHeader
          detail={showDetails
            ? describeRuleCounts({ peak: enabledPeakRuleCount, cluster: enabledRuleCount, sort: enabledSortRuleCount, filter: enabledFilterRuleCount })
            : 'Named rules the toolbar uses: which peaks Scan finds, and what Cluster, Sort and Filter go by.'}
          theme="violet"
        />
      }
    >
      {activeTab === 'peaks' && (
        <PeakDetectionPanel embedded isFullView={isFullView} />
      )}
      {activeTab === 'cluster' && (
        <ClusterFeatureRulesEditor
          rules={clusterFeatureRules}
          savedRuleSets={savedClusterFeatureRuleSets}
          activeLabelRules={activeColormap.rules}
          footprintGroups={footprintGroups}
          selectedGenes={selectedGenes}
          layerOptions={layerOptions}
          className={isFullView ? 'flex h-full min-h-0 flex-col shadow-none' : 'shadow-none'}
          listClassName={isFullView ? 'min-h-0 flex-1 space-y-2 overflow-y-auto pr-1' : 'max-h-[420px] space-y-2 overflow-y-auto pr-1'}
          onAddRule={addClusterFeatureRule}
          onUpdateRule={updateClusterFeatureRule}
          onRemoveRule={removeClusterFeatureRule}
          onSetRules={setClusterFeatureRules}
          onSaveRuleSet={saveClusterFeatureRuleSet}
          onLoadRuleSet={loadClusterFeatureRuleSet}
          onDeleteRuleSet={deleteClusterFeatureRuleSet}
          onSetDefaultRuleSet={setDefaultClusterFeatureRuleSet}
        />
      )}
      {activeTab === 'sort' && (
        <AnalysisSortRulesEditor
          rules={analysisSortRules}
          savedRuleSets={savedAnalysisSortRuleSets}
          activeLabelRules={activeColormap.rules}
          footprintGroups={footprintGroups}
          selectedGenes={selectedGenes}
          layerOptions={layerOptions}
          className={isFullView ? 'flex h-full min-h-0 flex-col shadow-none' : 'shadow-none'}
          listClassName={isFullView ? 'min-h-0 flex-1 space-y-2 overflow-y-auto pr-1' : 'max-h-[420px] space-y-2 overflow-y-auto pr-1'}
          onAddRule={addAnalysisSortRule}
          onUpdateRule={updateAnalysisSortRule}
          onRemoveRule={removeAnalysisSortRule}
          onSetRules={setAnalysisSortRules}
          onSaveRuleSet={saveAnalysisSortRuleSet}
          onLoadRuleSet={loadAnalysisSortRuleSet}
          onDeleteRuleSet={deleteAnalysisSortRuleSet}
          onSetDefaultRuleSet={setDefaultAnalysisSortRuleSet}
        />
      )}
      {activeTab === 'filter' && (
        <AnalysisFilterRulesEditor
          rules={analysisFilterRules}
          savedRuleSets={savedAnalysisFilterRuleSets}
          activeLabelRules={activeColormap.rules}
          footprintGroups={footprintGroups}
          selectedGenes={selectedGenes}
          layerOptions={layerOptions}
          className={isFullView ? 'flex h-full min-h-0 flex-col shadow-none' : 'shadow-none'}
          listClassName={isFullView ? 'min-h-0 flex-1 space-y-2 overflow-y-auto pr-1' : 'max-h-[420px] space-y-2 overflow-y-auto pr-1'}
          onAddRule={addAnalysisFilterRule}
          onUpdateRule={updateAnalysisFilterRule}
          onRemoveRule={removeAnalysisFilterRule}
          onSetRules={setAnalysisFilterRules}
          onSaveRuleSet={saveAnalysisFilterRuleSet}
          onLoadRuleSet={loadAnalysisFilterRuleSet}
          onDeleteRuleSet={deleteAnalysisFilterRuleSet}
          onSetDefaultRuleSet={setDefaultAnalysisFilterRuleSet}
        />
      )}
    </AnalysisPanelShell>
  );
}
