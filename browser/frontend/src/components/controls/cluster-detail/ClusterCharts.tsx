import { useEffect, useRef, useCallback, useMemo } from 'react';
import { ChartMaximizeButton } from '../../charts/ChartMaximizeButton';
import { ChartSaveButton } from '../../charts/ChartSaveButton';
import { getClusterLabel } from '../../tracks/ReadTrack';
import {
  benjaminiHochberg,
  fisherExactTwoSided,
  formatPValue,
  oddsRatio2x2,
  wilsonInterval,
} from '../../../utils/statistics';
import { formatProfileChartTsv, formatTsv } from '../../../utils/analysisExport';

function drawProfile(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  data: number[],
  color: string,
  isReversed: boolean,
) {
  ctx.clearRect(0, 0, width, height);
  if (!data || data.length === 0) return;

  const max = Math.max(...data, 1);
  const n = data.length;
  const padding = 2;
  const plotH = height - padding * 2;

  ctx.beginPath();
  ctx.moveTo(0, height - padding);
  for (let i = 0; i < n; i++) {
    const binIdx = isReversed ? (n - 1 - i) : i;
    const x = (i / Math.max(1, n - 1)) * width;
    const y = height - padding - (data[binIdx] / max) * plotH;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(width, height - padding);
  ctx.closePath();
  ctx.fillStyle = color + '33';
  ctx.fill();

  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const binIdx = isReversed ? (n - 1 - i) : i;
    const x = (i / Math.max(1, n - 1)) * width;
    const y = height - padding - (data[binIdx] / max) * plotH;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();
}

/** Full-width metaprofile chart for a single cluster. */
export function ProfileChart({
  data,
  color,
  width = 300,
  height = 80,
  isReversed = false,
  label = 'profile',
}: {
  data: number[];
  color: string;
  width?: number;
  height?: number;
  isReversed?: boolean;
  label?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data || data.length === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawProfile(ctx, width, height, data, color, isReversed);
  }, [data, color, width, height, isReversed]);

  return (
    <div className="relative group" style={{ width, height }}>
      <canvas
        ref={canvasRef}
        style={{ width, height }}
        className="block"
      />
      <ChartSaveButton
        canvasRef={canvasRef}
        filename="cluster_profile"
        width={width}
        height={height}
        dataTsv={() => formatProfileChartTsv([{ label, data, color }], { isReversed })}
      />
    </div>
  );
}

export interface ClusterBarProps {
  proportions: Map<number, number[]>;
  /** Raw counts and denominators are required for uncertainty and tests. */
  counts?: Map<number, number[]>;
  /** Complete, visibility-independent family used for BH correction. */
  comparisonCounts?: Map<number, number[]>;
  comparisonClusterIds?: number[];
  datasetTotals?: number[];
  datasetLabels: string[];
  clusterColors: Map<number, string>;
  clusterIds: number[];
  visibleClusterIds?: Set<number> | null;
  width?: number;
  height?: number;
}

