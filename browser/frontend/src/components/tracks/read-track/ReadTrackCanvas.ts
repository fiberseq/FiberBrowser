import { useBrowserStore } from '../../../stores/browserStore';
import { drawLiveLiftMarks, liveLiftBodyRects, liveLiftBodySpans } from './liveLiftCanvas';
import { getCanvasRenderScale, setupHighDpiCanvas } from '../../../utils/canvasUtils';
import { buildRuleMatchContext, footprintMatchesRule, ruleTargetsLayer } from '../../../utils/ruleMatching';
import { buildRuleColorResolver } from '../../../utils/ruleColors';
import type { CompactRead, SvSummary } from './types';
import { bodyClipRects, readSvDraw } from './svDrawing';
import { drawReadSvMarks, drawSvBand } from './svCanvas';
import type { Gene, FirePeak, Colormap, SelectedFootprint, FootprintGroup } from '../../../types';
import type { OrthogonalTrack, ModificationOverlay } from '../../../types/dataset';
import {
  SIDEBAR_WIDTH,
  MOD_COLORS, CIGAR_COLORS,
  getClusterColor,
} from './constants';
import { getLayerColor } from '../../../utils/layerColors';
import { sameChrom } from '../../../utils/chromAliases';
import { isSelectedFootprint } from '../../../utils/footprintSelection';
import { consensusRecordColor, consensusOutline,consensusPrimaryFamily } from '../../../utils/consensusVisual';
import {
  annotationLayerRenderRank,
  classifyStrandRescueAction,
  isStrandRescueLayer,
  strandRescueActionColor,
  strandRescueBaseLayer,
} from '../../../utils/strandRescue';
import { computeReadTrackLayout, shouldDrawReadBoundaryLines, type ReadSeparatorMode } from './layout';
import { clusterAssignmentForRead } from './readFilter';
import {
  buildTfFamilyDisplayIndex,
  passesFamilyAssignmentConfidence,
  tfFamilyColor,
  tfFamilyDisplayGeometryFromIndex,
  tfFamilyMetadata,
  tfFamilyRenderGeometry,
  type TfFamilyMetadata,
} from '../../../utils/tfFamilies';

interface JupyterMarkerItem {
  position: number;
  color?: string;
  label?: string;
}

interface DrawReadsParams {
  /** A live-lift panel: map correspondence per bin over the view (hatching on the coverage histogram). */
  liftCorrespondence?: number[] | null;
  genome?: string | null;
  canvas: HTMLCanvasElement;
  displayReads: CompactRead[];
  width: number;
  height: number;
  regionWidth: number;
  chrom: string;
  start: number;
  end: number;
  loading: boolean;
  // Layout
  datasetId: string;
  /** The panel's state key (its own family discovery); defaults to datasetId. */
  stateKey?: string;
  datasetLabel?: string;
  datasetColor?: string;
  sidebarWidth: number;
  hasCluster: boolean;
  myClusterAssignments: Record<string, number>;
  myClusterOrder: number[];
  hasClusterFocus: boolean;
  myClusterFocus: Set<number> | null;
  mySelectedClusters: Set<number> | null;
  // Rendering options
  enabledModTypes: Record<string, boolean>;
  enabledCigarTypes: { mismatches: boolean; insertions: boolean; deletions: boolean };
  isBAM: boolean;
  layerType?: string;  // 'mod', 'msp', 'fire', 'm5c', 'footprint', 'bam'
  fillReadHeight: boolean;
  storeReadRowHeight: number | 'auto';
  readScrollOffset: number;
  readSeparatorMode: ReadSeparatorMode;
  readSeparatorMinHeight: number;
  readSeparatorWidth: number;
  showCoverageHistogram: boolean;
  isReversed: boolean;
  // Colormap
  activeColormap: Colormap;
  genes: Gene[];
  allPeaks: FirePeak[];
  orthogonalTracks: OrthogonalTrack[];
  // Overlays
  modificationOverlays: ModificationOverlay[];
  overlayMarks: Record<string, Record<string, number[]>>;
  // Jupyter
  jupyterReadHighlights: Map<string, string>;
  jupyterFootprintColorMap: Map<string, Array<{ start: number; end: number; color: string }>>;
  allJupyterMarkers: JupyterMarkerItem[];
  // Linked mode
  linkedBoundsStart?: number;
  linkedSessionId?: string;
  linkedHighlightIds?: Set<string>;
  /** Reads gone to by name or highlighted from the read menu (fb-r4-clicks): a solid outline. */
  readHighlightIds?: Set<string> | null;
  // Selection
  selectedReadIds: Set<string> | undefined;
  selectedFootprints: SelectedFootprint[];
  footprintCrossHighlight: boolean;
  footprintGroups: FootprintGroup[];
  selectedFamilyGroupId: string | null;
  /** Layer scope for cross-highlight matching. null = match every layer
   *  (primary nucs + every overlay). 'nuc'/'footprint' = primary intervals
   *  only. Any other layer name = that overlay only. */
  footprintAnalysisLayer: string | null;
  // Cluster state
  clusterStateConsensus: Map<number, { pause: number; pic: number; elongating: number; total: number }>;
  hasFilter: boolean;
  myFilteredReadIds: Set<string> | null | undefined;
  // Zoomed-out coverage
  maxRegionForReads: number;
  coverageData?: number[];
  coverageMax?: number;
  // Annotation overlays
  annotationOverlays?: Record<string, Array<{ start: number; end: number; type: string; confidence: number }>>;
  annotationColors?: Record<string, string>;
  enabledAnnotationTypes?: Record<string, boolean>;
  annotationOpacityMin?: number;
  annotationOpacityMax?: number;
  annotationThresholds?: Record<string, number>;
  layerColors?: Record<string, string>;
  selectedConsensusFamily?: string | null;
  selectedConsensusFamilies?:Set<string>;
  relatedConsensusFamilies?: Set<string>;
  /** The run the class selections belong to: highlights apply only to that run's records. */
  consensusViewJobId?: string | null;
  nativeLattice?: import('../../../api/consensusWorkflow').NativeLatticeResponse | null;
  latticeShowHits?: boolean;
  latticeStyle?: 'ticks'|'dots';
  /** SV display (fb-n9-sv): break reads at deletions >= svMinLen, flag insertions and clips. */
  svEnabled?: boolean;
  svMinLen?: number;
  /** The SV summary above the reads: only outside a panel's rows (split views); a panel has its SvTrack. */
  svBandHeight?: number;
  svSummary?: SvSummary | null;
  /** Zoomed out: px at the bottom kept clear of the coverage plot (the zoomed-out banner sits there). */
  coverageFooterHeight?: number;
}

