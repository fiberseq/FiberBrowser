import { removeMatchedGroups, matchedGroupLabel } from '../../../utils/matchedGroupActions';
import { seedHistoryBaseline } from '../../../stores/historySlice';
import { useCallback, useEffect, useRef } from 'react';
import { useBrowserStore } from '../../../stores/browserStore';
import type { PeakRule } from '../../../types';
import { SignalProfileChart } from '../../charts/SignalProfileChart';
import { AnalysisButton, AnalysisControlRow } from '../shared';
import type { PeakSourceOptionGroup } from './usePeakSourceOptions';
import { DisclosureChevron } from '../../ui/Disclosure';

interface PeakRuleCardProps {
  rule: PeakRule;
  index: number;
  isExpanded: boolean;
  peakCount: number;
  signal?: number[];
  viewStart: number;
  viewEnd: number;
  scanning: boolean;
  peaksLocked: boolean;
  sourceGroups: PeakSourceOptionGroup[];
  onToggleExpand: () => void;
  onUpdate: (updates: Partial<PeakRule>) => void;
  onRemove: () => void;
  onToggleEnabled: () => void;
  onRescan: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragEnd: () => void;
}

export function PeakRuleCard({
  rule,
  isExpanded,
  peakCount,
  signal,
  viewStart,
  viewEnd,
  scanning,
  peaksLocked,
  sourceGroups,
  onToggleExpand,
  onUpdate,
  onRemove,
  onToggleEnabled,
  onRescan,
  onDragStart,
  onDragOver,
  onDragEnd,
}: PeakRuleCardProps) {
  const peaks = useBrowserStore(s => s.peaksByRule[rule.id]);

  const rescanTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerRescan = useCallback(() => {
    if (peaksLocked) return;
    if (rescanTimerRef.current) clearTimeout(rescanTimerRef.current);
    rescanTimerRef.current = setTimeout(onRescan, 600);
  }, [onRescan, peaksLocked]);

  useEffect(() => () => {
    if (rescanTimerRef.current) clearTimeout(rescanTimerRef.current);
  }, []);

  const updateAndRescan = useCallback((updates: Partial<PeakRule>) => {
    onUpdate(updates);
    if (rule.source !== 'custom') triggerRescan();
  }, [onUpdate, triggerRescan, rule.source]);

  const setSignalCutoff = useCallback((index: number, value: number) => {
    const newThresholds = [...rule.thresholds] as [number, number, number, number];
    newThresholds[index] = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
    updateAndRescan({ thresholds: newThresholds });
  }, [rule.thresholds, updateAndRescan]);

  const editGroup = (label: string, edit: () => void) => {
    seedHistoryBaseline(useBrowserStore.getState(), `Before ${label.toLowerCase()}`, 'analysis');
    edit();
    useBrowserStore.getState().pushSnapshot(label);
  };

  if (rule.source === 'matched') return (
    <div className="border border-line rounded-fb p-2 space-y-1 text-[11px] text-ink" data-testid="matched-group-card">
      <div className="flex items-center gap-2">
        <input type="checkbox" aria-label="Show group" data-testid="matched-group-enabled" checked={rule.enabled} onChange={() => editGroup('Show group', onToggleEnabled)} />
        <input type="color" aria-label="Group colour" data-testid="matched-group-color" className="w-5 h-5" value={rule.color} onChange={e => editGroup('Group colour', () => onUpdate({ color: e.target.value }))} />
        <input aria-label="Group name" data-testid="matched-group-name" className="min-w-0 flex-1 bg-transparent" value={rule.name} onChange={e => editGroup('Rename group', () => onUpdate({ name: e.target.value }))} />
        <span>{matchedGroupLabel(rule).split(' · ')[0]} · {peakCount} regions</span>
      </div>
      {(peaks ?? []).map(p => <div key={p.index} className="flex items-center justify-between gap-2">
        <span className="truncate">{p.match?.label} · {p.chrom}:{p.start}–{p.end}{p.match?.reversed ? ' · reversed' : ''}</span>
        <AnalysisButton data-testid="matched-region-reverse" onClick={() => editGroup('Reverse region', () => useBrowserStore.getState().reverseMatchedRegion(p.index))}>Reverse region</AnalysisButton>
      </div>)}
      <AnalysisButton data-testid="matched-group-remove" onClick={() => removeMatchedGroups(rule.id)}>Remove group</AnalysisButton>
    </div>
  );

  return (
    <div
      className="border border-gray-200 dark:border-gray-700 rounded-md bg-white dark:bg-gray-800"
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
    >
      <div
        className="flex items-center gap-1.5 px-2 py-1 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/50"
        onClick={onToggleExpand}
        data-tour="peak-rule-card"
        aria-expanded={isExpanded}
      >
        <span className="cursor-grab text-gray-400 select-none text-xs" onClick={e => e.stopPropagation()}>≡</span>
        <input
          type="checkbox"
          checked={rule.enabled}
          onChange={(e) => { e.stopPropagation(); onToggleEnabled(); }}
          className="w-3 h-3"
        />
        <input
          type="color"
          value={rule.color}
          onChange={(e) => { e.stopPropagation(); onUpdate({ color: e.target.value }); }}
          onClick={(e) => e.stopPropagation()}
          className="w-4 h-4 p-0 border-0 cursor-pointer"
        />
        <span className="text-xs font-medium flex-1 truncate">{rule.name}</span>
        {scanning && <span className="text-[11px] text-blue-500 animate-pulse">scanning</span>}
        <span className="text-[11px] text-gray-400">{peakCount}</span>
        <span className="inline-flex text-gray-400"><DisclosureChevron open={isExpanded} /></span>
      </div>

      {isExpanded && (
        <div className="border-t border-gray-100 dark:border-gray-700" onDragStart={e => e.stopPropagation()} draggable={false}>
          {rule.source !== 'custom' && (
            <div className="px-2 pt-1.5 pb-1" data-tour="peak-rule-signal">
              {signal && signal.length > 0 ? (
                <SignalProfileChart
                  signal={signal}
                  thresholds={rule.thresholds}
                  peaks={peaks}
                  color={rule.color}
                  width={280}
                  height={100}
                  viewStart={viewStart}
                  viewEnd={viewEnd}
                  filename={`signal_${rule.name}`}
                />
              ) : (
                <div className="h-12 flex items-center justify-center text-[11px] text-gray-400 bg-gray-50 dark:bg-gray-800/50 rounded">
                  {scanning ? 'Scanning...' : (
                    <AnalysisButton
                      onClick={onRescan}
                      disabled={peaksLocked}
                      theme="blue"
                      variant="outline"
                      title={peaksLocked ? 'Unlock peaks before rescanning' : 'Scan to load signal'}
                    >
                      {peaksLocked ? 'Peaks locked' : 'Scan to load signal'}
                    </AnalysisButton>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="px-3 py-2 space-y-2 text-xs">
            <AnalysisControlRow label="Name" labelClassName="w-14 text-[11px]">
              <input
                type="text"
                value={rule.name}
                onChange={(e) => onUpdate({ name: e.target.value })}
                className="input-tool flex-1 text-xs py-0.5 min-h-0"
              />
            </AnalysisControlRow>

            <AnalysisControlRow label="Source" labelClassName="w-14 text-[11px]">
              <select
                value={rule.source}
                onChange={(e) => updateAndRescan({ source: e.target.value })}
                className="input-tool flex-1 text-xs py-0.5 min-h-0"
                data-tour="peak-rule-source"
              >
                {sourceGroups.map(group => (
                  <optgroup key={group.label} label={group.label}>
                    {group.options.map(option => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </AnalysisControlRow>

            <AnalysisControlRow label="Color" labelClassName="w-14 text-[11px]">
              <input
                type="color"
                value={rule.color}
                onChange={(e) => onUpdate({ color: e.target.value })}
                className="w-5 h-5 p-0 border-0 cursor-pointer"
              />
              <input
                type="text"
                value={rule.color}
                onChange={(e) => onUpdate({ color: e.target.value })}
                className="input-tool w-[4.5rem] text-xs font-mono py-0.5 min-h-0"
              />
              <span className="text-gray-500 text-[11px] ml-auto">Opacity</span>
              <input
                type="range" min={0} max={1} step={0.05}
                value={rule.opacity}
                onChange={(e) => onUpdate({ opacity: parseFloat(e.target.value) })}
                className="w-14"
              />
              <span className="w-6 text-right text-[11px]">{Math.round(rule.opacity * 100)}%</span>
            </AnalysisControlRow>

            <label className="flex items-center gap-1.5 pl-[3.75rem]">
              <input
                type="checkbox"
                checked={rule.useGradient}
                onChange={(e) => onUpdate({ useGradient: e.target.checked })}
                className="w-3 h-3"
              />
              <span className="text-[11px] text-gray-500">Shade by layer</span>
            </label>

            {rule.source !== 'custom' && (
              <div className="space-y-0.5" data-tour="peak-rule-cutoffs">
                <div className="flex items-center justify-between">
                  <div className="text-[11px] text-gray-500 font-medium">Signal cutoffs</div>
                  <AnalysisButton
                    onClick={() => {
                      if (!signal || signal.length === 0) return;
                      const positiveValues = Array.from(signal).filter(value => value > 0);
                      if (positiveValues.length === 0) return;
                      const sorted = positiveValues.slice().sort((a, b) => a - b);
                      const percentile = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
                      const round = (value: number) => Math.max(0, Math.min(1, Math.round(value * 100) / 100));
                      updateAndRescan({
                        thresholds: [
                          round(percentile(0.95)),
                          round(percentile(0.85)),
                          round(percentile(0.70)),
                          round(percentile(0.50)),
                        ],
                      });
                    }}
                    disabled={!signal || signal.length === 0}
                    theme="emerald"
                    variant="outline"
                    title="Fill fixed signal cutoffs from current viewport percentiles (Strong=top 5%, Medium=15%, Weak=30%, Rare=50%)"
                  >
                    Fill from percentile
                  </AnalysisButton>
                </div>
                <div className="text-[11px] text-gray-400">
                  Stored as fixed occupancy cutoffs (0-1). Percentile fill only calculates these once from the current viewport.
                </div>
                {['Strong', 'Medium', 'Weak', 'Rare'].map((label, i) => (
                  <div key={label} className="flex items-center gap-1">
                    <span className="w-14 text-[11px] text-gray-400">{label}</span>
                    <input
                      type="range" min={0} max={100} step={1}
                      value={Math.round(rule.thresholds[i] * 100)}
                      onChange={(e) => setSignalCutoff(i, parseInt(e.target.value, 10) / 100)}
                      className="flex-1"
                      title="Fixed signal cutoff, not a percentile after it is set"
                    />
                    <input
                      type="number"
                      min={0}
                      max={1}
                      step={0.01}
                      value={rule.thresholds[i].toFixed(2)}
                      onChange={(e) => setSignalCutoff(i, parseFloat(e.target.value))}
                      className="input-tool w-14 text-[11px] py-0.5 min-h-0 font-mono text-right"
                      title="Fixed occupancy cutoff from 0 to 1"
                    />
                  </div>
                ))}
              </div>
            )}

            {rule.source !== 'custom' && (
              <AnalysisControlRow label="Resolution" labelClassName="w-14 text-[11px]" contentClassName="flex-wrap">
                <span className="text-[11px] text-gray-500">Smooth</span>
                <input
                  type="number"
                  value={rule.smoothWidth}
                  onChange={(e) => updateAndRescan({ smoothWidth: parseInt(e.target.value) || 100 })}
                  className="input-tool w-14 text-xs py-0.5 min-h-0"
                />
                <span className="text-[11px] text-gray-400">bp</span>
                <span className="text-[11px] text-gray-500 ml-1">Min width</span>
                <input
                  type="number"
                  value={rule.minPeakWidth}
                  onChange={(e) => updateAndRescan({ minPeakWidth: parseInt(e.target.value) || 1 })}
                  className="input-tool w-14 text-xs py-0.5 min-h-0"
                />
                <span className="text-[11px] text-gray-400">bp</span>
              </AnalysisControlRow>
            )}

            <div className="flex items-center gap-2 pt-1">
              {rule.source !== 'custom' && (
                <AnalysisButton
                  onClick={onRescan}
                  disabled={scanning || peaksLocked}
                  theme="blue"
                  variant="soft"
                  title={peaksLocked ? 'Unlock peaks before rescanning' : 'Re-scan this rule'}
                >
                  {scanning ? 'Scanning...' : peaksLocked ? 'Locked' : 'Re-scan'}
                </AnalysisButton>
              )}
              <div className="flex-1" />
              {(rule.source !== 'custom' || rule.id !== 'default-custom') && (
                <AnalysisButton
                  onClick={onRemove}
                  variant="dangerOutline"
                >
                  Remove
                </AnalysisButton>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
