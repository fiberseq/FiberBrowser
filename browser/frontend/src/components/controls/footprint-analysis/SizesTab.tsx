import type { FootprintAnalysisResult } from '../../../api/footprints';
import type { SelectedFootprint, FootprintGroup } from '../../../types';
import type { Dataset } from '../../../types/dataset';
import { HistogramChart } from '../../charts/HistogramChart';
import type { HistogramGroup } from '../../charts/HistogramChart';
import { getDatasetDisplayLabel } from '../../../utils/datasetLabels';
import { nextGroupColor } from './constants';
import { sizeRangeName } from '../../../utils/footprintGroupNames';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBrowserStore } from '../../../stores/browserStore';
import { AnalysisButton, AnalysisPanelHeader, AnalysisStatus } from '../shared';
import { wilsonCountInterval } from '../../../utils/statistics';
import { Trash } from '../../ui/Icons';

interface SizesTabProps {
  result: FootprintAnalysisResult;
  isFullView?: boolean;
  selectedFootprints: SelectedFootprint[];
  targetDatasets: Dataset[];
  chartWidth: number;
  footprintGroups: FootprintGroup[];
  addFootprintGroup: (group: Omit<FootprintGroup, 'id'>) => void;
  updateFootprintGroup: (id: string, updates: Partial<FootprintGroup>) => void;
  removeFootprintGroup: (id: string) => void;
  /** Unused since the size picker keeps its own range; kept for callers. */
  customGroupEdit?: number | null;
  setCustomGroupEdit?: (v: number | null) => void;
  customMin?: number;
  setCustomMin?: (v: number) => void;
  customMax?: number;
  setCustomMax?: (v: number) => void;
  /** When true, suppress the inline cart list at the bottom — the Cart tab
   *  is the canonical place for that view, and showing it in Define would
   *  be redundant. */
  hideCartList?: boolean;
}