export function drawReadTrack(params: DrawReadsParams): void {
  const {
    canvas, displayReads, width, height, regionWidth, chrom, genome, start, end, loading,
    datasetId, stateKey, datasetLabel, datasetColor, sidebarWidth, hasCluster, myClusterAssignments,
    myClusterOrder, hasClusterFocus, myClusterFocus, mySelectedClusters,
    enabledModTypes, enabledCigarTypes, isBAM, layerType,
    fillReadHeight, storeReadRowHeight, readScrollOffset,
    readSeparatorMode, readSeparatorMinHeight, readSeparatorWidth,
    showCoverageHistogram,
    isReversed, activeColormap, genes, allPeaks, orthogonalTracks,
    modificationOverlays, overlayMarks, jupyterReadHighlights, jupyterFootprintColorMap,
    allJupyterMarkers, linkedBoundsStart, linkedSessionId, linkedHighlightIds, readHighlightIds,
    selectedReadIds, selectedFootprints: allSelectedFootprints, footprintCrossHighlight, footprintGroups,
    selectedFamilyGroupId, footprintAnalysisLayer,
    clusterStateConsensus, hasFilter, myFilteredReadIds,
    maxRegionForReads, coverageData, coverageMax,
    annotationOverlays, annotationColors, enabledAnnotationTypes,
    annotationOpacityMin, annotationOpacityMax, annotationThresholds,
    layerColors,selectedConsensusFamily,selectedConsensusFamilies,relatedConsensusFamilies,consensusViewJobId,nativeLattice,latticeShowHits,latticeStyle,
    svEnabled = false, svMinLen = 50, svBandHeight = 0, svSummary = null, coverageFooterHeight = 0,
    liftCorrespondence = null,
  } = params;
  const selectedFootprints = allSelectedFootprints.filter(fp => fp.genome === undefined || fp.genome === (genome ?? null));

  const ctx = setupHighDpiCanvas(canvas, width, height);
  if (!ctx) return;
  const ctxNonNull = ctx;

  const noReadBackgroundColor = normalizeHexColor(
    activeColormap.noReadBackgroundColor ?? activeColormap.backgroundColor,
    '#ffffff'
  );
  const readBackgroundColor = normalizeHexColor(activeColormap.readBackgroundColor, '#f1f5f9');
  ctx.fillStyle = noReadBackgroundColor;
  ctx.fillRect(0, 0, width, height);

  // Draw dataset label header
  const headerHeight = datasetLabel ? 16 : 0;

  if (datasetLabel) {
    ctx.fillStyle = datasetColor || '#666';
    ctx.fillRect(0, 0, width, headerHeight - 2);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(datasetLabel, 4, 11);
  }

  // The SV summary band sits under the header, above the coverage histogram;
  // rows start below both (the mouse hook adds the band the same way).
  const coverageHistogramHeight = showCoverageHistogram ? 30 : 0;
  const histogramHeight = coverageHistogramHeight + svBandHeight;
  const trackHeight = height - headerHeight - histogramHeight;
  // A read track outside a panel's rows (split views) keeps the SV summary above its reads.
  if (svBandHeight > 0 && svSummary && regionWidth <= maxRegionForReads) {
    const bandScale = (width - sidebarWidth) / regionWidth;
    drawSvBand(ctx, svSummary, {
      top: headerHeight, height: svBandHeight, width, sidebarWidth, viewStart: start,
      toX: rel => (isReversed ? sidebarWidth + (regionWidth - rel) * bandScale : sidebarWidth + rel * bandScale),
      isReversed, backgroundColor: noReadBackgroundColor,
    });
  }

  // Show coverage histogram when zoomed out past maxRegionForReads
  if (regionWidth > maxRegionForReads && !linkedSessionId) {
    const sizeLabel = regionWidth >= 1e6
      ? `${(regionWidth / 1e6).toFixed(1)} Mb`
      : `${(regionWidth / 1e3).toFixed(0)} kb`;

    // The panel's ground (the colormap's, light or dark), and text that reads on it.
    const ink = inkOn(noReadBackgroundColor);
    if (coverageData && coverageMax && coverageMax > 0) {
      // The coverage fills the track: a label row, then the plot down to the
      // bottom (less the zoomed-out banner's line), over the same span the axis
      // and reads use (right of the cluster sidebar).
      const covBins = coverageData.length;
      const plotWidth = Math.max(0, width - sidebarWidth);
      const barW = plotWidth / covBins;
      const labelRow = 14;
      const plotTop = headerHeight + labelRow;
      const plotHeight = Math.max(4, height - plotTop - Math.max(2, coverageFooterHeight));

      ctx.fillStyle = noReadBackgroundColor;
      ctx.fillRect(0, headerHeight, width, height - headerHeight);

      // Coverage bars
      ctx.fillStyle = ink.dark ? 'rgba(147, 178, 230, 0.65)' : 'rgba(100, 140, 200, 0.55)';
      for (let b = 0; b < covBins; b++) {
        if (coverageData[b] === 0) continue;
        const barH = (coverageData[b] / coverageMax) * plotHeight;
        // Bin b covers the b-th slice of the region; a reversed view draws it from the right.
        const x = sidebarWidth + (isReversed ? plotWidth - (b + 1) * barW : b * barW);
        ctx.fillRect(x, plotTop + plotHeight - barH, Math.max(1, barW), barH);
      }
      // Baseline
      ctx.fillStyle = ink.rule;
      ctx.fillRect(sidebarWidth, plotTop + plotHeight, plotWidth, 1);

      ctx.font = '10px sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = ink.muted;
      ctx.textAlign = 'right';
      ctx.fillText(`max ${coverageMax}`, width - 4, headerHeight + labelRow / 2);
      ctx.fillStyle = ink.text;
      ctx.textAlign = 'left';
      ctx.fillText(`Coverage \u00b7 ${sizeLabel}`, sidebarWidth + 4, headerHeight + labelRow / 2);
      ctx.textBaseline = 'alphabetic';
    } else if (!useBrowserStore.getState().exportInProgress) {
      // No coverage data yet — show minimal message (a hint, not figure content)
      ctx.fillStyle = ink.text;
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Zoom in to see reads', width / 2, headerHeight + trackHeight / 2 - 8);
      ctx.fillStyle = ink.muted;
      ctx.font = '10px sans-serif';
      ctx.fillText(`Currently viewing ${sizeLabel}`, width / 2, headerHeight + trackHeight / 2 + 8);
    }
    return;
  }

  if (displayReads.length === 0) {
    ctx.fillStyle = '#999';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(loading ? 'Loading...' : 'No reads', width / 2, headerHeight + histogramHeight + trackHeight / 2);
    return;
  }

  const n = displayReads.length;
  const layout = computeReadTrackLayout(
    n,
    height,
    headerHeight,
    histogramHeight,
    fillReadHeight,
    storeReadRowHeight,
    readScrollOffset,
    readSeparatorMode,
    readSeparatorMinHeight,
    readSeparatorWidth,
  );
  const { rowHeight, rowGap, needsScroll, clampedScrollOffset, totalContentHeight, maxScrollOffset } = layout;
  const trackWidth = width - sidebarWidth;
  const scale = trackWidth / regionWidth;

  // Calculate visible range for virtual scrolling
  const firstVisibleRow = needsScroll ? Math.floor(clampedScrollOffset / (rowHeight + rowGap)) : 0;
  const lastVisibleRow = needsScroll
    ? Math.min(n - 1, Math.ceil((clampedScrollOffset + trackHeight) / (rowHeight + rowGap)))
    : n - 1;

  // Position helper: converts relative bp position to screen X
  const toX = (relPos: number) => isReversed
    ? sidebarWidth + (regionWidth - relPos) * scale
    : sidebarWidth + relPos * scale;

  // For linked mode: intervals are relative to linkedBoundsStart
  const linkedOffset = (linkedBoundsStart !== undefined)
    ? linkedBoundsStart - start
    : 0;

  // Track cluster boundaries for drag-and-drop
  const clusterBounds: Map<number, { startY: number; endY: number; count: number }> = new Map();

  // Draw cluster sidebar FIRST (before clipping for pan offset)
  if (hasCluster) {
    for (let i = 0; i < n; i++) {
      const read = displayReads[i];
      const y = headerHeight + histogramHeight + i * (rowHeight + rowGap) - (needsScroll ? clampedScrollOffset : 0);
      const cluster = clusterAssignmentForRead(myClusterAssignments, read.id);
      if (cluster !== undefined) {
        const actualY = headerHeight + histogramHeight + i * (rowHeight + rowGap);
        if (!clusterBounds.has(cluster)) {
          clusterBounds.set(cluster, { startY: actualY, endY: actualY + rowHeight, count: 1 });
        } else {
          const bounds = clusterBounds.get(cluster)!;
          bounds.endY = actualY + rowHeight;
          bounds.count++;
        }

        if (i >= firstVisibleRow && i <= lastVisibleRow) {
          const color = getClusterColor(cluster);
          const isFocused = hasClusterFocus && myClusterFocus?.has(cluster);
          const isSelected = mySelectedClusters?.has(cluster);

          ctx.fillStyle = isFocused ? color : `${color}66`;
          ctx.fillRect(0, y, sidebarWidth - 2, rowHeight - rowGap);
          if (isSelected) {
            ctx.strokeStyle = '#2563eb';
            ctx.lineWidth = 2;
            ctx.strokeRect(1, y + 1, Math.max(1, sidebarWidth - 5), Math.max(1, rowHeight - rowGap - 2));
          }
        }
      }
    }
  }

  // Clip genomic drawing to the non-sidebar content area.
  ctx.save();
  ctx.beginPath();
  ctx.rect(sidebarWidth, 0, width - sidebarWidth, height);
  ctx.clip();

  // Build shared rule-matching context
  const ruleCtx = buildRuleMatchContext(genes, allPeaks, orthogonalTracks, start, end, activeColormap.rules, chrom);

  // Footprint cart entries paint reads via a rule-like match: size + layer +
  // (optional) reference overlap + (optional) conditions. We can't reuse the
  // plain ColorRule matcher because cart entries also gate on referenceAbs*
  // (the original clicked footprint coords) — without that gate, an entry
  // like "TF @ fp1" would paint every TF in the viewport regardless of
  // whether it overlaps the reference site.
  // Saved definitions survive chromosome changes: one pinned to a position on
  // another chromosome must not colour footprints at the same numbers here.
  const cartEntries = footprintGroups.filter(g => g.enabled
    && (g.referenceGenome === undefined || g.referenceGenome === (genome ?? null))
    && !(g.referenceAbsStart != null && g.referenceChrom && chrom && !sameChrom(g.referenceChrom, chrom)));
  const familyDisplayIndex = buildTfFamilyDisplayIndex(footprintGroups, datasetId, chrom, stateKey ?? datasetId);
  // Cache the small subset of Cart entries that can possibly match one
  // layer/family pair. Frozen catalogs are commonly 100+ enabled rows; walking
  // all of them for every nuc/MSP/TF interval was the dominant post-scan UI
  // cost and made a navigation repaint look stalled.
  const cartCandidateCache = new Map<string, FootprintGroup[]>();
  const cartBaseCandidateCache = new Map<string, FootprintGroup[]>();
  // Annotation names are nearly unique per call, so a cache miss must not
  // rescan every Cart entry: bucket annotation-scoped entries by name.
  const cartOrder = new Map(cartEntries.map((group, index) => [group, index] as const));
  const cartUnannotated = cartEntries.filter(group => !group.familyAnnotationName);
  const cartByAnnotation = new Map<string, FootprintGroup[]>();
  for (const group of cartEntries) {
    if (!group.familyAnnotationName) continue;
    const bucket = cartByAnnotation.get(group.familyAnnotationName) ?? [];
    bucket.push(group);
    cartByAnnotation.set(group.familyAnnotationName, bucket);
  }
  // Class ids repeat across runs ('class_011' in each): a saved class matches only records of its own run.
  const cartByState = new Map(cartEntries
    .filter(group => (!group.sourceDatasetId || group.sourceDatasetId === datasetId) && group.consensusStateId)
    .map(group => [`${group.consensusJobId ?? '*'}\u0000${group.consensusStateId}`, group]));
  const cartStateGroup = (jobId: string | undefined, family: string) =>
    cartByState.get(`${jobId ?? '*'}\u0000${family}`) ?? cartByState.get(`*\u0000${family}`);
  const layerMatches = (a: string | null | undefined, b: string | null | undefined): boolean => {
    if (a === b) return true;
    return (a === 'fire' && b === 'msp') || (a === 'msp' && b === 'fire');
  };
  const cartMatch = (
    absStart: number, absEnd: number, size: number, layerName: string | undefined,
    familyMetadata: TfFamilyMetadata | null = null,
  ): string | null => {
    const canonicalLayer = layerName === 'msp' ? 'fire' : (layerName ?? '');
    const familyId = familyMetadata?.familyId ?? 0;
    const candidateKey = `${canonicalLayer}\u0000${familyId}\u0000${familyMetadata?.annotationName ?? ""}`;
    let candidates = cartCandidateCache.get(candidateKey);
    if (!candidates) {
      const baseKey = `${canonicalLayer}\u0000${familyId}`;
      let base = cartBaseCandidateCache.get(baseKey);
      if (!base) {
        base = cartUnannotated.filter(group => (
          (!group.layer || layerMatches(group.layer, layerName))
          && (group.familyId == null || group.familyId === familyMetadata?.familyId)
        ));
        cartBaseCandidateCache.set(baseKey, base);
      }
      const annotationName = familyMetadata?.annotationName;
      const annotated = annotationName
        ? (cartByAnnotation.get(annotationName) ?? []).filter(group => !group.layer || layerMatches(group.layer, layerName))
        : [];
      // Keep Cart order: the first matching entry wins.
      candidates = annotated.length === 0
        ? base
        : [...base, ...annotated].sort((a, b) => cartOrder.get(a)! - cartOrder.get(b)!);
      cartCandidateCache.set(candidateKey, candidates);
    }
    for (const g of candidates) {
      // Layer scope
      // Size scope
      if (g.sizeMin > 0 && size < g.sizeMin) continue;
      if (g.sizeMax !== null && size > g.sizeMax) continue;
      if (!g.familyAnnotationName && g.familyId != null && g.familyId !== familyMetadata?.familyId) continue;
      if (g.familyAnnotationName && g.familyAnnotationName !== familyMetadata?.annotationName) continue;
      if (!passesFamilyAssignmentConfidence(
        familyMetadata,
        g.minFamilyConfidence ?? 0,
      )) continue;
      // Reference overlap (when the entry was seeded from a clicked footprint)
      const refStart = g.referenceAbsStart;
      const refEnd = g.referenceAbsEnd;
      if (refStart != null && refEnd != null) {
        const ovlStart = Math.max(absStart, refStart);
        const ovlEnd = Math.min(absEnd, refEnd);
        if (ovlStart >= ovlEnd) continue;
        const ovlLen = ovlEnd - ovlStart;
        if ((g.minFpCoverage ?? 0) > 0 && ovlLen < (g.minFpCoverage ?? 0) * size) continue;
        if (
          (g.minTargetCoverage ?? 0) > 0
          && ovlLen < (g.minTargetCoverage ?? 0) * Math.max(1, refEnd - refStart)
        ) continue;
        if (g.overlapFraction > 0) {
          const frac = Math.min(ovlLen / size, ovlLen / (refEnd - refStart));
          if (frac < g.overlapFraction) continue;
        }
      }
      return g.color;
    }
    return null;
  };

  // Rule-based color evaluation: cart entries first (highest priority), then
  // activeColormap.rules. Primary intervals represent the nuc/FP layer
  // (whichever the dataset exposes), so rules with targetLayers=['tf'] won't
  // match primary nucs.
  const ruleOpacity = (opacity: unknown): number => {
    const numeric = typeof opacity === 'number' ? opacity : Number(opacity);
    return Math.max(0, Math.min(1, Number.isFinite(numeric) ? numeric : 1));
  };
  const ruleColorResolvers = new Map(
    activeColormap.rules.map(rule => [rule, buildRuleColorResolver(rule)] as const)
  );
  const layersWithTargetedRules = new Set<string>();
  for (const rule of activeColormap.rules) {
    for (const targetLayer of rule.targetLayers ?? []) {
      layersWithTargetedRules.add(targetLayer);
      if (targetLayer === 'fire') layersWithTargetedRules.add('msp');
      if (targetLayer === 'msp') layersWithTargetedRules.add('fire');
    }
  }
  const resolveRuleColor = (rule: Colormap['rules'][number], size: number): string => (
    ruleColorResolvers.get(rule)?.(size) ?? rule.color
  );
  const getColorHit = (
    intStart: number, intEnd: number, size: number, layerName?: string,
  ): { color: string; opacity: number; matched: boolean } => {
    if (size <= 0) return { color: '#cccccc', opacity: 1, matched: false };

    const cartHit = cartMatch(start + intStart, start + intEnd, size, layerName);
    if (cartHit) return { color: cartHit, opacity: 1, matched: true };
    for (const rule of activeColormap.rules) {
      if (footprintMatchesRule(intStart, intEnd, size, rule, ruleCtx, layerName)) {
        return { color: resolveRuleColor(rule, size), opacity: ruleOpacity(rule.opacity), matched: true };
      }
    }

    return { color: '#cccccc', opacity: 1, matched: false };
  };

  // Quality shading config
  const qs = activeColormap.qualityShading;
  const qualityShadingEnabled = qs.enabled && qs.mode === 'quality';

  // Global edge-ambiguity rendering. The MA interval is the conservative span;
  // el/er (TF) and lq/rq (nuc) encode how far the true edge may extend outward.
  //   soft   = feather each end's opacity by edge confidence (default)
  //   strict = crisp conservative span (ignore el/er)
  //   loose  = extend each edge outward to the liberal boundary, crisp there
  const edgeAmb = activeColormap.edgeAmbiguity
    ?? { mode: 'strict' as const, applyNuc: true, applyTf: true, maxGapBp: 30 };
  // bp the el/er byte spans: full gap at confidence 0 ("edge unknown / wide"),
  // shrinking to 0 (crisp) at confidence 255.
  const edgeGapBp = (edgeQ: number): number =>
    edgeAmb.maxGapBp * (1 - Math.max(0, Math.min(255, edgeQ)) / 255);
  const layerOpacity = (layerName: string, fallback: number): number => {
    const displayLayerName = layerName === 'msp' ? 'fire' : layerName;
    const raw = activeColormap.layerOpacities?.[displayLayerName]
      ?? activeColormap.layerOpacities?.[layerName]
      ?? fallback;
    return Math.max(0, Math.min(1, raw));
  };
  const layerBackgroundOpacity = (layerName: string): number => {
    const displayLayerName = layerName === 'msp' ? 'fire' : layerName;
    const raw = activeColormap.layerBackgroundOpacities?.[displayLayerName]
      ?? activeColormap.layerBackgroundOpacities?.[layerName]
      ?? 1;
    return Math.max(0, Math.min(1, Number.isFinite(Number(raw)) ? Number(raw) : 1));
  };
  const layerHasTargetedRules = (layerName: string): boolean => {
    const displayLayerName = layerName === 'msp' ? 'fire' : layerName;
    return layersWithTargetedRules.has(layerName) || layersWithTargetedRules.has(displayLayerName);
  };

  // Draw coverage histogram if enabled
  if (showCoverageHistogram && coverageHistogramHeight > 0) {
    drawCoverageHistogram(ctx, displayReads, {
      sidebarWidth, trackWidth, regionWidth, histogramHeight: coverageHistogramHeight, headerHeight: headerHeight + svBandHeight,
      linkedOffset, isReversed, width, liftCorrespondence,
    });
  }

  // Draw reads (in clipped/translated context for panning)
  for (let i = firstVisibleRow; i <= lastVisibleRow; i++) {
    const read = displayReads[i];
    const y = headerHeight + histogramHeight + i * (rowHeight + rowGap) - (needsScroll ? clampedScrollOffset : 0);

    const readExtent = getCompactReadExtent(read);
    // SVs (absolute coordinates: view-relative is ref - start, whatever the linked offset).
    const readSv = svEnabled && read.sv ? readSvDraw(read, start, end, svMinLen) : null;
    // The read's drawn body, in canvas x. Its calls are drawn clipped to it
    // (below), so nothing shows beyond the read, e.g. an MSP in a terminal
    // gap hidden by hideTerminalGaps. A deletion breaks it: nothing is drawn
    // in the deleted span.
    let bodyClip: { x: number; w: number } | Array<{ x: number; w: number }> | null = null;
    if (read.live_lift) {
      // A live-lift row: its body is its segments minus connectors (independent of the SV display).
      const rects = liveLiftBodyRects(read.live_lift, linkedOffset, regionWidth, toX);
      ctx.fillStyle = readBackgroundColor;
      for (const rect of rects) ctx.fillRect(rect.x, y, rect.w, Math.max(1, rowHeight - rowGap));
      bodyClip = rects.length ? rects : { x: 0, w: 0 };
    } else if (readExtent) {
      const adjustedStart = readExtent.start + linkedOffset;
      const adjustedEnd = readExtent.end + linkedOffset;
      const clippedStart = Math.max(0, adjustedStart);
      const clippedEnd = Math.min(regionWidth, adjustedEnd);
      if (readSv && readSv.deletions.length > 0 && clippedEnd > clippedStart) {
        const rects = bodyClipRects({ start: adjustedStart, end: adjustedEnd }, readSv.deletions, regionWidth, toX);
        ctx.fillStyle = readBackgroundColor;
        for (const rect of rects) ctx.fillRect(rect.x, y, rect.w, Math.max(1, rowHeight - rowGap));
        bodyClip = rects;
      } else if (clippedEnd > clippedStart) {
        const x = isReversed ? toX(clippedEnd) : toX(clippedStart);
        const w = Math.max(1, (clippedEnd - clippedStart) * scale);
        ctx.fillStyle = readBackgroundColor;
        ctx.fillRect(x, y, w, Math.max(1, rowHeight - rowGap));
        bodyClip = { x, w };
      } else {
        bodyClip = { x: 0, w: 0 };
      }
    }

    // Primary interval rendering. Each layer is independent:
    // - Read extent is drawn once above as a full-width background, so
    //   structural gaps/linkers are never rendered as standalone grey blocks.
    // - When a split nuc layer exists, nuc footprints draw from that layer only
    //   (TF-sized footprints stay in the TF overlay path below)
    // - Legacy files without a nuc layer fall back to the primary footprint stream
    // - Overlays (TF, FIRE/internal MSP, etc.) render in the separate generic overlay loop below
    //   and are independent of the footprint/nuc toggle.
    let effectiveLayerToggle: string = 'footprint';
    if (!isBAM && layerType && layerType !== 'footprint' && layerType !== 'bam') {
      effectiveLayerToggle = layerType;
    }
    const hasNucLayer = !!read.layers?.nuc;
    const footprintsEnabled = hasNucLayer
      ? (enabledModTypes['nuc'] ?? true)
      : (enabledModTypes[effectiveLayerToggle] ?? true);

    const primaryItems: Array<{
      interval: [number, number, number];
      intervalIndex: number;
      layerName: 'nuc' | 'footprint';
      quality?: number;
      edgeLeftQ?: number;   // genomic-left edge sharpness (lq/el), 0-255
      edgeRightQ?: number;  // genomic-right edge sharpness (rq/er), 0-255
    }> = [];

    if (hasNucLayer && read.layers?.nuc) {
      const nucLayer = read.layers.nuc;
      const nucQualities = nucLayer.qualities?.[0];
      // Edge-sharpness dims, mirroring the overlay lookup: el/lq = left, er/rq = right.
      const nQNames = nucLayer.quality_names ?? [];
      const nEdgeL = nQNames.indexOf('el') >= 0 ? nQNames.indexOf('el') : nQNames.indexOf('lq');
      const nEdgeR = nQNames.indexOf('er') >= 0 ? nQNames.indexOf('er') : nQNames.indexOf('rq');
      for (let nucIdx = 0; nucIdx < nucLayer.intervals.length; nucIdx++) {
        primaryItems.push({
          interval: nucLayer.intervals[nucIdx],
          intervalIndex: nucIdx,
          layerName: 'nuc',
          quality: nucQualities?.[nucIdx],
          edgeLeftQ: nEdgeL >= 0 ? nucLayer.qualities?.[nEdgeL]?.[nucIdx] : undefined,
          edgeRightQ: nEdgeR >= 0 ? nucLayer.qualities?.[nEdgeR]?.[nucIdx] : undefined,
        });
      }
    } else {
      let fpIndex = 0;
      for (let ivIdx = 0; ivIdx < read.intervals.length; ivIdx++) {
        const interval = read.intervals[ivIdx];
        if (interval[2] <= 0) continue;
        const quality = read.qualities?.[fpIndex];
        primaryItems.push({ interval, intervalIndex: ivIdx, layerName: 'footprint', quality });
        fpIndex++;
      }
    }

    const m6aToggled = enabledModTypes.m6a || enabledModTypes.mod;

    const drawPrimaryItems = () => {
      for (const item of primaryItems) {
        const { interval, intervalIndex, layerName: primaryLayer, quality } = item;
        const [intStart, intEnd, size] = interval;
        const isPositive = size > 0;
        if (!isPositive || !footprintsEnabled) continue;

        // Edge-ambiguity: nucleosomes participate when 'Nuc' is enabled and the
        // layer carries edge-sharpness dims. el/lq = genomic-left, er/rq = right.
        const nucEdgeOn = primaryLayer === 'nuc' && edgeAmb.applyNuc
          && (item.edgeLeftQ !== undefined || item.edgeRightQ !== undefined);
        const qGenL = item.edgeLeftQ ?? 255;
        const qGenR = item.edgeRightQ ?? 255;
        const edgeGapGenL = nucEdgeOn ? edgeGapBp(qGenL) : 0;
        const edgeGapGenR = nucEdgeOn ? edgeGapBp(qGenR) : 0;

        // Conservative span — used for ALL rule/cart/jupyter matching and
        // overlap below, so a visual edge mode never shifts labeling results.
        const adjustedStart = intStart + linkedOffset;
        const adjustedEnd = intEnd + linkedOffset;
        // Draw span — loose mode pushes each edge outward to its liberal
        // boundary (genomic space, so the reverse-aware x/w below stays correct).
        let drawStart = adjustedStart;
        let drawEnd = adjustedEnd;
        if (nucEdgeOn && edgeAmb.mode === 'loose') {
          drawStart -= edgeGapGenL;
          drawEnd += edgeGapGenR;
        }
        const visibleStart = nucEdgeOn && edgeAmb.mode === 'soft' ? adjustedStart - edgeGapGenL : drawStart;
        const visibleEnd = nucEdgeOn && edgeAmb.mode === 'soft' ? adjustedEnd + edgeGapGenR : drawEnd;
        if (visibleEnd < 0 || visibleStart > regionWidth) continue;

        const x = isReversed ? toX(drawEnd) : toX(drawStart);
        const w = Math.max(1, (drawEnd - drawStart) * scale);

        // Pass the actual primary layer name so target-scoped rules can gate
        // correctly; split TF intervals are handled in the overlay loop.
        const colorHit = getColorHit(adjustedStart, adjustedEnd, size, primaryLayer);
        let color = colorHit.color;
        let visualOpacity = colorHit.opacity;
        let matchedExplicitColor = colorHit.matched;
        if (isPositive) {
          const customColors = jupyterFootprintColorMap.get(read.id);
          if (customColors) {
            const absStart = start + adjustedStart;
            const absEnd = start + adjustedEnd;
            for (const cc of customColors) {
              if (cc.start < absEnd && cc.end > absStart) {
                color = cc.color;
                visualOpacity = 1;
                matchedExplicitColor = true;
                break;
              }
            }
          }
        }
        if (isPositive && !matchedExplicitColor && layerHasTargetedRules(primaryLayer)) {
          color = layerColors?.[primaryLayer] ?? getLayerColor(primaryLayer);
          visualOpacity = layerBackgroundOpacity(primaryLayer);
        }
        if (isPositive && visualOpacity <= 0) continue;

        const primaryOpacity = (isPositive ? layerOpacity(primaryLayer, primaryLayer === 'nuc' ? 1 : 0.85) : 1) * visualOpacity;
        const rowFillHeight = rowHeight - rowGap;
        const edgeGapVisL = (isReversed ? edgeGapGenR : edgeGapGenL) * scale;
        const edgeGapVisR = (isReversed ? edgeGapGenL : edgeGapGenR) * scale;
        const primarySoftEdge = nucEdgeOn && edgeAmb.mode === 'soft';
        if (qualityShadingEnabled && isPositive && quality !== undefined) {
          const q = quality / 255;
          const t = qs.invert ? (1 - q) : q;
          const alpha = qs.minOpacity + t * (qs.maxOpacity - qs.minOpacity);
          const fillAlpha = (qs.vizMode === 'opacity' || qs.vizMode === 'both')
            ? alpha * primaryOpacity
            : primaryOpacity;
          drawPrimaryFootprintFill(ctx, x, y, w, rowFillHeight, color, fillAlpha, primarySoftEdge, edgeGapVisL, edgeGapVisR);
          if (qs.vizMode === 'border' || qs.vizMode === 'both') {
            ctx.globalAlpha = fillAlpha;
            ctx.strokeStyle = color;
            ctx.lineWidth = 1 + t * 2;
            ctx.strokeRect(x, y, w, rowFillHeight);
          }
          ctx.globalAlpha = 1.0;
        } else {
          drawPrimaryFootprintFill(ctx, x, y, w, rowFillHeight, color, primaryOpacity, primarySoftEdge, edgeGapVisL, edgeGapVisR);
          ctx.globalAlpha = 1.0;
        }

        // Footprint selection highlighting — only matches selections that
        // came from this primary intervals array (sf.layer is null, 'nuc',
        // or 'footprint'). Layer-scoped selections (TF/FIRE/custom) get their
        // highlight drawn inside the per-layer overlay loop instead, so we
        // don't false-positive on a coincidental intervalIndex collision.
        if (isPositive && selectedFootprints.length > 0) {
          const drawn = { readId: read.id, datasetId, chrom, absStart: start + adjustedStart, absEnd: start + adjustedEnd };
          const isSelected = selectedFootprints.some(
            sf => isSelectedFootprint(sf, drawn)
              && (!sf.layer || layerMatches(sf.layer, primaryLayer))
          );
          if (isSelected) {
            ctx.strokeStyle = '#d97706';  // deep amber — visible on white
            ctx.lineWidth = 2;
            ctx.strokeRect(x - 1, y - 1, w + 2, rowHeight - rowGap + 2);
          } else if (footprintCrossHighlight) {
            const fpAbsStart = start + adjustedStart;
            const fpAbsEnd = start + adjustedEnd;
            const enabledGroups = cartEntries;

            if (enabledGroups.length > 0) {
              // Panel scope wins: when the user has chosen a non-primary
              // analysis layer (TF / FIRE / custom), don't paint primary
              // intervals at all. null = match every layer.
              if (footprintAnalysisLayer && footprintAnalysisLayer !== 'nuc' && footprintAnalysisLayer !== 'footprint') {
                // skip primary cross-highlight entirely
              } else {
              for (const gh of enabledGroups) {
                const sfp = selectedFootprints[gh.sourceIndex];
                if (!sfp) continue;
                if (gh.sizeMin > 0 && size < gh.sizeMin) continue;
                if (gh.sizeMax !== null && size > gh.sizeMax) continue;
                const ovlStart = Math.max(fpAbsStart, sfp.absStart);
                const ovlEnd = Math.min(fpAbsEnd, sfp.absEnd);
                if (ovlStart >= ovlEnd) continue;
                if (gh.overlapFraction > 0) {
                  const ovlLen = ovlEnd - ovlStart;
                  const frac = Math.min(ovlLen / size, ovlLen / (sfp.absEnd - sfp.absStart));
                  if (frac < gh.overlapFraction) continue;
                }
                ctx.strokeStyle = gh.color + '80';
                ctx.lineWidth = 1.5;
                ctx.strokeRect(x, y, w, rowHeight - rowGap);
                break;
              }
              }  // close panel-scope else
            } else {
              // No groups defined yet — outline anything overlapping the
              // current selection. Respect panel layer scope: when
              // analysisLayer is non-primary, skip primary intervals.
              if (footprintAnalysisLayer && footprintAnalysisLayer !== 'nuc' && footprintAnalysisLayer !== 'footprint') {
                // skip
              } else {
                const overlaps = selectedFootprints.some(
                  sf => fpAbsStart < sf.absEnd && fpAbsEnd > sf.absStart
                );
                if (overlaps) {
                  ctx.strokeStyle = 'rgba(245, 158, 11, 0.5)';
                  ctx.lineWidth = 1;
                  ctx.strokeRect(x, y, w, rowHeight - rowGap);
                }
              }
            }
          }
        }
      }
    };

    const drawBaseModificationMarks = (evidenceOnly = false) => {
      // Draw per-base modification / deamination marks. Each type is an
      // independent layer with its own toggle; per-read positions come from
      // the backend split of MM/ML by mod_type and IUPAC R/Y scans.
      const methylHeight = Math.max(2, rowHeight - rowGap);
      const methylWidth = Math.max(1, scale * 0.8);

      const drawMarks = (positions: number[] | undefined, color: string, opacity = 1) => {
        if (!positions || positions.length === 0) return;
        ctx.globalAlpha = opacity;
        ctx.fillStyle = color;
        for (const pos of positions) {
          const adjustedPos = pos + linkedOffset;
          if (adjustedPos < 0 || adjustedPos > regionWidth) continue;
          const x = toX(adjustedPos);
          ctx.fillRect(x - methylWidth / 2, y, methylWidth, methylHeight);
        }
        ctx.globalAlpha = 1;
      };

      const drawOpportunityMarks = (
        positions: number[] | undefined,
        color: string,
        edge: 'top' | 'bottom',
        opacity = 1,
      ) => {
        if (!positions || positions.length === 0) return;
        ctx.globalAlpha = opacity;
        ctx.fillStyle = color;
        const tickHeight = Math.max(1, Math.min(3, Math.floor(methylHeight / 3)));
        const tickY = edge === 'top' ? y : y + methylHeight - tickHeight;
        for (const pos of positions) {
          const adjustedPos = pos + linkedOffset;
          if (adjustedPos < 0 || adjustedPos > regionWidth) continue;
          const x = toX(adjustedPos);
          ctx.fillRect(x - methylWidth / 2, tickY, methylWidth, tickHeight);
        }
        ctx.globalAlpha = 1;
      };

      // m6A — m6a-tagged MM/ML positions. `read.methyl` is a back-compat union
      // (populated on the server when m6a is primary) so the legacy 'mod'
      // toggle still lights up the purple marks on older dataset shapes.
      if (!evidenceOnly && m6aToggled) {
        drawMarks(m6aPositions(read), MOD_COLORS.m6a, layerOpacity('m6a', 1));
      }

      // 5mC — C+m MM/ML blocks. Separate toggle from m6a now.
      if (!evidenceOnly && enabledModTypes.m5c) {
        drawMarks(read.methyl_m5c, MOD_COLORS.m5c, layerOpacity('m5c', 1));
      }

      // Possible DAF target sites are deliberately short edge rugs so the
      // full-height observed events stay legible through the row center.
      const showDeamOpportunities = !!enabledModTypes.deam_opportunity;
      if (showDeamOpportunities && evidenceOnly) {
        const opportunityOpacity = layerOpacity('deam_opportunity', 1);
        drawOpportunityMarks(read.possible_deam_ct, MOD_COLORS.deam_possible_ct, 'top', opportunityOpacity);
        drawOpportunityMarks(read.possible_deam_ga, MOD_COLORS.deam_possible_ga, 'bottom', opportunityOpacity);
      }

      // Deam — split by blockMod (0 = R / GA-dea, 1 = Y / CT-dea) so the
      // user can see deamination direction at a glance. Requires per-event
      // data from `read.deam`; the legacy union field is not sufficient.
      if (
        enabledModTypes.deam
        && read.deam
        && read.deam.length > 0
        && (evidenceOnly === showDeamOpportunities)
      ) {
        const rPositions: number[] = [];
        const yPositions: number[] = [];
        for (const [pos, flavor] of read.deam) {
          (flavor === 1 ? yPositions : rPositions).push(pos);
        }
        if (showDeamOpportunities) {
          drawMarks([...rPositions, ...yPositions], MOD_COLORS.deam_observed, layerOpacity('deam', 1));
        } else {
          const deamOpacity = layerOpacity('deam', 1);
          drawMarks(rPositions, MOD_COLORS.deam_r, deamOpacity);
          drawMarks(yPositions, MOD_COLORS.deam_y, deamOpacity);
        }
      }
    };

    // Generic annotation layer overlay loop (v3 caller layers + any custom types).
    // MSP remains an internal storage key; FIRE is the user-facing toggle/color.
    // 'nuc' is skipped — nucleosomes are drawn as primary intervals + mq gradient above.
    const layerEntries = read.layers
      ? Object.entries(read.layers).sort(([a], [b]) => {
          return annotationLayerRenderRank(a) - annotationLayerRenderRank(b);
        })
      : [];
    const BACKGROUND_LAYERS = new Set(['ddda_mcg', 'ddda_mcg_hemi', 'deam_ct', 'deam_ga']);
    function drawLayerOverlays(phase: 'background' | 'fire' | 'non-fire') {
      const ctx = ctxNonNull;
      if (!layerEntries.length) return;
      const tfCfg = activeColormap.tfOverlay;
      for (const [layerName, layer] of layerEntries) {
        if (layerName === 'nuc') continue;  // drawn as primary intervals
        const isFireLayer = layerName === 'msp' || layerName === 'fire';
        // Domain-scale layers (DddA mCG spans, per-strand coverage of DAF
        // consensus reads) go behind the segmentation calls.
        const isBackgroundLayer = BACKGROUND_LAYERS.has(layerName);
        if (phase === 'background' ? !isBackgroundLayer : isBackgroundLayer) continue;
        if (phase === 'fire' && !isFireLayer) continue;
        if (phase === 'non-fire' && isFireLayer) continue;
        const displayLayerName = layerName === 'msp' ? 'fire' : layerName;
        const isConsensusFamilyLayer = layerName === 'tf_consensus'
          || layerName === 'tf_cross_consensus';
        const carriesNativeFamilyAssignments = layerName === 'tf_sr'
          && (layer.quality_names ?? []).includes('fi');
        const familyAssignmentsEnabled = !!enabledModTypes.tf_consensus;
        const layerEnabled = layerName === 'msp'
          ? !!(enabledModTypes.fire || enabledModTypes.msp)
          : !!(enabledModTypes as Record<string, boolean>)[layerName]
            || (carriesNativeFamilyAssignments && familyAssignmentsEnabled);
        if (!layerEnabled) continue;
        if (!layer.intervals?.length) continue;

        // Color + opacity: TF layer uses tfOverlay config; others use layer colors
        const isTf = layerName === 'tf';
        const isStrandRescue = isStrandRescueLayer(layerName);
        const layerColor = isTf && tfCfg?.color
          ? tfCfg.color
          : (layerColors?.[displayLayerName] ?? getLayerColor(displayLayerName));
        // CR/XCR are categorical assignment layers. Their likelihoods remain
        // available as tq/fq filters and in the tooltip, but an accepted call
        // must look assigned in both assays. Multiplying DddA's often modest
        // tq and local-family fq previously made valid calls nearly white.
        const maxOpacity = isConsensusFamilyLayer
          ? 1
          : layerOpacity(displayLayerName, isBackgroundLayer ? 0.35 : isTf && tfCfg ? tfCfg.maxOpacity : 0.65);
        const minOpacity = isConsensusFamilyLayer
          ? 1
          : Math.min(isBackgroundLayer ? 0.15 : isTf && tfCfg ? tfCfg.minOpacity : 0.25, maxOpacity);
        const minQ = isTf && tfCfg ? tfCfg.minTq : 0;

        // First quality dim used for body opacity (tq for tf, aq for FIRE/internal MSP).
        // Layers without any quality dimension render at full opacity (255)
        // rather than a middle-grey default — "no data" means "no reason to
        // fade", not "medium confidence".
        const qIdx = isStrandRescue
          ? (layer.quality_names?.indexOf('q0') ?? -1)
          : (layer.quality_names?.length ? 0 : -1);
        const qualityValues = qIdx >= 0 ? layer.qualities?.[qIdx] : undefined;
        // Some legacy MSP BigBeds declare blockAq but write only 0 (or the
        // historical neutral sentinel 128). That is missing quality metadata,
        // not evidence for nearly-transparent FIRE. Match the loader/filter
        // fallback and render raw accessibility at normal opacity.
        const fireQualityUnavailable = isFireLayer
          && layer.quality_names?.[qIdx] === 'aq'
          && !!qualityValues?.length
          && qualityValues.every(value => value == null || value === 0 || value === 128);

        // Edge-confidence indices for left/right boundary opacity ramps.
        // v3 spec: TF carries el/er; nuc carries lq/rq. Nucleosomes and
        // FIRE/internal MSP intervals without these dims skip the ramp and render flat.
        const qNames = layer.quality_names ?? [];
        // q1/q2 on consensus-refinement layers are exact-edge posterior
        // marginals, not the v3 lq/rq or el/er distance encoding. The backend
        // swaps molecular reverse reads into genomic-left/right order. Do not
        // fabricate a liberal boundary from them; draw confidence-weighted
        // exact-edge ticks after the interval body instead.
        const srEdgeLeftIdx = isStrandRescue ? qNames.indexOf('q1') : -1;
        const srEdgeRightIdx = isStrandRescue ? qNames.indexOf('q2') : -1;
        const edgeLeftIdx = isStrandRescue
          ? -1
          : (qNames.indexOf('el') >= 0 ? qNames.indexOf('el') : qNames.indexOf('lq'));
        const edgeRightIdx = isStrandRescue
          ? -1
          : (qNames.indexOf('er') >= 0 ? qNames.indexOf('er') : qNames.indexOf('rq'));
        const hasEdgeQ = edgeLeftIdx >= 0 || edgeRightIdx >= 0;
        // Edge mode: TF honors the global edge-ambiguity mode when 'TF' is
        // enabled (else crisp/strict); other custom layers keep the soft feather.
        const effectiveEdgeMode: 'soft' | 'strict' | 'loose' =
          isTf ? (edgeAmb.applyTf ? edgeAmb.mode : 'strict') : 'soft';

        for (let li = 0; li < layer.intervals.length; li++) {
          const [ls, le, lsize] = layer.intervals[li];
          if (layer.consensus_workflow && layer.consensus_records?.[li]) {
            // Dedicated workflow layers paint the ACTUAL frozen per-unit span.
            // Never consult the Cart, align to a family median, or reassign at Q.
            const record = layer.consensus_records[li];
            const a = toX(ls + linkedOffset), b = toX(le + linkedOffset);
            const x = Math.min(a,b), w = Math.max(1,Math.abs(b-a));
            const h = Math.max(1,rowHeight-rowGap);
            const outline = consensusOutline(record);
            const primaryFamily=consensusPrimaryFamily(record);
            const layerJob=(layer as {job_id?:string}).job_id;
            const primaryCartGroup=primaryFamily?cartStateGroup(layerJob,primaryFamily):undefined;
            ctx.save();
            // Recaller calls carry each edge's range: the Edges control draws the sure inner span (strict), the widest
            // span its marks allow (loose), or both (soft: widest faint, sure span solid).
            const rcTier = layerName === 'tf_rc' && ['edge', 'loose'].includes(String((record as { tier?: string }).tier ?? ''));
            // Looser-tier calls take their edges from the class and the molecule's protected run: drawn whole.
            const edgeRange = layerName === 'tf_rc' && edgeAmb.applyTf && !rcTier
              ? (record as { edge_range?: [[number, number], [number, number]] | null }).edge_range : null;
            if (layer.draw_style !== 'outline' && edgeRange) {
              const span = (lo: number, hi: number) => {
                const p = toX(lo - start + linkedOffset), q = toX(hi - start + linkedOffset);
                return [Math.min(p, q), Math.max(1, Math.abs(q - p))] as const;
              };
              const inner = edgeRange[0][1] < edgeRange[1][0] ? span(edgeRange[0][1], edgeRange[1][0]) : [x, w] as const;
              const outer = span(edgeRange[0][0], edgeRange[1][1]);
              ctx.fillStyle = consensusRecordColor(record);
              if (edgeAmb.mode === 'soft') { ctx.globalAlpha = .35; ctx.fillRect(outer[0], y, outer[1], h); }
              ctx.globalAlpha = .95;
              const [fx, fw] = edgeAmb.mode === 'loose' ? outer : inner;
              ctx.fillRect(fx, y, fw, h);
            } else if (layer.draw_style !== 'outline') {
              ctx.fillStyle = consensusRecordColor(record);
              ctx.globalAlpha = layerName === 'tf_native_replay' ? .5 : .95;
              ctx.fillRect(x,y,w,h);
            }
            // Footprint-class calls the native caller did not make (the recaller's own): a thin dark outline, dashed
            // for calls counted only by a looser rule (edge / overlap).
            if (layerName === 'tf_rc' && ((record as { recaller_added?: boolean }).recaller_added || rcTier)) {
              ctx.globalAlpha = .75; ctx.setLineDash(rcTier ? [2, 1.5] : []); ctx.strokeStyle = '#1f2937'; ctx.lineWidth = Math.min(1, Math.max(.5, h / 4));
              ctx.strokeRect(x + .25, y + .25, Math.max(.5, w - .5), Math.max(.5, h - .5));
              ctx.setLineDash([]);
            }
            if (outline && (record.manual || record.manual_group_id || layer.draw_style === 'outline' || layer.show_quality_outlines)) {
              ctx.globalAlpha=1;ctx.strokeStyle=outline.color;ctx.lineWidth=Math.min(1.5,Math.max(.7,h/3));
              if(outline.dashed)ctx.setLineDash([3,2]);
              ctx.strokeRect(x,y,w,h);
            }
            if(primaryFamily&&relatedConsensusFamilies?.has(primaryFamily)&&(!layerJob||!consensusViewJobId||layerJob===consensusViewJobId)){
              const selected=selectedConsensusFamilies?.has(primaryFamily)||primaryFamily===selectedConsensusFamily;
              ctx.globalAlpha=1;ctx.setLineDash([]);ctx.strokeStyle=selected?'#111827':'#00a8bb';
              ctx.lineWidth=selected?2.5:2;
              ctx.strokeRect(x-.5,y-.5,w+1,h+1);
            }
            if(primaryCartGroup?.id===selectedFamilyGroupId){
              ctx.globalAlpha=1;ctx.setLineDash([]);ctx.strokeStyle='#f59e0b';ctx.lineWidth=2.5;
              ctx.strokeRect(x-.5,y-.5,w+1,h+1);
            }
            ctx.restore();
            continue;
          }
          const q = !fireQualityUnavailable && qIdx >= 0 && layer.qualities?.[qIdx]?.[li] !== undefined
            ? layer.qualities[qIdx][li] : 255;
          if (q < minQ) continue;
          // Genomic edge sharpness (el/lq = left, er/rq = right).
          const qGenL = edgeLeftIdx  >= 0 ? (layer.qualities?.[edgeLeftIdx]?.[li]  ?? 255) : 255;
          const qGenR = edgeRightIdx >= 0 ? (layer.qualities?.[edgeRightIdx]?.[li] ?? 255) : 255;
          const baseStart = ls + linkedOffset;
          const baseEnd = le + linkedOffset;
          const intervalSize = lsize ?? (le - ls);
          const sourceInterval = layer.source_intervals?.[li];
          const fpAbsStart = start + (sourceInterval?.[0] ?? ls);
          const fpAbsEnd = start + (sourceInterval?.[1] ?? le);
          const familyMetadata = (
            layerName === 'tf_consensus'
            || layerName === 'tf_cross_consensus'
            || (carriesNativeFamilyAssignments && familyAssignmentsEnabled)
          )
            ? tfFamilyMetadata(layer, li)
            : null;
          const familyDisplay = familyMetadata
            ? tfFamilyDisplayGeometryFromIndex(
              familyDisplayIndex,
              familyMetadata.familyId,
              fpAbsStart,
              fpAbsEnd,
              layerName,
              familyMetadata.familyConfidence,
              familyMetadata.annotationName,
            )
            : null;
          if (
            layerName === 'tf_cross_consensus'
            && familyMetadata
            && !familyDisplay
          ) continue;
          const edgeGapGenL = hasEdgeQ ? edgeGapBp(qGenL) : 0;
          const edgeGapGenR = hasEdgeQ ? edgeGapBp(qGenR) : 0;
          let aStart = baseStart;
          let aEnd = baseEnd;
          // Loose mode pushes each edge outward to its liberal boundary.
          if (hasEdgeQ && effectiveEdgeMode === 'loose') {
            aStart -= edgeGapGenL;
            aEnd += edgeGapGenR;
          }
          const relativeFamilyDisplay = familyDisplay
            ? {
              ...familyDisplay,
              start: familyDisplay.start - start + linkedOffset,
              end: familyDisplay.end - start + linkedOffset,
            }
            : null;
          const payloadFamilyInterval = layer.family_intervals?.[li];
          const payloadFamilyDisplay = payloadFamilyInterval
            ? {
              groupId: familyDisplay?.groupId ?? '',
              mode: familyDisplay?.mode ?? 'both' as const,
              start: payloadFamilyInterval[0] + linkedOffset,
              end: payloadFamilyInterval[1] + linkedOffset,
            }
            : null;
          const renderGeometry = tfFamilyRenderGeometry(
            aStart,
            aEnd,
            relativeFamilyDisplay ?? payloadFamilyDisplay,
          );
          const selectedFamily = familyDisplay?.groupId === selectedFamilyGroupId;
          const familyOutlineStart = renderGeometry.outlineStart
            ?? (selectedFamily ? relativeFamilyDisplay?.start ?? null : null);
          const familyOutlineEnd = renderGeometry.outlineEnd
            ?? (selectedFamily ? relativeFamilyDisplay?.end ?? null : null);
          aStart = renderGeometry.fillStart;
          aEnd = renderGeometry.fillEnd;
          let visibleStart = hasEdgeQ && effectiveEdgeMode === 'soft' ? baseStart - edgeGapGenL : aStart;
          let visibleEnd = hasEdgeQ && effectiveEdgeMode === 'soft' ? baseEnd + edgeGapGenR : aEnd;
          if (familyOutlineStart != null && familyOutlineEnd != null) {
            visibleStart = Math.min(visibleStart, familyOutlineStart);
            visibleEnd = Math.max(visibleEnd, familyOutlineEnd);
          }
          if (visibleEnd < 0 || visibleStart > regionWidth) continue;
          // toX flips pixel mapping under reverse, so we can't assume
          // toX(aStart) < toX(aEnd). Normalize to (leftX, rightX) in pixel
          // space so the fillRect below always gets a positive width.
          const pxA = toX(Math.max(0, aStart));
          const pxB = toX(Math.min(regionWidth, aEnd));
          const x = Math.min(pxA, pxB);
          const xEnd = Math.max(pxA, pxB);
          const w = Math.max(1, xEnd - x);
          // Rule-aware color: cart entries first (with reference-overlap
          // gating when set), then activeColormap.rules. Falls back to
          // layerColor when nothing matches.
          const cartHit = cartMatch(
            fpAbsStart, fpAbsEnd, intervalSize, displayLayerName,
            familyMetadata,
          ) ?? cartMatch(
            fpAbsStart, fpAbsEnd, intervalSize, layerName,
            familyMetadata,
          );
          const rescueAction = isStrandRescue
            ? classifyStrandRescueAction(layer.refinement_kinds?.[li], layer.annotation_names?.[li])
            : null;
          const rescueColor = isStrandRescue && rescueAction
            ? strandRescueActionColor(
              layerName,
              rescueAction,
              layerColors?.[strandRescueBaseLayer(layerName)]
                ?? getLayerColor(strandRescueBaseLayer(layerName)),
            )
            : layerColor;
          let fill = cartHit
            ?? (familyMetadata ? tfFamilyColor(familyMetadata.familyId,familyMetadata.annotationName) : rescueColor);
          let visualOpacity = isConsensusFamilyLayer
            ? 1
            : familyMetadata?.confidenceKind === 'assignment'
              ? 0.4 + 0.6 * familyMetadata.familyConfidence
              : 1;
          let matchedExplicitColor = Boolean(cartHit);
          // Rule-based recoloring rules:
          //  - TF layer: always evaluate rules (historical behavior — size
          //    rules categorize TF output into pol2/tf/other).
          //  - Other layers (FIRE/internal MSP, custom): only evaluate rules that
          //    explicitly target this layer via `targetLayers`. Prevents
          //    generic size rules from recoloring FIRE/custom intervals with
          //    e.g. a "TF" rule color. Lets a layer-specific gated rule
          //    repaint the subset that passes.
          const layerHasTargetedRule = layerHasTargetedRules(layerName);
          if ((isTf || layerHasTargetedRule) && !cartHit) {
            let intervalQualities: Record<string, number> | undefined;
            const getIntervalQualities = () => {
              if (intervalQualities !== undefined) return intervalQualities;
              intervalQualities = {};
              if (layer.quality_names && layer.qualities) {
                for (let qn = 0; qn < layer.quality_names.length; qn++) {
                  const name = layer.quality_names[qn];
                  const val = layer.qualities[qn]?.[li];
                  if (val !== undefined) intervalQualities[name] = val;
                }
              }
              return intervalQualities;
            };
            for (const rule of activeColormap.rules) {
              // Non-TF layers: only consider rules that explicitly target this layer.
              if (!isTf && ((rule.targetLayers ?? []).length === 0 || !ruleTargetsLayer(rule, layerName))) continue;
              const ruleQualities = (rule.qualityGates?.length ?? 0) > 0 ? getIntervalQualities() : undefined;
              if (footprintMatchesRule(
                ls,
                le,
                intervalSize,
                rule,
                ruleCtx,
                layerName,
                ruleQualities,
                layer.annotation_names?.[li],
              )) {
                fill = resolveRuleColor(rule, intervalSize);
                visualOpacity = ruleOpacity(rule.opacity);
                matchedExplicitColor = true;
                break;
              }
            }
          }
          if (!matchedExplicitColor && layerHasTargetedRule) {
            visualOpacity = layerBackgroundOpacity(displayLayerName);
          }
          if (visualOpacity <= 0) continue;
          const alpha = Math.round(255 * visualOpacity * (minOpacity + (maxOpacity - minOpacity) * (q / 255)));
          const alphaHex = alpha.toString(16).padStart(2, '0');
          // Soft mode draws the strict body plus a cheap strict-to-loose
          // uncertainty band outside each fuzzy edge. No per-footprint gradients.
          if (hasEdgeQ && effectiveEdgeMode === 'soft') {
            // qGenL / qGenR reference GENOMIC left/right. Under reverse, the
            // genomic-left edge is visually on the RIGHT, so the corresponding
            // strict-to-loose band widths swap sides.
            const edgeGapVisL = (isReversed ? edgeGapGenR : edgeGapGenL) * scale;
            const edgeGapVisR = (isReversed ? edgeGapGenL : edgeGapGenR) * scale;
            const bodyAlpha = alpha / 255;
            const strictPxA = toX(baseStart);
            const strictPxB = toX(baseEnd);
            const strictX = Math.min(strictPxA, strictPxB);
            const strictW = Math.max(1, Math.abs(strictPxB - strictPxA));
            if (!drawStrictToLooseSoftEdgeRect(ctx, strictX, y, strictW, rowHeight - rowGap, fill, bodyAlpha, edgeGapVisL, edgeGapVisR)) {
              ctx.fillStyle = fill + alphaHex;
              ctx.fillRect(x, y, w, rowHeight - rowGap);
            }
          } else {
            ctx.fillStyle = fill + alphaHex;
            ctx.fillRect(x, y, w, rowHeight - rowGap);
          }
          // Bottom border for visibility at small row heights
          const borderAlphaHex = Math.round(0x90 * visualOpacity).toString(16).padStart(2, '0');
          const inferenceStageColor = layerName === 'tf_cross_consensus'
            ? '#db2777'
            : layerName === 'tf_consensus' ? '#0891b2' : fill;
          ctx.fillStyle = inferenceStageColor + borderAlphaHex;
          ctx.fillRect(x, y + rowHeight - rowGap - 1, w, 1);
          if (familyOutlineStart != null && familyOutlineEnd != null) {
            // The colored block is the assigned call on this molecule.  The
            // dark outline is the frozen family model, so its boundaries are
            // identical for every member of the family.  Keep the outline
            // unclamped: the canvas clip hides off-screen geometry without
            // inventing a false end-cap at the viewport boundary.
            const familyPxA = toX(familyOutlineStart);
            const familyPxB = toX(familyOutlineEnd);
            const familyX = Math.min(familyPxA, familyPxB);
            const familyW = Math.max(1, Math.abs(familyPxB - familyPxA));
            ctx.save();
            if (selectedFamily) {
              // A pale halo keeps the selected shared boundary legible over
              // any family color, followed by a strong amber inspection line.
              ctx.strokeStyle = 'rgba(255, 255, 255, 0.96)';
              ctx.lineWidth = Math.max(3, Math.min(5, rowHeight / 2));
              ctx.strokeRect(
                familyX,
                y,
                familyW,
                Math.max(1, rowHeight - rowGap),
              );
              ctx.strokeStyle = '#f59e0b';
              ctx.lineWidth = Math.max(2, Math.min(3, rowHeight / 3));
            } else {
              ctx.strokeStyle = layerName === 'tf_cross_consensus'
                ? '#db2777'
                : layerName === 'tf_consensus' ? '#0891b2' : 'rgba(15, 23, 42, 0.82)';
              ctx.lineWidth = Math.max(1, Math.min(1.5, rowHeight / 4));
              if (layerName === 'tf_cross_consensus') ctx.setLineDash([3, 2]);
            }
            ctx.strokeRect(
              familyX,
              y,
              familyW,
              Math.max(1, rowHeight - rowGap),
            );
            ctx.restore();
          }
          if (isStrandRescue && rescueAction === 'harmonized') {
            // A harmonization changes geometry rather than inventing a call.
            // An explicit outline keeps both revised boundaries visible while
            // preserving the underlying baseline-layer color as context.
            ctx.strokeStyle = fill;
            ctx.lineWidth = Math.max(1, Math.min(2, rowHeight / 4));
            ctx.strokeRect(x, y, w, Math.max(1, rowHeight - rowGap));
          }
          if (isStrandRescue && rescueAction === 'configuration') {
            // A latent configuration is an explicit alternative structural
            // hypothesis. Outline it even when fi/fq family coloring supplies
            // the fill, so model-derived geometry is never mistaken for an
            // unchanged molecule-level call.
            ctx.save();
            ctx.strokeStyle = '#f59e0b';
            ctx.lineWidth = Math.max(1.5, Math.min(2.5, rowHeight / 3));
            const propagated = /^fhlt_[0-9a-f]+_P_/i.test(layer.annotation_names?.[li] ?? '');
            ctx.setLineDash(propagated ? [1, 2] : [3, 2]);
            ctx.strokeRect(x, y, w, Math.max(1, rowHeight - rowGap));
            ctx.restore();
          }
          if (
            isStrandRescue
            && rescueAction !== 'unchanged'
            && familyDisplay?.mode !== 'family'
          ) {
            const exactLeftQ = srEdgeLeftIdx >= 0
              ? (layer.qualities?.[srEdgeLeftIdx]?.[li] ?? 0) : 0;
            const exactRightQ = srEdgeRightIdx >= 0
              ? (layer.qualities?.[srEdgeRightIdx]?.[li] ?? 0) : 0;
            const exactHeight = Math.max(1, rowHeight - rowGap);
            const drawExactEdge = (position: number, confidence: number) => {
              if (confidence <= 0) return;
              ctx.save();
              ctx.globalAlpha = Math.max(0.08, Math.min(1, confidence / 255));
              ctx.fillStyle = fill;
              ctx.fillRect(Math.round(toX(position)) - 1, y, 2, exactHeight);
              ctx.restore();
            };
            drawExactEdge(baseStart, exactLeftQ);
            drawExactEdge(baseEnd, exactRightQ);
          }

          // Selection highlight for layer-selected footprints (TF, FIRE, custom).
          // Match by (readId, layer, intervalIndex) — the layer-specific index
          // stored when getFootprintAtXY hits a layer overlay.
          let layerOverlaySelected = false;
          if (selectedFootprints.length > 0) {
            const drawn = { readId: read.id, datasetId, chrom, absStart: start + ls, absEnd: start + le };
            layerOverlaySelected = selectedFootprints.some(
              sf => layerMatches(sf.layer, layerName) && isSelectedFootprint(sf, drawn)
            );
            if (layerOverlaySelected) {
              ctx.strokeStyle = '#d97706';
              ctx.lineWidth = 2;
              ctx.strokeRect(x - 1, y - 1, w + 2, rowHeight - rowGap + 2);
            }
          }

          // Cross-highlight matching footprints in this same layer across reads
          // (TF clicks should highlight other TFs that match the group, etc.).
          // Skip when the panel scope is set to a different layer.
          if (!layerOverlaySelected && footprintCrossHighlight && selectedFootprints.length > 0) {
            const inScope = !footprintAnalysisLayer
              || layerMatches(footprintAnalysisLayer, layerName);
            if (inScope) {
              const enabledGroups = cartEntries;
              const fpAbsStart = start + ls;
              const fpAbsEnd = start + le;
              const ivSize = lsize ?? (le - ls);

              if (enabledGroups.length > 0) {
                for (const gh of enabledGroups) {
                  const sfp = selectedFootprints[gh.sourceIndex];
                  const referenceStart = sfp?.absStart ?? gh.referenceAbsStart;
                  const referenceEnd = sfp?.absEnd ?? gh.referenceAbsEnd;
                  if (referenceStart == null || referenceEnd == null) continue;
                  if (gh.layer && !layerMatches(gh.layer, layerName)) continue;
                  if (gh.sizeMin > 0 && ivSize < gh.sizeMin) continue;
                  if (gh.sizeMax !== null && ivSize > gh.sizeMax) continue;
                  if (!gh.familyAnnotationName && gh.familyId != null && gh.familyId !== familyMetadata?.familyId) continue;
                  if (gh.familyAnnotationName && gh.familyAnnotationName !== familyMetadata?.annotationName) continue;
                  if (!passesFamilyAssignmentConfidence(
                    familyMetadata,
                    gh.minFamilyConfidence ?? 0,
                  )) continue;
                  const ovlStart = Math.max(fpAbsStart, referenceStart);
                  const ovlEnd = Math.min(fpAbsEnd, referenceEnd);
                  if (ovlStart >= ovlEnd) continue;
                  const ovlLen = ovlEnd - ovlStart;
                  if (
                    (gh.minFpCoverage ?? 0) > 0
                    && ovlLen < (gh.minFpCoverage ?? 0) * ivSize
                  ) continue;
                  if (
                    (gh.minTargetCoverage ?? 0) > 0
                    && ovlLen < (gh.minTargetCoverage ?? 0) * Math.max(1, referenceEnd - referenceStart)
                  ) continue;
                  if (gh.overlapFraction > 0) {
                    const frac = Math.min(
                      ovlLen / ivSize,
                      ovlLen / Math.max(1, referenceEnd - referenceStart),
                    );
                    if (frac < gh.overlapFraction) continue;
                  }
                  ctx.strokeStyle = gh.color + 'C0';
                  ctx.lineWidth = 1.5;
                  ctx.strokeRect(x, y, w, rowHeight - rowGap);
                  break;
                }
              } else {
                const overlaps = selectedFootprints.some(
                  sf => fpAbsStart < sf.absEnd && fpAbsEnd > sf.absStart
                );
                if (overlaps) {
                  ctx.strokeStyle = 'rgba(245, 158, 11, 0.7)';
                  ctx.lineWidth = 1;
                  ctx.strokeRect(x, y, w, rowHeight - rowGap);
                }
              }
            }
          }
        }
      }
    }

    // Legacy FIRE overlay — only drawn when no 'msp' layer exists (backward compat
    // for BAMs where as/al tags were parsed into read.fire but not into layers).
    function drawLegacyFireOverlay() {
      const ctx = ctxNonNull;
      if (!read.layers?.msp && !read.layers?.fire && enabledModTypes.fire && read.fire && read.fire.length > 0) {
        const fireOpacity = layerOpacity('fire', 0.55);
        const fireHasTargetedRule = layerHasTargetedRules('fire');
        for (const [fStart, fEnd, fQual] of read.fire) {
          const quality = Number.isFinite(Number(fQual)) ? Number(fQual) : 255;
          const aStart = fStart + linkedOffset;
          const aEnd = fEnd + linkedOffset;
          if (aEnd < 0 || aStart > regionWidth) continue;
          const pxA = toX(Math.max(0, aStart));
          const pxB = toX(Math.min(regionWidth, aEnd));
          const x = Math.min(pxA, pxB);
          const xEnd = Math.max(pxA, pxB);
          const w = Math.max(1, xEnd - x);
          const intervalSize = fEnd - fStart;
          let fill: string = MOD_COLORS.fire;
          let visualOpacity = 1;
          let matchedExplicitColor = false;
          if (fireHasTargetedRule) {
            const ruleQualities = { aq: quality };
            for (const rule of activeColormap.rules) {
              if (((rule.targetLayers ?? []).length === 0 || !ruleTargetsLayer(rule, 'fire'))) continue;
              if (footprintMatchesRule(fStart, fEnd, intervalSize, rule, ruleCtx, 'fire', ruleQualities)) {
                fill = resolveRuleColor(rule, intervalSize);
                visualOpacity = ruleOpacity(rule.opacity);
                matchedExplicitColor = true;
                break;
              }
            }
          }
          if (!matchedExplicitColor && fireHasTargetedRule) {
            visualOpacity = layerBackgroundOpacity('fire');
          }
          if (visualOpacity <= 0) continue;
          const alpha = Math.round(255 * fireOpacity * visualOpacity * (0.35 + 0.65 * (quality / 255)));
          ctx.fillStyle = fill + alpha.toString(16).padStart(2, '0');
          ctx.fillRect(x, y, w, rowHeight - rowGap);
          ctx.fillStyle = fill + Math.round(0x90 * visualOpacity).toString(16).padStart(2, '0');
          ctx.fillRect(x, y + rowHeight - rowGap - 1, w, 1);
        }
      }
    }

    // Default z-order: read extent background, broad DddA mCG spans, FIRE/MSP
    // accessibility, primary nuc/FP, base marks, then TF/custom overlays. This
    // keeps broad intervals from hiding the nuc/TF layers when several are on.
    withReadBodyClip(ctxNonNull, bodyClip, height, () => {
      drawLayerOverlays('background');
      drawLayerOverlays('fire');
      drawLegacyFireOverlay();
      drawPrimaryItems();
      drawBaseModificationMarks();
      drawLayerOverlays('non-fire');
      // In evidence mode, keep the short possible-site rugs and full-height
      // observed events above consensus overlays. Otherwise the footprint fill
      // hides precisely the evidence the rescue view is meant to explain.
      if (enabledModTypes.deam_opportunity) drawBaseModificationMarks(true);
    });
    // This independent observation view is transported by the native encoder,
    // not inferred from interval gaps, reference-only targets, or family Q.
    const latticeRead=nativeLattice?.reads[read.id];
    if(latticeRead){
      ctx.save();
      const targetColor=latticeRead.strand==='CT'?'#0d9488':latticeRead.strand==='GA'?'#d97706':'#7c3aed';
      const h=Math.max(2,rowHeight-rowGap),mark=Math.max(.7,Math.min(1.7,scale*.55));
      for(let oi=0;oi<latticeRead.positions.length;oi++){
        const p=latticeRead.positions[oi]+linkedOffset;if(p<0||p>=regionWidth)continue;
        const x=toX(p);const hit=latticeRead.hits[oi]===1;
        ctx.globalAlpha=hit&&latticeShowHits?1:.72;
        if(hit&&latticeShowHits){ctx.fillStyle='#111827';ctx.fillRect(x-mark/2,y,mark,h);}
        else if(latticeStyle==='dots'&&h>=4){ctx.strokeStyle=targetColor;ctx.lineWidth=.8;
          ctx.beginPath();ctx.arc(x,y+h/2,Math.min(1.5,h/4),0,Math.PI*2);ctx.stroke();}
        else {ctx.fillStyle=targetColor;ctx.fillRect(x-mark/2,y+h-Math.min(2,h/2),mark,Math.min(2,h/2));}
      }
      ctx.restore();
    }

    if (readSv) {
      drawReadSvMarks(ctx, readSv, {
        y, rowHeight: Math.max(1, rowHeight - rowGap), toX, isReversed,
        backgroundColor: readBackgroundColor, gapColor: noReadBackgroundColor,
      });
    }
    if (read.live_lift) {
      drawLiveLiftMarks(ctx, read.live_lift, {
        y, rowHeight: Math.max(1, rowHeight - rowGap), linkedOffset, regionWidth, toX, isReversed,
        backgroundColor: readBackgroundColor,
      });
    }

    // Draw CIGAR events (small indels: SV display draws those of at least its min size)
    if (isBAM && read.cigar && read.cigar.length > 0) {
      const cigarHeight = Math.max(2, rowHeight - rowGap);

      for (const event of read.cigar) {
        if (svEnabled && event.type !== 'M' && event.len >= svMinLen) continue;
        const adjustedPos = event.pos + linkedOffset;
        if (adjustedPos < 0 || adjustedPos > regionWidth) continue;
        const x = toX(adjustedPos);

        if (event.type === 'M' && enabledCigarTypes.mismatches) {
          const base = (event.seq || 'N').toUpperCase() as keyof typeof CIGAR_COLORS;
          ctx.fillStyle = CIGAR_COLORS[base] || CIGAR_COLORS.N;
          const mismatchWidth = Math.max(2, scale);
          // The base spans [pos, pos + 1): its left edge in either direction.
          ctx.fillRect(Math.min(x, toX(adjustedPos + 1)), y, mismatchWidth, cigarHeight);
        } else if (event.type === 'I' && enabledCigarTypes.insertions) {
          ctx.fillStyle = CIGAR_COLORS.insertion;
          const insertWidth = Math.max(2, 3);
          ctx.fillRect(x - insertWidth / 2, y, insertWidth, cigarHeight);
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x - 3, y - 4);
          ctx.lineTo(x + 3, y - 4);
          ctx.closePath();
          ctx.fill();
        } else if (event.type === 'D' && enabledCigarTypes.deletions) {
          ctx.strokeStyle = CIGAR_COLORS.deletion;
          ctx.lineWidth = 2;
          // Both ends through toX, so a reversed view draws it leftward.
          const endX = toX(adjustedPos + event.len);
          const lineEnd = Math.abs(endX - x) >= 1 ? endX : x + (isReversed ? -1 : 1);
          const midY = y + cigarHeight / 2;
          ctx.beginPath();
          ctx.moveTo(x, midY);
          ctx.lineTo(lineEnd, midY);
          ctx.stroke();
        }
      }
    }

    // Draw overlay marks
    for (const overlay of modificationOverlays) {
      const overlayType = overlay.type as keyof typeof enabledModTypes;
      if (!enabledModTypes[overlayType]) continue;

      const marks = overlayMarks[overlay.id];
      if (!marks) continue;

      const readMarks = marks[read.id];
      if (!readMarks || readMarks.length === 0) continue;

      ctx.fillStyle = overlay.color;
      const markHeight = Math.max(2, rowHeight - rowGap);
      const markWidth = Math.max(1, scale * 0.8);

      for (const pos of readMarks) {
        const adjustedPos = pos + linkedOffset;
        if (adjustedPos < 0 || adjustedPos > regionWidth) continue;
        const x = toX(adjustedPos);
        ctx.fillRect(x - markWidth / 2, y, markWidth, markHeight);
      }
    }

    // Draw annotation overlays (semi-transparent colored rectangles)
    if (annotationOverlays) {
      const readAnns = annotationOverlays[read.id];
      if (readAnns) {
        for (const ann of readAnns) {
          if (!(enabledAnnotationTypes?.[ann.type])) continue;
          const minConf = annotationThresholds?.[ann.type] ?? 0;
          if (ann.confidence < minConf) continue;
          const aStart = ann.start + linkedOffset;
          const aEnd = ann.end + linkedOffset;
          if (aEnd < 0 || aStart > regionWidth) continue;
          const pxA = toX(Math.max(0, aStart));
          const pxB = toX(Math.min(regionWidth, aEnd));
          const x = Math.min(pxA, pxB);
          const xEnd = Math.max(pxA, pxB);
          const w = Math.max(1, xEnd - x);
          const color = annotationColors?.[ann.type] || '#6366f1';
          const opMin = annotationOpacityMin ?? 0.2;
          const opMax = annotationOpacityMax ?? 0.6;
          const alpha = Math.round((opMin + (opMax - opMin) * ann.confidence) * 255);
          ctx.fillStyle = color + alpha.toString(16).padStart(2, '0');
          ctx.fillRect(x, y, w, rowHeight - rowGap);
          // Thin bottom border for visibility
          ctx.fillStyle = color + '80';
          ctx.fillRect(x, y + rowHeight - rowGap - 1, w, 1);
        }
      }
    }

    const hasDrawableExtent = read.intervals.length > 0;

    // Draw linked-molecule visual emphasis. This is intentionally independent
    // from selectedReadIds so it does not alter downstream selected-read stats.
    if (hasDrawableExtent && linkedHighlightIds?.has(read.id)) {
      const readStartRel = Math.min(...read.intervals.map(iv => iv[0])) + linkedOffset;
      const readEndRel = Math.max(...read.intervals.map(iv => iv[1])) + linkedOffset;
      const readX = isReversed ? toX(readEndRel) : toX(readStartRel);
      const readW = Math.max(1, (readEndRel - readStartRel) * scale);

      ctx.fillStyle = 'rgba(245, 158, 11, 0.12)';
      ctx.fillRect(readX, y, readW, rowHeight - rowGap);

      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(readX - 1, y - 1, readW + 2, rowHeight - rowGap + 2);
      ctx.setLineDash([]);

      ctx.fillStyle = '#f59e0b';
      ctx.fillRect(sidebarWidth, y, 3, rowHeight - rowGap);
    }

    // A read gone to by name, or highlighted from the read menu: a solid outline
    // and a bar in the gutter (not a data colour; the pulse is an overlay).
    if (hasDrawableExtent && readHighlightIds && readHighlightIds.size > 0
      && (readHighlightIds.has(read.id) || readHighlightIds.has(read.id.replace(/_\d+$/, '')))) {
      const readStartRel = Math.min(...read.intervals.map(iv => iv[0])) + linkedOffset;
      const readEndRel = Math.max(...read.intervals.map(iv => iv[1])) + linkedOffset;
      const readX = isReversed ? toX(readEndRel) : toX(readStartRel);
      const readW = Math.max(1, (readEndRel - readStartRel) * scale);
      ctx.strokeStyle = '#ca8a04';
      ctx.lineWidth = 2;
      ctx.setLineDash([]);
      ctx.strokeRect(readX - 1.5, y - 1.5, readW + 3, rowHeight - rowGap + 3);
      ctx.fillStyle = '#ca8a04';
      ctx.fillRect(sidebarWidth, y, 4, Math.max(1, rowHeight - rowGap));
    }

    // Draw Jupyter highlight background
    const highlightColor = jupyterReadHighlights.get(read.id);
    if (hasDrawableExtent && highlightColor) {
      const readStartRel = Math.min(...read.intervals.map(iv => iv[0])) + linkedOffset;
      const readEndRel = Math.max(...read.intervals.map(iv => iv[1])) + linkedOffset;
      const readX = isReversed ? toX(readEndRel) : toX(readStartRel);
      const readW = Math.max(1, (readEndRel - readStartRel) * scale);

      ctx.fillStyle = highlightColor + '40';
      ctx.fillRect(readX, y, readW, rowHeight - rowGap);

      ctx.strokeStyle = highlightColor;
      ctx.lineWidth = 2;
      ctx.strokeRect(readX - 1, y - 1, readW + 2, rowHeight - rowGap + 2);

      ctx.fillStyle = highlightColor;
      ctx.fillRect(sidebarWidth, y, 3, rowHeight - rowGap);
    }

    // Draw selection highlight for shift+click selected read
    if (hasDrawableExtent && selectedReadIds?.has(read.id)) {
      const readStartRel = Math.min(...read.intervals.map(iv => iv[0])) + linkedOffset;
      const readEndRel = Math.max(...read.intervals.map(iv => iv[1])) + linkedOffset;
      const readX = isReversed ? toX(readEndRel) : toX(readStartRel);
      const readW = Math.max(1, (readEndRel - readStartRel) * scale);

      ctx.strokeStyle = '#06b6d4';
      ctx.lineWidth = 2;
      ctx.strokeRect(readX - 1, y - 1, readW + 2, rowHeight - rowGap + 2);

      ctx.fillStyle = '#06b6d4';
      ctx.fillRect(sidebarWidth, y, 4, rowHeight - rowGap);
    }
  }

  const smoothing = activeColormap.displaySmoothing;
  if (smoothing?.enabled && (smoothing.sigmaX > 0 || smoothing.sigmaY > 0)) {
    applyGaussianSmoothing(
      ctx,
      sidebarWidth,
      headerHeight + histogramHeight,
      trackWidth,
      trackHeight,
      smoothing.sigmaX,
      smoothing.sigmaY,
    );
  }

  // Draw cluster separators and drag handles
  if (hasCluster && clusterBounds.size > 1) {
    ctx.strokeStyle = 'rgba(0,0,0,0.3)';
    ctx.lineWidth = 1;

    const scrollAdjust = needsScroll ? clampedScrollOffset : 0;

    const sortedClusters = myClusterOrder.length > 0
      ? myClusterOrder.filter(c => clusterBounds.has(c))
      : [...clusterBounds.keys()].sort((a, b) => a - b);

    for (let i = 0; i < sortedClusters.length; i++) {
      const cluster = sortedClusters[i];
      const bounds = clusterBounds.get(cluster);
      if (!bounds) continue;

      const visStartY = bounds.startY - scrollAdjust;
      const visEndY = bounds.endY - scrollAdjust;

      if (visEndY < headerHeight || visStartY > height) continue;

      if (i < sortedClusters.length - 1 && visEndY > headerHeight && visEndY < height) {
        ctx.strokeStyle = 'rgba(0,0,0,0.4)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, visEndY);
        ctx.lineTo(width, visEndY);
        ctx.stroke();
      }

      // Draw transcription state consensus indicator
      const consensus = clusterStateConsensus.get(cluster);
      if (consensus && consensus.total > 0 && bounds.count >= 3) {
        const statePercentages = {
          P: consensus.pause / consensus.total,
          I: consensus.pic / consensus.total,
          E: consensus.elongating / consensus.total,
        };

        const dominantStates = Object.entries(statePercentages)
          .filter(([, pct]) => pct > 0.3)
          .sort(([, a], [, b]) => b - a);

        if (dominantStates.length > 0 && visStartY > headerHeight && visStartY < height - 10) {
          const indicatorY = visStartY + 2;
          const indicatorSize = Math.min(10, (visEndY - visStartY) / 2);

          const stateColors: Record<string, string> = {
            P: '#ec4899',
            I: '#3b82f6',
            E: '#22c55e',
          };

          for (let si = 0; si < Math.min(2, dominantStates.length); si++) {
            const [stateKey, pct] = dominantStates[si];
            const indicatorX = sidebarWidth - 6 - (si * 6);

            ctx.fillStyle = stateColors[stateKey];
            ctx.beginPath();
            ctx.arc(indicatorX, indicatorY + indicatorSize / 2, Math.min(3, indicatorSize / 2), 0, 2 * Math.PI);
            ctx.fill();

            if (pct > 0.6) {
              ctx.strokeStyle = '#000';
              ctx.lineWidth = 0.5;
              ctx.stroke();
            }
          }
        }
      }
    }
  }

  // Draw Jupyter position markers
  for (const marker of allJupyterMarkers) {
    const markerPos = marker.position - start;
    if (markerPos >= 0 && markerPos <= regionWidth) {
      const x = toX(markerPos);

      ctx.strokeStyle = marker.color || '#ff0000';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, headerHeight + histogramHeight);
      ctx.lineTo(x, height);
      ctx.stroke();

      if (marker.label) {
        ctx.fillStyle = marker.color || '#ff0000';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(marker.label, x, headerHeight + histogramHeight + 10);
      }
    }
  }

  if (shouldDrawReadBoundaryLines(n, rowHeight, readSeparatorMode)) {
    ctx.strokeStyle = 'rgba(200,200,200,0.5)';
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= n; i++) {
      const y = headerHeight + histogramHeight + i * (rowHeight + rowGap)
        - (needsScroll ? clampedScrollOffset : 0);
      ctx.beginPath();
      ctx.moveTo(sidebarWidth, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
  }

  // Restore context after clipped genomic drawing
  ctx.restore();

  // Draw scrollbar indicator when vertical scrolling is active
  if (needsScroll) {
    const scrollbarWidth = 6;
    const scrollbarX = width - scrollbarWidth - 2;
    const scrollTrackHeight = trackHeight - 4;
    const scrollThumbHeight = Math.max(20, (trackHeight / totalContentHeight) * scrollTrackHeight);
    const scrollThumbY = headerHeight + histogramHeight + 2 + (clampedScrollOffset / maxScrollOffset) * (scrollTrackHeight - scrollThumbHeight);

    ctx.fillStyle = 'rgba(0, 0, 0, 0.1)';
    ctx.fillRect(scrollbarX, headerHeight + histogramHeight + 2, scrollbarWidth, scrollTrackHeight);

    ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.fillRect(scrollbarX, scrollThumbY, scrollbarWidth, scrollThumbHeight);
  }
}

