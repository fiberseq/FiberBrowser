import { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { useBrowserStore } from '../../../stores/browserStore';
import { useConsensusViewStore } from '../../../stores/consensusViewStore';
import { consensusPrimaryFamily } from '../../../utils/consensusVisual';
import { useEphemeralStore } from '../../../stores/ephemeralStore';
import type { SelectedFootprint } from '../../../types';
import type { CompactRead, SvCluster, SvEvent, SvSummary } from './types';
import { readSvEventAt } from './svDrawing';
import { useReadActionsStore } from '../../../stores/readActionsStore';
import { copyInsertedSequence } from '../../../utils/svInsertedSequence';
import { DEBUG } from '../../../stores/utils';
import { findFootprintHit } from './footprintHitTest';
import { computeReadTrackLayout, nextReadRowHeight, type ReadSeparatorMode } from './layout';
import { clusterAssignmentForRead } from './readFilter';
import { tfFamilyDisplayGeometry, tfFamilyMetadata } from '../../../utils/tfFamilies';
import { findChromInfo } from '../../../utils/chromAliases';
import { panelGenomeChroms } from '../../../stores/panelGenomeStore';
import { FOOTPRINT_ANALYSIS_TAB_STORAGE_KEY } from '../../controls/footprint-analysis/constants';
import { beginPointerDrag, clearDocumentSelection, endPointerDrag } from '../../../utils/pointerDrag';
import { maybeShowReadActionsHint } from '../../../stores/readActionsStore';
import { liveLiftHitAt, type LiveLiftBadge } from './liveLiftCanvas';
import type { LiftAxis } from '../../../features/liveLift/axis';
import { selectReadDifference } from '../../../features/liveLift/inspectionStore';

const IS_MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

/** ⌘-click on a Mac, Ctrl-click elsewhere (on a Mac, Ctrl-click is the right-click). */
export function isFootprintClick(e: { metaKey: boolean; ctrlKey: boolean }, isMac = IS_MAC): boolean {
  return isMac ? e.metaKey : (e.ctrlKey || e.metaKey);
}

/** What the right-click menu acts on: the read and footprint under the pointer. */
export interface ReadContextTarget {
  clientX: number;
  clientY: number;
  /** Canvas coordinates (for the footprint hit test when an action runs). */
  x: number;
  y: number;
  read: CompactRead | null;
  liveLiftBadge?: LiveLiftBadge;
  footprint: FootprintHit | null;
  /** Genome position under the pointer. */
  genomePos: number;
  /** Opened on the SV summary band (fb-n9-sv), on this cluster (null: between clusters). */
  inSvBand?: boolean;
  svCluster?: SvCluster | null;
}

/** What the pointer is over in SV terms (fb-n9-sv): a band cluster, or a read's SV. */
export type SvHover =
  | { kind: 'cluster'; cluster: SvCluster; x: number; y: number }
  | { kind: 'event'; read: CompactRead; event: Extract<SvEvent, { t: 'D' | 'I' }>; x: number; y: number };

export interface FootprintHit {
  read: CompactRead;
  intervalIndex: number;
  interval: [number, number, number];
  layer?: string | null;
}


interface UseReadTrackMouseParams {
  axis?: LiftAxis;
  displayReads: CompactRead[];
  width: number;
  height: number;
  sidebarWidth: number;
  regionWidth: number;
  start: number;
  end: number;
  chrom: string;
  datasetId: string;
  stateKey: string;    // key for per-panel state (clusters, filters, sort). Same as datasetId for non-duplicated panels.
  datasetLabel?: string;
  datasetColor?: string;
  hasCluster: boolean;
  myClusterAssignments: Record<string, number>;
  myClusterOrder: number[];
  myClusterFocus: Set<number> | null;
  mySelectedClusters: Set<number> | null;
  hasClusterFocus: boolean;
  isPanning: boolean;
  isReversed: boolean;
  fillReadHeight: boolean;
  storeReadRowHeight: number | 'auto';
  readScrollOffset: number;
  readSeparatorMode: ReadSeparatorMode;
  readSeparatorMinHeight: number;
  readSeparatorWidth: number;
  showReadTooltip: boolean;
  showCoverageHistogram: boolean;
  linkedBoundsStart?: number;
  linkedSessionId?: string;
  onViewportChange?: (start: number, end: number) => void;
  /** View this track shows (usePanOffsetTransform scope): 'main', or the
   * panel's own when it navigates on its own. */
  panScope?: string;
  /** The panel's own reference (PanelConfig.genome): its chromosome topology bounds a pan. */
  genome?: string;
  /** SV display (fb-n9-sv): the band above the rows and what it shows. */
  svEnabled?: boolean;
  svMinLen?: number;
  svBandHeight?: number;
  svSummary?: SvSummary | null;
}

export function useReadTrackMouse(params: UseReadTrackMouseParams) {
  const {
    displayReads, width, height, sidebarWidth, regionWidth, start, end, chrom, datasetId, stateKey,
    datasetLabel, datasetColor,
    hasCluster, myClusterAssignments, myClusterOrder,
    isPanning, isReversed, fillReadHeight, storeReadRowHeight, readScrollOffset,
    readSeparatorMode, readSeparatorMinHeight, readSeparatorWidth,
    showReadTooltip, showCoverageHistogram,
    linkedBoundsStart, linkedSessionId, onViewportChange, panScope = 'main', genome,
    svEnabled = false, svMinLen = 50, svBandHeight = 0, svSummary = null,
  } = params;

  // Drag state for cluster reordering
  const [dragCluster, setDragCluster] = useState<number | null>(null);
  const [dragY, setDragY] = useState<number | null>(null);
  const [hoverCluster, setHoverCluster] = useState<number | null>(null);
  const [hoverY, setHoverY] = useState<number | null>(null);

  // Per-read selection from global store (multi-select)
  const selectedReadIds = useBrowserStore(s => s.selectedReadIds[stateKey]);

  // Hover tooltip state
  const [hoveredRead, setHoveredRead] = useState<{read: CompactRead; x: number; y: number; liveLiftBadge?: LiveLiftBadge} | null>(null);
  const [hoveredSv, setHoveredSv] = useState<SvHover | null>(null);

  // Pan drag tracking. The drag belongs to the track it started on: that
  // track's own document listeners (attached on mousedown, removed on mouseup)
  // move and commit it. They used to hang off the shared isPanning flag, so
  // with two panels open the first panel's mouseup cleared the flag and tore
  // down the dragged panel's listeners before they ran: only the leftmost
  // panel panned, the others snapped back.
  const panDragCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => { panDragCleanupRef.current?.(); }, []);

  // Shared layout computation — computed once, reused by getReadAtY, getClusterAtY, handleWheel
  const headerHeight = (datasetLabel ? 16 : 0) + (params.axis?.blocks.length ? 24 : 0);
  // The SV band and the coverage histogram sit between the header and the rows (as drawn).
  const histH = (showCoverageHistogram ? 30 : 0) + svBandHeight;
  const n = displayReads.length;
  const layout = useMemo(
    () => computeReadTrackLayout(
      n,
      height,
      headerHeight,
      histH,
      fillReadHeight,
      storeReadRowHeight,
      readScrollOffset,
      readSeparatorMode,
      readSeparatorMinHeight,
      readSeparatorWidth,
    ),
    [n, height, headerHeight, histH, fillReadHeight, storeReadRowHeight, readScrollOffset, readSeparatorMode, readSeparatorMinHeight, readSeparatorWidth]
  );

  // Pre-compute cluster boundaries once (not on every mouse move)
  const clusterBoundsMap = useMemo(() => {
    if (!hasCluster || n === 0) return null;
    const { rowHeight, rowGap, scrollAdjust } = layout;
    const bounds: Map<number, { startY: number; endY: number }> = new Map();
    for (let i = 0; i < n; i++) {
      const read = displayReads[i];
      const rowY = headerHeight + histH + i * (rowHeight + rowGap) - scrollAdjust;
      const cluster = clusterAssignmentForRead(myClusterAssignments, read.id);
      if (cluster !== undefined) {
        if (!bounds.has(cluster)) {
          bounds.set(cluster, { startY: rowY, endY: rowY + rowHeight });
        } else {
          bounds.get(cluster)!.endY = rowY + rowHeight;
        }
      }
    }
    return bounds;
  }, [hasCluster, n, displayReads, myClusterAssignments, layout, headerHeight, histH]);

  // Compute cluster at Y position using pre-computed bounds
  const getClusterAtY = useCallback((y: number): number | null => {
    if (!clusterBoundsMap) return null;
    for (const [cluster, bounds] of clusterBoundsMap) {
      if (y >= bounds.startY && y < bounds.endY) {
        return cluster;
      }
    }
    return null;
  }, [clusterBoundsMap]);

  // Get the read at a given Y position using shared layout
  const getReadAtY = useCallback((y: number): CompactRead | null => {
    if (n === 0) return null;
    const { rowHeight, rowGap, scrollAdjust } = layout;
    const adjustedY = y - headerHeight - histH + scrollAdjust;
    const readIndex = Math.floor(adjustedY / (rowHeight + rowGap));
    if (readIndex >= 0 && readIndex < n) {
      return displayReads[readIndex];
    }
    return null;
  }, [displayReads, n, layout, headerHeight, histH]);

  /** Native rows keep their existing Y selection; lifted rows have empty connectors and gaps even on that Y. */
  const getReadHitAtXY = useCallback((x: number, y: number): { read: CompactRead; liveLiftBadge?: LiveLiftBadge } | null => {
    const read = getReadAtY(y);
    if (!read) return null;
    const block = params.axis?.fromX(x - sidebarWidth);
    if (block?.ins_id) {
      const payload = read.live_lift?.insertions?.[block.ins_id];
      return payload && !('too_large' in payload) && block.within! >= payload.covered[0] && block.within! < payload.covered[1] ? { read } : null;
    }
    if (!read.live_lift) return { read };
    if (x < sidebarWidth || x >= width || y < headerHeight + histH || y >= height) return null;
    const { rowHeight, rowGap, scrollAdjust } = layout;
    const index = Math.floor((y - headerHeight - histH + scrollAdjust) / (rowHeight + rowGap));
    const scale = (width - sidebarWidth) / regionWidth;
    const hit = liveLiftHitAt(read.live_lift, x, y, {
      y: headerHeight + histH + index * (rowHeight + rowGap) - scrollAdjust,
      rowHeight: Math.max(1, rowHeight - rowGap),
      linkedOffset: linkedBoundsStart !== undefined ? linkedBoundsStart - start : 0,
      regionWidth,
      toX: rel => sidebarWidth + (params.axis ? params.axis.toX(start + rel) : (isReversed ? regionWidth - rel : rel) * scale),
    });
    return hit ? { read, liveLiftBadge: hit.badge } : null;
  }, [getReadAtY, sidebarWidth, width, height, headerHeight, histH, layout, regionWidth, linkedBoundsStart, start, isReversed, params.axis]);

  // --- SV events on reads (fb-n9-sv); the SV summary is its own track (SvTrack) ---
  const genomePosAtX = useCallback((x: number) => {
    if (params.axis) return params.axis.fromX(x - sidebarWidth).pos;
    const scl = (width - sidebarWidth) / Math.max(1, regionWidth);
    const rel = (x - sidebarWidth) / scl;
    return isReversed ? end - rel : start + rel;
  }, [width, sidebarWidth, regionWidth, isReversed, start, end, params.axis]);
  /** The SV event of the read at (x, y) within a few pixels. */
  const svEventAtXY = useCallback((x: number, y: number) => {
    if (!svEnabled) return null;
    const read = getReadHitAtXY(x, y)?.read;
    if (!read?.sv) return null;
    const bpPerPx = regionWidth / Math.max(1, width - sidebarWidth);
    const event = readSvEventAt(read, genomePosAtX(x), 5 * bpPerPx, svMinLen);
    return event ? { read, event } : null;
  }, [svEnabled, getReadHitAtXY, regionWidth, width, sidebarWidth, genomePosAtX, svMinLen]);

  // Map pixel (x, y) to a specific footprint interval on a read.
  //
  // TF and other layer footprints can be 5-30bp — at typical viewport scales
  // (e.g. 100kb across 1500px) that is sub-pixel, so a precise hit test
  // misses them. We do two things to make small overlays clickable:
  //   1. Click tolerance: expand each layer interval by ~3 pixels worth of
  //      bp on each side for hit testing.
  //   2. Best-match selection: if multiple layer intervals match, pick the
  //      smallest one (a tiny TF inside a larger nuc rendering should win).
  //   3. Optional clickTargetLayer scoping: when set, hit-test is restricted
  //      to that layer (set via the FootprintAnalysisPanel preference).
  const getFootprintAtXY = useCallback((pixelX: number, pixelY: number, assignedClassesOnly = false) => {
    const read = getReadHitAtXY(pixelX, pixelY)?.read;
    if (!read) return null;

    const trackWidth = width - sidebarWidth;
    const scl = trackWidth / regionWidth;
    const linkedOff = (linkedBoundsStart !== undefined) ? linkedBoundsStart - start : 0;
    const pxTolerance = 3;
    const bpTolerance = scl > 0 ? pxTolerance / scl : 0;
    // The click-target control is only shown with analysis details on.
    const clickTargetLayer = useBrowserStore.getState().showAnalysisDetails
      ? useBrowserStore.getState().clickTargetLayer : null;
    const enabledModTypes = useBrowserStore.getState().enabledModTypes as Record<string, boolean>;
    // Match the renderer: in 'loose' edge mode footprints grow to their liberal
    // boundary, so expand the click target by the same amount.
    const edgeAmbiguity = useBrowserStore.getState().activeColormap?.edgeAmbiguity;
    const footprintGroups = useBrowserStore.getState().footprintGroups;

    if (params.axis?.fromX(pixelX - sidebarWidth).ins_id) return null;
    let relPos: number;
    if (params.axis) {
      relPos = params.axis.fromX(pixelX - sidebarWidth).pos - start;
    } else if (isReversed) {
      relPos = regionWidth - (pixelX - sidebarWidth) / scl;
    } else {
      relPos = (pixelX - sidebarWidth) / scl;
    }

    const hit = findFootprintHit(read, {
      relPos,
      bpTolerance,
      linkedOffset: linkedOff,
      clickTargetLayer: assignedClassesOnly ? null : clickTargetLayer,
      assignedClassesOnly,
      enabledModTypes,
      edgeAmbiguity,
      displayBounds: (layerName, intervalIndex, interval) => {
        if (
          layerName !== 'tf_sr'
          && layerName !== 'tf_consensus'
          && layerName !== 'tf_cross_consensus'
        ) return null;
        const layer = read.layers?.[layerName];
        const metadata = tfFamilyMetadata(layer, intervalIndex);
        if (!metadata) return null;
        const family = tfFamilyDisplayGeometry(
          footprintGroups,
          datasetId,
          metadata.familyId,
          start + interval[0],
          start + interval[1],
          layerName,
          metadata.familyConfidence,
              metadata.annotationName,
          chrom,
          stateKey,
        );
        if (!family || family.mode === 'molecule') return null;
        const familyStart = family.start - start;
        const familyEnd = family.end - start;
        if (family.mode === 'family') {
          return { start: familyStart, end: familyEnd };
        }
        // "Both" visibly contains the adjusted molecular block and the
        // shared family-model outline.
        return {
          start: Math.min(interval[0], familyStart),
          end: Math.max(interval[1], familyEnd),
        };
      },
    });
    if (hit) {
      return {
        read,
        intervalIndex: hit.intervalIndex,
        interval: hit.interval,
        layer: hit.layer,
      };
    }

    return null;
  }, [getReadHitAtXY, width, sidebarWidth, regionWidth, start, isReversed, linkedBoundsStart, chrom, stateKey, params.axis]);

  const startPanDrag = useCallback((clientX: number, renderedWidth: number) => {
    panDragCleanupRef.current?.();
    const panStartX = clientX;
    const panStartPos = { start, end };
    const logicalDx = (ev: MouseEvent) => (ev.clientX - panStartX) * width / (renderedWidth || width);

    const handleDocumentMouseMove = (ev: MouseEvent) => {
      useEphemeralStore.getState().setPanOffset(logicalDx(ev), panScope);
    };
    const finish = () => {
      document.removeEventListener('mousemove', handleDocumentMouseMove);
      document.removeEventListener('mouseup', handleDocumentMouseUp);
      endPointerDrag();
      panDragCleanupRef.current = null;
      useEphemeralStore.getState().setIsPanning(false);
    };
    const handleDocumentMouseUp = (ev: MouseEvent) => {
      const dx = logicalDx(ev);
      const viewportWidth = width - sidebarWidth;
      const bpPerPixel = params.axis ? 1 / params.axis.pxPerBp : (panStartPos.end - panStartPos.start) / viewportWidth;
      const bpShift = Math.round(-dx * bpPerPixel) * (isReversed ? -1 : 1);
      const windowWidth = panStartPos.end - panStartPos.start;

      let newStart = panStartPos.start + bpShift;
      let newEnd = panStartPos.end + bpShift;

      // The panel's reference: a contig circular there wraps even when the main genome lacks it.
      const chromInfo = findChromInfo(panelGenomeChroms(genome, useBrowserStore.getState().chroms), chrom);
      if (!chromInfo?.circular && newStart < 0) {
        newStart = 0;
        newEnd = windowWidth;
      }

      if (DEBUG) console.log(`[PAN] MouseUp: dx=${dx}px, bpShift=${bpShift}, scope=${panScope}, old=${panStartPos.start}-${panStartPos.end}, new=${newStart}-${newEnd}`);

      finish();
      if (Math.abs(dx) > 3) {
        // The offset stays until the new view's reads are drawn.
        if (onViewportChange) {
          onViewportChange(newStart, newEnd);
        } else {
          useBrowserStore.getState().setViewport(chrom, newStart, newEnd);
        }
      } else {
        useEphemeralStore.getState().setPanOffset(0);
      }
    };

    beginPointerDrag();
    useEphemeralStore.getState().setIsPanning(true);
    useEphemeralStore.getState().setPanOffset(0, panScope);
    document.addEventListener('mousemove', handleDocumentMouseMove);
    document.addEventListener('mouseup', handleDocumentMouseUp);
    panDragCleanupRef.current = finish;
  }, [start, end, width, sidebarWidth, isReversed, chrom, onViewportChange, panScope, genome, params.axis]);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    // Only the main button pans; a right-click (or Ctrl-click on a Mac) opens the read menu instead.
    if (e.button !== 0 || (IS_MAC && e.ctrlKey)) return;
    // Reads are a drag surface, never text: no mousedown here starts (or keeps
    // extending) a selection. preventDefault also stops the browser's usual
    // clear-the-selection-on-click, so clear it ourselves: a selection left
    // from elsewhere would otherwise stay painted over the panel while dragging.
    e.preventDefault();
    clearDocumentSelection();
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) * e.currentTarget.clientWidth / rect.width;
    const y = (e.clientY - rect.top) * e.currentTarget.clientHeight / rect.height;

    if (hasCluster && myClusterOrder.length >= 1 && x < sidebarWidth) {
      const cluster = getClusterAtY(y);
      if (cluster !== null) {
        if (myClusterOrder.length >= 2) {
          setDragCluster(cluster);
          setDragY(y);
        }
        return;
      }
    }

    if (x >= sidebarWidth) {
      setHoveredRead(null);
      // The first click on reads says what clicks do (once, remembered).
      maybeShowReadActionsHint(stateKey);
      startPanDrag(e.clientX, rect.width);
    }
  }, [hasCluster, myClusterOrder, sidebarWidth, getClusterAtY, startPanDrag, stateKey]);

  /** Select the footprint at (x, y) and open Footprints (⌘/Ctrl-click, or the menu). */
  const selectFootprintAt = useCallback((x: number, y: number): boolean => {
    // Linked-session intervals are relative to the session's bounds, not the view.
    const origin = linkedBoundsStart ?? start;
    // Native/manual string family IDs use the shared consensus inspector, not
    // the legacy numeric-ID Cart. The read's original interval remains intact.
    const consensusHit = getFootprintAtXY(x, y, true) ?? getFootprintAtXY(x, y);
    const annotation = consensusHit?.layer ? consensusHit.read.layers?.[consensusHit.layer] : undefined;
    const record = consensusHit ? annotation?.consensus_records?.[consensusHit.intervalIndex] : undefined;
    const consensusFamily = record ? consensusPrimaryFamily(record) : null;
    if (annotation?.consensus_workflow && annotation.job_id && consensusFamily && consensusHit && record) {
      const jobId = annotation.job_id;
      const view = useConsensusViewStore.getState();
      if (view.jobId === jobId) {
        view.select({ jobId, datasetId, family: consensusFamily }, true);
        useConsensusViewStore.setState({ callSelection: { jobId, datasetId, readId: consensusHit.read.id, record } });
        useBrowserStore.getState().openAnalysisPanel('footprint-analysis');
        return true;
      }
      void view.load(jobId).then(() => {
        if (useConsensusViewStore.getState().jobId === jobId) {
          useConsensusViewStore.getState().select({ jobId, datasetId, family: consensusFamily });
          useConsensusViewStore.setState({ callSelection: { jobId, datasetId, readId: consensusHit.read.id, record } });
          useBrowserStore.getState().openAnalysisPanel('footprint-analysis');
        }
      });
      return true;
    }

    const hit = getFootprintAtXY(x, y);
    if (!hit) return false;
    const { read, intervalIndex, interval, layer } = hit;
    const [relStart, relEnd, size] = interval;
    const family = layer ? tfFamilyMetadata(read.layers?.[layer], intervalIndex) : null;
    const fp: SelectedFootprint = {
      readId: read.id, datasetId, intervalIndex,
      relStart, relEnd, size,
      absStart: origin + relStart, absEnd: origin + relEnd, chrom, stateKey, genome: genome ?? null, reversed: isReversed,
      layer: layer ?? null,
      familyId: family?.familyId ?? null,
      familyAnnotationName: family?.annotationName ?? null,
      familyConfidence: family?.confidenceKind === 'unavailable' ? null : family?.familyConfidence ?? null,
      familyConfidenceKind: family?.confidenceKind ?? null,
    };
    const store = useBrowserStore.getState();
    store.selectFootprint(fp, true);
    if (family && (
      layer === 'tf_sr'
      || layer === 'tf_consensus'
      || layer === 'tf_cross_consensus'
    )) {
      const familyDisplay = tfFamilyDisplayGeometry(
        store.footprintGroups,
        datasetId,
        family.familyId,
        fp.absStart,
        fp.absEnd,
        layer,
        family.familyConfidence,
        family.annotationName,
        chrom,
        stateKey,
      );
      if (familyDisplay) {
        store.setSelectedFamilyGroupId(familyDisplay.groupId);
        window.sessionStorage.setItem(
          FOOTPRINT_ANALYSIS_TAB_STORAGE_KEY,
          'saved',
        );
        store.openAnalysisPanel('footprint-analysis');
        queueMicrotask(() => {
          window.dispatchEvent(new CustomEvent('fiberbrowser:open-footprint-analysis-tab', {
            detail: { tab: 'saved', familyGroupId: familyDisplay.groupId },
          }));
        });
        return true;
      }
    }
    store.openAnalysisPanel('footprint-analysis');
    return true;
  }, [getFootprintAtXY, datasetId, stateKey, chrom, start, linkedBoundsStart, genome, isReversed]);

  /** Toggle a read's selection and open Read Stats (Shift-click, or the menu). */
  const selectReadById = useCallback((readId: string, openStats = true) => {
    useBrowserStore.getState().toggleReadSelection(stateKey, readId);
    if (openStats) useBrowserStore.getState().openAnalysisPanel('read-stats');
  }, [stateKey]);

  // Right-click (Ctrl-click on a Mac; a long press where the platform makes it a contextmenu): the read menu.
  const [contextTarget, setContextTarget] = useState<ReadContextTarget | null>(null);
  const closeContextMenu = useCallback(() => setContextTarget(null), []);
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  const openContextMenuAt = useCallback((x: number, y: number, clientX: number, clientY: number) => {
    // A drag that turned into a right-click (or Ctrl-click) never pans.
    panDragCleanupRef.current?.();
    useEphemeralStore.getState().setPanOffset(0, panScope);
    setHoveredRead(null);
    const scl = (width - sidebarWidth) / Math.max(1, regionWidth);
    const rel = (x - sidebarWidth) / scl;
    const genomePos = Math.round(genomePosAtX(x));
    const hit = getReadHitAtXY(x, y);
    const read = hit?.read ?? null;
    if (read && hit?.liveLiftBadge && selectReadDifference(read, hit.liveLiftBadge, genomePos,
      { datasetId, stateKey, chrom, start: linkedBoundsStart ?? start }, 'inspect')) return;
    setContextTarget({
      clientX,
      clientY,
      x,
      y,
      read,
      liveLiftBadge: hit?.liveLiftBadge,
      footprint: read ? getFootprintAtXY(x, y) : null,
      genomePos,
    });
  }, [sidebarWidth, width, regionWidth, isReversed, start, end, getReadHitAtXY, getFootprintAtXY, panScope, genomePosAtX, datasetId, stateKey, chrom, linkedBoundsStart]);
  const handleContextMenu = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) * e.currentTarget.clientWidth / rect.width;
    const y = (e.clientY - rect.top) * e.currentTarget.clientHeight / rect.height;
    // The cluster bar keeps the browser's own menu.
    if (x < sidebarWidth) return;
    e.preventDefault();
    e.stopPropagation();
    openContextMenuAt(x, y, e.clientX, e.clientY);
  }, [sidebarWidth, openContextMenuAt]);
  // The keyboard's menu key or Shift+F10 on the focused reads: the menu for the
  // read last pointed at, else the first read in view.
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (!(e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) return;
    e.preventDefault();
    e.stopPropagation();
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const sx = rect.width / (canvas.clientWidth || rect.width || 1);
    const sy = rect.height / (canvas.clientHeight || rect.height || 1);
    const firstRowY = headerHeight + histH + layout.rowHeight / 2 - layout.scrollAdjust
      + Math.ceil(layout.scrollAdjust / Math.max(0.5, layout.rowHeight + layout.rowGap)) * (layout.rowHeight + layout.rowGap);
    const at = lastPointerRef.current ?? { x: sidebarWidth + (width - sidebarWidth) / 2, y: firstRowY };
    openContextMenuAt(at.x, at.y, rect.left + at.x * sx, rect.top + at.y * sy);
  }, [openContextMenuAt, headerHeight, histH, layout, sidebarWidth, width]);

  // Clicks in the read area: Shift selects a read, ⌘/Ctrl a footprint; a plain
  // click or drag pans (mouseDown). The cluster colorbar selects clusters.
  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) * e.currentTarget.clientWidth / rect.width;
    const y = (e.clientY - rect.top) * e.currentTarget.clientHeight / rect.height;

    if (x >= sidebarWidth) {
      if (isFootprintClick(e)) {
        selectFootprintAt(x, y);
        return;
      }
      if (e.shiftKey) {
        const read = getReadHitAtXY(x, y)?.read;
        if (read) selectReadById(read.id);
        return;
      }
      const lifted = getReadHitAtXY(x, y);
      const origin = linkedBoundsStart ?? start;
      const mismatch = useBrowserStore.getState().enabledCigarTypes.mismatches ? lifted?.read.cigar?.find(e => {
        if (e.type !== 'X') return false;
        const px = sidebarWidth + (params.axis ? params.axis.toX(origin + e.pos)
          : (isReversed ? end - origin - e.pos : origin + e.pos - start) * (width - sidebarWidth) / regionWidth);
        return Math.abs(px - x) <= Math.max(3, params.axis?.pxPerBp ?? 1);
      }) : undefined;
      if (lifted && (lifted.liveLiftBadge || mismatch) && selectReadDifference(lifted.read, lifted.liveLiftBadge,
        mismatch ? origin + mismatch.pos : genomePosAtX(x), { datasetId, stateKey, chrom, start: origin })) return;
      // A click on an insertion's flag copies its inserted bases.
      const hit = svEventAtXY(x, y);
      if (hit && hit.event.t === 'I') {
        void copyInsertedSequence({ datasetId, chrom, readId: hit.read.id, event: hit.event, stateKey });
      }
      // A plain click pans (handled by mouseDown/mouseUp).
      return;
    }

    if (!hasCluster) return;

    const cluster = getClusterAtY(y);
    if (cluster === null) return;

    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      useBrowserStore.getState().toggleClusterSelection(stateKey, cluster);
      useBrowserStore.getState().openAnalysisPanel('cluster-detail');
      return;
    }

    useBrowserStore.getState().setClusterSelection(stateKey, [cluster]);
    useBrowserStore.getState().openAnalysisPanel('cluster-detail');
  }, [hasCluster, sidebarWidth, getClusterAtY, getReadHitAtXY, selectFootprintAt, selectReadById, stateKey, chrom, svEventAtXY, datasetId, genomePosAtX, linkedBoundsStart, start, params.axis, isReversed, end, width, regionWidth]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) * e.currentTarget.clientWidth / rect.width;
    const y = (e.clientY - rect.top) * e.currentTarget.clientHeight / rect.height;
    lastPointerRef.current = x >= sidebarWidth ? { x, y } : lastPointerRef.current;

    if (dragCluster !== null) {
      setDragY(y);
      const targetCluster = getClusterAtY(y);
      setHoverCluster(targetCluster);
      setHoverY(y);
      setHoveredRead(null);
    } else if (hasCluster && x < sidebarWidth) {
      const cluster = getClusterAtY(y);
      setHoverCluster(cluster);
      setHoverY(y);
      setHoveredRead(null);
    } else {
      setHoverCluster(null);
      setHoverY(null);
      const svHit = !isPanning && x >= sidebarWidth ? svEventAtXY(x, y) : null;
      setHoveredSv(svHit ? { kind: 'event', read: svHit.read, event: svHit.event, x, y } : null);
      if (showReadTooltip && !isPanning && x >= sidebarWidth) {
        const hit = getReadHitAtXY(x, y);
        if (hit) {
          setHoveredRead({ ...hit, x, y });
        } else {
          setHoveredRead(null);
        }
      } else {
        setHoveredRead(null);
      }
    }
  }, [dragCluster, hasCluster, sidebarWidth, getClusterAtY, getReadHitAtXY, isPanning, showReadTooltip, svEventAtXY]);

  const handleMouseUp = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (dragCluster !== null && hoverCluster !== null && dragCluster !== hoverCluster) {
      const newOrder = [...myClusterOrder];
      const fromIdx = newOrder.indexOf(dragCluster);
      const toIdx = newOrder.indexOf(hoverCluster);

      if (fromIdx !== -1 && toIdx !== -1) {
        newOrder.splice(fromIdx, 1);
        newOrder.splice(toIdx, 0, dragCluster);
        useBrowserStore.getState().setClusterOrder(stateKey, newOrder);
      }
    }

    setDragCluster(null);
    setDragY(null);
    setHoverCluster(null);
  }, [dragCluster, hoverCluster, myClusterOrder, stateKey]);

  const handleMouseLeave = useCallback(() => {
    setHoveredSv(null);
    setDragCluster(null);
    setDragY(null);
    setHoverCluster(null);
    setHoverY(null);
    setHoveredRead(null);
  }, []);

  // Wheel handler for vertical zoom and scroll
  const handleWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) * e.currentTarget.clientWidth / rect.width;

    if (x < sidebarWidth) return;

    const { rowHeight, rowGap, totalContentHeight, needsScroll, maxScrollOffset, trackHeight } = layout;

    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      if (n === 0) return;

      // A fixed-height layout reports its own height as autoRowHeight; the
      // height automatic sizing would fit comes from an 'auto' layout.
      const autoFitHeight = computeReadTrackLayout(
        n, height, headerHeight, histH, fillReadHeight, 'auto', 0,
        readSeparatorMode, readSeparatorMinHeight, readSeparatorWidth,
      ).autoRowHeight;
      useBrowserStore.getState().setReadRowHeight(nextReadRowHeight(storeReadRowHeight, autoFitHeight, e.deltaY));
    } else {
      if (n === 0) return;

      if (needsScroll) {
        e.preventDefault();
        const newOffset = Math.max(0, Math.min(maxScrollOffset, readScrollOffset + e.deltaY));
        useBrowserStore.getState().setReadScrollOffset(stateKey, newOffset);
      }
    }
  }, [sidebarWidth, n, layout, storeReadRowHeight, readScrollOffset, stateKey, height, headerHeight, histH, fillReadHeight, readSeparatorMode, readSeparatorMinHeight, readSeparatorWidth]);

  return {
    dragCluster,
    dragY,
    hoverCluster,
    hoverY,
    selectedReadIds,
    hoveredRead,
    hoveredSv,
    handleMouseDown,
    handleClick,
    handleContextMenu,
    handleKeyDown,
    contextTarget,
    closeContextMenu,
    selectFootprintAt,
    selectReadById,
    handleMouseMove,
    handleMouseUp,
    handleMouseLeave,
    handleWheel,
    getClusterAtY,
    getReadAtY,
    getFootprintAtXY,
  };
}