/** Exact plotted rates plus the count-scale pairwise inference behind the chart. */
export function formatClusterRateTsv(props: ClusterBarProps): string {
  const {
    proportions, counts, comparisonCounts, comparisonClusterIds, datasetTotals, datasetLabels,
    clusterColors, clusterIds, visibleClusterIds,
  } = props;
  const drawClusters = visibleClusterIds
    ? clusterIds.filter(cluster => visibleClusterIds.has(cluster))
    : clusterIds;
  const rows: unknown[][] = [[
    'record_type', 'cluster', 'cluster_label', 'color',
    'dataset_i_index', 'dataset_i', 'count_i', 'total_i',
    'rate_i', 'percent_i', 'ci_low_i', 'ci_high_i',
    'dataset_j_index', 'dataset_j', 'count_j', 'total_j',
    'rate_j', 'percent_j', 'ci_low_j', 'ci_high_j',
    'difference', 'difference_percentage_points', 'odds_ratio', 'p_value', 'q_value',
  ]];

  for (const cluster of drawClusters) {
    const fractions = proportions.get(cluster) ?? [];
    for (let datasetIndex = 0; datasetIndex < datasetLabels.length; datasetIndex++) {
      const count = counts?.get(cluster)?.[datasetIndex];
      const total = datasetTotals?.[datasetIndex];
      const rate = fractions[datasetIndex] ?? (count != null && total ? count / total : 0);
      const interval = count != null && total != null && total > 0
        ? wilsonInterval(count, total)
        : undefined;
      rows.push([
        'rate', cluster, getClusterLabel(cluster, true), clusterColors.get(cluster),
        datasetIndex, datasetLabels[datasetIndex], count, total,
        rate, rate * 100, interval?.low, interval?.high,
        '', '', '', '', '', '', '', '', '', '', '', '', '',
      ]);
    }
  }

  if (counts && datasetTotals) {
    const visibleClusters = new Set(drawClusters);
    const family = computeClusterRateComparisons(
      comparisonCounts ?? counts,
      datasetTotals,
      comparisonClusterIds ?? clusterIds,
    );
    for (const comparison of family.filter(item => visibleClusters.has(item.cluster))) {
      const intervalI = wilsonInterval(comparison.countI, comparison.totalI);
      const intervalJ = wilsonInterval(comparison.countJ, comparison.totalJ);
      rows.push([
        'comparison', comparison.cluster, getClusterLabel(comparison.cluster, true), clusterColors.get(comparison.cluster),
        comparison.datasetI, datasetLabels[comparison.datasetI], comparison.countI, comparison.totalI,
        comparison.rateI, comparison.rateI * 100, intervalI.low, intervalI.high,
        comparison.datasetJ, datasetLabels[comparison.datasetJ], comparison.countJ, comparison.totalJ,
        comparison.rateJ, comparison.rateJ * 100, intervalJ.low, intervalJ.high,
        comparison.difference, comparison.difference * 100,
        comparison.oddsRatio, comparison.pValue, comparison.qValue,
      ]);
    }
  }

  return formatTsv(rows);
}

export interface ClusterRateComparison {
  cluster: number;
  datasetI: number;
  datasetJ: number;
  countI: number;
  countJ: number;
  totalI: number;
  totalJ: number;
  rateI: number;
  rateJ: number;
  difference: number;
  oddsRatio: number;
  pValue: number;
  qValue: number;
}

/** Pairwise read-rate tests for every cluster in the declared analysis family. */
export function computeClusterRateComparisons(
  counts: Map<number, number[]>,
  datasetTotals: number[],
  clusterIds: number[],
): ClusterRateComparison[] {
  const comparisons: Omit<ClusterRateComparison, 'qValue'>[] = [];
  for (const cluster of clusterIds) {
    const clusterCounts = counts.get(cluster);
    if (!clusterCounts) continue;
    for (let i = 0; i < datasetTotals.length; i++) {
      for (let j = i + 1; j < datasetTotals.length; j++) {
        const totalI = Math.max(0, datasetTotals[i] ?? 0);
        const totalJ = Math.max(0, datasetTotals[j] ?? 0);
        if (totalI === 0 || totalJ === 0) continue;
        const countI = Math.max(0, Math.min(totalI, clusterCounts[i] ?? 0));
        const countJ = Math.max(0, Math.min(totalJ, clusterCounts[j] ?? 0));
        const notI = totalI - countI;
        const notJ = totalJ - countJ;
        comparisons.push({
          cluster,
          datasetI: i,
          datasetJ: j,
          countI,
          countJ,
          totalI,
          totalJ,
          rateI: countI / totalI,
          rateJ: countJ / totalJ,
          difference: countI / totalI - countJ / totalJ,
          oddsRatio: oddsRatio2x2(countI, notI, countJ, notJ),
          pValue: fisherExactTwoSided(countI, notI, countJ, notJ),
        });
      }
    }
  }
  const qValues = benjaminiHochberg(comparisons.map(comparison => comparison.pValue));
  return comparisons.map((comparison, index) => ({ ...comparison, qValue: qValues[index] }));
}