/** Text and rule colours that read on a ground (a dark colormap's too). */
export function inkOn(background: string): { text: string; muted: string; rule: string; dark: boolean } {
  const hex = normalizeHexColor(background, '#ffffff');
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  const dark = 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.45;
  return dark
    ? { text: '#e5e7eb', muted: '#a8b0bd', rule: 'rgba(255,255,255,0.25)', dark }
    : { text: '#4b5563', muted: '#6b7280', rule: 'rgba(0,0,0,0.18)', dark };
}

function normalizeHexColor(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function drawPrimaryFootprintFill(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  color: string,
  alphaRaw: number,
  softEdge: boolean,
  visualLeftGapPx: number,
  visualRightGapPx: number,
): void {
  const alpha = clamp01(alphaRaw);
  const usedSoftEdge = softEdge && drawStrictToLooseSoftEdgeRect(
    ctx,
    x,
    y,
    width,
    height,
    color,
    alpha,
    visualLeftGapPx,
    visualRightGapPx,
  );
  if (!usedSoftEdge) {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.fillRect(x, y, width, height);
  }
}

function drawStrictToLooseSoftEdgeRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  color: string,
  bodyAlphaRaw: number,
  leftGapPxRaw: number,
  rightGapPxRaw: number,
): boolean {
  if (width <= 0 || height < 4) return false;
  const bodyAlpha = clamp01(bodyAlphaRaw);
  if (bodyAlpha <= 0) return true;
  const leftGapPx = Math.max(0, Number.isFinite(leftGapPxRaw) ? leftGapPxRaw : 0);
  const rightGapPx = Math.max(0, Number.isFinite(rightGapPxRaw) ? rightGapPxRaw : 0);
  if (leftGapPx < 0.5 && rightGapPx < 0.5) return false;

  ctx.fillStyle = color;
  ctx.globalAlpha = bodyAlpha;
  ctx.fillRect(x, y, width, height);
  drawSoftEdgeBand(ctx, x - leftGapPx, y, leftGapPx, height, bodyAlpha, true);
  drawSoftEdgeBand(ctx, x + width, y, rightGapPx, height, bodyAlpha, false);
  ctx.globalAlpha = 1.0;
  return true;
}

