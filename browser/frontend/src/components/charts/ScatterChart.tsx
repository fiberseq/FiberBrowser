import { useRef, useEffect, useMemo, useCallback, useState, type ReactNode } from 'react';
import { ChartSaveButton } from './ChartSaveButton';
import { ChartMaximizeButton } from './ChartMaximizeButton';
import { formatScatterChartTsv } from '../../utils/analysisExport';

export interface DissolveArrow {
  from: [number, number];
  to: [number, number];
  fromCluster: number;
  toCluster: number;
  count?: number;
}

interface ScatterChartProps {
  coordsX: number[];
  coordsY: number[];
  labels: number[];                    // per-point cluster id
  pointIds?: string[];                 // per-point read/observation id (parallel)
  datasetIds?: string[];               // per-point dataset id (parallel)
  clusterColors: Record<number, string>;
  centroids?: Record<number, [number, number]>;  // cluster id -> [x,y]
  dimClusterIds?: Set<number>;         // clusters that were dissolved (drawn hollow/faded)
  highlightedClusters?: Set<number> | null;
  /** The labels `highlightedClusters` refers to (default `labels`): the current clusters on an after-merge preview. */
  highlightLabels?: number[];
  highlightedDatasetIds?: Set<string> | null;
  dissolveArrows?: DissolveArrow[];
  width?: number;
  height?: number;
  title?: string;
  filename?: string;
  xLabel?: string;
  yLabel?: string;
  pointSize?: number;
  jitter?: number;                     // std-dev of random offset, in data units
  showAxes?: boolean;
  showCentroids?: boolean;
  showCentroidLabels?: boolean;
  /** Clusters selected elsewhere (Overview, read panel): their centroid gets a ring. */
  selectedClusters?: Set<number> | null;
  /** Clicking a dot (fb-n5-projection); the modifier keys say what the click means. */
  onPointClick?: (index: number, modifiers: PointClickModifiers) => void;
  /** A click on the map away from any dot. */
  onBackgroundClick?: () => void;
  /** What the hover card says about one dot. */
  renderTooltip?: (index: number) => ReactNode;
  /** Text alternative for the canvas (the legend is the keyboard way in). */
  ariaLabel?: string;
}

export interface PointClickModifiers {
  shiftKey: boolean;
  /** ⌘ on a Mac, Ctrl elsewhere. */
  metaKey: boolean;
}

/**
 * A grid over the drawn dots (pixel positions) for hit-testing the pointer:
 * each move looks at the dots in the 3x3 cells around it only.
 */
export interface PointIndex {
  cell: number;
  px: Float32Array;
  py: Float32Array;
  cells: Map<number, number[]>;
}

const cellKey = (cx: number, cy: number) => cx * 100003 + cy;

export function buildPointIndex(px: ArrayLike<number>, py: ArrayLike<number>, drawn: ArrayLike<boolean | number>, cell = 8): PointIndex {
  const cells = new Map<number, number[]>();
  const n = px.length;
  for (let i = 0; i < n; i++) {
    if (!drawn[i]) continue;
    const key = cellKey(Math.floor(px[i] / cell), Math.floor(py[i] / cell));
    const list = cells.get(key);
    if (list) list.push(i);
    else cells.set(key, [i]);
  }
  return { cell, px: Float32Array.from(px), py: Float32Array.from(py), cells };
}

/** The dot nearest (x, y) within `radius` pixels (ties: the later-drawn, i.e. higher index), else null. */
export function nearestPoint(index: PointIndex | null, x: number, y: number, radius = 6): number | null {
  if (!index) return null;
  const { cell, px, py, cells } = index;
  const cx = Math.floor(x / cell);
  const cy = Math.floor(y / cell);
  const reach = Math.max(1, Math.ceil(radius / cell));
  let best: number | null = null;
  let bestD = radius * radius;
  for (let dx = -reach; dx <= reach; dx++) {
    for (let dy = -reach; dy <= reach; dy++) {
      const list = cells.get(cellKey(cx + dx, cy + dy));
      if (!list) continue;
      for (const i of list) {
        const d = (px[i] - x) ** 2 + (py[i] - y) ** 2;
        if (d < bestD || (d === bestD && best !== null && i > best)) {
          bestD = d;
          best = i;
        }
      }
    }
  }
  return best;
}

/**
 * The keyboard way across the map: from dot `from` (null: start near the
 * middle), the nearest drawn dot in the arrow's direction (the angle off the
 * arrow costs as much as twice the distance), else null.
 */
