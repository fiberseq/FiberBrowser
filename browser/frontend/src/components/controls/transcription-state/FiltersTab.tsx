import type { Dispatch, SetStateAction } from 'react';
import type { TranscriptionStateFilters } from '../../../types/clustering';
import { AnalysisSettingsSection, AnalysisStatus } from '../shared';
import { TranscriptionStateChart } from './TranscriptionStateChart';
import type { TranscriptionClassData } from './TranscriptionStateChart';

export interface TranscriptionSummaryTotals {
  pause: number;
  pic: number;
  elongating_gte_1: number;
  elongating_gte_3: number;
  elongating_gte_5: number;
  elongating_dist: { '1': number; '2': number; '3': number; '4+': number };
  total_matching: number;
  overlapping_genes: number;
}

/** The reads classified at the selected genes: the denominator of every state rate. */
export function classifiedTotal(summary: { overlapping_genes?: number; total_matching?: number }): number {
  return summary.overlapping_genes ?? summary.total_matching ?? 0;
}

interface DatasetDisplay {
  id: string;
  label: string;
  color: string;
}

export function FiltersTab({
  loading,
  hasSummary,
  filters,
  onTogglePause,
  onTogglePic,
  onToggleElongating,
  combinedSummary,
  elongatingThresholdLabel,
  elongatingCount,
  showThresholdSettings,
  setShowThresholdSettings,
  elongatingMin,
  elongatingMax,
  elongatingMaxEnabled,
  onElongatingMinChange,
  onElongatingMaxChange,
  onToggleElongatingMax,
  hasActiveFilter,
  hasAppliedFilter,
  perDatasetBars,
  targetDatasets,
  containerWidth,
}: {
  loading: boolean;
  hasSummary: boolean;
  filters: TranscriptionStateFilters;
  onTogglePause: () => void;
  onTogglePic: () => void;
  onToggleElongating: () => void;
  combinedSummary: TranscriptionSummaryTotals;
  elongatingThresholdLabel: string;
  elongatingCount: number;
  showThresholdSettings: boolean;
  setShowThresholdSettings: Dispatch<SetStateAction<boolean>>;
  elongatingMin: number;
  elongatingMax: number | null;
  elongatingMaxEnabled: boolean;
  onElongatingMinChange: (value: number) => void;
  onElongatingMaxChange: (value: number | null) => void;
  onToggleElongatingMax: () => void;
  hasActiveFilter: boolean;
  hasAppliedFilter: boolean;
  perDatasetBars: TranscriptionClassData[] | null;
  targetDatasets: DatasetDisplay[];
  containerWidth: number;
}) {
  if (loading && !hasSummary) {
    return (
      <AnalysisStatus kind="loading" compact>
        Loading state counts...
      </AnalysisStatus>
    );
  }

  return (
    <>
      <div className="space-y-1.5" data-tour="transcription-states">
        <label className="flex items-center gap-2 cursor-pointer hover:bg-amber-100 dark:hover:bg-amber-900/20 px-1 rounded">
          <input
            type="checkbox"
            checked={!!filters.pause}
            onChange={onTogglePause}
            className="rounded border-amber-400 text-amber-600 focus:ring-amber-500"
          />
          <span className="flex-1">Pause</span>
          <span className="text-xs text-amber-600 dark:text-amber-400">
            ({combinedSummary.pause} reads)
          </span>
        </label>

        <label className="flex items-center gap-2 cursor-pointer hover:bg-amber-100 dark:hover:bg-amber-900/20 px-1 rounded">
          <input
            type="checkbox"
            checked={!!filters.pic}
            onChange={onTogglePic}
            className="rounded border-amber-400 text-amber-600 focus:ring-amber-500"
          />
          <span className="flex-1">PIC</span>
          <span className="text-xs text-amber-600 dark:text-amber-400">
            ({combinedSummary.pic} reads)
          </span>
        </label>

        <div className="hover:bg-amber-100 dark:hover:bg-amber-900/20 px-1 rounded">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={filters.elongating !== null}
              onChange={onToggleElongating}
              className="rounded border-amber-400 text-amber-600 focus:ring-amber-500"
            />
            <span className="flex-1 flex items-center gap-1 flex-wrap">{elongatingThresholdLabel}</span>
            <span className="text-xs text-amber-600 dark:text-amber-400 whitespace-nowrap">
              ({elongatingCount})
            </span>
          </div>
        </div>

        <AnalysisSettingsSection
          open={showThresholdSettings}
          onOpenChange={setShowThresholdSettings}
          theme="amber"
          title="State thresholds"
          tourId="transcription-thresholds"
          summary={elongatingThresholdLabel}
        >
          <label className="flex items-center justify-between gap-2 text-[11px] text-gray-600 dark:text-gray-300">
            <span>Minimum Pol II count</span>
            <input
              type="number"
              min={1}
              max={20}
              value={elongatingMin}
              data-tour="transcription-min-pol2"
              onChange={(e) => onElongatingMinChange(Math.max(1, parseInt(e.target.value) || 1))}
              className="input-tool w-14 text-right text-[11px] py-0.5 min-h-0"
            />
          </label>
          <label className="flex items-center justify-between gap-2 text-[11px] text-gray-600 dark:text-gray-300">
            <span className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={elongatingMaxEnabled}
                onChange={onToggleElongatingMax}
                className="rounded border-gray-300 text-amber-600 focus:ring-amber-500 w-3 h-3"
              />
              Maximum Pol II count
            </span>
            <input
              type="number"
              min={1}
              max={20}
              value={elongatingMax ?? 5}
              onChange={(e) => onElongatingMaxChange(Math.max(1, parseInt(e.target.value) || 1))}
              disabled={!elongatingMaxEnabled}
              className="input-tool w-14 text-right text-[11px] py-0.5 min-h-0 disabled:opacity-40"
            />
          </label>
        </AnalysisSettingsSection>
      </div>

      {hasActiveFilter && combinedSummary.total_matching > 0 && (
        <AnalysisStatus kind={hasAppliedFilter ? 'success' : 'info'} compact>
          {combinedSummary.total_matching} reads match filter
          {hasAppliedFilter && ' (applied)'}
        </AnalysisStatus>
      )}

      {perDatasetBars && targetDatasets.length > 0 && (
        <div className="pt-2 border-t border-amber-200 dark:border-amber-800">
          <div className="text-xs font-medium text-amber-800 dark:text-amber-300 mb-1">Per-dataset breakdown</div>
          <TranscriptionStateChart classes={perDatasetBars} width={Math.max(200, containerWidth - 20)} />
          <div className="mt-0.5 text-[11px] italic text-ink-secondary">
            Whiskers are 95% Wilson intervals with reads as the observation unit.
          </div>
        </div>
      )}

      <AnalysisStatus kind="info" compact>
        Tip: Shift+click genes for multi-select
      </AnalysisStatus>
    </>
  );
}