function drawSoftEdgeBand(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  bodyAlpha: number,
  innerEdgeOnRight: boolean,
): void {
  if (width < 0.5) return;
  const steps = width >= 6 ? 3 : (width >= 2 ? 2 : 1);
  for (let i = 0; i < steps; i++) {
    const segStart = (i / steps) * width;
    const segEnd = ((i + 1) / steps) * width;
    const segWidth = Math.max(0.5, segEnd - segStart);
    const outerToInner = (i + 0.5) / steps;
    const t = innerEdgeOnRight ? outerToInner : 1 - outerToInner;
    ctx.globalAlpha = bodyAlpha * Math.max(0.08, Math.min(0.9, t));
    ctx.fillRect(x + segStart, y, segWidth, height);
  }
}

/**
 * Run ``draw`` with the canvas clipped horizontally to a read's body
 * (``bodyClip`` in canvas x; the full height stays drawable). A read's calls
 * are drawn inside its body only: whatever a loader returns beyond it (an MSP
 * in a hidden terminal gap, a mark past the last footprint) is not shown
 * floating off the read. ``null`` (no extent known) draws unclipped.
 */
export function withReadBodyClip(
  ctx: Pick<CanvasRenderingContext2D, 'save' | 'restore' | 'beginPath' | 'rect' | 'clip'>,
  /** The body, or its pieces when a deletion breaks it. */
  bodyClip: { x: number; w: number } | Array<{ x: number; w: number }> | null,
  height: number,
  draw: () => void,
): void {
  if (!bodyClip) {
    draw();
    return;
  }
  ctx.save();
  try {
    ctx.beginPath();
    for (const rect of Array.isArray(bodyClip) ? bodyClip : [bodyClip]) ctx.rect(rect.x, 0, rect.w, height);
    ctx.clip();
    draw();
  } finally {
    ctx.restore();
  }
}