function ClusterRateStatistics({
  counts,
  comparisonCounts,
  datasetTotals,
  datasetLabels,
  clusterIds,
  comparisonClusterIds,
  clusterColors,
}: Pick<ClusterBarProps, 'counts' | 'comparisonCounts' | 'datasetTotals' | 'datasetLabels' | 'clusterIds' | 'comparisonClusterIds' | 'clusterColors'>) {
  const family = useMemo(
    () => counts && datasetTotals
      ? computeClusterRateComparisons(
          comparisonCounts ?? counts,
          datasetTotals,
          comparisonClusterIds ?? clusterIds,
        )
      : [],
    [counts, comparisonCounts, datasetTotals, clusterIds, comparisonClusterIds],
  );
  const comparisons = useMemo(
    () => family.filter(comparison => clusterIds.includes(comparison.cluster)),
    [family, clusterIds],
  );
  if (comparisons.length === 0) return null;
  const twoDatasets = datasetLabels.length === 2;

  return (
    <details open={twoDatasets} className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
      <summary className="cursor-pointer font-medium">
        Pairwise cluster-rate tests ({comparisons.length} shown; BH family n={family.length})
      </summary>
      <div className="mt-1 max-h-40 space-y-0.5 overflow-y-auto font-mono">
        {comparisons.map(comparison => {
          const significant = comparison.qValue < 0.05;
          return (
            <div
              key={`${comparison.cluster}:${comparison.datasetI}:${comparison.datasetJ}`}
              className={significant ? 'text-gray-800 dark:text-gray-200' : undefined}
            >
              <span className="font-semibold" style={{ color: clusterColors.get(comparison.cluster) }}>
                {getClusterLabel(comparison.cluster, true)}
              </span>{' '}
              {datasetLabels[comparison.datasetI]} {comparison.countI}/{comparison.totalI} ({(comparison.rateI * 100).toFixed(1)}%) vs{' '}
              {datasetLabels[comparison.datasetJ]} {comparison.countJ}/{comparison.totalJ} ({(comparison.rateJ * 100).toFixed(1)}%);{' '}
              Δ={(comparison.difference * 100).toFixed(1)}pp; OR={comparison.oddsRatio.toFixed(2)};{' '}
              p={formatPValue(comparison.pValue)}; q={formatPValue(comparison.qValue)}{significant ? ' *' : ''}
            </div>
          );
        })}
      </div>
      <div className="mt-1 italic text-gray-400">
        Fisher exact tests compare each cluster vs all other assigned reads; 95% Wilson bars and tests use reads as units. Unequal dataset coverage is retained in each denominator. Biological-replicate inference requires replicate-level data.
      </div>
    </details>
  );
}

