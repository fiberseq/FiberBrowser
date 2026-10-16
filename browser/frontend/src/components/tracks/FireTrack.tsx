import { openRegionPanels } from '../../utils/regionPanels';
import { matchedGroupLabel, removeMatchedGroups } from '../../utils/matchedGroupActions';
import { isScannedRule } from '../../utils/matchedRegions';
import { crosshairBottomAt, logicalOffset } from '../../utils/scaledCoordinates';
import { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { usePanelDisplayStore as useBrowserStore } from '../../hooks/usePanelDisplayStore';
import { useEphemeralStore } from '../../stores/ephemeralStore';
import { useDafcStore } from '../../stores/dafcStore';
import { sameChrom } from '../../utils/chromAliases';
import { setupHighDpiCanvas, useCanvasRenderVersion } from '../../utils/canvasUtils';
import { generateLayerColors } from '../../utils/peakColors';
import { logPerfTiming, nowMs } from '../../utils/perfDebug';
import type { PeakMode, FirePeak, PeakRule } from '../../types';
import { drawTrackLabel } from '../../utils/trackLabels';
import { HoverLabel, useTrackLabels } from './TrackLabels';

interface Props {
  width: number;
  height: number;
  scanning?: boolean;
  spanningOnly?: boolean;
  sidebarWidth?: number;  // Width of cluster sidebar in ReadTrack (for alignment)
  // Override viewport for split-view panels
  overrideChrom?: string;
  /** Its panel's reference when that is another assembly (only that panel's scanned peaks show). */
  genome?: string | null;
  overrideStart?: number;
  overrideEnd?: number;
  /** The panel's read-state key: scanned peaks are drawn only while it shows reads (M16). */
  readsKey?: string;
}

// Mode-specific colors for selected peaks. PeakMode is open-ended (any custom
// layer name flows through), so this is a lookup table of well-known modes;
// anything not listed falls back to the accessibility color.
const MODE_COLORS: Partial<Record<PeakMode, { fill: string; stroke: string }>> = {
  accessibility: { fill: 'rgba(16, 185, 129, 0.8)', stroke: '#059669' },  // Green
  tf: { fill: 'rgba(249, 115, 22, 0.8)', stroke: '#ea580c' },             // Orange
  tf_layer: { fill: 'rgba(224, 64, 251, 0.8)', stroke: '#c026d3' },       // Fuchsia
  nuc: { fill: 'rgba(22, 163, 74, 0.8)', stroke: '#15803d' },             // Dark green
  nuc_layer: { fill: 'rgba(22, 163, 74, 0.8)', stroke: '#15803d' },       // Dark green
  msp: { fill: 'rgba(251, 146, 60, 0.8)', stroke: '#f97316' },            // Internal alias for FIRE
  fire: { fill: 'rgba(251, 146, 60, 0.8)', stroke: '#f97316' },           // Orange
  modification: { fill: 'rgba(139, 92, 246, 0.8)', stroke: '#7c3aed' },   // Purple
  mod: { fill: 'rgba(139, 92, 246, 0.8)', stroke: '#7c3aed' },            // Purple
  annotation: { fill: 'rgba(99, 102, 241, 0.8)', stroke: '#4f46e5' },     // Indigo
};
const DEFAULT_MODE_COLOR = MODE_COLORS.accessibility!;

export function FireTrack({ width, height, scanning, spanningOnly, sidebarWidth = 0, overrideChrom, overrideStart, overrideEnd, readsKey, genome }: Props) {
  const hoveredPanelRegion = useEphemeralStore(s => s.hoveredPanelRegion);
  const hoveredMatchGroup = useEphemeralStore(s => s.hoveredMatchGroup);
  const [matchTooltip, setMatchTooltip] = useState<string | undefined>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const trackLabels = useTrackLabels();
  const canvasRenderVersion = useCanvasRenderVersion();
  const storeStart = useBrowserStore(s => s.start);
  const storeEnd = useBrowserStore(s => s.end);
  const storeChrom = useBrowserStore(s => s.chrom);
  const start = overrideStart ?? storeStart;
  const end = overrideEnd ?? storeEnd;

  const peakRules = useBrowserStore(s => s.peakRules);
  const ownPanel = useBrowserStore(s => s.panels.find(p => (p.stateKey ?? p.datasetId) === readsKey));
  const allPeaks = useBrowserStore(s => s.getAllPeaks());
  // Peaks are scanned from the reads in view; a panel with none (another
  // dataset's locus, another genome) shows no scanned peaks, only drawn ones.
  // (Zoomed out past read level no reads are fetched: the peaks still show.)
  const panelHasReads = useBrowserStore(s => readsKey == null || (s.activeReadIds[readsKey]?.length ?? 0) > 0
    || (overrideEnd ?? s.end) - (overrideStart ?? s.start) > s.maxRegionForReads);
  const selectedPeaks = useBrowserStore(s => s.selectedPeaks);
  const peakDrawMode = useBrowserStore(s => s.peakDrawMode);
  const peakDrawStartAny = useBrowserStore(s => s.peakDrawStart);
  const peakDrawChrom = useBrowserStore(s => s.peakDrawChrom);
  const peakModes = useBrowserStore(s => s.peakModes);

  const isReversed = useBrowserStore(s => s.isReversed);
  const datasets = useBrowserStore(s => s.datasets);
  const dynamicClustering = useBrowserStore(s => s.dynamicClustering);
  const clusterPeakRegions = useBrowserStore(s => s.clusterPeakRegions);

  // Get Micro-C track mode for Virtual 4C peak click behavior
  const { microcTrackMode, setV4cViewpoint } = useDafcStore(useShallow(s => ({
    microcTrackMode: s.microcTrackMode,
    setV4cViewpoint: s.setV4cViewpoint,
  })));

  // Check if any dataset has footprints (determines default peak mode)
  const hasFootprints = datasets.some(d =>
    d.available_layers?.footprint || d.layer_type === 'footprint' ||
    (d.data_type === 'bam' && !d.available_layers)
  );

  const [hoverPos, setHoverPos] = useState<number | null>(null);

  // Track width excluding sidebar (to align with reads)
  const trackWidth = width - sidebarWidth;

  // Visible rules (only enabled ones get rows). The Custom row is always
  // there to draw peaks on, so the track never changes height as peaks come and go.
  // An exported figure keeps the same rows, so its row heights match the view.
  const exportInProgress = useBrowserStore(s => s.exportInProgress);
  const effectiveChrom = overrideChrom ?? storeChrom;
  // A peak start clicked in a panel on another chromosome isn't this panel's:
  // here the next click starts a new peak instead of ending that one.
  const peakDrawStart = peakDrawStartAny !== null && (peakDrawChrom == null || sameChrom(peakDrawChrom, effectiveChrom))
    ? peakDrawStartAny : null;
  const visibleRules = useMemo(() => peakRules.filter(r => r.enabled), [peakRules]);
  const numRows = Math.max(1, visibleRules.length);

  // Precompute per-rule layer colors
  const ruleLayerColors = useMemo(() => {
    const map: Record<string, ReturnType<typeof generateLayerColors>> = {};
    for (const rule of visibleRules) {
      map[rule.id] = generateLayerColors(rule.color, rule.opacity, rule.useGradient);
    }
    return map;
  }, [visibleRules]);

  // Filter peaks by chromosome for cross-chrom split view panels
  const filteredPeaksByRule = useMemo(() => {
    const result: Record<string, FirePeak[]> = {};
    for (const rule of visibleRules) {
      const peaks = allPeaks.filter(p => p.ruleId === rule.id && (panelHasReads || !isScannedRule(rule) || p.match?.correspondenceId));
      result[rule.id] = peaks.filter(p =>
        // A peak without a chrom was scanned in the main view.
        sameChrom(p.chrom ?? storeChrom, effectiveChrom) && p.end > start && p.start < end
        // Another assembly's peaks (same chromosome names) stay in their own panels.
        && (p.genome ?? null) === (genome ?? null)
        && (!p.memberPanelId || p.match?.correspondenceId || !ownPanel || p.memberPanelId === ownPanel.id)
        && (!p.match?.correspondenceId || !p.match.panelId || !ownPanel || p.match.panelId === ownPanel.id
          || (ownPanel.regionPanelGroup?.id === p.match.correspondenceId && ownPanel.regionPanelGroup?.regionLabel === p.match.label))
      );
    }
    return result;
  }, [visibleRules, allPeaks, effectiveChrom, storeChrom, start, end, panelHasReads, genome, ownPanel]);

  const hasData = visibleRules.some(r => (filteredPeaksByRule[r.id]?.length ?? 0) > 0);

  const genomeToScreen = useCallback((pos: number) => {
    const frac = (pos - start) / (end - start);
    return sidebarWidth + (isReversed ? (1 - frac) : frac) * trackWidth;
  }, [start, end, trackWidth, sidebarWidth, isReversed]);
  const screenToGenome = useCallback((x: number) => {
    const frac = (x - sidebarWidth) / trackWidth;
    return Math.round(start + (isReversed ? 1 - frac : frac) * (end - start));
  }, [start, end, trackWidth, sidebarWidth, isReversed]);


  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = setupHighDpiCanvas(canvas, width, height);
    if (!ctx) return;

    const drawStarted = nowMs();
    const finish = (reason: string) => {
      const peakCount = visibleRules.reduce((sum, rule) => sum + (filteredPeaksByRule[rule.id]?.length ?? 0), 0);
      logPerfTiming('peaks.draw', nowMs() - drawStarted, {
        reason,
        rows: visibleRules.length,
        peaks: peakCount,
        selected: selectedPeaks.size,
        width,
        height,
      }, 25);
    };

    // Clear
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    const labelHeight = 14;
    const padding = 2;

    // Draw label
    ctx.fillStyle = '#666';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'left';
    // Rows are named by their peak rule (e.g. Accessibility), so the track is just Peaks.
    drawTrackLabel(ctx, 'Peaks', 6, 11, trackLabels);

    // Draw mode indicator (on screen only, not in exported figures)
    if (peakDrawMode && !exportInProgress) {
      ctx.fillStyle = '#d97706';
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      const msg = peakDrawStart !== null
        ? 'Click to set peak end'
        : 'Click to set peak start';
      ctx.fillText(msg, width / 2, 11);
    }

    // If scanning, show loading (on screen only)
    if (scanning && !exportInProgress) {
      ctx.fillStyle = '#666';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Scanning peaks...', width / 2, height / 2);
      finish('scanning');
      return;
    }

    // Calculate row dimensions
    const gridTop = labelHeight;
    const gridHeight = height - labelHeight - padding;
    const rowHeight = Math.max(1, Math.floor(gridHeight / numRows));
    // Small rows (several rules in a short track) keep a visible peak (was negative below 4 px).
    const peakHeight = Math.max(1, rowHeight - (rowHeight >= 8 ? 4 : 1));

    // Draw row backgrounds (alternating)
    for (let r = 0; r < numRows; r++) {
      ctx.fillStyle = r % 2 === 0 ? '#f8f9fa' : '#ffffff';
      ctx.fillRect(0, gridTop + r * rowHeight, width, rowHeight);
      // Divider
      if (r > 0) {
        ctx.strokeStyle = '#e0e0e0';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, gridTop + r * rowHeight);
        ctx.lineTo(width, gridTop + r * rowHeight);
        ctx.stroke();
      }
    }

    // Draw peaks for each rule row
    for (let r = 0; r < visibleRules.length; r++) {
      const rule = visibleRules[r];
      const peaks = filteredPeaksByRule[rule.id] || [];
      const layerColors = ruleLayerColors[rule.id];
      const isCustom = rule.source === 'custom';
      const y = gridTop + r * rowHeight + 2;
      const h = isCustom ? rowHeight - 2 : peakHeight;

      for (const peak of peaks) {
        const layer = peak.layer ?? 0;
        const rawX1 = genomeToScreen(peak.start);
        const rawX2 = genomeToScreen(peak.end);
        const x1 = Math.min(rawX1, rawX2);
        const peakWidth = Math.max(Math.abs(rawX2 - rawX1), 3);
        const isSelected = peak.featureIndex !== undefined || selectedPeaks.has(peak.index);
        const peakMode = peak.featureMode || peakModes[peak.index] || 'accessibility';

        if (peak.match && !peak.match.correspondenceId) {
          const panelHover = hoveredPanelRegion?.groupId === peak.match.groupId && hoveredPanelRegion.label === peak.match.label;
          ctx.strokeStyle = panelHover ? rule.color : isSelected ? '#000000' : rule.color;
          ctx.lineWidth = panelHover ? 4 : isSelected || hoveredMatchGroup === peak.match.groupId ? 3 : 1;
          ctx.beginPath(); ctx.moveTo(x1, y + h / 2); ctx.lineTo(x1 + peakWidth, y + h / 2); ctx.stroke();
          for (const block of peak.match.blocks) {
            const a = genomeToScreen(block.genomic[0]), b = genomeToScreen(block.genomic[1]);
            ctx.fillStyle = rule.color;
            ctx.globalAlpha = rule.opacity;
            ctx.fillRect(Math.min(a, b), y, Math.max(1, Math.abs(b - a)), h);
            ctx.globalAlpha = 1;
            ctx.setLineDash(peak.match.blocks.length > 1 ? [3, 2] : []);
            ctx.strokeRect(Math.min(a, b), y, Math.max(1, Math.abs(b - a)), h);
            ctx.setLineDash([]);
          }
          if (peakWidth >= 24) {
            ctx.fillStyle = '#ffffff'; ctx.font = '9px sans-serif';
            ctx.fillText(`${peak.match.reversed ? '◀ ' : ''}${peak.match.label}`, x1 + 3, y + h - 2);
          }
        } else if (isSelected) {
          ctx.strokeStyle = '#000000';
          ctx.lineWidth = 3;
          ctx.strokeRect(x1, y, peakWidth, h);
          const modeColor = MODE_COLORS[peakMode] ?? DEFAULT_MODE_COLOR;
          ctx.fillStyle = modeColor.fill;
          ctx.fillRect(x1, y, peakWidth, h);
        } else {
          const lc = layerColors[Math.min(layer, layerColors.length - 1)];
          ctx.fillStyle = lc.fill;
          ctx.strokeStyle = lc.stroke;
          ctx.lineWidth = isCustom ? 2 : 1;
          ctx.fillRect(x1, y, peakWidth, h);
          ctx.strokeRect(x1, y, peakWidth, h);
        }
      }
    }

    // Row labels from rule names, over the peaks (on a pill; none in Clean view)
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'left';
    for (let r = 0; r < visibleRules.length; r++) {
      ctx.fillStyle = visibleRules[r].color;
      drawTrackLabel(ctx, visibleRules[r].source === 'matched' ? matchedGroupLabel(visibleRules[r]) : visibleRules[r].name, 6, gridTop + r * rowHeight + rowHeight / 2 + 3, trackLabels);
    }

    // Draw cluster peak regions (locked peaks for dynamic clustering) — on the
    // last scanned row (the Custom row below it only holds drawn peaks).
    if (dynamicClustering && clusterPeakRegions.length > 0) {
      const scannedRows = visibleRules.map((r, i) => (isScannedRule(r) ? i : -1)).filter(i => i >= 0);
      const lastRowIdx = scannedRows.length > 0 ? scannedRows[scannedRows.length - 1] : numRows - 1;
      for (const region of clusterPeakRegions) {
        if (!sameChrom(region.chrom ?? storeChrom, effectiveChrom)) continue;  // another locus's peak
        const rawX1 = genomeToScreen(region.start);
        const rawX2 = genomeToScreen(region.end);
        const x1 = Math.min(rawX1, rawX2);
        const peakWidth = Math.max(Math.abs(rawX2 - rawX1), 3);
        const yAuto = gridTop + lastRowIdx * rowHeight + 2;

        ctx.strokeStyle = '#0d9488';
        ctx.lineWidth = 2;
        ctx.setLineDash([3, 2]);
        ctx.strokeRect(x1, yAuto, peakWidth, peakHeight);
        ctx.setLineDash([]);

        // A small padlock drawn with paths (an emoji renders differently on every OS).
        const lx = x1 + peakWidth - 8;
        const ly = yAuto + 2;
        ctx.fillStyle = '#0d9488';
        ctx.strokeStyle = '#0d9488';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(lx + 3, ly + 3.5, 2, Math.PI, 0);
        ctx.stroke();
        ctx.fillRect(lx, ly + 3.5, 6, 4.5);
      }
    }

    // Draw peak being drawn (custom) — on the custom rule's row
    if (peakDrawMode && hoverPos !== null) {
      const customRowIdx = visibleRules.findIndex(r => r.source === 'custom');
      const drawRow = customRowIdx >= 0 ? customRowIdx : 0;
      const y = gridTop + drawRow * rowHeight + 1;
      const drawH = rowHeight - 2;

      if (peakDrawStart !== null) {
        // Screen left/right (a reversed view puts the higher position on the left).
        const ends = [genomeToScreen(peakDrawStart), genomeToScreen(hoverPos)];
        const drawX1 = Math.min(...ends);
        const drawWidth = Math.max(Math.max(...ends) - drawX1, 3);

        ctx.fillStyle = 'rgba(245, 158, 11, 0.3)';
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 2]);
        ctx.fillRect(drawX1, y, drawWidth, drawH);
        ctx.strokeRect(drawX1, y, drawWidth, drawH);
        ctx.setLineDash([]);
      } else {
        const guideX = genomeToScreen(hoverPos);
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 2]);
        ctx.beginPath();
        ctx.moveTo(guideX, y);
        ctx.lineTo(guideX, y + drawH);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    finish('standard');
  }, [hoveredPanelRegion, hoveredMatchGroup, visibleRules, filteredPeaksByRule, ruleLayerColors, selectedPeaks, peakModes, start, end, width, height, hasData, peakDrawMode, peakDrawStart, hoverPos, genomeToScreen, scanning, dynamicClustering, clusterPeakRegions, numRows, canvasRenderVersion, exportInProgress, storeChrom, effectiveChrom, trackLabels]);

  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = logicalOffset(e.clientX - rect.left, e.currentTarget.clientWidth, rect.width);
    const clickY = logicalOffset(e.clientY - rect.top, e.currentTarget.clientHeight, rect.height);
    const clickPos = screenToGenome(clickX);

    // Handle draw mode
    if (peakDrawMode) {
      if (peakDrawStart === null) {
        useBrowserStore.getState().setPeakDrawStart(clickPos, effectiveChrom);
      } else {
        const peakStart = Math.min(peakDrawStart, clickPos);
        const peakEnd = Math.max(peakDrawStart, clickPos);
        const minBp = Math.max(1, Math.round(5 * (end - start) / trackWidth));
        if (peakEnd - peakStart >= minBp) {
          useBrowserStore.getState().addCustomPeak(peakStart, peakEnd, overrideChrom, genome, ownPanel?.id);
        }
        useBrowserStore.getState().setPeakDrawStart(null);
      }
      return;
    }

    // Normal mode - select peaks directly (no copy-to-saved)
    const labelHeight = 14;
    const gridHeight = height - labelHeight - 2;
    const rowHeight = Math.floor(gridHeight / numRows);

    // Helper to handle peak click — toggle selection directly
    const handlePeakClick = (peak: FirePeak) => {
      if (peak.featureIndex !== undefined) {
        const s = useBrowserStore.getState();
        s.selectFeature(s.selectedFeatures[peak.featureIndex], true); return;
      }
      if (peak.match && !peak.match.correspondenceId) { useBrowserStore.getState().selectMatchedGroup(peak.match.groupId, e.shiftKey); return; }
      if (microcTrackMode === 'virtual4c') {
        const label = peak.sourceLabel || `Peak ${peak.index + 1}`;
        setV4cViewpoint({ chrom: peak.chrom ?? storeChrom, start: peak.start, end: peak.end, label });
        if (!selectedPeaks.has(peak.index)) {
          useBrowserStore.getState().togglePeakSelection(peak.index);
        }
        return;
      }
      useBrowserStore.getState().togglePeakSelection(peak.index, hasFootprints ? 'accessibility' : 'modification');
    };

    // Check each rule row for clicks
    for (let r = 0; r < visibleRules.length; r++) {
      const rule = visibleRules[r];
      const peaks = filteredPeaksByRule[rule.id] || [];
      const y = labelHeight + r * rowHeight;

      for (const peak of peaks) {
        const rx1 = genomeToScreen(peak.start);
        const rx2 = genomeToScreen(peak.end);
        const px = Math.min(rx1, rx2);
        const peakWidth = Math.max(Math.abs(rx2 - rx1), 3);
        if (clickX >= px && clickX <= px + peakWidth && clickY >= y && clickY <= y + rowHeight) {
          handlePeakClick(peak);
          return;
        }
      }
    }
  }, [visibleRules, filteredPeaksByRule, start, end, width, height, selectedPeaks, hasFootprints, peakDrawMode, peakDrawStart, screenToGenome, genomeToScreen, microcTrackMode, setV4cViewpoint, overrideChrom, genome, ownPanel, trackWidth, numRows]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = logicalOffset(e.clientX - rect.left, e.currentTarget.clientWidth, rect.width);
    const genomePos = screenToGenome(x);
    const y = logicalOffset(e.clientY - rect.top, e.currentTarget.clientHeight, rect.height);
    const row = Math.floor((y - 14) / Math.max(1, Math.floor((height - 16) / numRows)));
    const rule = visibleRules[row];
    const peak = rule && filteredPeaksByRule[rule.id]?.find(p => p.start <= genomePos && genomePos < p.end);
    useEphemeralStore.setState({ hoveredMatchGroup: peak?.match?.groupId ?? null, hoveredRegion: peak?.match ? { groupId: peak.match.groupId, label: peak.match.label } : null });
    setMatchTooltip(peak?.match ? `${rule.name} · ${peak.match.label} · ${peak.chrom}:${peak.start}–${peak.end} · ${peak.match.length} bp${peak.match.reversed ? ' · reversed' : ''} · ${peak.match.blocks.length} blocks` : undefined);

    const container = e.currentTarget.closest('[data-export-container]') ?? document.querySelector('[data-export-container]');
    const containerX = container
      ? logicalOffset(e.clientX - container.getBoundingClientRect().left, container.clientWidth, container.getBoundingClientRect().width)
      : x;

    useEphemeralStore.getState().setCrosshair(containerX, genomePos.toLocaleString(), genomePos, container ? crosshairBottomAt(container, e.clientX) : null);

    if (peakDrawMode) {
      setHoverPos(genomePos);
    } else {
      setHoverPos(null);
    }
  }, [peakDrawMode, screenToGenome, height, numRows, visibleRules, filteredPeaksByRule]);

  return (
    <div className="relative group/peaks" style={{ width, height }} data-copilot-track="peaks"
      data-peak-count={visibleRules.reduce((n, r) => n + (filteredPeaksByRule[r.id]?.length ?? 0), 0)}>
      <canvas
        title={matchTooltip}
        data-testid="matched-region-canvas"
        ref={canvasRef}
        width={width}
        height={height}
        onClick={handleClick}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => { setHoverPos(null); setMatchTooltip(undefined); useEphemeralStore.setState({ hoveredMatchGroup: null }); useEphemeralStore.getState().setCrosshair(null, null, null); }}
        className={`block ${peakDrawMode ? 'cursor-crosshair' : 'cursor-pointer'}`}
        style={{ userSelect: 'none' }}
      />
      {visibleRules.flatMap(rule => (filteredPeaksByRule[rule.id] ?? []).filter(p => p.match).map(p => (
        <button key={`${p.index}-${p.match!.groupId}`} type="button" data-testid={`matched-region-${p.ruleId}-${p.match!.label}`} data-peak-index={p.index}
          className="sr-only focus:not-sr-only focus:absolute focus:top-0 focus:z-10 bg-white dark:bg-gray-800 text-ink text-[11px]"
          aria-label={`${rule.name} · ${p.match!.label} · ${p.match!.length} bp${p.match!.reversed ? ' · reversed' : ''}`}
          aria-pressed={p.featureIndex !== undefined || selectedPeaks.has(p.index)}
          onFocus={() => useEphemeralStore.setState({ hoveredMatchGroup: p.match!.groupId, hoveredRegion: { groupId: p.match!.groupId, label: p.match!.label } })}
          onBlur={() => useEphemeralStore.setState({ hoveredMatchGroup: null })}
          onClick={e => p.featureIndex !== undefined ? useBrowserStore.getState().selectFeature(useBrowserStore.getState().selectedFeatures[p.featureIndex], true) : p.match!.correspondenceId ? useBrowserStore.getState().togglePeakSelection(p.index) : useBrowserStore.getState().selectMatchedGroup(p.match!.groupId, e.shiftKey)}>{rule.name} · {p.match!.label}</button>
      )))}
      <HoverLabel style={{ top: 1 }}>Peaks</HoverLabel>
      {visibleRules.map((rule, r) => {
        const rowHeight = Math.floor((height - 14 - 2) / numRows);
        if (rule.source === 'matched' && !useBrowserStore.getState().exportInProgress && !window.__FIBERBROWSER_RENDER_MODE) return (
          <span key={rule.id} className="fb-hover-label !pointer-events-auto !text-[9px] !leading-[11px] group-hover/peaks:!opacity-100 group-focus-within/peaks:!opacity-100"
            style={{ top: Math.max(14, 14 + r * rowHeight + rowHeight / 2 - 5.5), left: 6, color: rule.color }}>
            {matchedGroupLabel(rule)}
            <button type="button" data-testid={`matched-group-open-panels-${rule.id}`} className="ml-1 rounded px-1 hover:bg-black/5 dark:hover:bg-white/10 focus-visible:outline"
              onClick={e => { e.stopPropagation(); openRegionPanels(rule.id); }}>Open as panels</button>
            <button type="button" data-testid={`matched-group-remove-${rule.id}`} aria-label={`Remove ${matchedGroupLabel(rule)}`}
              title={`Remove ${matchedGroupLabel(rule)}`} className="ml-1 rounded px-1 hover:bg-black/5 dark:hover:bg-white/10 focus-visible:outline"
              onClick={e => { e.stopPropagation(); removeMatchedGroups(rule.id); }}>×</button>
          </span>
        );
        return (
          <HoverLabel key={rule.id} className="!text-[9px] !leading-[11px]"
            style={{ top: Math.max(14, 14 + r * rowHeight + rowHeight / 2 - 5.5), left: 6, color: rule.color }}>
            {rule.source === 'matched' ? '↔ ' : ''}{rule.name}
          </HoverLabel>
        );
      })}
    </div>
  );
}