export function getCompactReadExtent(read: CompactRead): { start: number; end: number } | null {
  let minStart = Infinity;
  let maxEnd = -Infinity;

  const includeInterval = (iv: [number, number, number]) => {
    if (!Number.isFinite(iv[0]) || !Number.isFinite(iv[1])) return;
    minStart = Math.min(minStart, iv[0]);
    maxEnd = Math.max(maxEnd, iv[1]);
  };
  const includePoint = (pos: number) => {
    if (!Number.isFinite(pos)) return;
    minStart = Math.min(minStart, pos);
    maxEnd = Math.max(maxEnd, pos + 1);
  };

  for (const interval of read.intervals ?? []) includeInterval(interval);
  if (Number.isFinite(minStart) && Number.isFinite(maxEnd) && maxEnd > minStart) {
    return { start: minStart, end: maxEnd };
  }

  for (const layer of Object.values(read.layers ?? {})) {
    for (const interval of layer.intervals ?? []) includeInterval(interval);
  }
  for (const [ivStart, ivEnd] of read.fire ?? []) {
    includeInterval([ivStart, ivEnd, ivEnd - ivStart]);
  }
  for (const pos of read.methyl_m6a ?? read.methyl ?? []) includePoint(pos);
  for (const pos of read.methyl_m5c ?? []) includePoint(pos);
  for (const [pos] of read.deam ?? []) includePoint(pos);

  if (!Number.isFinite(minStart) || !Number.isFinite(maxEnd) || maxEnd <= minStart) return null;
  return { start: minStart, end: maxEnd };
}