export function SizesTab({
  result, isFullView, selectedFootprints, targetDatasets, chartWidth,
  footprintGroups, addFootprintGroup, updateFootprintGroup, removeFootprintGroup,
  hideCartList,
}: SizesTabProps) {
  return (
    <div className="space-y-3">
      <AnalysisPanelHeader
        title="Save a size range"
        detail="Footprints of this size here are coloured on reads and can be compared in Co-occupancy."
        theme="emerald"
        actions={selectedFootprints.length > 1 ? (
          <AnalysisButton
            data-testid="save-all-selected-footprints"
            theme="emerald"
            variant="soft"
            size="sm"
            title="Save each selected footprint with its default size range (edit a range below first to save it differently)"
            onClick={() => {
              const groups = [...footprintGroups];
              selectedFootprints.forEach((fp, fpIdx) => {
                const range = defaultRange(fp.size);
                const group = sizeRangeGroup(fp, fpIdx, range.min, range.max ?? null, groups);
                addFootprintGroup(group);
                groups.push({ ...group, id: `pending-${fpIdx}` } as FootprintGroup);
              });
            }}
          >
            Save all {selectedFootprints.length}
          </AnalysisButton>
        ) : undefined}
      />
      {selectedFootprints.map((fp, fpIdx) => (
        <FootprintSizeBlock
          // Keyed by the footprint so a new selection starts from its own range.
          key={`${fp.chrom}:${fp.absStart}-${fp.absEnd}:${fp.layer ?? ''}`}
          fp={fp}
          fpIdx={fpIdx}
          selectedCount={selectedFootprints.length}
          result={result}
          isFullView={isFullView}
          targetDatasets={targetDatasets}
          chartWidth={chartWidth}
          footprintGroups={footprintGroups}
          addFootprintGroup={addFootprintGroup}
        />
      ))}

      {/* Active cart list — editable name + color, persists across viewport
          changes and reloads (footprintGroups are persisted to localStorage).
          Hidden in the Define tab; the Cart tab is the canonical view. */}
      {!hideCartList && footprintGroups.length > 0 && (
        <div className="space-y-1">
          <div className="text-[11px] font-medium text-gray-600 dark:text-gray-300">Saved</div>
          {footprintGroups.map(g => (
            <div
              key={g.id}
              className="flex items-center gap-1.5 text-[11px]"
              // Per-row Copilot anchor — remove_footprint_group carries
              // the group_id, so the spotlight can ring this specific row.
              data-copilot-anchor={`footprint-group-${g.id}`}
            >
              <input
                type="checkbox" checked={g.enabled}
                onChange={e => updateFootprintGroup(g.id, { enabled: e.target.checked })}
                className="w-3 h-3"
                title="Toggle this entry"
              />
              <input
                type="color" value={g.color}
                onChange={e => updateFootprintGroup(g.id, { color: e.target.value })}
                className="w-4 h-4 rounded-sm cursor-pointer flex-shrink-0 border-0 p-0 bg-transparent"
                title="Color"
              />
              <input
                type="text" value={g.name}
                onChange={e => updateFootprintGroup(g.id, { name: e.target.value })}
                className="flex-1 min-w-0 px-1 py-0.5 text-[11px] bg-transparent border border-transparent
                           hover:border-gray-300 dark:hover:border-gray-600 focus:border-emerald-500 rounded"
                title="Name"
              />
              <span className="text-gray-400 whitespace-nowrap">{g.sizeMin}-{g.sizeMax ?? '\u221E'}bp</span>
              <AnalysisButton
                onClick={() => removeFootprintGroup(g.id)}
                variant="dangerOutline"
                className="inline-flex items-center"
                title="Remove from Saved"
                aria-label={`Remove ${g.name}`}
              >
                <Trash size={12} aria-hidden="true" />
              </AnalysisButton>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Default range for a clicked footprint: its size class, to adjust from. */
function defaultRange(size: number): { min: number; max: number | null } {
  if (size >= 90) return { min: 90, max: null };
  // Always include the clicked size (an 85 bp footprint gets 35-85).
  if (size >= 35) return { min: 35, max: Math.max(80, size) };
  return { min: 0, max: 34 };
}

/** A saved size range at a selected footprint's position. */
function sizeRangeGroup(fp: SelectedFootprint, fpIdx: number, min: number, max: number | null, existing: FootprintGroup[]): Omit<FootprintGroup, 'id'> {
  return {
    name: sizeRangeName(min, max, `fp${fpIdx + 1}`),
    autoName: true,
    color: nextGroupColor(existing),
    sourceIndex: fpIdx,
    layer: fp.layer ?? null,
    familyId: fp.familyId ?? null,
    familyAnnotationName: fp.familyAnnotationName ?? null,
    minFamilyConfidence: 0,
    referenceAbsStart: fp.absStart,
    referenceAbsEnd: fp.absEnd,
    referenceChrom: fp.chrom,
    referenceGenome: fp.genome,
    referenceReversed: fp.reversed,
    sourceDatasetId: fp.datasetId,
    sourceViewKey: fp.stateKey,
    sizeMin: min,
    sizeMax: max,
    overlapFraction: 0,
    enabled: true,
  };
}

function FootprintSizeBlock({
  fp, fpIdx, selectedCount, result, isFullView, targetDatasets, chartWidth, footprintGroups, addFootprintGroup,
}: {
  fp: SelectedFootprint;
  fpIdx: number;
  selectedCount: number;
  result: FootprintAnalysisResult;
  isFullView?: boolean;
  targetDatasets: Dataset[];
  chartWidth: number;
  footprintGroups: FootprintGroup[];
  addFootprintGroup: (group: Omit<FootprintGroup, 'id'>) => void;
}) {
  const showDetails = useBrowserStore(s => s.showAnalysisDetails);
  // The histogram takes the width of its own box, which sits inside cards and
  // their padding: the panel's width would run past the card's edge (M21).
  const [boxWidth, setBoxWidth] = useState<number | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const chartBoxRef = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    if (el.clientWidth > 0) setBoxWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    observer.current = new ResizeObserver(entries => {
      const width = Math.floor(entries[0].contentRect.width);
      if (width > 0) setBoxWidth(width);
    });
    observer.current.observe(el);
  }, []);
  useEffect(() => () => observer.current?.disconnect(), []);
  const histogramWidth = Math.max(160, boxWidth == null ? chartWidth : Math.min(chartWidth, boxWidth));
  const initial = defaultRange(fp.size);
  const [minText, setMinText] = useState(String(initial.min));
  const [maxText, setMaxText] = useState(initial.max == null ? '' : String(initial.max));
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const min = Math.max(0, Number(minText) || 0);
  const maxValue = maxText.trim() === '' ? null : Number(maxText);
  const invalid = maxValue != null && (!Number.isFinite(maxValue) || maxValue < min);
  const max = maxValue == null || invalid ? null : maxValue;

  // Histogram bars (only bins with reads), shared by the chart and the range.
  const histogram = useMemo(() => {
    const firstDs = targetDatasets[0];
    const firstHist = firstDs ? result.overlap_stats[firstDs.id]?.per_footprint?.[fpIdx]?.size_histogram : null;
    if (!firstHist) return null;
    const bins = firstHist.bins;
    const binWidth = bins.length > 1 ? bins[1] - bins[0] : 5;
    const groups: (HistogramGroup & { start: number })[] = bins.map((binStart, bi) => ({
      label: `${binStart}`,
      start: binStart,
      bars: targetDatasets.map(ds => {
        const hist = result.overlap_stats[ds.id]?.per_footprint?.[fpIdx]?.size_histogram;
        const value = hist?.counts?.[bi] ?? 0;
        const total = result.overlap_stats[ds.id]?.per_footprint?.[fpIdx]?.overlap_count ?? 0;
        const ci = wilsonCountInterval(value, total);
        return { label: getDatasetDisplayLabel(ds), value, ciLow: ci.low, ciHigh: ci.high, n: total, color: ds.color };
      }),
    })).filter(group => group.bars.some(bar => bar.value > 0));
    // The last bin of the full histogram (not just the non-empty ones) is "and larger".
    return { groups, binWidth, lastBinStart: bins[bins.length - 1] };
  }, [result, targetDatasets, fpIdx]);

  const selection = useMemo(() => {
    if (!histogram || histogram.groups.length === 0) return null;
    const inRange = histogram.groups
      .map((group, index) => ({ index, start: group.start }))
      .filter(({ start }) => start + histogram.binWidth > min && (max == null || start <= max));
    if (inRange.length === 0) return null;
    return { from: inRange[0].index, to: inRange[inRange.length - 1].index };
  }, [histogram, min, max]);

  const selectBins = (from: number, to: number) => {
    if (!histogram) return;
    const last = histogram.groups[to];
    setMinText(String(histogram.groups[from].start));
    // Sizes are whole bp and the maximum is inclusive: a bar starting at 35 is 35-39.
    // Dragging to the histogram's last bin means "and larger".
    setMaxText(last.start >= histogram.lastBinStart ? '' : String(last.start + histogram.binWidth - 1));
  };

  const save = () => {
    if (invalid) return;
    const group = sizeRangeGroup(fp, fpIdx, min, max, footprintGroups);
    addFootprintGroup(group);
    const name = group.name;
    setSavedMessage(`Saved ${name}`);
    window.setTimeout(() => setSavedMessage(null), 2500);
  };

  const inputClass = 'w-14 rounded border border-gray-300 bg-white px-1 py-0.5 text-right text-[11px] dark:border-gray-600 dark:bg-gray-800';
  return (
    <div className="space-y-2 rounded border border-gray-200 p-2 dark:border-gray-700" data-testid="footprint-size-block">
      {selectedCount > 1 && <div className="text-[11px] font-medium text-gray-600 dark:text-gray-300">
        {fp.absStart.toLocaleString()}-{fp.absEnd.toLocaleString()} ({fp.size}bp)
      </div>}
      {showDetails && fp.familyId != null && <div className="text-[11px] text-gray-500">
        {(
          <span>
            State F{String(fp.familyId).padStart(3, '0')}
            {fp.familyConfidence != null ? ` · ${(100 * fp.familyConfidence).toFixed(1)}%` : ''}
          </span>
        )}
      </div>}

      {!histogram ? (
        <AnalysisStatus kind="empty" compact title="No size data returned">
          Re-select the footprint.
        </AnalysisStatus>
      ) : histogram.groups.length === 0 ? (
        <AnalysisStatus kind="empty" compact title="No overlapping reads">
          Try turning off <span className="font-mono">Full-length</span> or loosening Quality filters.
        </AnalysisStatus>
      ) : (
        <div ref={chartBoxRef} className="min-w-0" data-testid="footprint-size-histogram">
          <HistogramChart
            groups={histogram.groups}
            width={histogramWidth}
            height={isFullView ? 160 : 110}
            yLabel="Reads"
            groupedLayout={targetDatasets.length > 1}
            selection={selection}
            onSelectRange={selectBins}
          />
          <div className="mt-0.5 text-[11px] text-gray-500">
            Sizes of the footprints reads have here. Drag across the bars to choose a size range.
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className="text-gray-600 dark:text-gray-300">Size</span>
        <input type="number" min={0} value={minText} onChange={e => setMinText(e.target.value)} className={inputClass} aria-label="Minimum size (bp)" />
        <span className="text-gray-400">to</span>
        <input type="number" min={0} value={maxText} placeholder="any" onChange={e => setMaxText(e.target.value)} className={inputClass} aria-label="Maximum size (bp), blank for no limit" />
        <span className="text-gray-400">bp</span>
        <AnalysisButton
          data-copilot-anchor="footprint-add-group"
          onClick={save}
          disabled={invalid}
          theme="emerald"
          variant="primary"
          title="Save this size range at this position (shown on reads, and comparable in Co-occupancy)"
        >
          Save
        </AnalysisButton>
        <span className="ml-1 text-[11px] text-gray-400">quick:</span>
        <button type="button" className="text-[11px] text-emerald-700 hover:underline dark:text-emerald-300" onClick={() => { setMinText('90'); setMaxText(''); }}>≥ 90 (nucleosome)</button>
        <button type="button" className="text-[11px] text-emerald-700 hover:underline dark:text-emerald-300" onClick={() => { setMinText('35'); setMaxText('80'); }}>35–80 (TF)</button>
      </div>
      {invalid && <div className="text-[11px] text-amber-700 dark:text-amber-300">The maximum must be at least the minimum (or blank for no limit).</div>}
      {savedMessage && <div className="text-[11px] text-emerald-700 dark:text-emerald-300">{savedMessage} (see Saved)</div>}
    </div>
  );
}
