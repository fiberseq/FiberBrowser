import { sameChrom } from '../../utils/chromAliases';
import { logicalOffset } from '../../utils/scaledCoordinates';
import { useRef, useEffect, useMemo, useState, useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { usePanelDisplayStore as useBrowserStore } from '../../hooks/usePanelDisplayStore';
import { getGenes } from '../../api/reference';
import { setupHighDpiCanvas, useCanvasRenderVersion } from '../../utils/canvasUtils';
import { usePanOffsetTransform } from '../../hooks/usePanOffsetTransform';
import type { Gene } from '../../types';
import { drawTrackLabel } from '../../utils/trackLabels';
import { HoverHint, HoverLabel, useTrackLabels } from './TrackLabels';
import { TRACK_BACKGROUND } from './TrackContainerConstants';

interface Props {
  width: number;
  height: number;
  // Override props for independent viewport (e.g., DAF-C split view)
  overrideChrom?: string;
  overrideStart?: number;
  overrideEnd?: number;
  /** Its panel's reference when that is another assembly than the main genome (services/panel_genomes.py). */
  genome?: string | null;
}

const PLUS_COLOR = '#2563eb';
const MINUS_COLOR = '#dc2626';
const SELECTION_COLOR = '#fbbf24';  // Yellow for selected genes
const MIN_ROW_HEIGHT = 14;  // Below this, merge isoforms

/** Merge isoforms (same name) into single gene entries with union exons. */
function mergeIsoforms(genes: Gene[]): { merged: Gene[]; isoformCounts: Map<string, number> } {
  const groups = new Map<string, Gene[]>();
  const noName: Gene[] = [];
  for (const g of genes) {
    const key = g.name;
    if (!key) { noName.push(g); continue; }
    const list = groups.get(key);
    if (list) list.push(g);
    else groups.set(key, [g]);
  }
  const merged: Gene[] = [...noName];
  const isoformCounts = new Map<string, number>();
  for (const [name, isoforms] of groups) {
    if (isoforms.length === 1) {
      merged.push(isoforms[0]);
      continue;
    }
    isoformCounts.set(name, isoforms.length);
    // Merge: union span + merge overlapping exons
    const mStart = Math.min(...isoforms.map(g => g.start));
    const mEnd = Math.max(...isoforms.map(g => g.end));
    const allExons = isoforms.flatMap(g => g.exons).sort((a, b) => a.start - b.start);
    const unionExons: { start: number; end: number }[] = [];
    for (const ex of allExons) {
      const last = unionExons[unionExons.length - 1];
      if (last && ex.start <= last.end) {
        last.end = Math.max(last.end, ex.end);
      } else {
        unionExons.push({ start: ex.start, end: ex.end });
      }
    }
    merged.push({
      id: `merged-${name}`,
      name,
      chrom: isoforms[0].chrom,
      start: mStart,
      end: mEnd,
      strand: isoforms[0].strand,
      biotype: isoforms[0].biotype,
      exons: unionExons,
    });
  }
  return { merged, isoformCounts };
}

export function GeneTrack({ width, height, overrideChrom, overrideStart, overrideEnd, genome }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const trackLabels = useTrackLabels();
  const canvasRenderVersion = useCanvasRenderVersion();
  // Redraw on entering/leaving an export: figures leave out the collapse hint.
  const exportInProgress = useBrowserStore(s => s.exportInProgress);
  const {
    storeGenes,
    storeStart,
    storeEnd,
    storeChrom,
    refreshGeneration,
    selectedGenes,
    setSelectedGenes,
    toggleGeneSelection,
    isReversed,
  } = useBrowserStore(useShallow(s => ({
    storeGenes: s.genes,
    refreshGeneration: s.refreshGeneration,
    storeStart: s.start,
    storeEnd: s.end,
    storeChrom: s.chrom,
    selectedGenes: s.selectedGenes,
    setSelectedGenes: s.setSelectedGenes,
    toggleGeneSelection: s.toggleGeneSelection,
    isReversed: s.isReversed,
  })));

  // Use override values if provided (for split view)
  const useOverride = overrideStart !== undefined && overrideEnd !== undefined;
  const start = useOverride ? overrideStart : storeStart;
  const end = useOverride ? overrideEnd : storeEnd;
  const chrom = overrideChrom ?? storeChrom;

  // Disable gene selection in override/split view mode
  const enableSelection = !useOverride;

  // Local genes state for override mode
  const [localGenes, setLocalGenes] = useState<Gene[]>([]);

  // Build a set of selected gene IDs for fast lookup
  const selectedGeneIds = useMemo(() =>
    new Set(selectedGenes.map(g => g.id)), [selectedGenes]);
  
  // Fetch genes when in override mode
  useEffect(() => {
    if (!useOverride) return;
    
    let cancelled = false;
    
    const fetchGenes = async () => {
      try {
        // A panel on another assembly: that reference's annotation.
        const result = await getGenes(chrom, start, end, undefined, genome);
        if (!cancelled) {
          setLocalGenes(result.genes || []);
        }
      } catch (e) {
        console.error('Failed to fetch genes for override viewport:', e);
      }
    };
    
    fetchGenes();
    return () => { cancelled = true; };
    // refreshGeneration: a newly loaded GTF (the main view refetches the same way).
  }, [useOverride, chrom, start, end, refreshGeneration, genome]);
  
  // Use local genes in override mode, store genes otherwise. The store may
  // hold a padded gene window for navigation caching; layout only visible
  // genes so off-screen annotations do not consume rows.
  const genes = useMemo(() => {
    const sourceGenes = useOverride ? localGenes : storeGenes;
    // Also this chromosome: genes from the last one stay loaded until the new
    // fetch returns, and could overlap these coordinates.
    return sourceGenes.filter(gene => (!gene.chrom || sameChrom(gene.chrom, chrom)) && gene.end > start && gene.start < end);
  }, [useOverride, localGenes, storeGenes, chrom, start, end]);
  usePanOffsetTransform(canvasRef, { enabled: !useOverride });

  const genomeToScreen = useCallback((pos: number) => {
    const frac = (pos - start) / (end - start);
    return isReversed ? (1 - frac) * width : frac * width;
  }, [start, end, width, isReversed]);

  const screenToGenome = useCallback((x: number) => {
    const frac = x / width;
    return start + (isReversed ? 1 - frac : frac) * (end - start);
  }, [start, end, width, isReversed]);

  // Decide whether to merge isoforms based on available height
  const { displayGenes, geneRows, isCollapsed, isoformCounts } = useMemo(() => {
    if (genes.length === 0) return { displayGenes: genes, geneRows: new Map<string, number>(), isCollapsed: false, isoformCounts: new Map<string, number>() };

    // Helper: assign rows and return row count
    const assignRows = (geneList: Gene[]) => {
      const rows = new Map<string, number>();
      const rowEnds: number[] = [];
      // Pack by screen edges, left to right (in a reversed view a gene's
      // start is its right edge).
      const spans = geneList.map(gene => {
        const a = genomeToScreen(gene.start);
        const b = genomeToScreen(gene.end);
        return { gene, left: Math.min(a, b), right: Math.max(a, b) };
      }).sort((x, y) => x.left - y.left);
      for (const { gene, left, right } of spans) {
        let row = 0;
        while (row < rowEnds.length && rowEnds[row] > left - 20) row++;
        if (row >= rowEnds.length) rowEnds.push(right);
        else rowEnds[row] = right;
        rows.set(gene.id, row);
      }
      const nRows = rowEnds.length || 1;
      return { rows, nRows };
    };

    // Try full (unmerged) layout first
    const full = assignRows(genes);
    const fullRowHeight = (height - 10) / full.nRows;
    if (fullRowHeight >= MIN_ROW_HEIGHT) {
      return { displayGenes: genes, geneRows: full.rows, isCollapsed: false, isoformCounts: new Map<string, number>() };
    }

    // Rows too thin — merge isoforms
    const { merged, isoformCounts: counts } = mergeIsoforms(genes);
    const mergedLayout = assignRows(merged);
    return { displayGenes: merged, geneRows: mergedLayout.rows, isCollapsed: true, isoformCounts: counts };
  }, [genes, start, end, width, height, genomeToScreen]);

  // Hit detection - find gene at a given screen coordinate
  const getGeneAtPosition = useCallback((x: number, y: number): Gene | null => {
    if (displayGenes.length === 0) return null;

    // Rows are 0-based: one row of genes is nRows 1.
    const nRows = Math.max(0, ...Array.from(geneRows.values())) + 1;
    const rowHeight = Math.min(22, (height - 10) / nRows);

    const genomicPos = screenToGenome(x);

    for (const gene of displayGenes) {
      // Check if click is within gene bounds horizontally
      if (genomicPos < gene.start || genomicPos > gene.end) continue;

      // Check if click is within gene row vertically
      const row = geneRows.get(gene.id) ?? 0;
      const geneY = 5 + row * rowHeight + rowHeight / 2;
      const hitZone = rowHeight * 0.4; // Allow clicking slightly above/below the line

      if (y >= geneY - hitZone && y <= geneY + hitZone) {
        return gene;
      }
    }
    return null;
  }, [displayGenes, geneRows, height, screenToGenome]);

  // Handle click on genes
  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!enableSelection) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const x = logicalOffset(e.clientX - rect.left, e.currentTarget.clientWidth, rect.width);
    const y = logicalOffset(e.clientY - rect.top, e.currentTarget.clientHeight, rect.height);

    const gene = getGeneAtPosition(x, y);

    if (gene) {
      if (e.metaKey || e.ctrlKey) {
        // Cmd+click: select gene + open the dedicated Transcription panel.
        setSelectedGenes([gene]);
        window.sessionStorage.setItem('fiberbrowser_transcription_state_tab', 'overview');
        useBrowserStore.getState().openAnalysisPanel('transcription-state');
        window.dispatchEvent(new CustomEvent('fiberbrowser:open-transcription-state-tab', {
          detail: { tab: 'overview' },
        }));
      } else if (e.shiftKey) {
        // Shift+click: toggle selection
        toggleGeneSelection(gene);
      } else {
        // Regular click: single select (or deselect if already selected)
        if (selectedGeneIds.has(gene.id) && selectedGenes.length === 1) {
          setSelectedGenes([]);
        } else {
          setSelectedGenes([gene]);
        }
      }
    } else {
      // Click on empty area: deselect all
      if (selectedGenes.length > 0) {
        setSelectedGenes([]);
      }
    }
  }, [enableSelection, getGeneAtPosition, toggleGeneSelection, setSelectedGenes, selectedGeneIds, selectedGenes]);

  // Track hover state for cursor feedback + name tooltip
  const [hoveredGene, setHoveredGene] = useState<Gene | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!enableSelection) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const x = logicalOffset(e.clientX - rect.left, e.currentTarget.clientWidth, rect.width);
    const y = logicalOffset(e.clientY - rect.top, e.currentTarget.clientHeight, rect.height);

    const gene = getGeneAtPosition(x, y);
    setHoveredGene(gene);
    setHoverPos(gene ? { x, y } : null);
  }, [enableSelection, getGeneAtPosition]);

  const handleMouseLeave = useCallback(() => {
    setHoveredGene(null);
    setHoverPos(null);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = setupHighDpiCanvas(canvas, width, height);
    if (!ctx) return;

    ctx.fillStyle = TRACK_BACKGROUND.gene;
    ctx.fillRect(0, 0, width, height);

    if (displayGenes.length === 0) {
      ctx.fillStyle = '#999';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      drawTrackLabel(ctx, 'No genes in region', width / 2, height / 2, { ...trackLabels, pill: false });
      return;
    }

    // Rows are 0-based: one row of genes is nRows 1.
    const nRows = Math.max(0, ...Array.from(geneRows.values())) + 1;
    const rowHeight = Math.min(22, (height - 10) / nRows);

    for (const gene of displayGenes) {
      const row = geneRows.get(gene.id) ?? 0;
      const y = 5 + row * rowHeight + rowHeight / 2;
      const baseColor = gene.strand === '+' ? PLUS_COLOR : MINUS_COLOR;
      const isSelected = selectedGeneIds.has(gene.id);
      const isoCount = gene.name ? (isoformCounts.get(gene.name) ?? 0) : 0;

      const rawX1 = genomeToScreen(Math.max(gene.start, start));
      const rawX2 = genomeToScreen(Math.min(gene.end, end));
      const x1 = Math.min(rawX1, rawX2);
      const x2 = Math.max(rawX1, rawX2);

      // Draw selection highlight background
      if (isSelected) {
        ctx.fillStyle = SELECTION_COLOR + '40';  // 25% opacity yellow
        ctx.fillRect(x1, y - rowHeight * 0.4, x2 - x1, rowHeight * 0.8);

        // Draw selection border
        ctx.strokeStyle = SELECTION_COLOR;
        ctx.lineWidth = 2;
        ctx.strokeRect(x1, y - rowHeight * 0.4, x2 - x1, rowHeight * 0.8);
      }

      const color = baseColor;

      // At far zoom (>100bp/px), draw simplified gene body instead of individual exons
      const bpPerPx = (end - start) / width;

      if (bpPerPx > 100) {
        // Simplified: solid rectangle for entire gene body
        ctx.fillStyle = color;
        ctx.fillRect(x1, y - rowHeight * 0.2, Math.max(1, x2 - x1), rowHeight * 0.4);
      } else {
        // Full detail: intron line + individual exons
        // Intron line
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x1, y);
        ctx.lineTo(x2, y);
        ctx.stroke();

        // Exons
        ctx.fillStyle = color;
        for (const exon of gene.exons) {
          const rawEx1 = genomeToScreen(Math.max(exon.start, start));
          const rawEx2 = genomeToScreen(Math.min(exon.end, end));
          const ex1 = Math.min(rawEx1, rawEx2);
          const ex2 = Math.max(rawEx1, rawEx2);
          if (ex2 > ex1) {
            ctx.fillRect(ex1, y - rowHeight * 0.25, ex2 - ex1, rowHeight * 0.5);
          }
        }
      }

      // Gene name (bold if selected, show isoform count if collapsed). Show the
      // label whenever it fits within the feature box; otherwise the hover
      // tooltip supplies the name. This labels small features (e.g. plasmid
      // promoters) the old fixed 5%-of-viewport rule left blank.
      if (gene.name) {
        const label = isoCount > 1 ? `${gene.name} (${isoCount})` : gene.name;
        ctx.font = isSelected ? 'bold italic 9px sans-serif' : 'italic 9px sans-serif';
        ctx.textAlign = 'center';
        const labelWidth = ctx.measureText(label).width;
        if (labelWidth + 4 <= x2 - x1) {
          ctx.fillStyle = isSelected ? SELECTION_COLOR : color;
          ctx.fillText(label, (x1 + x2) / 2, y - rowHeight * 0.3 - 2);
        }
      }

      // Strand arrows - flip direction when view is reversed
      ctx.strokeStyle = color;
      ctx.lineWidth = 0.8;
      const arrowLeft = Math.min(x1, x2);
      const arrowRight = Math.max(x1, x2);
      const spacing = Math.max(50, (arrowRight - arrowLeft) / 5);
      const visualForward = isReversed ? (gene.strand === '-') : (gene.strand === '+');
      for (let ax = arrowLeft + spacing / 2; ax < arrowRight - 10; ax += spacing) {
        ctx.beginPath();
        if (visualForward) {
          ctx.moveTo(ax - 3, y - 2);
          ctx.lineTo(ax, y);
          ctx.lineTo(ax - 3, y + 2);
        } else {
          ctx.moveTo(ax + 3, y - 2);
          ctx.lineTo(ax, y);
          ctx.lineTo(ax + 3, y + 2);
        }
        ctx.stroke();
      }
    }

    // Collapsed indicator — draw on top (outside pan offset); a hint, so not in exported figures
    if (isCollapsed && !exportInProgress) {
      const totalCollapsed = Array.from(isoformCounts.values()).reduce((s, n) => s + n, 0) - isoformCounts.size;
      ctx.fillStyle = '#9ca3af';
      ctx.font = '9px sans-serif';
      ctx.textAlign = 'right';
      drawTrackLabel(ctx, `${totalCollapsed} isoforms merged \u2014 resize to expand`, width - 4, height - 3, { ...trackLabels, pill: false });
    }
  }, [displayGenes, geneRows, start, end, width, height, selectedGeneIds, genomeToScreen, isReversed, isCollapsed, isoformCounts, canvasRenderVersion, exportInProgress, trackLabels]);

  // Determine cursor style based on hover state
  const cursorClass = enableSelection && hoveredGene ? 'cursor-pointer' : '';

  return (
    <div style={{ width, height, overflow: 'hidden', position: 'relative' }} data-tour="gene-track">
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        className={`block ${cursorClass}`}
        onClick={handleClick}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      />
      {displayGenes.length === 0 && <HoverHint>No genes in region</HoverHint>}
      {isCollapsed && displayGenes.length > 0 && (
        <HoverLabel style={{ left: 'auto', right: 4, top: 'auto', bottom: 1 }}>
          {Array.from(isoformCounts.values()).reduce((n, c) => n + c, 0) - isoformCounts.size} isoforms merged — resize to expand
        </HoverLabel>
      )}
      {enableSelection && hoveredGene && hoverPos && (
        <div
          className="pointer-events-none absolute z-20 whitespace-nowrap rounded bg-gray-900/90 px-2 py-1 text-[11px] leading-tight text-white shadow"
          style={{ left: Math.min(Math.max(2, hoverPos.x + 10), Math.max(2, width - 150)), top: Math.max(2, hoverPos.y - 30) }}
        >
          <div className="font-semibold">{hoveredGene.name || hoveredGene.id}</div>
          <div className="text-gray-300">
            {(hoveredGene.biotype || 'feature')} · {hoveredGene.strand} · {hoveredGene.start.toLocaleString()}–{hoveredGene.end.toLocaleString()}
          </div>
        </div>
      )}
    </div>
  );
}