export function nextPointInDirection(
  index: PointIndex | null,
  from: number | null,
  dir: 'left' | 'right' | 'up' | 'down',
  centre: [number, number],
): number | null {
  if (!index) return null;
  const { px, py, cells } = index;
  const drawn: number[] = [];
  for (const list of cells.values()) drawn.push(...list);
  if (drawn.length === 0) return null;
  if (from === null) return drawn.reduce((best, i) => ((px[i] - centre[0]) ** 2 + (py[i] - centre[1]) ** 2 < (px[best] - centre[0]) ** 2 + (py[best] - centre[1]) ** 2 ? i : best), drawn[0]);
  const [ux, uy] = dir === 'left' ? [-1, 0] : dir === 'right' ? [1, 0] : dir === 'up' ? [0, -1] : [0, 1];
  let best: number | null = null;
  let bestCost = Number.POSITIVE_INFINITY;
  for (const i of drawn) {
    if (i === from) continue;
    const dx = px[i] - px[from];
    const dy = py[i] - py[from];
    const along = dx * ux + dy * uy;
    if (along <= 0) continue;
    const across = Math.abs(dx * uy - dy * ux);
    const cost = along + 2 * across;
    if (cost < bestCost || (cost === bestCost && best !== null && i < best)) {
      bestCost = cost;
      best = i;
    }
  }
  return best;
}

