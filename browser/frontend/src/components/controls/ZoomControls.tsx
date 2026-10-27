import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../stores/browserStore';
import { formatBp } from '../../utils/coordinates';
import { findChromInfo } from '../../utils/chromAliases';
import { findTopLocus, isTopLocusStep, resetTopLoci, type TopLocusStep } from '../../utils/topLoci';
import { sameChrom } from '../../utils/chromAliases';
import { ArrowLeft, ArrowRight, Plus, Minus, Crosshair } from '../ui/Icons';

export function ZoomControls() {
  const {
    start, end, setViewport, chrom,
    isReversed, datasetCount,
  } = useBrowserStore(useShallow(s => ({
    start: s.start, end: s.end, setViewport: s.setViewport, chrom: s.chrom,
    isReversed: s.isReversed, datasetCount: s.datasets.length,
  })));

  const currentSize = end - start;
  const [randomLoading, setRandomLoading] = useState(false);
  const [locus, setLocus] = useState<TopLocusStep | null>(null);
  // New datasets or another genome (a ranking holds windows on the old
  // reference's contigs): rank again from the top.
  const datasetKey = useBrowserStore(s => s.datasets.map(d => d.id).join(','));
  const referenceKey = useBrowserStore(s => `${s.currentGenome ?? ''}|${s.fastaPath ?? ''}|${s.chroms.length}|${s.chroms.reduce((n, c) => n + (c.size || 0), 0)}`);
  useEffect(() => { resetTopLoci(); setLocus(null); }, [datasetKey, referenceKey]);
  // The k/N label describes the locus on screen; it goes once you move away.
  const shownLocus = locus && sameChrom(locus.window.chrom, chrom) && start < locus.window.end && end > locus.window.start ? locus : null;

  // The best-covered loci at this zoom, deepest first; each click goes to the next.
  // A click while it searches cancels the search.
  const searchRef = useRef<AbortController | null>(null);
  useEffect(() => () => searchRef.current?.abort(), []);
  const handleTopLocus = async () => {
    if (randomLoading) {
      searchRef.current?.abort();
      return;
    }
    if (datasetCount === 0) return;
    const controller = new AbortController();
    searchRef.current = controller;
    setRandomLoading(true);
    try {
      const result = await findTopLocus(currentSize, undefined, { signal: controller.signal });
      if (isTopLocusStep(result)) {
        setLocus(result);
        useBrowserStore.getState().recordJump(null, { to: result.window });  // Back (Alt+←) returns here
        setViewport(result.window.chrom, result.window.start, result.window.end);
      } else if (result.reason !== 'cancelled') {
        useBrowserStore.getState().setError(result.message);
      }
    } finally {
      if (searchRef.current === controller) searchRef.current = null;
      setRandomLoading(false);
    }
  };

  const handleZoomIn = () => {
    const center = (start + end) / 2;
    const newSize = Math.max(1000, currentSize / 1.5);
    setViewport(chrom, Math.round(center - newSize / 2), Math.round(center + newSize / 2));
  };

  const handleZoomOut = () => {
    const center = (start + end) / 2;
    const chroms = useBrowserStore.getState().chroms;
    const chromInfo = findChromInfo(chroms, chrom);
    const maxSize = chromInfo ? chromInfo.size : 10_000_000;
    const newSize = Math.min(maxSize, currentSize * 1.5);
    const newStart = chromInfo?.circular
      ? Math.round(center - newSize / 2)
      : Math.max(0, Math.round(center - newSize / 2));
    setViewport(chrom, newStart, Math.round(center + newSize / 2));
  };

  const { panLeft, panRight } = useBrowserStore(useShallow(s => ({
    panLeft: s.panLeft, panRight: s.panRight,
  })));

  // On the button too (its own tooltip); the span keeps it when the button is disabled.
  const topLocusTitle = randomLoading
    ? 'Searching for reads… click to cancel'
    : shownLocus
      ? `Locus ${shownLocus.index + 1} of ${shownLocus.total}: depth ${shownLocus.window.depth.toLocaleString()} at ${shownLocus.window.chrom}:${shownLocus.window.start.toLocaleString()}. Click for the next.`
      : 'Go to the best-covered locus at this zoom; click again for the next (deepest first)';

  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1"
      title="Pan with arrow keys. Zoom the genomic viewport with ArrowUp/ArrowDown or +/-."
    >
      {/* Back / Forward, then Zoom out, the width readout and Zoom in */}
      <button
        onClick={isReversed ? panRight : panLeft}
        className="btn-tool-default px-2"
        title="Shift view left 25% (keyboard: ←)"
        aria-label="Pan left"
        data-testid="pan-left-button"
      >
        <ArrowLeft size={14} />
      </button>
      <button
        onClick={isReversed ? panLeft : panRight}
        className="btn-tool-default px-2"
        title="Shift view right 25% (keyboard: →)"
        aria-label="Pan right"
        data-testid="pan-right-button"
      >
        <ArrowRight size={14} />
      </button>
      <button
        onClick={handleZoomOut}
        className="btn-tool-default px-2"
        title="Zoom out 1.5x (keyboard: ↓ or -)"
        aria-label="Zoom out"
        data-testid="zoom-out-button"
      >
        <Minus size={14} />
      </button>
      <span
        className="hidden sm:inline text-[13px] font-mono tabular-nums text-tool-500 min-w-14 text-center"
        title="Current viewport width. Use ↑/↓ or +/- to zoom the genomic viewport. Cmd/Ctrl+scroll over reads adjusts row height."
      >
        {formatBp(currentSize)}
      </span>
      <button
        onClick={handleZoomIn}
        className="btn-tool-default px-2"
        title="Zoom in 1.5x (keyboard: ↑ or +)"
        aria-label="Zoom in"
        data-testid="zoom-in-button"
      >
        <Plus size={14} />
      </button>

      {/* Step through the best-covered loci at this zoom, deepest first
          (for sparse or targeted data, where most of the genome is empty). */}
      <span className="flex items-center gap-1" title={topLocusTitle}>
        <button
          onClick={handleTopLocus}
          title={topLocusTitle}
          disabled={!randomLoading && datasetCount === 0}
          className={`btn-tool-default px-2 disabled:opacity-40${randomLoading ? ' animate-pulse' : ''}`}
          aria-label={randomLoading ? 'Searching for reads: click to cancel' : 'Go to the next best-covered locus'}
          aria-busy={randomLoading}
          data-testid="random-window-button"
        >
          <Crosshair size={14} />
        </button>
        {shownLocus && <span className="text-[11px] tabular-nums text-tool-500" data-testid="top-locus-position">{shownLocus.index + 1}/{shownLocus.total}</span>}
      </span>

    </div>
  );
}

