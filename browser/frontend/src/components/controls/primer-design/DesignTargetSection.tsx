import type { Dispatch, SetStateAction } from 'react';
import type { FirePeak, PrimerState, Region } from '../../../types';
import { AnalysisButton, AnalysisToggleGroup } from '../shared';

type PrimerMode = PrimerState['mode'];

const MODE_LABELS: Record<PrimerMode, string> = {
  standard: 'Standard',
  dafc: '3C',
  '4c': '4C',
};

const MODE_OPTIONS: Array<{ value: PrimerMode; label: string; title: string }> = [
  { value: 'standard', label: MODE_LABELS.standard, title: 'Design primers around the selected target interval' },
  { value: 'dafc', label: MODE_LABELS.dafc, title: 'Design paired 3C-style primers for two loci' },
  { value: '4c', label: MODE_LABELS['4c'], title: 'Design 4C-style primers from the selected viewpoint' },
];

function countPeaksInRegion(peaks: FirePeak[], region: Region | null): number {
  if (!region) return 0;
  return peaks.filter(p => p.end > region.start && p.start < region.end).length;
}

export function DesignTargetSection({
  mode,
  setMode,
  chrom,
  targetStart,
  targetEnd,
  targetSize,
  peakCount,
  selectedPeaksList,
  hasSplitView,
  locusX,
  locusY,
  locusXInput,
  setLocusXInput,
  locusYInput,
  setLocusYInput,
  resolvingLoci,
  onCreateSplitView,
  onCloseSplitView,
}: {
  mode: PrimerMode;
  setMode: (mode: PrimerMode) => void;
  chrom: string;
  targetStart: number | null;
  targetEnd: number | null;
  targetSize: number;
  peakCount: number;
  selectedPeaksList: FirePeak[];
  hasSplitView: boolean;
  locusX: Region | null;
  locusY: Region | null;
  locusXInput: string;
  setLocusXInput: Dispatch<SetStateAction<string>>;
  locusYInput: string;
  setLocusYInput: Dispatch<SetStateAction<string>>;
  resolvingLoci: boolean;
  onCreateSplitView: () => void;
  onCloseSplitView: () => void;
}) {
  const xPeakCount = countPeaksInRegion(selectedPeaksList, locusX);
  const yPeakCount = countPeaksInRegion(selectedPeaksList, locusY);

  return (
    <>
      <AnalysisToggleGroup
        label="Mode"
        value={mode}
        onChange={value => { if (value) setMode(value as PrimerMode); }}
        options={MODE_OPTIONS}
        theme="rose"
      />

      {mode === 'standard' || mode === '4c' ? (
        <div className="text-gray-600 dark:text-gray-400">
          {targetStart && targetEnd ? (
            <span>
              {mode === '4c' ? 'Viewpoint' : 'Target'}: {chrom}:{targetStart.toLocaleString()}-{targetEnd.toLocaleString()} ({targetSize.toLocaleString()}bp, {peakCount} peak{peakCount !== 1 ? 's' : ''})
            </span>
          ) : (
            <span className="text-gray-400">Select peaks to define {mode === '4c' ? 'viewpoint' : 'target'} region</span>
          )}
        </div>
      ) : (
        <div className="space-y-1.5">
          {!hasSplitView ? (
            <div className="space-y-1">
              <div className="text-gray-500 dark:text-gray-400 text-[11px]">Enter two loci (gene name or chr:start-end):</div>
              <div className="flex items-center gap-1">
                <span className="text-blue-600 font-medium w-3">X</span>
                <input
                  type="text"
                  className="input-tool flex-1 text-[11px]"
                  placeholder="e.g. sog"
                  value={locusXInput}
                  onChange={e => setLocusXInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') onCreateSplitView(); }}
                />
              </div>
              <div className="flex items-center gap-1">
                <span className="text-amber-600 font-medium w-3">Y</span>
                <input
                  type="text"
                  className="input-tool flex-1 text-[11px]"
                  placeholder="e.g. brk"
                  value={locusYInput}
                  onChange={e => setLocusYInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') onCreateSplitView(); }}
                />
              </div>
              <AnalysisButton
                onClick={onCreateSplitView}
                disabled={resolvingLoci || !locusXInput.trim() || !locusYInput.trim()}
                theme="cyan"
                variant="primary"
              >
                {resolvingLoci ? 'Resolving...' : 'Open Split View'}
              </AnalysisButton>
            </div>
          ) : (
            <div className="text-gray-600 dark:text-gray-400 space-y-0.5">
              {locusX && (
                <div>
                  <span className="text-blue-600 font-medium">X:</span> {locusX.chrom}:{locusX.start.toLocaleString()}-{locusX.end.toLocaleString()}
                  {xPeakCount > 0 ? ` (${xPeakCount} peak${xPeakCount !== 1 ? 's' : ''})` : ' - draw peaks'}
                </div>
              )}
              {locusY && (
                <div>
                  <span className="text-amber-600 font-medium">Y:</span> {locusY.chrom}:{locusY.start.toLocaleString()}-{locusY.end.toLocaleString()}
                  {yPeakCount > 0 ? ` (${yPeakCount} peak${yPeakCount !== 1 ? 's' : ''})` : ' - draw peaks'}
                </div>
              )}
              <AnalysisButton onClick={onCloseSplitView} variant="outline">
                Close split view
              </AnalysisButton>
            </div>
          )}
        </div>
      )}
    </>
  );
}