// Coverage histogram drawing helper
/**
 * Molecules covering each histogram bin. A read's intervals (footprints and
 * the gaps between them) are merged per read first: adjacent intervals share
 * their boundary bin, and one molecule must count once there.
 */
export function coverageHistogramBins(
  reads: Pick<CompactRead, 'intervals' | 'live_lift'>[],
  histBins: number,
  regionWidth: number,
  linkedOffset = 0,
): Float32Array {
  const binSize = regionWidth / histBins;
  const coverageDiff = new Float32Array(histBins + 1);
  for (const read of reads) {
    const ranges: Array<[number, number]> = [];
    // A live-lift row covers its body (segments minus connectors), never its hull across a connector.
    const spans: Array<[number, number] | [number, number, number]> = read.live_lift
      ? liveLiftBodySpans(read.live_lift) : read.intervals;
    for (const [ivStart, ivEnd] of spans) {
      const b0 = Math.max(0, Math.floor((ivStart + linkedOffset) / binSize));
      const b1 = Math.min(histBins, Math.ceil((ivEnd + linkedOffset) / binSize));
      if (b1 > b0) ranges.push([b0, b1]);
    }
    ranges.sort((a, b) => a[0] - b[0]);
    let curStart = -1;
    let curEnd = -1;
    for (const [b0, b1] of ranges) {
      if (b0 <= curEnd) {
        curEnd = Math.max(curEnd, b1);
        continue;
      }
      if (curEnd > curStart) { coverageDiff[curStart]++; coverageDiff[curEnd]--; }
      curStart = b0;
      curEnd = b1;
    }
    if (curEnd > curStart) { coverageDiff[curStart]++; coverageDiff[curEnd]--; }
  }
  const coverage = new Float32Array(histBins);
  let running = 0;
  for (let b = 0; b < histBins; b++) {
    running += coverageDiff[b];
    coverage[b] = running;
  }
  return coverage;
}

