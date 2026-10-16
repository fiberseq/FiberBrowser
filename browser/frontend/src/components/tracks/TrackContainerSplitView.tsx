import { useMemo } from 'react';
import { usePanelDisplayStore as useBrowserStore } from '../../hooks/usePanelDisplayStore';
import { useDafcStore, linkedViewportFilter } from '../../stores/dafcStore';
import { AxisTrack } from './AxisTrack';
import { ReadTrack } from './ReadTrack';
import { SequenceTrack } from './SequenceTrack';
import { GeneTrack } from './GeneTrack';
import { SEQUENCE_HEIGHT } from './TrackContainerConstants';
import { logFrontendDiagnostic } from '../../utils/diagnostics';
import { getDatasetDisplayLabel, getDatasetHoverLabel } from '../../utils/datasetLabels';
import { RotateCcw } from '../ui/Icons';

interface SplitViewProps {
  containerRef: React.RefObject<HTMLDivElement>;
  dimensions: { width: number; height: number };
}

/**
 * Split view for molecule-linked or region-independent X/Y views.
 * Rendered when viewMode === 'linkedSplit'.
 */
export function TrackContainerSplitView({ containerRef, dimensions }: SplitViewProps) {
  const datasets = useBrowserStore(s => s.datasets);
  const hasFasta = useBrowserStore(s => s.hasFasta);
  const isReversed = useBrowserStore(s => s.isReversed);

  // DAF-C state
  const splitViewMode = useDafcStore(s => s.splitViewMode);
  const contactMode = useDafcStore(s => s.contactMode);
  const linkedRegions = useDafcStore(s => s.linkedRegions);
  const currentLinkedSessionId = useDafcStore(s => s.currentLinkedSessionId);
  const linkedReadCount = useDafcStore(s => s.linkedReadCount);
  const xSegmentNames = useDafcStore(s => s.xSegmentNames);
  const ySegmentNames = useDafcStore(s => s.ySegmentNames);
  const xViewport = useDafcStore(s => s.xViewport);
  const yViewport = useDafcStore(s => s.yViewport);
  const linkedSortBy = useDafcStore(s => s.linkedSortBy);
  const xViewportFilter = useDafcStore(s => s.xViewportFilter);
  const yViewportFilter = useDafcStore(s => s.yViewportFilter);
  const xVisibleReadIds = useDafcStore(s => s.xVisibleReadIds);
  const yVisibleReadIds = useDafcStore(s => s.yVisibleReadIds);
  const setXViewport = useDafcStore(s => s.setXViewport);
  const setYViewport = useDafcStore(s => s.setYViewport);
  const toggleLinkedSortBy = useDafcStore(s => s.toggleLinkedSortBy);
  const toggleXViewportFilter = useDafcStore(s => s.toggleXViewportFilter);
  const toggleYViewportFilter = useDafcStore(s => s.toggleYViewportFilter);
  const setXVisibleReadIds = useDafcStore(s => s.setXVisibleReadIds);
  const setYVisibleReadIds = useDafcStore(s => s.setYVisibleReadIds);
  const showUnlinkedReads = useDafcStore(s => s.showUnlinkedReads);
  const toggleShowUnlinkedReads = useDafcStore(s => s.toggleShowUnlinkedReads);
  const highlightLinkedMolecules = useDafcStore(s => s.highlightLinkedMolecules);
  const toggleHighlightLinkedMolecules = useDafcStore(s => s.toggleHighlightLinkedMolecules);

  // Memoize linkedFilteredIds computation (used in linkedSplit mode)
  const linkedFilteredIds = useMemo(
    () => linkedViewportFilter(xViewportFilter, yViewportFilter, xVisibleReadIds, yVisibleReadIds),
    [xViewportFilter, yViewportFilter, xVisibleReadIds, yVisibleReadIds],
  );

  // Memoize linkedReadBaseIds computation (excludes linked reads from unlinked panels)
  const linkedReadBaseIds = useMemo(() => {
    const result = new Set<string>();
    for (const segName of xSegmentNames) {
      const baseId = segName.replace(/_\d+$/, '');
      result.add(baseId);
      result.add(segName);
    }
    for (const segName of ySegmentNames) {
      const baseId = segName.replace(/_\d+$/, '');
      result.add(baseId);
      result.add(segName);
    }
    return result;
  }, [xSegmentNames, ySegmentNames]);

  if (!linkedRegions) {
    return (
      <div ref={containerRef} className="h-full w-full flex items-center justify-center bg-gray-50">
        <div className="text-gray-500 text-lg">No linked regions. Select a contact in the Contact viewer.</div>
      </div>
    );
  }

  const isMoleculeLinkedMode = splitViewMode === 'molecule_linked';
  const isIndependentMode = !isMoleculeLinkedMode;
  logFrontendDiagnostic(`[TrackContainer] linkedSplit mode=${splitViewMode}, contactMode=${contactMode}, linkedRegions.chrom=${linkedRegions.chrom}, datasets=${datasets.map(d => d.id).join(',')}`);
  if (isMoleculeLinkedMode && !currentLinkedSessionId) {
    return (
      <div ref={containerRef} className="h-full w-full flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="text-gray-500 text-lg mb-2">No linked session active.</div>
          <div className="text-gray-400 text-sm">Select a contact in the Contact viewer and send to browser.</div>
        </div>
      </div>
    );
  }

  const controlBarHeight = 32;
  const availableHeight = dimensions.height - controlBarHeight;
  const panelWidth = Math.floor(dimensions.width / 2);
  const linkedPanelHeight = showUnlinkedReads ? Math.floor(availableHeight * 0.6) : availableHeight;
  const unlinkedPanelHeight = showUnlinkedReads ? availableHeight - linkedPanelHeight : 0;

  const xStart = xViewport?.start ?? linkedRegions.x_start;
  const xEnd = xViewport?.end ?? linkedRegions.x_end;
  const yStart = yViewport?.start ?? linkedRegions.y_start;
  const yEnd = yViewport?.end ?? linkedRegions.y_end;
  const xChrom = linkedRegions.x_chrom || linkedRegions.chrom;
  const yChrom = linkedRegions.y_chrom || linkedRegions.chrom;

  const xRegionSize = linkedRegions.x_end - linkedRegions.x_start;
  const yRegionSize = linkedRegions.y_end - linkedRegions.y_start;
  const xBounds = isIndependentMode
    ? { min: Math.max(0, linkedRegions.x_start - xRegionSize * 10), max: linkedRegions.x_end + xRegionSize * 10 }
    : { min: linkedRegions.x_start, max: linkedRegions.x_end };
  const yBounds = isIndependentMode
    ? { min: Math.max(0, linkedRegions.y_start - yRegionSize * 10), max: linkedRegions.y_end + yRegionSize * 10 }
    : { min: linkedRegions.y_start, max: linkedRegions.y_end };

  // Track heights within each panel
  const headerHeight = 28;
  const axisHeight = 25;
  const geneHeight = 60;
  const numDatasets = isIndependentMode ? Math.max(1, datasets.length) : 1;

  // Zoom/pan helper functions
  const clampToBounds = (start: number, end: number, bounds: { min: number; max: number }) => {
    const size = end - start;
    let newStart = start;
    let newEnd = end;

    if (newStart < bounds.min) {
      newStart = bounds.min;
      newEnd = Math.min(bounds.max, newStart + size);
    }
    if (newEnd > bounds.max) {
      newEnd = bounds.max;
      newStart = Math.max(bounds.min, newEnd - size);
    }

    return { start: newStart, end: newEnd };
  };

  const handleZoom = (
    currentStart: number,
    currentEnd: number,
    factor: number,
    bounds: { min: number; max: number },
    setViewport: (start: number, end: number) => void
  ) => {
    const size = currentEnd - currentStart;
    const center = (currentStart + currentEnd) / 2;
    let newSize = Math.round(size * factor);

    const maxSize = bounds.max - bounds.min;
    newSize = Math.max(1000, Math.min(maxSize, newSize));

    let newStart = Math.round(center - newSize / 2);
    let newEnd = Math.round(center + newSize / 2);

    const clamped = clampToBounds(newStart, newEnd, bounds);
    setViewport(clamped.start, clamped.end);
  };

  const handlePan = (
    currentStart: number,
    currentEnd: number,
    direction: number,
    bounds: { min: number; max: number },
    setViewport: (start: number, end: number) => void
  ) => {
    const size = currentEnd - currentStart;
    const shift = Math.round(size * 0.25 * direction);

    const clamped = clampToBounds(currentStart + shift, currentEnd + shift, bounds);
    setViewport(clamped.start, clamped.end);
  };

  const handleReset = (
    bounds: { min: number; max: number },
    setViewport: (start: number, end: number) => void
  ) => {
    setViewport(bounds.min, bounds.max);
  };

  const renderPanel = (
    label: string,
    regionChrom: string,
    regionStart: number,
    regionEnd: number,
    isXPanel: boolean,
    bounds: { min: number; max: number },
    setViewport: (start: number, end: number) => void,
    thisViewportFilter: boolean,
    toggleThisViewportFilter: () => void,
    setThisVisibleReadIds: (ids: Set<string>) => void
  ) => {
    const isZoomed = regionStart > bounds.min || regionEnd < bounds.max;
    // Each panel shows bases (and makes room for them) by its own current size.
    const showSequence = hasFasta && (regionEnd - regionStart) <= 2000;
    const totalReadTrackHeight = linkedPanelHeight - headerHeight - axisHeight - geneHeight - (showSequence ? SEQUENCE_HEIGHT : 0);
    const perDatasetHeight = Math.floor(totalReadTrackHeight / numDatasets);

    const handleWheel = (e: React.WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 1.3 : 0.7;
      handleZoom(regionStart, regionEnd, factor, bounds, setViewport);
    };

    return (
      <div
        className="flex flex-col"
        style={{
          width: panelWidth,
          height: linkedPanelHeight,
          borderRight: isXPanel ? '2px solid #d1d5db' : 'none',
        }}
        onWheel={handleWheel}
      >
        {/* Panel header with zoom controls */}
        <div
          className="flex items-center justify-between px-2 border-b"
          style={{
            height: headerHeight,
            backgroundColor: isXPanel ? '#dbeafe' : '#fef3c7',
            borderColor: isXPanel ? '#93c5fd' : '#fcd34d',
          }}
        >
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm" style={{ color: isXPanel ? '#1e40af' : '#92400e' }}>
              {label}
            </span>
            {/* Zoom/pan controls */}
            <div className="flex items-center gap-1">
              <button
                onClick={() => handlePan(regionStart, regionEnd, isReversed ? 1 : -1, bounds, setViewport)}
                className="px-1.5 py-0.5 text-xs bg-white/50 rounded hover:bg-white/80"
                title="Pan left"
              >
                {'\u2190'}
              </button>
              <button
                onClick={() => handleZoom(regionStart, regionEnd, 0.5, bounds, setViewport)}
                className="px-1.5 py-0.5 text-xs bg-white/50 rounded hover:bg-white/80"
                title="Zoom in"
              >
                +
              </button>
              <button
                onClick={() => handleZoom(regionStart, regionEnd, 2.0, bounds, setViewport)}
                className="px-1.5 py-0.5 text-xs bg-white/50 rounded hover:bg-white/80"
                title="Zoom out"
              >
                {'\u2212'}
              </button>
              <button
                onClick={() => handlePan(regionStart, regionEnd, isReversed ? -1 : 1, bounds, setViewport)}
                className="px-1.5 py-0.5 text-xs bg-white/50 rounded hover:bg-white/80"
                title="Pan right"
              >
                {'\u2192'}
              </button>
              {isZoomed && (
                <button
                  onClick={() => handleReset(bounds, setViewport)}
                  className="px-1.5 py-0.5 text-xs bg-amber-200 rounded hover:bg-amber-300 text-amber-800"
                  title="Reset to full region"
                  aria-label="Reset to full region"
                >
                  <RotateCcw size={12} />
                </button>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono" style={{ color: isXPanel ? '#3b82f6' : '#d97706' }}>
              {regionChrom}:{regionStart.toLocaleString()}-{regionEnd.toLocaleString()}
            </span>
            {isMoleculeLinkedMode && (
              <span className="text-xs px-1.5 py-0.5 rounded" style={{
                backgroundColor: isXPanel ? '#bfdbfe' : '#fde68a',
                color: isXPanel ? '#1d4ed8' : '#b45309',
              }}>
                {linkedFilteredIds ? `${linkedFilteredIds.size}/${linkedReadCount}` : linkedReadCount} reads
              </span>
            )}
            {isMoleculeLinkedMode && (
              <label className="flex items-center gap-1 text-xs cursor-pointer" title="Filter to reads visible in this viewport (applies to both panels)">
                <input
                  type="checkbox"
                  checked={thisViewportFilter}
                  onChange={toggleThisViewportFilter}
                  className="w-3 h-3"
                />
                <span style={{ color: isXPanel ? '#1e40af' : '#92400e' }}>filter {isXPanel ? 'X' : 'Y'}</span>
              </label>
            )}
          </div>
        </div>

        {/* Axis */}
        <div style={{ height: axisHeight }}>
          <AxisTrack
            width={panelWidth}
            height={axisHeight}
            overrideChrom={regionChrom}
            overrideStart={regionStart}
            overrideEnd={regionEnd}
            onViewportChange={(newStart, newEnd) => {
              const clamped = clampToBounds(newStart, newEnd, bounds);
              setViewport(clamped.start, clamped.end);
            }}
          />
        </div>

        {/* Read track(s) */}
        <div style={{ height: totalReadTrackHeight, flex: 1, display: 'flex', flexDirection: 'column' }}>
          {isIndependentMode ? (
            datasets.length > 0 ? datasets.map((ds, idx) => (
              <div key={ds.id} style={{ height: perDatasetHeight, borderTop: idx > 0 ? '1px solid #e5e7eb' : 'none' }}>
                {datasets.length > 1 && (
                  <div className="text-xs px-2 py-0.5 bg-gray-50 text-gray-600 border-b border-gray-200 truncate" title={getDatasetHoverLabel(ds)}>
                    {getDatasetDisplayLabel(ds)}
                  </div>
                )}
                <ReadTrack
                  width={panelWidth}
                  height={datasets.length > 1 ? perDatasetHeight - 20 : perDatasetHeight}
                  overrideChrom={regionChrom}
                  overrideStart={regionStart}
                  overrideEnd={regionEnd}
                  panelLabel={`${label} - ${getDatasetDisplayLabel(ds)}`}
                  disableSpanning={true}
                  datasetId={ds.id}
                  datasetLabel={getDatasetDisplayLabel(ds)}
                  datasetColor={ds.color}
                  panScope={`split:${isXPanel ? 'x' : 'y'}`}
                  onViewportChange={(newStart, newEnd) => {
                    const clamped = clampToBounds(newStart, newEnd, bounds);
                    setViewport(clamped.start, clamped.end);
                  }}
                />
              </div>
            )) : (
              <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
                No datasets loaded
              </div>
            )
          ) : (
            <ReadTrack
              width={panelWidth}
              height={totalReadTrackHeight}
              overrideChrom={regionChrom}
              overrideStart={regionStart}
              overrideEnd={regionEnd}
              panelLabel={label}
              disableSpanning={true}
              linkedSessionId={currentLinkedSessionId ?? undefined}
              linkedRegion={isXPanel ? 'x' : 'y'}
              linkedBoundsStart={bounds.min}
              linkedBoundsEnd={bounds.max}
              linkedSortBy={linkedSortBy}
              linkedFilteredIds={linkedFilteredIds}
              linkedHighlightIds={highlightLinkedMolecules ? linkedReadBaseIds : undefined}
              onVisibleReadsChange={setThisVisibleReadIds}
              panScope={`split:${isXPanel ? 'x' : 'y'}`}
              onViewportChange={(newStart, newEnd) => {
                const clamped = clampToBounds(newStart, newEnd, bounds);
                setViewport(clamped.start, clamped.end);
              }}
            />
          )}
        </div>

        {/* Sequence track */}
        {showSequence && (
          <div style={{ height: SEQUENCE_HEIGHT }} className="border-t border-gray-200">
            <SequenceTrack
              width={panelWidth}
              height={SEQUENCE_HEIGHT}
              overrideChrom={regionChrom}
              overrideStart={regionStart}
              overrideEnd={regionEnd}
            />
          </div>
        )}

        {/* Gene track */}
        <div style={{ height: geneHeight }} className="border-t border-gray-200">
          <GeneTrack
            width={panelWidth}
            height={geneHeight}
            overrideChrom={regionChrom}
            overrideStart={regionStart}
            overrideEnd={regionEnd}
          />
        </div>
      </div>
    );
  };

  return (
    <div ref={containerRef} data-export-container className="h-full w-full bg-white overflow-hidden flex flex-col">
      {/* Control bar */}
      <div
        className="flex items-center justify-between px-4 bg-gray-100 border-b border-gray-300"
        style={{ height: controlBarHeight }}
      >
        <div className="flex items-center gap-4">
          {isIndependentMode ? (
            <>
              <span className="font-semibold text-gray-700">Region-Independent Split View</span>
              <span className="text-sm text-gray-500">
                {datasets.length} dataset{datasets.length !== 1 ? 's' : ''} &bull; Independent reads per region
              </span>
            </>
          ) : (
            <>
              <span className="font-semibold text-gray-700">Molecule-Linked Split View</span>
              <span className="text-sm text-gray-500">
                {linkedReadCount} paired reads
              </span>
              <button
                onClick={toggleLinkedSortBy}
                className="px-2 py-1 text-xs rounded bg-purple-100 text-purple-700 hover:bg-purple-200 flex items-center gap-1"
                title={`Currently sorted by ${linkedSortBy.toUpperCase()} start position. Click to swap.`}
              >
                <span>Sort by:</span>
                <span className="font-semibold" style={{
                  color: linkedSortBy === 'x' ? '#1e40af' : '#92400e'
                }}>
                  {linkedSortBy.toUpperCase()}
                </span>
                <span>{'\u21C4'}</span>
              </button>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          {isMoleculeLinkedMode && (
            <label
              className="flex items-center gap-1.5 text-xs cursor-pointer"
              title="Visually mark all molecule-linked reads. Shift-click/read-mode clicks still select paired molecules across both panels."
            >
              <input
                type="checkbox"
                checked={highlightLinkedMolecules}
                onChange={toggleHighlightLinkedMolecules}
                className="w-3.5 h-3.5"
              />
              <span className="text-gray-600">Highlight linked</span>
            </label>
          )}
          {isMoleculeLinkedMode && (
            <label className="flex items-center gap-1.5 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={showUnlinkedReads}
                onChange={toggleShowUnlinkedReads}
                className="w-3.5 h-3.5"
              />
              <span className="text-gray-600">Show unlinked reads</span>
            </label>
          )}
          <button
            onClick={() => {
              if (datasets.length > 0) {
                useBrowserStore.getState().setFilteredReadIds(datasets[0].id, undefined as any);
              }
              useBrowserStore.getState().setViewMode('stacked');
            }}
            className="px-2 py-1 text-xs rounded bg-gray-200 text-gray-700 hover:bg-gray-300 ml-2"
          >
            Exit
          </button>
        </div>
      </div>

      {/* Split panels */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex flex-row" style={{ height: linkedPanelHeight }}>
          {renderPanel('Locus X', xChrom, xStart, xEnd, true, xBounds, setXViewport, xViewportFilter, toggleXViewportFilter, setXVisibleReadIds)}
          {renderPanel('Locus Y', yChrom, yStart, yEnd, false, yBounds, setYViewport, yViewportFilter, toggleYViewportFilter, setYVisibleReadIds)}
        </div>

        {/* Background reads row for molecule-linked mode only */}
        {showUnlinkedReads && isMoleculeLinkedMode && (
          <div className="flex flex-row border-t-2 border-gray-400" style={{ height: unlinkedPanelHeight }}>
            {/* X region unlinked reads */}
            <div
              className="flex flex-col"
              style={{
                width: panelWidth,
                height: unlinkedPanelHeight,
                borderRight: '2px solid #d1d5db',
              }}
            >
              <div
                className="flex items-center justify-between px-2 border-b"
                style={{
                  height: 24,
                  backgroundColor: '#f3f4f6',
                  borderColor: '#d1d5db',
                }}
              >
                <span className="text-xs text-gray-600 font-medium">Unlinked reads (X region)</span>
              </div>
              <div style={{ flex: 1 }}>
                <ReadTrack
                  width={panelWidth}
                  height={unlinkedPanelHeight - 24}
                  overrideChrom={xChrom}
                  overrideStart={xStart}
                  overrideEnd={xEnd}
                  panelLabel="Unlinked X"
                  disableSpanning={true}
                  excludeIds={linkedReadBaseIds}
                />
              </div>
            </div>

            {/* Y region unlinked reads */}
            <div
              className="flex flex-col"
              style={{
                width: panelWidth,
                height: unlinkedPanelHeight,
              }}
            >
              <div
                className="flex items-center justify-between px-2 border-b"
                style={{
                  height: 24,
                  backgroundColor: '#f3f4f6',
                  borderColor: '#d1d5db',
                }}
              >
                <span className="text-xs text-gray-600 font-medium">Unlinked reads (Y region)</span>
              </div>
              <div style={{ flex: 1 }}>
                <ReadTrack
                  width={panelWidth}
                  height={unlinkedPanelHeight - 24}
                  overrideChrom={yChrom}
                  overrideStart={yStart}
                  overrideEnd={yEnd}
                  panelLabel="Unlinked Y"
                  disableSpanning={true}
                  excludeIds={linkedReadBaseIds}
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