function drawClusterBar(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  props: ClusterBarProps,
) {
  const { proportions, counts, datasetTotals, datasetLabels, clusterColors, clusterIds, visibleClusterIds } = props;
  ctx.clearRect(0, 0, width, height);

  const nDs = datasetLabels.length;
  const drawClusters = visibleClusterIds
    ? clusterIds.filter(c => visibleClusterIds.has(c))
    : clusterIds;
  const nClusters = drawClusters.length;
  if (nDs === 0 || nClusters === 0) return;

  const leftPad = 30;
  const rightPad = 10;
  const topPad = 10;
  const bottomPad = 24;
  const plotW = width - leftPad - rightPad;
  const plotH = height - topPad - bottomPad;

  let maxPct = 0;
  for (const cluster of drawClusters) {
    const fractions = proportions.get(cluster);
    if (!fractions) continue;
    for (let d = 0; d < fractions.length; d++) {
      const count = counts?.get(cluster)?.[d];
      const total = datasetTotals?.[d];
      const high = count != null && total != null ? wilsonInterval(count, total).high : fractions[d];
      if (high > maxPct) maxPct = high;
    }
  }
  if (maxPct <= 0.01) maxPct = 0.01;
  else if (maxPct <= 0.05) maxPct = Math.ceil(maxPct * 100) / 100;
  else if (maxPct <= 0.2) maxPct = Math.ceil(maxPct * 20) / 20;
  else maxPct = Math.ceil(maxPct * 10) / 10;

  ctx.strokeStyle = '#ccc';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(leftPad, topPad);
  ctx.lineTo(leftPad, topPad + plotH);
  ctx.lineTo(leftPad + plotW, topPad + plotH);
  ctx.stroke();

  ctx.fillStyle = '#999';
  ctx.font = '9px sans-serif';
  ctx.textAlign = 'right';
  const yTicks = [0, maxPct / 2, maxPct];
  for (const pct of yTicks) {
    const y = topPad + plotH - (pct / maxPct) * plotH;
    const pctVal = pct * 100;
    const label = pctVal < 1 && pctVal > 0 ? `${pctVal.toFixed(1)}%` : `${Math.round(pctVal)}%`;
    ctx.fillText(label, leftPad - 4, y + 3);
    if (pct > 0) {
      ctx.save();
      ctx.setLineDash([2, 2]);
      ctx.strokeStyle = '#e5e5e5';
      ctx.beginPath();
      ctx.moveTo(leftPad, y);
      ctx.lineTo(leftPad + plotW, y);
      ctx.stroke();
      ctx.restore();
    }
  }

  const groupWidth = plotW / nDs;
  const groupPadding = groupWidth * 0.15;
  const barAreaWidth = groupWidth - groupPadding * 2;
  const barWidth = Math.max(4, barAreaWidth / nClusters - 2);
  const barSpacing = (barAreaWidth - barWidth * nClusters) / Math.max(1, nClusters - 1);

  for (let d = 0; d < nDs; d++) {
    const groupX = leftPad + d * groupWidth + groupPadding;

    drawClusters.forEach((cluster, cIdx) => {
      const fractions = proportions.get(cluster);
      if (!fractions) return;

      const frac = fractions[d] || 0;
      const barHeight = (frac / maxPct) * plotH;
      const barX = groupX + cIdx * (barWidth + barSpacing);
      const barY = topPad + plotH - barHeight;

      const color = clusterColors.get(cluster) || '#999';
      ctx.fillStyle = color;
      ctx.fillRect(barX, barY, barWidth, barHeight);

      ctx.strokeStyle = 'rgba(0,0,0,0.2)';
      ctx.lineWidth = 0.5;
      ctx.strokeRect(barX, barY, barWidth, barHeight);

      const count = counts?.get(cluster)?.[d];
      const total = datasetTotals?.[d];
      if (count != null && total != null && total > 0) {
        const ci = wilsonInterval(count, total);
        const centerX = barX + barWidth / 2;
        const highY = topPad + plotH - (ci.high / maxPct) * plotH;
        const lowY = topPad + plotH - (ci.low / maxPct) * plotH;
        const cap = Math.max(2, Math.min(5, barWidth * 0.7));
        ctx.strokeStyle = '#374151';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(centerX, highY);
        ctx.lineTo(centerX, lowY);
        ctx.moveTo(centerX - cap / 2, highY);
        ctx.lineTo(centerX + cap / 2, highY);
        ctx.moveTo(centerX - cap / 2, lowY);
        ctx.lineTo(centerX + cap / 2, lowY);
        ctx.stroke();
      }
    });

    ctx.fillStyle = '#666';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'center';
    const labelX = groupX + barAreaWidth / 2;
    ctx.fillText(datasetLabels[d], labelX, topPad + plotH + 12);
  }

  if (nClusters <= 8 && width > 250) {
    const legendY = topPad + 2;
    const legendX = leftPad + plotW - nClusters * 20;
    ctx.font = '8px sans-serif';
    ctx.textAlign = 'left';
    drawClusters.forEach((cluster, i) => {
      const x = legendX + i * 20;
      const color = clusterColors.get(cluster) || '#999';
      ctx.fillStyle = color;
      ctx.fillRect(x, legendY, 8, 8);
      ctx.fillStyle = '#666';
      ctx.fillText(getClusterLabel(cluster, true), x + 10, legendY + 7);
    });
  }
}