interface ScatterBounds {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

// Deterministic jitter based on point index so repeated renders are stable.
function deterministicJitter(index: number, amplitude: number): [number, number] {
  if (!amplitude) return [0, 0];
  const s = Math.sin(index * 12.9898) * 43758.5453;
  const t = Math.sin(index * 78.233) * 43758.5453;
  const jx = (s - Math.floor(s) - 0.5) * 2 * amplitude;
  const jy = (t - Math.floor(t) - 0.5) * 2 * amplitude;
  return [jx, jy];
}

function drawScatter(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  bounds: ScatterBounds,
  props: {
    coordsX: number[];
    coordsY: number[];
    labels: number[];
    datasetIds: string[] | undefined;
    clusterColors: Record<number, string>;
    centroids: Record<number, [number, number]> | undefined;
    dimClusterIds: Set<number> | undefined;
    highlightedClusters: Set<number> | null | undefined;
    highlightLabels?: number[];
    highlightedDatasetIds: Set<string> | null | undefined;
    dissolveArrows: DissolveArrow[] | undefined;
    title: string | undefined;
    xLabel: string;
    yLabel: string;
    pointSize: number;
    jitter: number;
    showAxes: boolean;
    showCentroids: boolean;
    showCentroidLabels: boolean;
    selectedClusters?: Set<number> | null;
  },
): { px: Float32Array; py: Float32Array; drawn: Uint8Array } {
  const {
    coordsX, coordsY, labels, datasetIds, clusterColors, centroids,
    dimClusterIds, highlightedClusters, highlightedDatasetIds, dissolveArrows,
    title, xLabel, yLabel, pointSize, jitter,
    showAxes, showCentroids, showCentroidLabels, selectedClusters, highlightLabels,
  } = props;

  const pxOut = new Float32Array(coordsX.length);
  const pyOut = new Float32Array(coordsX.length);
  const drawnOut = new Uint8Array(coordsX.length);

  ctx.clearRect(0, 0, width, height);

  if (!coordsX.length) {
    ctx.fillStyle = '#9ca3af';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No projection data', width / 2, height / 2);
    return { px: pxOut, py: pyOut, drawn: drawnOut };
  }

  const topPad = title ? 22 : 10;
  const bottomPad = showAxes ? 32 : 10;
  const leftPad = showAxes ? 44 : 10;
  const rightPad = 12;
  const plotW = width - leftPad - rightPad;
  const plotH = height - topPad - bottomPad;

  const xScale = plotW / (bounds.xMax - bounds.xMin);
  const yScale = plotH / (bounds.yMax - bounds.yMin);
  const toPx = (x: number, y: number): [number, number] => [
    leftPad + (x - bounds.xMin) * xScale,
    topPad + (bounds.yMax - y) * yScale,
  ];

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(leftPad, topPad, plotW, plotH);
  ctx.strokeStyle = '#e5e7eb';
  ctx.lineWidth = 1;
  ctx.strokeRect(leftPad, topPad, plotW, plotH);

  if (title) {
    ctx.fillStyle = '#374151';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(title, width / 2, 14);
  }

  ctx.setLineDash([2, 4]);
  ctx.strokeStyle = '#d1d5db';
  if (bounds.xMin <= 0 && bounds.xMax >= 0) {
    const [zx] = toPx(0, 0);
    ctx.beginPath();
    ctx.moveTo(zx, topPad);
    ctx.lineTo(zx, topPad + plotH);
    ctx.stroke();
  }
  if (bounds.yMin <= 0 && bounds.yMax >= 0) {
    const [, zy] = toPx(0, 0);
    ctx.beginPath();
    ctx.moveTo(leftPad, zy);
    ctx.lineTo(leftPad + plotW, zy);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  const hasClusterHL = !!(highlightedClusters && highlightedClusters.size > 0);
  const hasDatasetHL = !!(highlightedDatasetIds && highlightedDatasetIds.size > 0);
  const dimClusterSet = dimClusterIds ?? new Set<number>();

  const isPointHighlighted = (i: number): boolean => {
    if (hasClusterHL && !highlightedClusters!.has((highlightLabels ?? labels)[i])) return false;
    if (hasDatasetHL && datasetIds && !highlightedDatasetIds!.has(datasetIds[i])) return false;
    return true;
  };

  const drawPoint = (i: number, fg: boolean) => {
    const hl = isPointHighlighted(i);
    if (fg !== hl) return;
    const cluster = labels[i];
    const isDim = dimClusterSet.has(cluster);
    const [jx, jy] = deterministicJitter(i, jitter);
    const [px, py] = toPx(coordsX[i] + jx, coordsY[i] + jy);
    if (px < leftPad || px > leftPad + plotW || py < topPad || py > topPad + plotH) return;
    pxOut[i] = px;
    pyOut[i] = py;
    drawnOut[i] = 1;

    const color = clusterColors[cluster] || '#9ca3af';
    const baseAlpha = isDim ? 0.22 : (hl ? 0.75 : 0.15);
    ctx.globalAlpha = baseAlpha;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(px, py, pointSize, 0, Math.PI * 2);
    ctx.fill();
  };

  for (let i = 0; i < coordsX.length; i++) drawPoint(i, false);
  for (let i = 0; i < coordsX.length; i++) drawPoint(i, true);
  ctx.globalAlpha = 1.0;

  if (dissolveArrows && dissolveArrows.length > 0) {
    for (const arrow of dissolveArrows) {
      const [x1, y1] = toPx(arrow.from[0], arrow.from[1]);
      const [x2, y2] = toPx(arrow.to[0], arrow.to[1]);
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.hypot(dx, dy);
      if (len < 2) continue;

      ctx.strokeStyle = 'rgba(55, 65, 81, 0.85)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.setLineDash([]);

      const angle = Math.atan2(dy, dx);
      const ah = 6;
      ctx.fillStyle = 'rgba(55, 65, 81, 0.85)';
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - ah * Math.cos(angle - Math.PI / 7), y2 - ah * Math.sin(angle - Math.PI / 7));
      ctx.lineTo(x2 - ah * Math.cos(angle + Math.PI / 7), y2 - ah * Math.sin(angle + Math.PI / 7));
      ctx.closePath();
      ctx.fill();
    }
  }

  if (showCentroids && centroids) {
    for (const [cidStr, [cx, cy]] of Object.entries(centroids)) {
      const cid = parseInt(cidStr, 10);
      const [px, py] = toPx(cx, cy);
      const color = clusterColors[cid] || '#374151';
      const isDim = dimClusterSet.has(cid);

      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(px - 6, py);
      ctx.lineTo(px + 6, py);
      ctx.moveTo(px, py - 6);
      ctx.lineTo(px, py + 6);
      ctx.stroke();

      ctx.strokeStyle = color;
      ctx.lineWidth = isDim ? 1.25 : 2;
      ctx.globalAlpha = isDim ? 0.5 : 1.0;
      ctx.beginPath();
      ctx.moveTo(px - 6, py);
      ctx.lineTo(px + 6, py);
      ctx.moveTo(px, py - 6);
      ctx.lineTo(px, py + 6);
      ctx.stroke();
      ctx.globalAlpha = 1.0;

      if (selectedClusters?.has(cid)) {
        // Selected (Overview, read panel): a blue ring, as the read panel outlines it.
        ctx.strokeStyle = '#2563eb';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(px, py, 10, 0, Math.PI * 2);
        ctx.stroke();
      }

      if (showCentroidLabels) {
        const label = `C${cid}`;
        ctx.font = 'bold 10px sans-serif';
        ctx.textAlign = 'left';
        const tx = px + 8;
        const ty = py - 6;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 3;
        ctx.strokeText(label, tx, ty);
        ctx.fillStyle = color;
        ctx.globalAlpha = isDim ? 0.6 : 1.0;
        ctx.fillText(label, tx, ty);
        ctx.globalAlpha = 1.0;
      }
    }
  }

  if (showAxes) {
    ctx.fillStyle = '#6b7280';
    ctx.font = '10px sans-serif';

    ctx.textAlign = 'center';
    ctx.fillText(xLabel, leftPad + plotW / 2, topPad + plotH + 24);
    ctx.fillText(bounds.xMin.toFixed(2), leftPad, topPad + plotH + 12);
    ctx.fillText(bounds.xMax.toFixed(2), leftPad + plotW, topPad + plotH + 12);

    ctx.save();
    ctx.translate(10, topPad + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText(yLabel, 0, 0);
    ctx.restore();
    ctx.textAlign = 'right';
    ctx.fillText(bounds.yMax.toFixed(2), leftPad - 3, topPad + 8);
    ctx.fillText(bounds.yMin.toFixed(2), leftPad - 3, topPad + plotH);
  }
  return { px: pxOut, py: pyOut, drawn: drawnOut };
}

export function ScatterChart({
  coordsX,
  coordsY,
  labels,
  pointIds,
  datasetIds,
  clusterColors,
  centroids,
  dimClusterIds,
  highlightedClusters,
  highlightLabels,
  highlightedDatasetIds,
  dissolveArrows,
  width = 420,
  height = 360,
  title,
  filename = 'projection',
  xLabel = 'Dim 1',
  yLabel = 'Dim 2',
  pointSize = 3,
  jitter = 0,
  showAxes = true,
  showCentroids = true,
  showCentroidLabels = true,
  selectedClusters,
  onPointClick,
  onBackgroundClick,
  renderTooltip,
  ariaLabel,
}: ScatterChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const indexRef = useRef<PointIndex | null>(null);
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null);
  const interactive = !!(onPointClick || renderTooltip);

  const bounds = useMemo<ScatterBounds>(() => {
    if (!coordsX.length) return { xMin: 0, xMax: 1, yMin: 0, yMax: 1 };
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (let i = 0; i < coordsX.length; i++) {
      const [jx, jy] = deterministicJitter(i, jitter);
      const x = coordsX[i] + jx;
      const y = coordsY[i] + jy;
      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
    if (centroids) {
      for (const [x, y] of Object.values(centroids)) {
        if (x < xMin) xMin = x;
        if (x > xMax) xMax = x;
        if (y < yMin) yMin = y;
        if (y > yMax) yMax = y;
      }
    }
    const padX = (xMax - xMin) * 0.05 || 1;
    const padY = (yMax - yMin) * 0.05 || 1;
    return {
      xMin: xMin - padX,
      xMax: xMax + padX,
      yMin: yMin - padY,
      yMax: yMax + padY,
    };
  }, [coordsX, coordsY, centroids, jitter]);

  const drawFn = useCallback((ctx: CanvasRenderingContext2D, w: number, h: number) => {
    return drawScatter(ctx, w, h, bounds, {
      coordsX, coordsY, labels, datasetIds, clusterColors, centroids,
      dimClusterIds, highlightedClusters, highlightedDatasetIds, dissolveArrows,
      title, xLabel, yLabel, pointSize, jitter,
      showAxes, showCentroids, showCentroidLabels, selectedClusters, highlightLabels,
    });
  }, [
    bounds, coordsX, coordsY, labels, datasetIds, clusterColors, centroids,
    dimClusterIds, highlightedClusters, highlightedDatasetIds, dissolveArrows,
    title, xLabel, yLabel, pointSize, jitter,
    showAxes, showCentroids, showCentroidLabels, selectedClusters, highlightLabels,
  ]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const drawn = drawFn(ctx, width, height);
    indexRef.current = interactive ? buildPointIndex(drawn.px, drawn.py, drawn.drawn) : null;
  }, [drawFn, width, height, interactive]);

  // The dots moved (new map, size): the hover card would point at another read.
  useEffect(() => { setHover(null); }, [coordsX, width, height]);

  const pointerAt = (e: React.PointerEvent<HTMLCanvasElement> | React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    return { x, y, index: nearestPoint(indexRef.current, x, y, Math.max(5, pointSize + 3)) };
  };

  return (
    <div className="relative group">
      <canvas
        ref={canvasRef}
        style={{ width, height, cursor: interactive && hover ? 'pointer' : undefined }}
        role="img"
        aria-label={ariaLabel ?? title ?? 'Projection'}
        data-testid={interactive ? 'projection-map-canvas' : undefined}
        // Keyboard: arrows step from dot to dot (the hover card follows), Enter acts as a click.
        tabIndex={interactive ? 0 : undefined}
        className={interactive ? 'rounded focus-visible:outline-none focus-visible:shadow-focus' : undefined}
        onKeyDown={interactive ? (e => {
          const dirs: Record<string, 'left' | 'right' | 'up' | 'down'> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
          const dir = dirs[e.key];
          if (dir) {
            e.preventDefault();
            const next = nextPointInDirection(indexRef.current, hover?.index ?? null, dir, [width / 2, height / 2]);
            if (next !== null) setHover({ index: next, x: indexRef.current!.px[next], y: indexRef.current!.py[next] });
            return;
          }
          if ((e.key === 'Enter' || e.key === ' ') && hover && onPointClick) {
            e.preventDefault();
            onPointClick(hover.index, { shiftKey: e.shiftKey, metaKey: e.metaKey || e.ctrlKey });
          }
        }) : undefined}
        onBlur={interactive ? (() => setHover(null)) : undefined}
        onPointerMove={interactive ? (e => {
          const { x, y, index } = pointerAt(e);
          setHover(prev => (index === null ? null : prev?.index === index ? prev : { index, x, y }));
        }) : undefined}
        onPointerLeave={interactive ? (() => setHover(null)) : undefined}
        onClick={onPointClick || onBackgroundClick ? (e => {
          const { index } = pointerAt(e);
          if (index === null) { onBackgroundClick?.(); return; }
          onPointClick?.(index, { shiftKey: e.shiftKey, metaKey: e.metaKey || e.ctrlKey });
        }) : undefined}
      />
      {hover && renderTooltip && (
        <>
          <div
            className="pointer-events-none absolute rounded-full border-2 border-gray-900"
            style={{ left: indexRef.current!.px[hover.index] - 6, top: indexRef.current!.py[hover.index] - 6, width: 12, height: 12 }}
            aria-hidden="true"
          />
          <div
            role="tooltip"
            data-testid="projection-map-tooltip"
            className="pointer-events-none absolute z-20 max-w-[260px] rounded border border-gray-200 bg-white/95 px-2 py-1 text-[11px] leading-snug text-gray-700 shadow-dropdown dark:border-white/10 dark:bg-gray-900/95 dark:text-gray-200"
            style={{
              left: Math.min(Math.max(4, hover.x + 12), Math.max(4, width - 264)),
              top: hover.y + 12 > height - 72 ? Math.max(4, hover.y - 76) : hover.y + 12,
            }}
          >
            {renderTooltip(hover.index)}
          </div>
        </>
      )}
      <ChartSaveButton
        canvasRef={canvasRef}
        filename={filename}
        drawFn={drawFn}
        width={width}
        height={height}
        dataTsv={() => formatScatterChartTsv({ coordsX, coordsY, labels, pointIds, datasetIds })}
      />
      <ChartMaximizeButton
        title={title || 'Projection'}
        filename={filename}
        renderChart={(w, h) => (
          <ScatterChart
            coordsX={coordsX}
            coordsY={coordsY}
            labels={labels}
            pointIds={pointIds}
            datasetIds={datasetIds}
            clusterColors={clusterColors}
            centroids={centroids}
            dimClusterIds={dimClusterIds}
            highlightedClusters={highlightedClusters}
            highlightLabels={highlightLabels}
            highlightedDatasetIds={highlightedDatasetIds}
            dissolveArrows={dissolveArrows}
            width={w}
            height={h}
            title={title}
            filename={filename}
            xLabel={xLabel}
            yLabel={yLabel}
            pointSize={pointSize}
            jitter={jitter}
            showAxes={showAxes}
            showCentroids={showCentroids}
            showCentroidLabels={showCentroidLabels}
            selectedClusters={selectedClusters}
            onPointClick={onPointClick}
            onBackgroundClick={onBackgroundClick}
            renderTooltip={renderTooltip}
            ariaLabel={ariaLabel}
          />
        )}
      />
    </div>
  );
}
