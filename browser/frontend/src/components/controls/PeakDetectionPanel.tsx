import { SignalProfileChart } from '../charts/SignalProfileChart';
import { removeMatchedGroups } from '../../utils/matchedGroupActions';
import { Fragment, useState, useCallback, useRef, useMemo, useEffect } from 'react';
import { useBrowserStore } from '../../stores/browserStore';
import { useShallow } from 'zustand/react/shallow';
import type { PeakRule } from '../../types';
import { AnalysisButton, AnalysisPanelHeader, AnalysisPanelShell, AnalysisRunSummary, AnalysisStatus } from './shared';
import { PeakRuleCard } from './peak-detection/PeakRuleCard';
import { X } from '../ui/Icons';
import { PeakRulesHeader } from './peak-detection/PeakRulesHeader';
import { usePeakImportExport } from './peak-detection/usePeakImportExport';
import { usePeakSourceOptions } from './peak-detection/usePeakSourceOptions';

function generateRuleId(): string {
  return `rule-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

const PEAK_DETECTION_TABS = [
  { key: 'rules' as const, label: 'Rules' },
];

interface PeakDetectionPanelProps {
  isFullView?: boolean;
  embedded?: boolean;
}

export function PeakDetectionPanel({ isFullView, embedded = false }: PeakDetectionPanelProps) {
  const {
    peakRules, peaksByRule, peakSignalCache, peaksLocked,
    addPeakRule, updatePeakRule, removePeakRule, reorderPeakRules,
    setPeakRules, savedPeakPresets, savePeakPreset, loadPeakPreset, deletePeakPreset,
    chrom, start, end, selectedPeaks, getAllPeaks,
    analysisSampleSeed,
    activeColormap,
  } = useBrowserStore(useShallow(s => ({
    peakRules: s.peakRules,
    peaksByRule: s.peaksByRule,
    peakSignalCache: s.peakSignalCache,
    peaksLocked: s.peaksLocked,
    addPeakRule: s.addPeakRule,
    updatePeakRule: s.updatePeakRule,
    removePeakRule: s.removePeakRule,
    reorderPeakRules: s.reorderPeakRules,
    setPeakRules: s.setPeakRules,
    savedPeakPresets: s.savedPeakPresets,
    savePeakPreset: s.savePeakPreset,
    loadPeakPreset: s.loadPeakPreset,
    deletePeakPreset: s.deletePeakPreset,
    chrom: s.chrom,
    start: s.start,
    end: s.end,
    selectedPeaks: s.selectedPeaks,
    getAllPeaks: s.getAllPeaks,
    analysisSampleSeed: s.analysisSampleSeed,
    activeColormap: s.activeColormap,
  })));

  const sourceGroups = usePeakSourceOptions();

  const [expandedRuleId, setExpandedRuleId] = useState<string | null>(null);
  const [scanningRules, setScanningRules] = useState<Set<string>>(new Set());
  const {
    peakBedStatus,
    setPeakBedStatus,
    handleExportJSON,
    handleImportJSON,
    handleExportPeakBED,
    handleImportPeakBED,
    handleResetDefaults,
  } = usePeakImportExport({
    peakRules,
    setPeakRules,
    chrom,
    start,
    end,
    selectedPeaks,
    getAllPeaks,
  });

  const dragIdxRef = useRef<number | null>(null);

  // Per-rule scan handler — calls Browser.tsx scan via imperative event
  const handleRescanRule = useCallback((ruleId: string) => {
    if (useBrowserStore.getState().peaksLocked) return;
    setScanningRules(prev => new Set(prev).add(ruleId));
    // Clear existing peaks so auto-scan effect doesn't skip
    useBrowserStore.getState().setPeaksByRule(ruleId, []);
    useBrowserStore.getState().setPeakSignalCache(ruleId, []);
    // Dispatch a custom event that Browser.tsx listens for
    window.dispatchEvent(new CustomEvent('fiberhmm:rescan-rule', { detail: { ruleId } }));
    // Fallback timeout in case scan returns 0 peaks or fails
    setTimeout(() => {
      setScanningRules(prev => {
        if (!prev.has(ruleId)) return prev;
        const next = new Set(prev);
        next.delete(ruleId);
        return next;
      });
    }, 10000);
  }, []);

  // Clear scanning indicator when peaks arrive for that rule
  useEffect(() => {
    if (scanningRules.size === 0) return;
    for (const ruleId of scanningRules) {
      const peaks = peaksByRule[ruleId];
      if (peaks && peaks.length > 0) {
        setScanningRules(prev => {
          const next = new Set(prev);
          next.delete(ruleId);
          return next;
        });
      }
    }
  }, [peaksByRule, scanningRules]);

  const handleAddRule = useCallback(() => {
    const newRule: PeakRule = {
      id: generateRuleId(),
      name: 'New Rule',
      source: 'accessibility',
      enabled: true,
      color: '#6366f1',
      opacity: 0.6,
      useGradient: true,
      smoothWidth: 100,
      thresholds: [0.50, 0.30, 0.15, 0.08],
      minPeakWidth: 80,
      minReads: 5,
    };
    addPeakRule(newRule);
    setExpandedRuleId(newRule.id);
  }, [addPeakRule]);

  const totalPeaks = useMemo(() => {
    let count = 0;
    for (const rule of peakRules) {
      if (rule.enabled) count += (peaksByRule[rule.id] || []).length;
    }
    return count;
  }, [peakRules, peaksByRule]);
  const correspondenceScans = useBrowserStore(s => s.correspondenceScans);
  const enabledPeakRuleCount = peakRules.filter(r => r.enabled).length;
  const enabledQualityFilterCount = activeColormap.qualityFilters.filter(filter => filter.enabled).length;

  const content = (
    <>
      <PeakRulesHeader
        savedPeakPresets={savedPeakPresets}
        totalPeaks={totalPeaks}
        selectedPeakCount={selectedPeaks.size}
        theme={embedded ? 'violet' : 'indigo'}
        onAddRule={handleAddRule}
        onSavePreset={savePeakPreset}
        onLoadPreset={loadPeakPreset}
        onDeletePreset={deletePeakPreset}
        onImportPeakBed={handleImportPeakBED}
        onExportPeakBed={handleExportPeakBED}
        onImportJson={handleImportJSON}
        onExportJson={handleExportJSON}
        onResetDefaults={handleResetDefaults}
      />
      {peakRules.length === 0 ? (
        <AnalysisStatus kind="empty" compact center title="No peak rules">
          Add a rule or load a preset to scan peaks.
        </AnalysisStatus>
      ) : (
        <div className={isFullView ? 'min-h-0 flex-1 space-y-1 overflow-y-auto pr-1' : 'space-y-1'}>
          {[...peakRules.filter(r => r.source !== 'matched'), ...peakRules.filter(r => r.source === 'matched')].map(rule => {
            const idx = peakRules.indexOf(rule);
            return <Fragment key={rule.id}>
              {rule.id === peakRules.find(r => r.source === 'matched')?.id && <div data-testid="matched-section" className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-ink">
                <span>Matched regions</span>
                <AnalysisButton data-testid="matched-remove-all" onClick={() => removeMatchedGroups()}>Remove all matched regions</AnalysisButton>
              </div>}
              {Object.entries(correspondenceScans[rule.id] ?? {}).filter(([id]) => peakRules.some(r => r.id === id)).map(([id, scan]) => <div key={id} className="space-y-1 text-[11px] text-ink-secondary">
                <AnalysisStatus kind="info" compact>
                  <span data-testid="peaks-pooled-summary">{peakRules.find(r => r.id === id)?.name}: {scan.peaks.length} shared peaks from {scan.n_reads} pooled reads · {Object.values(scan.members).map(m => m.n_reads).join(' / ')} reads per member. Unaligned positions stay member-specific.</span>
                </AnalysisStatus>
                <details data-testid="peaks-pooled-profiles">
                  <summary className="cursor-pointer">Pooled and member profiles</summary>
                  {[{ label: 'Pooled', profiles: scan.profiles }, ...Object.values(scan.members).map(m => ({ label: m.label, profiles: m.profiles }))].map(m => <div key={m.label}>
                    <span>{m.label}</span>
                    {m.profiles?.map(p => <SignalProfileChart key={p.start} signal={p.signal} thresholds={rule.thresholds} color={rule.color} width={280} height={100}
                      viewStart={p.start} viewEnd={p.end} filename={`${rule.name}_${m.label}_${p.start}`} />)}
                  </div>)}
                </details>
              </div>)}
              <PeakRuleCard
                rule={rule}
                index={idx}
                isExpanded={expandedRuleId === rule.id}
                peakCount={(peaksByRule[rule.id] || []).length}
                signal={peakSignalCache[rule.id]}
                viewStart={start}
                viewEnd={end}
                scanning={scanningRules.has(rule.id)}
                peaksLocked={peaksLocked}
                sourceGroups={sourceGroups}
                onToggleExpand={() => setExpandedRuleId(expandedRuleId === rule.id ? null : rule.id)}
                onUpdate={(updates) => updatePeakRule(rule.id, updates)}
                onRemove={() => removePeakRule(rule.id)}
                onToggleEnabled={() => updatePeakRule(rule.id, { enabled: !rule.enabled })}
                onRescan={() => handleRescanRule(rule.id)}
                onDragStart={(e) => {
                  dragIdxRef.current = idx;
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (dragIdxRef.current !== null && dragIdxRef.current !== idx) {
                    reorderPeakRules(dragIdxRef.current, idx);
                    dragIdxRef.current = idx;
                  }
                }}
                onDragEnd={() => { dragIdxRef.current = null; }}
              />
            </Fragment>;
          })}
        </div>
      )}

      {peakBedStatus && (
        <div className="flex items-start justify-between gap-2 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300">
          <span>{peakBedStatus}</span>
          <AnalysisButton
            onClick={() => setPeakBedStatus(null)}
            theme="amber"
            variant="outline"
            className="px-1 py-0 leading-none"
            aria-label="Dismiss peak import/export status"
          >
            <X size={12} aria-hidden="true" />
          </AnalysisButton>
        </div>
      )}
    </>
  );

  if (embedded) {
    return (
      <div className={`space-y-2 ${isFullView ? 'flex h-full min-h-0 flex-col' : ''}`}>
        {content}
      </div>
    );
  }

  return (
    <AnalysisPanelShell
      tabs={PEAK_DETECTION_TABS}
      activeTab="rules"
      onTabChange={() => {}}
      theme="indigo"
      isFullView={isFullView}
      className={`flex flex-col gap-2 p-2 ${isFullView ? 'h-full min-h-0' : ''}`}
      bodyMode={isFullView ? 'fill' : 'none'}
      bodyClassName="space-y-2"
      header={
        <AnalysisPanelHeader
          title="Peak Rules"
          detail={`${totalPeaks} peaks from ${enabledPeakRuleCount} enabled rules`}
          theme="indigo"
        />
      }
      summary={
        <AnalysisRunSummary
          seed={analysisSampleSeed}
          qualityFilterCount={enabledQualityFilterCount}
          peaksLocked={peaksLocked}
          inputs={[
            `${(end - start).toLocaleString()}bp window`,
            `${enabledPeakRuleCount} enabled rule${enabledPeakRuleCount !== 1 ? 's' : ''}`,
            `${sourceGroups.length} source group${sourceGroups.length !== 1 ? 's' : ''}`,
          ]}
          outputs={totalPeaks > 0 ? [
            `${totalPeaks.toLocaleString()} peak${totalPeaks !== 1 ? 's' : ''}`,
            `${selectedPeaks.size.toLocaleString()} selected`,
          ] : []}
        />
      }
    >
      {content}
    </AnalysisPanelShell>
  );
}