function drawClusterLine(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  props: ClusterBarProps,
) {
  const { proportions, counts, datasetTotals, datasetLabels, clusterColors, clusterIds, visibleClusterIds } = props;
  ctx.clearRect(0, 0, width, height);

  const nDs = datasetLabels.length;
  const drawClusters = visibleClusterIds
    ? clusterIds.filter(c => visibleClusterIds.has(c))
    : clusterIds;
  if (nDs === 0 || drawClusters.length === 0) return;

  const leftPad = 34;
  const rightPad = 12;
  const topPad = 12;
  const bottomPad = 30;
  const plotW = width - leftPad - rightPad;
  const plotH = height - topPad - bottomPad;

  let maxPct = 0;
  for (const cluster of drawClusters) {
    const fractions = proportions.get(cluster);
    if (!fractions) continue;
    for (let d = 0; d < fractions.length; d++) {
      const count = counts?.get(cluster)?.[d];
      const total = datasetTotals?.[d];
      const high = count != null && total != null ? wilsonInterval(count, total).high : fractions[d];
      if (high > maxPct) maxPct = high;
    }
  }
  if (maxPct <= 0.01) maxPct = 0.01;
  else if (maxPct <= 0.05) maxPct = Math.ceil(maxPct * 100) / 100;
  else if (maxPct <= 0.2) maxPct = Math.ceil(maxPct * 20) / 20;
  else maxPct = Math.ceil(maxPct * 10) / 10;

  const xForDataset = (idx: number) => (
    leftPad + (nDs === 1 ? plotW / 2 : (idx / Math.max(1, nDs - 1)) * plotW)
  );
  const yForFraction = (frac: number) => topPad + plotH - (frac / maxPct) * plotH;

  ctx.strokeStyle = '#ccc';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(leftPad, topPad);
  ctx.lineTo(leftPad, topPad + plotH);
  ctx.lineTo(leftPad + plotW, topPad + plotH);
  ctx.stroke();

  ctx.fillStyle = '#999';
  ctx.font = '9px sans-serif';
  ctx.textAlign = 'right';
  const yTicks = [0, maxPct / 2, maxPct];
  for (const pct of yTicks) {
    const y = yForFraction(pct);
    const pctVal = pct * 100;
    const label = pctVal < 1 && pctVal > 0 ? `${pctVal.toFixed(1)}%` : `${Math.round(pctVal)}%`;
    ctx.fillText(label, leftPad - 4, y + 3);
    if (pct > 0) {
      ctx.save();
      ctx.setLineDash([2, 2]);
      ctx.strokeStyle = '#e5e5e5';
      ctx.beginPath();
      ctx.moveTo(leftPad, y);
      ctx.lineTo(leftPad + plotW, y);
      ctx.stroke();
      ctx.restore();
    }
  }

  ctx.font = '9px sans-serif';
  ctx.fillStyle = '#666';
  ctx.textAlign = 'right';
  for (let d = 0; d < nDs; d++) {
    const x = xForDataset(d);
    ctx.strokeStyle = '#e5e5e5';
    ctx.beginPath();
    ctx.moveTo(x, topPad);
    ctx.lineTo(x, topPad + plotH);
    ctx.stroke();

    const label = datasetLabels[d].length > 10 ? `${datasetLabels[d].slice(0, 9)}...` : datasetLabels[d];
    ctx.save();
    ctx.translate(x, topPad + plotH + 12);
    ctx.rotate(-Math.PI / 8);
    ctx.fillText(label, 0, 0);
    ctx.restore();
  }

  for (const cluster of drawClusters) {
    const fractions = proportions.get(cluster);
    if (!fractions) continue;
    const color = clusterColors.get(cluster) || '#999';

    ctx.strokeStyle = color;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    for (let d = 0; d < nDs; d++) {
      const x = xForDataset(d);
      const y = yForFraction(fractions[d] || 0);
      if (d === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    for (let d = 0; d < nDs; d++) {
      const x = xForDataset(d);
      const y = yForFraction(fractions[d] || 0);
      const count = counts?.get(cluster)?.[d];
      const total = datasetTotals?.[d];
      if (count != null && total != null && total > 0) {
        const ci = wilsonInterval(count, total);
        const highY = yForFraction(ci.high);
        const lowY = yForFraction(ci.low);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, highY);
        ctx.lineTo(x, lowY);
        ctx.moveTo(x - 3, highY);
        ctx.lineTo(x + 3, highY);
        ctx.moveTo(x - 3, lowY);
        ctx.lineTo(x + 3, lowY);
        ctx.stroke();
      }
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, 2.7, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }
  }

  if (drawClusters.length <= 8 && width > 250) {
    const legendY = topPad + 2;
    const legendX = leftPad + plotW - drawClusters.length * 22;
    ctx.font = '8px sans-serif';
    ctx.textAlign = 'left';
    drawClusters.forEach((cluster, i) => {
      const x = legendX + i * 22;
      const color = clusterColors.get(cluster) || '#999';
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x + 4, legendY + 4, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#666';
      ctx.fillText(getClusterLabel(cluster, true), x + 9, legendY + 7);
    });
  }
}

/** Grouped bar chart: X = datasets (groups), Y = percentage, bars = clusters */
export function ClusterBarChart({
  proportions,
  counts,
  comparisonCounts,
  comparisonClusterIds,
  datasetTotals,
  datasetLabels,
  clusterColors,
  clusterIds,
  visibleClusterIds,
  width = 300,
  height = 140,
}: ClusterBarProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const drawFn = useCallback((ctx: CanvasRenderingContext2D, w: number, h: number) => {
    drawClusterBar(ctx, w, h, { proportions, counts, datasetTotals, datasetLabels, clusterColors, clusterIds, visibleClusterIds });
  }, [proportions, counts, datasetTotals, datasetLabels, clusterColors, clusterIds, visibleClusterIds]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawFn(ctx, width, height);
  }, [drawFn, width, height]);

  return (
    <div className="relative group">
      <canvas
        ref={canvasRef}
        style={{ width, height }}
        className="block"
      />
      <ChartSaveButton
        canvasRef={canvasRef}
        filename="cluster_proportions"
        drawFn={drawFn}
        width={width}
        height={height}
        dataTsv={() => formatClusterRateTsv({ proportions, counts, comparisonCounts, comparisonClusterIds, datasetTotals, datasetLabels, clusterColors, clusterIds, visibleClusterIds })}
      />
      <ChartMaximizeButton
        title="Cluster Proportions"
        filename="cluster_proportions"
        renderChart={(w, h) => (
          <ClusterBarChart
            proportions={proportions}
            counts={counts}
            comparisonCounts={comparisonCounts}
            comparisonClusterIds={comparisonClusterIds}
            datasetTotals={datasetTotals}
            datasetLabels={datasetLabels}
            clusterColors={clusterColors}
            clusterIds={clusterIds}
            visibleClusterIds={visibleClusterIds}
            width={w}
            height={h}
          />
        )}
      />
      <ClusterRateStatistics
        counts={counts}
        comparisonCounts={comparisonCounts}
        datasetTotals={datasetTotals}
        datasetLabels={datasetLabels}
        clusterIds={clusterIds}
        comparisonClusterIds={comparisonClusterIds}
        clusterColors={clusterColors}
      />
    </div>
  );
}