/** Coverage of the reads drawn, as bars filling `histogramHeight` below `headerHeight` (the Coverage track). */
export function drawCoverageHistogram(
  ctx: CanvasRenderingContext2D,
  displayReads: CompactRead[],
  opts: {
    sidebarWidth: number;
    trackWidth: number;
    regionWidth: number;
    histogramHeight: number;
    headerHeight: number;
    linkedOffset: number;
    isReversed: boolean;
    width: number;
    /** The ground (the colormap's no-read colour); labels pick their colour to read on it. */
    backgroundColor?: string;
    /** A live-lift panel: per-bin correspondence (0-1) over the view; bins without it are hatched (full where
     *  none, light where partial), so "no reads" and "no correspondence" never look alike. */
    liftCorrespondence?: number[] | null;
  }
) {
  const { sidebarWidth, trackWidth, regionWidth, histogramHeight, headerHeight, linkedOffset, isReversed, width } = opts;
  const histBins = Math.max(1, Math.min(Math.floor(trackWidth), 500));
  const coverage = coverageHistogramBins(displayReads, histBins, regionWidth, linkedOffset);
  let maxCov = 1;
  for (let b = 0; b < histBins; b++) if (coverage[b] > maxCov) maxCov = coverage[b];
  const background = normalizeHexColor(opts.backgroundColor, '#f8f8f8');
  const ink = inkOn(background);
  const histTop = headerHeight + 1;
  const histH = Math.max(1, histogramHeight - 3);
  const barW = trackWidth / histBins;

  ctx.fillStyle = background;
  ctx.fillRect(sidebarWidth, histTop, trackWidth, histH);

  ctx.fillStyle = ink.dark ? 'rgba(147, 178, 230, 0.65)' : 'rgba(100, 140, 200, 0.55)';
  for (let b = 0; b < histBins; b++) {
    if (coverage[b] === 0) continue;
    const barH = (coverage[b] / maxCov) * histH;
    const bx = isReversed
      ? sidebarWidth + (histBins - 1 - b) * barW
      : sidebarWidth + b * barW;
    ctx.fillRect(bx, histTop + histH - barH, Math.max(1, barW), barH);
  }

  if (opts.liftCorrespondence && opts.liftCorrespondence.length) {
    drawCorrespondenceHatching(ctx, opts.liftCorrespondence, {
      x: sidebarWidth, y: histTop, w: trackWidth, h: histH, isReversed, dark: ink.dark,
    });
  }

  ctx.fillStyle = ink.muted;
  ctx.font = '9px sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(String(maxCov), sidebarWidth + trackWidth - 2, histTop + 9);

  ctx.strokeStyle = ink.rule;
  ctx.beginPath();
  ctx.moveTo(sidebarWidth, headerHeight + histogramHeight - 1);
  ctx.lineTo(width, headerHeight + histogramHeight - 1);
  ctx.stroke();
}

