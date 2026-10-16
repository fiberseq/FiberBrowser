import { useState, useCallback, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { nanoid } from 'nanoid';
import { useBrowserStore } from '../../stores/browserStore';
import { getSequenceChunked } from '../../api/reference';
import type { CaptureRegion } from '../../types/capture';
import { Download, Trash } from '../ui/Icons';
import { AnalysisButton, AnalysisPanelHeader, AnalysisPanelShell, AnalysisRunSummary, AnalysisStatus } from './shared';
import { fetchCaptureSequences } from '../../utils/captureSequences';
import { useRememberedState } from '../../hooks/useRememberedState';

type ExportFormat = 'bed' | 'twist-tsv' | 'fasta' | 'probe-tsv';
type CaptureTab = 'cart' | 'export';

interface Props {
  isFullView?: boolean;
  /** Inside another panel (Primers > Capture): no padding of its own. */
  embedded?: boolean;
}

/** Download helper — triggers a browser download for the given text content. */
function downloadText(filename: string, content: string, mime = 'text/plain') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export type CaptureTarget =
  | { chrom: string; start: number; end: number; size: number; count: number; chroms?: undefined }
  | { chroms: string[]; count: number };

/**
 * The region bounding the selected peaks, on their chromosome (a peak without
 * one is the main view's). Peaks on several chromosomes have no bounding region.
 */
export function boundingTarget(
  peaks: { chrom?: string; start: number; end: number }[],
  viewChrom: string,
): CaptureTarget | null {
  if (peaks.length === 0) return null;
  const chroms = [...new Set(peaks.map(p => p.chrom ?? viewChrom))];
  if (chroms.length > 1) return { chroms, count: peaks.length };
  const start = Math.min(...peaks.map(p => p.start));
  const end = Math.max(...peaks.map(p => p.end));
  return { chrom: chroms[0], start, end, size: end - start, count: peaks.length };
}

export function CapturePanel({ isFullView, embedded = false }: Props) {
  const {
    chrom, start, end,
    selectedPeaks,
    captureRegions, capturePadding,
    addCaptureRegions, removeCaptureRegion, updateCaptureRegionName,
    updateCaptureRegionPadding,
    clearCaptureRegions, setCapturePadding,
    hasFasta,
    peaksLocked,
    analysisSampleSeed,
  } = useBrowserStore(useShallow(s => ({
    chrom: s.chrom, start: s.start, end: s.end,
    selectedPeaks: s.selectedPeaks,
    captureRegions: s.captureRegions, capturePadding: s.capturePadding,
    addCaptureRegions: s.addCaptureRegions, removeCaptureRegion: s.removeCaptureRegion,
    updateCaptureRegionName: s.updateCaptureRegionName,
    updateCaptureRegionPadding: s.updateCaptureRegionPadding,
    clearCaptureRegions: s.clearCaptureRegions, setCapturePadding: s.setCapturePadding,
    hasFasta: s.hasFasta,
    peaksLocked: s.peaksLocked,
    analysisSampleSeed: s.analysisSampleSeed,
  })));

  const [exportFormat, setExportFormat] = useState<ExportFormat>('bed');
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState('');
  const [exportError, setExportError] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [activeTab, setActiveTab] = useRememberedState<CaptureTab>('capture:tab', () => 'cart');

  // Derive selected peaks. getAllPeaks is memoized on peakRules/peaksByRule, so
  // subscribing to its result follows rescans (the function itself never changes).
  const allPeaks = useBrowserStore(s => s.getAllPeaks());
  const selectedPeaksList = useMemo(
    () => allPeaks.filter(p => selectedPeaks.has(p.index)).sort((a, b) => a.start - b.start),
    [allPeaks, selectedPeaks],
  );

  // Live preview: target derived from selected peaks
  const targetInfo = useMemo(() => boundingTarget(selectedPeaksList, chrom), [selectedPeaksList, chrom]);

  const nextIndex = captureRegions.length + 1;

  const handleAddBounding = useCallback(() => {
    if (!targetInfo || targetInfo.chroms) return;
    addCaptureRegions([{
      id: nanoid(8),
      name: `region_${nextIndex}`,
      chrom: targetInfo.chrom,
      start: targetInfo.start,
      end: targetInfo.end,
      padding: capturePadding,
      addedAt: Date.now(),
      source: 'bounding',
    }]);
  }, [targetInfo, nextIndex, capturePadding, addCaptureRegions]);

  const handleAddViewport = useCallback(() => {
    addCaptureRegions([{
      id: nanoid(8),
      name: `viewport_${nextIndex}`,
      chrom,
      start,
      end,
      padding: capturePadding,
      addedAt: Date.now(),
      source: 'viewport',
    }]);
  }, [chrom, start, end, nextIndex, capturePadding, addCaptureRegions]);

  // Padded coordinates (per-region padding, fallback 0 for old sessions)
  const padded = (r: CaptureRegion) => {
    const p = r.padding ?? 0;
    return { start: Math.max(0, r.start - p), end: r.end + p };
  };

  // Export handler
  const handleExport = useCallback(async () => {
    if (captureRegions.length === 0) return;
    setExporting(true);
    setExportProgress('');
    setExportError('');

    try {
      if (exportFormat === 'bed') {
        const lines = captureRegions.map(r => {
          const p = padded(r);
          return `${r.chrom}\t${p.start}\t${p.end}\t${r.name}`;
        });
        downloadText('capture_regions.bed', lines.join('\n') + '\n');
      } else if (exportFormat === 'twist-tsv') {
        const header = 'Chromosome\tStart\tStop\tAnnotation';
        const lines = captureRegions.map(r => {
          const p = padded(r);
          return `${r.chrom}\t${p.start}\t${p.end}\t${r.name}`;
        });
        downloadText('capture_regions.tsv', [header, ...lines].join('\n') + '\n');
      } else if (exportFormat === 'fasta' || exportFormat === 'probe-tsv') {
        const { entries, failures } = await fetchCaptureSequences(
          captureRegions.map(r => ({ name: r.name, chrom: r.chrom, ...padded(r) })),
          // Regions longer than one sequence request are fetched in pieces.
          getSequenceChunked,
          (i, n) => setExportProgress(`Fetching ${i + 1}/${n}...`),
        );
        if (failures.length > 0) {
          // No file with made-up sequence: name what couldn't be fetched.
          setExportError(`No export: ${failures.join('; ')}.`);
          return;
        }

        if (exportFormat === 'fasta') {
          const lines = entries.map(e => `>${e.name}\n${e.seq}`);
          downloadText('capture_regions.fa', lines.join('\n') + '\n');
        } else {
          const header = 'Probe Identifier\tProbe Sequence';
          const lines = entries.map(e => `${e.name}\t${e.seq}`);
          downloadText('capture_probes.txt', [header, ...lines].join('\n') + '\n');
        }
      }
    } finally {
      setExporting(false);
      setExportProgress('');
    }
  }, [captureRegions, exportFormat]);

  const startEditing = (r: CaptureRegion) => {
    setEditingId(r.id);
    setEditName(r.name);
  };

  const commitEdit = () => {
    if (editingId && editName.trim()) {
      updateCaptureRegionName(editingId, editName.trim());
    }
    setEditingId(null);
  };

  const totalSize = captureRegions.reduce((sum, r) => {
    const p = padded(r);
    return sum + (p.end - p.start);
  }, 0);
  const totalSizeLabel = totalSize >= 1000 ? `${(totalSize / 1000).toFixed(1)}kb` : `${totalSize}bp`;
  const tabs = [
    { key: 'cart' as const, label: `Regions${captureRegions.length > 0 ? ` (${captureRegions.length})` : ''}` },
    { key: 'export' as const, label: 'Export' },
  ];

  return (
    <AnalysisPanelShell
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      theme="indigo"
      isFullView={isFullView}
      layout={embedded ? 'custom' : 'standard'}
      className={embedded ? `flex flex-col gap-2 text-[13px] ${isFullView ? 'h-full' : ''}` : (isFullView ? 'flex h-full flex-col text-[13px]' : 'text-[13px]')}
      bodyMode={isFullView ? 'fill' : 'none'}
      bodyClassName={embedded ? 'space-y-2' : undefined}
      header={
        <AnalysisPanelHeader
          title={`${captureRegions.length} capture region${captureRegions.length !== 1 ? 's' : ''}`}
          detail={`${totalSizeLabel} padded · regions to order as a capture panel, from selected peaks or the view`}
          meta={targetInfo ? `${targetInfo.count} selected peak${targetInfo.count !== 1 ? 's' : ''}` : 'No target selected'}
          theme="indigo"
        />
      }
      summary={
        <AnalysisRunSummary
          seed={analysisSampleSeed}
          peaksLocked={peaksLocked}
          inputs={[
            targetInfo
              ? `${targetInfo.count} selected peak${targetInfo.count !== 1 ? 's' : ''}`
              : `${chrom}:${start.toLocaleString()}-${end.toLocaleString()}`,
          ]}
          outputs={captureRegions.length > 0 ? [
            `${captureRegions.length} capture region${captureRegions.length !== 1 ? 's' : ''}`,
            totalSizeLabel,
          ] : []}
        />
      }
    >
      {activeTab === 'cart' && (
        <>
          {/* Live preview — auto-derived from selected peaks */}
          <div className="px-2 py-1.5 rounded bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-100 dark:border-indigo-800/40 text-[11px]" data-tour="capture-target">
            {targetInfo?.chroms ? (
              <span className="text-amber-700 dark:text-amber-400">
                The selected peaks are on {targetInfo.chroms.join(', ')}. Select peaks on one chromosome to add a bounding region.
              </span>
            ) : targetInfo ? (
              <span className="text-indigo-700 dark:text-indigo-300 font-mono">
                Target: {targetInfo.chrom}:{targetInfo.start.toLocaleString()}-{targetInfo.end.toLocaleString()}{' '}
                <span className="text-indigo-500 dark:text-indigo-400">
                  ({(targetInfo.size / 1000).toFixed(1)}kb, {targetInfo.count} peak{targetInfo.count !== 1 ? 's' : ''})
                </span>
              </span>
            ) : (
              <span className="text-gray-400 dark:text-gray-500 italic">Select peaks to see target preview</span>
            )}
          </div>

          {/* Padding input */}
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500 dark:text-gray-400">Padding:</label>
            <input
              type="number" min={0} step={50}
              value={capturePadding}
              onChange={e => setCapturePadding(parseInt(e.target.value, 10) || 0)}
              className="input-tool w-16 text-xs"
              data-tour="capture-padding"
            />
            <span className="text-xs text-ink-secondary">bp</span>
          </div>

          {/* Add buttons */}
          <div className="flex flex-wrap gap-1">
            <AnalysisButton
              theme="indigo"
              variant="primary"
              onClick={handleAddBounding}
              disabled={!targetInfo || Boolean(targetInfo.chroms)}
              data-tour="capture-add-bounding"
            >
              + Bounding
            </AnalysisButton>
            <AnalysisButton
              variant="neutral"
              onClick={handleAddViewport}
              data-copilot-anchor="capture-add-region"
            >
              + Viewport
            </AnalysisButton>
          </div>

          {/* Order list */}
          {captureRegions.length === 0 ? (
            <AnalysisStatus kind="empty" center title="No capture regions">
              Select peaks and use Bounding, or add the current viewport.
            </AnalysisStatus>
          ) : (
            <div className="space-y-1">
              <div className="text-[11px] text-ink-secondary">
                {captureRegions.length} region{captureRegions.length !== 1 ? 's' : ''} &middot; {totalSizeLabel} total
              </div>
              {captureRegions.map(r => {
                const p = padded(r);
                const size = p.end - p.start;
                const rPad = r.padding ?? 0;
                return (
                  <div
                    key={r.id}
                    className="flex items-center gap-1.5 p-1 rounded bg-gray-50 dark:bg-white/5 border border-gray-100 dark:border-white/10 group"
                  >
                    <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 bg-indigo-500" />
                    {editingId === r.id ? (
                      <input
                        autoFocus
                        value={editName}
                        onChange={e => setEditName(e.target.value)}
                        onBlur={commitEdit}
                        onKeyDown={e => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') setEditingId(null); }}
                        className="input-tool flex-1 text-xs min-w-0"
                      />
                    ) : (
                      <span
                        className="text-xs font-mono truncate cursor-pointer hover:text-indigo-600 dark:hover:text-indigo-400 flex-1 min-w-0"
                        onClick={() => startEditing(r)}
                        title="Click to rename"
                      >
                        {r.name}
                      </span>
                    )}
                    <span className="text-[11px] text-ink-secondary flex-shrink-0 font-mono">
                      {r.chrom}:{p.start.toLocaleString()}-{p.end.toLocaleString()}
                    </span>
                    <input
                      type="number" min={0} step={50}
                      value={rPad}
                      onChange={e => updateCaptureRegionPadding(r.id, parseInt(e.target.value, 10) || 0)}
                      className="input-tool w-12 text-[11px] text-center"
                      title="Per-region padding (bp)"
                    />
                    <span className="text-[11px] text-ink-secondary bg-gray-100 dark:bg-white/10 px-1 rounded flex-shrink-0">
                      {size >= 1000 ? `${(size / 1000).toFixed(1)}kb` : `${size}bp`}
                    </span>
                    <AnalysisButton
                      variant="dangerOutline"
                      onClick={() => removeCaptureRegion(r.id)}
                      className="opacity-0 group-hover:opacity-100 px-1 py-0 flex-shrink-0"
                      title="Remove"
                    >
                      <Trash className="w-3 h-3" />
                    </AnalysisButton>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {activeTab === 'export' && (
        <div className="space-y-2">
          {captureRegions.length === 0 ? (
            <AnalysisStatus kind="empty" center title="Nothing to export">
              Add regions to the Cart before exporting.
            </AnalysisStatus>
          ) : (
            <>
              <div className="px-2 py-1.5 rounded bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-100 dark:border-indigo-800/40 text-[11px] text-indigo-700 dark:text-indigo-300">
                Exporting {captureRegions.length} region{captureRegions.length !== 1 ? 's' : ''} &middot; {totalSizeLabel} total padded span
              </div>
              <div className="flex items-center gap-2">
                <select
                  value={exportFormat}
                  onChange={e => setExportFormat(e.target.value as ExportFormat)}
                  className="input-tool text-xs flex-1 min-w-0"
                  data-tour="capture-export-format"
                >
                  <option value="bed">BED</option>
                  <option value="twist-tsv">Twist TSV</option>
                  <option value="fasta">FASTA</option>
                  <option value="probe-tsv">Probe TSV</option>
                </select>
                <AnalysisButton
                  theme="indigo"
                  variant="primary"
                  onClick={handleExport}
                  disabled={exporting || ((exportFormat === 'fasta' || exportFormat === 'probe-tsv') && !hasFasta)}
                  data-tour="capture-download"
                  className="flex items-center gap-1 flex-shrink-0"
                >
                  <Download className="w-3 h-3" />
                  {exporting ? exportProgress || '...' : 'Download'}
                </AnalysisButton>
                <AnalysisButton
                  variant="dangerOutline"
                  onClick={clearCaptureRegions}
                  className="flex-shrink-0"
                  title="Clear all regions"
                >
                  Clear
                </AnalysisButton>
              </div>
              {exportError && (
                <AnalysisStatus kind="error" compact>{exportError}</AnalysisStatus>
              )}
              {(exportFormat === 'fasta' || exportFormat === 'probe-tsv') && !hasFasta && (
                <AnalysisStatus kind="warning" compact>
                  Load a reference FASTA before exporting sequence-based formats.
                </AnalysisStatus>
              )}
            </>
          )}
        </div>
      )}
    </AnalysisPanelShell>
  );
}