/**
 * Full-length, Reverse and TSS± beside the zoom controls. Full-length is a read filter, so it stays on in Per panel
 * mode (owner, 6 Oct); Reverse and TSS± follow the main view and are off with the main navigation then.
 */
export function ViewToggles({ navDisabled = false }: { navDisabled?: boolean }) {
  const {
    spanningOnly, setSpanningOnly,
    isReversed, toggleReversed,
    showRelativeCoords, toggleRelativeCoords,
    selectedGenes,
  } = useBrowserStore(useShallow(s => ({
    spanningOnly: s.spanningOnly, setSpanningOnly: s.setSpanningOnly,
    isReversed: s.isReversed, toggleReversed: s.toggleReversed,
    showRelativeCoords: s.showRelativeCoords, toggleRelativeCoords: s.toggleRelativeCoords,
    selectedGenes: s.selectedGenes,
  })));
  return (
    <div className="flex items-center gap-x-1" data-testid="view-toggles">
      <label
        data-copilot-anchor="spanning-only-toggle"
        className="ml-1 flex items-center gap-1 text-[12px] text-gray-700 cursor-pointer dark:text-gray-300"
        title="Only show reads that cover the whole view edge to edge. Off shows every read overlapping the view."
      >
        <input
          type="checkbox"
          checked={spanningOnly}
          onChange={e => setSpanningOnly(e.target.checked)}
        />
        Full-length
      </label>
      <label
        className={`flex items-center gap-1 text-[12px] text-gray-700 cursor-pointer dark:text-gray-300${navDisabled ? ' opacity-40' : ''}`}
        title={navDisabled ? "Use Reverse in each panel’s header menu in Per panel mode." : "Reverse view direction (3' to 5'). Reads flip horizontally and coordinates invert."}
        data-tour="reverse-view"
      >
        <input
          type="checkbox"
          checked={isReversed}
          onChange={() => toggleReversed()}
          disabled={navDisabled}
        />
        <span className="hidden md:inline">Reverse</span>
        <span className="md:hidden">Rev</span>
      </label>
      <label
        className={`flex items-center gap-1 text-[12px] text-gray-700 cursor-pointer dark:text-gray-300 ${
          navDisabled ? 'opacity-40' : selectedGenes.length === 0 && !showRelativeCoords ? 'opacity-50' : ''
        }`}
        title="TSS-relative coordinates. Select a gene first unless relative coordinates are already active."
        data-tour="relative-coords"
      >
        <input
          type="checkbox"
          checked={showRelativeCoords}
          onChange={() => toggleRelativeCoords()}
          disabled={navDisabled || (selectedGenes.length === 0 && !showRelativeCoords)}
        />
        TSS&plusmn;
      </label>
    </div>
  );
}