/** Hatching over coverage bins with no (full) or partial (light) map correspondence (§3.8, owner 4). */
export function drawCorrespondenceHatching(
  ctx: CanvasRenderingContext2D,
  correspondence: number[],
  box: { x: number; y: number; w: number; h: number; isReversed: boolean; dark: boolean },
): void {
  const n = correspondence.length;
  const binW = box.w / n;
  ctx.save();
  for (let b = 0; b < n; b++) {
    const c = correspondence[b];
    if (c >= 0.999) continue;
    const x0 = box.isReversed ? box.x + (n - 1 - b) * binW : box.x + b * binW;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, box.y, Math.max(1, binW), box.h);
    ctx.clip();
    ctx.strokeStyle = box.dark ? 'rgba(226, 232, 240, 0.55)' : 'rgba(71, 85, 105, 0.55)';
    ctx.globalAlpha = c <= 0 ? 1 : 0.4;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let d = -box.h; d < binW + box.h; d += 4) {
      ctx.moveTo(x0 + d, box.y + box.h);
      ctx.lineTo(x0 + d + box.h, box.y);
    }
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}

function applyGaussianSmoothing(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  sigmaX: number,
  sigmaY: number,
): void {
  const renderScale = getCanvasRenderScale();
  const px = Math.max(0, Math.floor(x * renderScale));
  const py = Math.max(0, Math.floor(y * renderScale));
  const pw = Math.max(1, Math.floor(width * renderScale));
  const ph = Math.max(1, Math.floor(height * renderScale));
  const sx = Math.max(0, Math.min(10, sigmaX)) * renderScale;
  const sy = Math.max(0, Math.min(10, sigmaY)) * renderScale;
  if (sx <= 0 && sy <= 0) return;

  try {
    const image = ctx.getImageData(px, py, pw, ph);
    let working: Uint8ClampedArray<ArrayBufferLike> = new Uint8ClampedArray(image.data);
    if (sx > 0) {
      working = blurImageDataPass(working, pw, ph, sx, 'x');
    }
    if (sy > 0) {
      working = blurImageDataPass(working, pw, ph, sy, 'y');
    }
    image.data.set(working);
    ctx.putImageData(image, px, py);
  } catch {
    // Canvas readback can fail in unusual browser security states. Smoothing
    // is visual-only, so fail closed rather than breaking read rendering.
  }
}

function gaussianKernel(sigma: number): Float32Array {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(radius * 2 + 1);
  const denom = 2 * sigma * sigma;
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const value = Math.exp(-(i * i) / denom);
    kernel[i + radius] = value;
    sum += value;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
  return kernel;
}

function blurImageDataPass(
  input: Uint8ClampedArray<ArrayBufferLike>,
  width: number,
  height: number,
  sigma: number,
  axis: 'x' | 'y',
): Uint8ClampedArray<ArrayBufferLike> {
  const kernel = gaussianKernel(sigma);
  const radius = Math.floor(kernel.length / 2);
  const output = new Uint8ClampedArray(input.length);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const base = (row * width + col) * 4;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let k = -radius; k <= radius; k++) {
        const sampleCol = axis === 'x' ? Math.max(0, Math.min(width - 1, col + k)) : col;
        const sampleRow = axis === 'y' ? Math.max(0, Math.min(height - 1, row + k)) : row;
        const sample = (sampleRow * width + sampleCol) * 4;
        const weight = kernel[k + radius];
        r += input[sample] * weight;
        g += input[sample + 1] * weight;
        b += input[sample + 2] * weight;
        a += input[sample + 3] * weight;
      }
      output[base] = r;
      output[base + 1] = g;
      output[base + 2] = b;
      output[base + 3] = a;
    }
  }
  return output;
}

/**
 * A read's m6A positions. Loaders set methyl_m6a whenever they read m6A and copy
 * one mark type into the legacy `methyl` union (m6A, else 5mC, else
 * deamination), so `methyl` is m6A only on reads with no typed marks at all.
 * (services/read_marks.py m6a_positions is the same rule.)
 */
export function m6aPositions(read: Pick<CompactRead, 'methyl' | 'methyl_m6a' | 'methyl_m5c' | 'deam'>): number[] | undefined {
  if (read.methyl_m6a) return read.methyl_m6a;
  if (read.methyl_m5c?.length || read.deam?.length) return undefined;
  return read.methyl;
}