/** Shared-axis line chart: X = datasets, Y = cluster frequency, series = clusters. */
export function ClusterLineChart({
  proportions,
  counts,
  comparisonCounts,
  comparisonClusterIds,
  datasetTotals,
  datasetLabels,
  clusterColors,
  clusterIds,
  visibleClusterIds,
  width = 300,
  height = 140,
}: ClusterBarProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const drawFn = useCallback((ctx: CanvasRenderingContext2D, w: number, h: number) => {
    drawClusterLine(ctx, w, h, { proportions, counts, datasetTotals, datasetLabels, clusterColors, clusterIds, visibleClusterIds });
  }, [proportions, counts, datasetTotals, datasetLabels, clusterColors, clusterIds, visibleClusterIds]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawFn(ctx, width, height);
  }, [drawFn, width, height]);

  return (
    <div className="relative group">
      <canvas
        ref={canvasRef}
        style={{ width, height }}
        className="block"
      />
      <ChartSaveButton
        canvasRef={canvasRef}
        filename="cluster_proportions_line"
        drawFn={drawFn}
        width={width}
        height={height}
        dataTsv={() => formatClusterRateTsv({ proportions, counts, comparisonCounts, comparisonClusterIds, datasetTotals, datasetLabels, clusterColors, clusterIds, visibleClusterIds })}
      />
      <ChartMaximizeButton
        title="Cluster Proportions"
        filename="cluster_proportions_line"
        renderChart={(w, h) => (
          <ClusterLineChart
            proportions={proportions}
            counts={counts}
            comparisonCounts={comparisonCounts}
            comparisonClusterIds={comparisonClusterIds}
            datasetTotals={datasetTotals}
            datasetLabels={datasetLabels}
            clusterColors={clusterColors}
            clusterIds={clusterIds}
            visibleClusterIds={visibleClusterIds}
            width={w}
            height={h}
          />
        )}
      />
      <ClusterRateStatistics
        counts={counts}
        comparisonCounts={comparisonCounts}
        datasetTotals={datasetTotals}
        datasetLabels={datasetLabels}
        clusterIds={clusterIds}
        comparisonClusterIds={comparisonClusterIds}
        clusterColors={clusterColors}
      />
    </div>
  );
}
