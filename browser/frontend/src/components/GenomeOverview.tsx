import { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { useBrowserStore } from '../stores/browserStore';
import { getCoverage } from '../api/coverage';
import { logFrontendDiagnostic } from '../utils/diagnostics';
import { findChromInfo, sameChrom } from '../utils/chromAliases';
import { categoryShown, useRegionCatalogStore } from '../stores/regionCatalogStore';
import { goToRegion, mainGenomeKey } from '../utils/regionNavigation';
import type { RegionEntry } from '../types/regions';

const TOTAL_HEIGHT = 24;
const LABEL_WIDTH = 44;
const RIGHT_PAD = 12;
const BAR_HEIGHT = 14;

export function GenomeOverview() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  // Coverage data cached per chrom
  const coverageRef = useRef<{ chrom: string; datasetKey: string; data: number[]; max: number } | null>(null);
  const [coverageData, setCoverageData] = useState<number[] | null>(null);
  const [coverageMax, setCoverageMax] = useState(0);

  const chrom = useBrowserStore(s => s.chrom);
  const start = useBrowserStore(s => s.start);
  const end = useBrowserStore(s => s.end);
  const chroms = useBrowserStore(s => s.chroms);
  const datasets = useBrowserStore(s => s.datasets);
  const setViewport = useBrowserStore(s => s.setViewport);
  const darkMode = useBrowserStore(s => s.darkMode);
  // Duplicate-flagged molecules count only while the read panels show them.
  const showDuplicateReads = useBrowserStore(s => s.showDuplicateReads);

  const chromInfo = findChromInfo(chroms, chrom);
  // Saved regions (markers above the bar, click to go) and highlights (washes) on this chromosome (fb-r4-regions).
  const genomeKey = useBrowserStore(s => mainGenomeKey(s));
  const highlights = useBrowserStore(s => s.highlights);
  const catalog = useRegionCatalogStore(s => s.catalogs[genomeKey]);
  const fingerprints = useRegionCatalogStore(s => s.fingerprints);
  const active = useRegionCatalogStore(s => s.active);
  const markers = useMemo(() => {
    if (!catalog) return [] as RegionEntry[];
    const shown = new Set(catalog.categories.filter(c => {
      if (!categoryShown(c, fingerprints)) return false;
      const parent = c.parent ? catalog.categories.find(p => p.id === c.parent) : undefined;
      return !parent || categoryShown(parent, fingerprints);
    }).map(c => c.id));
    return catalog.entries.filter(e => shown.has(e.category) && sameChrom(e.chrom, chrom)).slice(0, 5000);
  }, [catalog, fingerprints, chrom]);
  const [hoverLabel, setHoverLabel] = useState<string | null>(null);
  const datasetKey = datasets.map(d => d.id).join(',') + (showDuplicateReads ? '|dup' : '');

  // Observe container width. The container only exists once chromosomes are
  // known (render returns null before), so re-attach when it appears.
  const hasContainer = !!chromInfo && chroms.length > 0;
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setContainerWidth(el.clientWidth);
    const obs = new ResizeObserver(entries => {
      for (const entry of entries) setContainerWidth(entry.contentRect.width);
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, [hasContainer]);

  // Fetch coverage when chrom or datasets change (NOT on viewport pan)
  useEffect(() => {
    if (!chromInfo || containerWidth === 0) return;

    // Only re-fetch if chrom or datasets changed
    const cached = coverageRef.current;
    if (cached && cached.chrom === chrom && cached.datasetKey === datasetKey) {
      setCoverageData(cached.data);
      setCoverageMax(cached.max);
      return;
    }

    const barWidth = containerWidth - LABEL_WIDTH - RIGHT_PAD;
    const bins = Math.max(100, Math.min(barWidth, 2000));

    const controller = new AbortController();
    setIsLoading(true);

    logFrontendDiagnostic(`[GenomeOverview] Fetching coverage: ${chrom}:0-${chromInfo.size}, ${bins} bins, datasets=${datasetKey}`);
    getCoverage(chrom, 0, chromInfo.size, bins, undefined, { signal: controller.signal }, showDuplicateReads)
      .then(result => {
        if (controller.signal.aborted) return;
        logFrontendDiagnostic(`[GenomeOverview] Coverage received: max=${result.max}, nonzero=${result.coverage.filter((v: number) => v > 0).length}/${result.coverage.length} bins`);
        coverageRef.current = { chrom, datasetKey, data: result.coverage, max: result.max };
        setCoverageData(result.coverage);
        setCoverageMax(result.max);
        setIsLoading(false);
      })
      .catch(err => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        console.error('[GenomeOverview] Failed to fetch coverage:', err);
        setIsLoading(false);
      });

    return () => controller.abort();
  }, [chrom, chromInfo, datasetKey, containerWidth, showDuplicateReads]);

  // Draw
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !chromInfo || containerWidth === 0) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = containerWidth * dpr;
    canvas.height = TOTAL_HEIGHT * dpr;
    canvas.style.width = `${containerWidth}px`;
    canvas.style.height = `${TOTAL_HEIGHT}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, containerWidth, TOTAL_HEIGHT);

    const chromSize = chromInfo.size;
    const barWidth = containerWidth - LABEL_WIDTH - RIGHT_PAD;
    const barX = LABEL_WIDTH;
    const barY = (TOTAL_HEIGHT - BAR_HEIGHT) / 2;
    const isDark = darkMode;

    // The whole chromosome as a visible track (it was a 1-px line, lost in dark mode).
    ctx.fillStyle = isDark ? 'rgba(255,255,255,0.10)' : 'rgba(15,23,42,0.06)';
    ctx.fillRect(barX, barY, barWidth, BAR_HEIGHT);
    ctx.fillStyle = isDark ? 'rgba(255,255,255,0.28)' : 'rgba(15,23,42,0.18)';
    ctx.fillRect(barX, barY + BAR_HEIGHT - 1, barWidth, 1);

    // Coverage as a grey sparkline rising from the baseline.
    if (coverageData && coverageMax > 0) {
      const numBins = coverageData.length;
      const colWidth = barWidth / numBins;
      ctx.fillStyle = isDark ? 'rgba(203,213,225,0.75)' : 'rgba(100,116,139,0.5)';
      for (let i = 0; i < numBins; i++) {
        const val = coverageData[i];
        if (val <= 0) continue;
        const h = Math.max(1, Math.min(val / coverageMax, 1) * BAR_HEIGHT);
        ctx.fillRect(barX + i * colWidth, barY + BAR_HEIGHT - h, Math.max(1, colWidth), h);
      }
    }

    // Where the view is: a blue mark (at least 2 px) spanning the bar.
    const vpStart = Math.max(0, start / chromSize);
    const vpEnd = Math.min(1, end / chromSize);
    const vpX = barX + vpStart * barWidth;
    const vpW = Math.max(2, (vpEnd - vpStart) * barWidth);
    ctx.fillStyle = isDark ? 'rgba(96,165,250,0.40)' : 'rgba(59,130,246,0.18)';
    ctx.fillRect(vpX, barY - 1, vpW, BAR_HEIGHT + 2);
    ctx.fillStyle = isDark ? '#93c5fd' : '#3b82f6';
    ctx.fillRect(vpX, barY - 1, Math.min(vpW, 2), BAR_HEIGHT + 2);
    if (vpW > 4) ctx.fillRect(vpX + vpW - 2, barY - 1, 2, BAR_HEIGHT + 2);

    // Highlighted regions: their colour across the bar.
    for (const h of highlights) {
      if (h.genome !== genomeKey || !sameChrom(h.chrom, chrom)) continue;
      const x1 = barX + Math.max(0, h.start / chromSize) * barWidth;
      const w = Math.max(2, (Math.min(chromSize, h.end) - Math.max(0, h.start)) / chromSize * barWidth);
      ctx.globalAlpha = isDark ? 0.55 : 0.7;
      ctx.fillStyle = h.color;
      ctx.fillRect(x1, barY, w, BAR_HEIGHT);
      ctx.globalAlpha = 1;
    }
    // Saved regions: a mark above the bar each (the current category's darker).
    for (const e of markers) {
      const x = barX + ((e.start + e.end) / 2 / chromSize) * barWidth;
      const current = active?.genome === genomeKey && (active.category === e.category || active.entry === e.id);
      ctx.fillStyle = current ? (isDark ? '#5eead4' : '#0f766e') : (isDark ? 'rgba(94,234,212,0.6)' : 'rgba(15,118,110,0.55)');
      ctx.beginPath();
      ctx.moveTo(x - 3, 0);
      ctx.lineTo(x + 3, 0);
      ctx.lineTo(x, barY + 1);
      ctx.closePath();
      ctx.fill();
    }

    // Chromosome name at the left.
    ctx.fillStyle = isDark ? '#cbd5e1' : '#64748b';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    // Long contig names are shortened to fit beside the bar.
    let name = isLoading ? '…' : chrom;
    while (name.length > 1 && ctx.measureText(name).width > LABEL_WIDTH - 4) name = name.slice(0, -2) + '…';
    ctx.fillText(name, 0, TOTAL_HEIGHT / 2);
  }, [containerWidth, chrom, start, end, chromInfo, coverageData, coverageMax, isLoading, darkMode, highlights, markers, active, genomeKey]);

  /** The saved region whose mark is under the pointer (within 4 px), if any. */
  const markerAt = useCallback((clientX: number): RegionEntry | null => {
    if (!chromInfo || !canvasRef.current || !markers.length) return null;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = (clientX - rect.left) * canvasRef.current.clientWidth / rect.width;
    const barWidth = containerWidth - LABEL_WIDTH - RIGHT_PAD;
    let best: RegionEntry | null = null;
    let bestD = 4.5;
    for (const e of markers) {
      const d = Math.abs(LABEL_WIDTH + ((e.start + e.end) / 2 / chromInfo.size) * barWidth - x);
      if (d < bestD) { best = e; bestD = d; }
    }
    return best;
  }, [chromInfo, markers, containerWidth]);

  // Click/drag handler
  const jumpTo = useCallback((clientX: number) => {
    if (!chromInfo || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = (clientX - rect.left) * canvasRef.current.clientWidth / rect.width;
    const barWidth = containerWidth - LABEL_WIDTH - RIGHT_PAD;
    const barX = LABEL_WIDTH;

    if (x < barX || x > barX + barWidth) return;

    const frac = (x - barX) / barWidth;
    const center = Math.floor(frac * chromInfo.size);
    const viewSize = end - start;
    const half = Math.floor(viewSize / 2);
    const newStart = Math.max(0, center - half);
    const newEnd = Math.min(chromInfo.size, newStart + viewSize);
    setViewport(chrom, newStart, newEnd);
  }, [chromInfo, containerWidth, chrom, start, end, setViewport]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const marker = markerAt(e.clientX);
    if (marker) {
      goToRegion(genomeKey, marker);
      return;
    }
    setIsDragging(true);
    jumpTo(e.clientX);
  }, [jumpTo, markerAt, genomeKey]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (isDragging) { jumpTo(e.clientX); return; }
    const marker = markerAt(e.clientX);
    setHoverLabel(marker ? `${marker.label} · ${marker.chrom}:${marker.start.toLocaleString()}-${marker.end.toLocaleString()} (click to go there)` : null);
  }, [isDragging, jumpTo, markerAt]);

  const handleMouseUp = useCallback(() => setIsDragging(false), []);

  // Global mouseup
  useEffect(() => {
    if (!isDragging) return;
    const handler = () => setIsDragging(false);
    window.addEventListener('mouseup', handler);
    return () => window.removeEventListener('mouseup', handler);
  }, [isDragging]);

  if (!chromInfo || chroms.length === 0) return null;

  return (
    <div
      className="w-full bg-white/70 dark:bg-[#1c1c1e]/80 backdrop-blur-[20px] border-b border-gray-200/30 dark:border-white/10"
      style={{ height: TOTAL_HEIGHT }}
    >
      <div ref={containerRef} className="h-full mx-3 sm:mx-4">
        <canvas
          ref={canvasRef}
          style={{ cursor: isDragging ? 'grabbing' : 'pointer', width: '100%', height: TOTAL_HEIGHT }}
          title={hoverLabel ?? undefined}
          data-testid="genome-overview"
          data-region-markers={markers.length}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
        />
      </div>
    </div>
  );
}
