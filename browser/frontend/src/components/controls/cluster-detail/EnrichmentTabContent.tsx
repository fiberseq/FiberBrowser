import { useEffect, useRef, useMemo, useCallback, useState } from 'react';
import { ChartMaximizeButton } from '../../charts/ChartMaximizeButton';
import { ChartSaveButton } from '../../charts/ChartSaveButton';
import type { ColorRule } from '../../../types';
import type { EnrichmentResult } from '../../../utils/ruleMatching';
import { AnalysisStatus } from '../shared';
import { getClusterLabel } from '../../tracks/ReadTrack';
import {
  benjaminiHochberg,
  fisherExactTwoSided,
  formatPValue,
  oddsRatio2x2,
  wilsonInterval,
} from '../../../utils/statistics';
import { formatTsv } from '../../../utils/analysisExport';
import { pickedClusterData, useClusterPicks } from './clusterPicks';
import { ClusterPickChips } from './ClusterPickChips';

export interface EnrichmentInference {
  ruleId: string;
  cluster: number;
  matched: number;
  total: number;
  restMatched: number;
  restTotal: number;
  oddsRatio: number;
  pValue: number;
  qValue: number;
}

export function computeEnrichmentInference(
  enrichmentData: Map<string, Map<number, EnrichmentResult>>,
  enabledRules: ColorRule[],
  clusterData: Array<{ cluster: number }>,
): EnrichmentInference[] {
  const raw: Omit<EnrichmentInference, 'qValue'>[] = [];
  for (const rule of enabledRules) {
    const clusterMap = enrichmentData.get(rule.id);
    if (!clusterMap) continue;
    const entries = clusterData
      .map(({ cluster }) => ({ cluster, entry: clusterMap.get(cluster) }))
      .filter((item): item is { cluster: number; entry: EnrichmentResult } => !!item.entry);
    const allMatched = entries.reduce((sum, item) => sum + item.entry.matched, 0);
    const allTotal = entries.reduce((sum, item) => sum + item.entry.total, 0);
    for (const { cluster, entry } of entries) {
      const restMatched = allMatched - entry.matched;
      const restTotal = allTotal - entry.total;
      if (entry.total === 0 || restTotal === 0) continue;
      const unmatched = entry.total - entry.matched;
      const restUnmatched = restTotal - restMatched;
      raw.push({
        ruleId: rule.id,
        cluster,
        matched: entry.matched,
        total: entry.total,
        restMatched,
        restTotal,
        oddsRatio: oddsRatio2x2(entry.matched, unmatched, restMatched, restUnmatched),
        pValue: fisherExactTwoSided(entry.matched, unmatched, restMatched, restUnmatched),
      });
    }
  }
  const qValues = benjaminiHochberg(raw.map(item => item.pValue));
  return raw.map((item, index) => ({ ...item, qValue: qValues[index] }));
}

/** Export the plotted rule rates, count denominators, Wilson intervals, and tests. */
export function formatEnrichmentTsv(
  enrichmentData: Map<string, Map<number, EnrichmentResult>>,
  enabledRules: ColorRule[],
  clusterData: Array<{ cluster: number; color: string }>,
  inferenceClusterData: Array<{ cluster: number }> = clusterData,
): string {
  const inferenceByKey = new Map(
    computeEnrichmentInference(enrichmentData, enabledRules, inferenceClusterData)
      .map(item => [`${item.ruleId}:${item.cluster}`, item]),
  );
  const rows: unknown[][] = [[
    'rule_id', 'rule_name', 'cluster', 'cluster_label', 'cluster_color',
    'matched', 'total', 'rate', 'percent', 'ci_low', 'ci_high',
    'rest_matched', 'rest_total', 'odds_ratio', 'p_value', 'q_value',
    'rest_rate', 'difference_pp', 'difference_ci_low_pp', 'difference_ci_high_pp',
  ]];
  for (const rule of enabledRules) {
    const clusterMap = enrichmentData.get(rule.id);
    for (const cluster of clusterData) {
      const entry = clusterMap?.get(cluster.cluster);
      if (!entry) continue;
      const rate = entry.total > 0 ? entry.matched / entry.total : 0;
      const interval = entry.total > 0 ? wilsonInterval(entry.matched, entry.total) : undefined;
      const inference = inferenceByKey.get(`${rule.id}:${cluster.cluster}`);
      const diff = inference
        ? rateDifference(inference.matched, inference.total, inference.restMatched, inference.restTotal)
        : undefined;
      rows.push([
        rule.id, rule.name, cluster.cluster, getClusterLabel(cluster.cluster, true), cluster.color,
        entry.matched, entry.total, rate, rate * 100, interval?.low, interval?.high,
        inference?.restMatched, inference?.restTotal, inference?.oddsRatio,
        inference?.pValue, inference?.qValue,
        diff?.restRate, diff ? diff.difference * 100 : undefined,
        diff ? diff.low * 100 : undefined, diff ? diff.high * 100 : undefined,
      ]);
    }
  }
  return formatTsv(rows);
}

/**
 * Rules that can't tell clusters apart: every plotted cluster at 100% (all of
 * its reads match) or every one at 0%. They are listed in a note instead of
 * drawn as a row of identical bars.
 */
export function splitUniformRules(
  enrichmentData: Map<string, Map<number, EnrichmentResult>>,
  enabledRules: ColorRule[],
  clusterData: Array<{ cluster: number }>,
): { plotted: ColorRule[]; allMatched: ColorRule[]; noneMatched: ColorRule[] } {
  const plotted: ColorRule[] = [];
  const allMatched: ColorRule[] = [];
  const noneMatched: ColorRule[] = [];
  for (const rule of enabledRules) {
    const clusterMap = enrichmentData.get(rule.id);
    const entries = clusterData
      .map(({ cluster }) => clusterMap?.get(cluster))
      .filter((entry): entry is EnrichmentResult => !!entry && entry.total > 0);
    if (entries.length === 0) { plotted.push(rule); continue; }
    if (entries.every(entry => entry.matched === entry.total)) allMatched.push(rule);
    else if (entries.every(entry => entry.matched === 0)) noneMatched.push(rule);
    else plotted.push(rule);
  }
  return { plotted, allMatched, noneMatched };
}

/** Break a category name into at most `maxLines` lines of `maxWidth`, the last one ellipsised if it still doesn't fit. */
export function wrapLabel(text: string, maxWidth: number, measure: (s: string) => number, maxLines = 2): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  let i = 0;
  for (; i < words.length; i++) {
    const next = current ? `${current} ${words[i]}` : words[i];
    if (measure(next) <= maxWidth || !current) {
      current = next;
    } else {
      lines.push(current);
      current = words[i];
      if (lines.length === maxLines - 1) { i++; break; }
    }
  }
  if (i < words.length) current = [current, ...words.slice(i)].join(' ');
  if (current) lines.push(current);
  const out = lines.slice(0, maxLines);
  const last = out.length - 1;
  if (last >= 0 && measure(out[last]) > maxWidth) {
    let cut = out[last];
    while (cut.length > 1 && measure(cut + '…') > maxWidth) cut = cut.slice(0, -1);
    out[last] = cut + '…';
  }
  return out;
}

/**
 * The difference between two read rates (cluster minus the other clusters)
 * with Newcombe's hybrid score interval, built from the two Wilson intervals.
 */
export function rateDifference(matched: number, total: number, restMatched: number, restTotal: number) {
  const p1 = total > 0 ? matched / total : 0;
  const p2 = restTotal > 0 ? restMatched / restTotal : 0;
  const w1 = wilsonInterval(matched, total);
  const w2 = wilsonInterval(restMatched, restTotal);
  const d = p1 - p2;
  return {
    rate: p1,
    restRate: p2,
    difference: d,
    low: d - Math.sqrt((p1 - w1.low) ** 2 + (w2.high - p2) ** 2),
    high: d + Math.sqrt((w1.high - p1) ** 2 + (p2 - w2.low) ** 2),
  };
}

export interface DifferenceRow {
  ruleId: string;
  ruleName: string;
  matched: number;
  total: number;
  restMatched: number;
  restTotal: number;
  rate: number;
  restRate: number;
  /** Cluster rate minus the other clusters' rate (a fraction; ×100 for percentage points). */
  difference: number;
  low: number;
  high: number;
  oddsRatio: number;
  qValue: number;
}

export interface DifferencePanel {
  cluster: number;
  color: string;
  /** Reads compared (those fetched for the view, often a drawn sample). */
  reads: number;
  /** Reads assigned to the cluster, when known. */
  assigned?: number;
  rows: DifferenceRow[];
}

/**
 * One panel per drawn cluster: each plotted rule's rate in the cluster against
 * the rate in every other cluster (hidden ones included), most "more common"
 * first. The tests come from the full family (inferenceByKey).
 */
export function computeDifferencePanels(
  enrichmentData: Map<string, Map<number, EnrichmentResult>>,
  plottedRules: ColorRule[],
  clusters: Array<{ cluster: number; color: string; totalCount?: number }>,
  inferenceByKey: Map<string, EnrichmentInference>,
): DifferencePanel[] {
  return clusters.map(({ cluster, color, totalCount }) => {
    const rows: DifferenceRow[] = [];
    let reads = 0;
    for (const rule of plottedRules) {
      const inference = inferenceByKey.get(`${rule.id}:${cluster}`);
      const entry = enrichmentData.get(rule.id)?.get(cluster);
      if (entry) reads = Math.max(reads, entry.total);
      if (!inference) continue;
      const diff = rateDifference(inference.matched, inference.total, inference.restMatched, inference.restTotal);
      rows.push({
        ruleId: rule.id,
        ruleName: rule.name,
        matched: inference.matched,
        total: inference.total,
        restMatched: inference.restMatched,
        restTotal: inference.restTotal,
        ...diff,
        oddsRatio: inference.oddsRatio,
        qValue: inference.qValue,
      });
    }
    rows.sort((a, b) => b.difference - a.difference || a.ruleName.localeCompare(b.ruleName));
    return { cluster, color, reads, assigned: totalCount, rows };
  });
}

/** The shared x-axis half-width, in percentage points: a round number covering every interval. */
export function differenceAxisMax(panels: DifferencePanel[]): number {
  let max = 0;
  for (const panel of panels) {
    for (const row of panel.rows) max = Math.max(max, Math.abs(row.low) * 100, Math.abs(row.high) * 100);
  }
  const steps = [10, 20, 25, 40, 50, 60, 80, 100];
  return steps.find(step => step >= max) ?? 100;
}

const PANEL_HEADER = 18;
const ROW_HEIGHT = 18;
const PANEL_GAP = 8;
const AXIS_HEIGHT = 32;
/** Below this plot width the axis title gets its own line (it would run into "less/more common"). */
const AXIS_ONE_LINE_MIN = 380;
const VALUE_WIDTH = 92;

export function differencesLayout(width: number, panels: DifferencePanel[]) {
  const labelWidth = Math.round(Math.min(150, Math.max(70, width * 0.28)));
  const x0 = labelWidth + 6;
  const x1 = Math.max(x0 + 40, width - VALUE_WIDTH - 4);
  const rows: Array<{ panel: number; row: number; y: number }> = [];
  const headers: number[] = [];
  let y = 2;
  panels.forEach((panel, pi) => {
    headers.push(y);
    y += PANEL_HEADER;
    panel.rows.forEach((_, ri) => {
      rows.push({ panel: pi, row: ri, y });
      y += ROW_HEIGHT;
    });
    if (panel.rows.length === 0) y += ROW_HEIGHT;
    y += PANEL_GAP;
  });
  const axisLines = x1 - x0 >= AXIS_ONE_LINE_MIN ? 2 : 3;
  return { labelWidth, x0, x1, rows, headers, axisY: y, axisLines, height: y + AXIS_HEIGHT + (axisLines - 2) * 13 };
}

/** The row under the pointer, for the tooltip. */
export function differencesHitTest(y: number, layout: ReturnType<typeof differencesLayout>) {
  return layout.rows.find(r => y >= r.y && y < r.y + ROW_HEIGHT) ?? null;
}

/** "33 reads", or "33 of 412 reads compared" when the view's reads are a sample of the cluster. */
export function differencePanelReadsLabel(panel: Pick<DifferencePanel, 'reads' | 'assigned'>): string {
  if (panel.assigned != null && panel.assigned > panel.reads) {
    return `${panel.reads.toLocaleString()} of ${panel.assigned.toLocaleString()} reads compared`;
  }
  return `${panel.reads.toLocaleString()} reads`;
}

const significanceStars = (q: number) => (q < 0.001 ? '***' : q < 0.01 ? '**' : q < 0.05 ? '*' : '');
const pct = (fraction: number) => `${Math.round(fraction * 100)}%`;

export interface DifferencesInk {
  text: string;
  muted: string;
  grid: string;
  whisker: string;
}

export const LIGHT_INK: DifferencesInk = { text: '#374151', muted: '#6b7280', grid: '#e5e7eb', whisker: '#374151' };
export const DARK_INK: DifferencesInk = { text: '#e5e7eb', muted: '#9ca3af', grid: '#374151', whisker: '#d1d5db' };

function drawDifferences(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  panels: DifferencePanel[],
  ink: DifferencesInk,
) {
  ctx.clearRect(0, 0, width, height);
  const layout = differencesLayout(width, panels);
  const { x0, x1, labelWidth } = layout;
  const axisMax = differenceAxisMax(panels);
  const center = (x0 + x1) / 2;
  const scale = (x1 - x0) / 2 / axisMax;
  const xFor = (fraction: number) => center + Math.max(-axisMax, Math.min(axisMax, fraction * 100)) * scale;
  const font = (size: number, weight = '') => `${weight ? `${weight} ` : ''}${size}px system-ui, sans-serif`;

  // Light vertical grid at the ticks, behind everything.
  const ticks = [-axisMax, -axisMax / 2, 0, axisMax / 2, axisMax];
  ctx.lineWidth = 1;
  for (const tick of ticks) {
    const x = Math.round(center + tick * scale) + 0.5;
    ctx.strokeStyle = tick === 0 ? ink.muted : ink.grid;
    ctx.beginPath();
    ctx.moveTo(x, 2 + PANEL_HEADER - 2);
    ctx.lineTo(x, layout.axisY - PANEL_GAP + 2);
    ctx.stroke();
  }

  panels.forEach((panel, pi) => {
    const hy = layout.headers[pi];
    ctx.fillStyle = panel.color;
    ctx.fillRect(0, hy + 4, 9, 9);
    ctx.fillStyle = ink.text;
    ctx.font = font(11, '600');
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(getClusterLabel(panel.cluster, true), 13, hy + 9);
    const labelW = ctx.measureText(getClusterLabel(panel.cluster, true)).width;
    ctx.fillStyle = ink.muted;
    ctx.font = font(10);
    ctx.fillText(differencePanelReadsLabel(panel), 19 + labelW, hy + 9);
    if (panel.rows.length === 0) {
      ctx.fillText('No rule to compare', x0, hy + PANEL_HEADER + ROW_HEIGHT / 2);
    }
  });

  for (const { panel: pi, row: ri, y } of layout.rows) {
    const panel = panels[pi];
    const row = panel.rows[ri];
    const mid = y + ROW_HEIGHT / 2;
    const significant = row.qValue < 0.05;
    // Rule name, cut to its column.
    ctx.font = font(10);
    ctx.fillStyle = ink.text;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const [name] = wrapLabel(row.ruleName, labelWidth - 4, text => ctx.measureText(text).width, 1);
    ctx.fillText(name ?? row.ruleName, labelWidth, mid);
    // The difference: a bar from 0 in the cluster's colour, faded when not significant.
    const xEnd = xFor(row.difference);
    const barLeft = Math.min(center, xEnd);
    const barWidth = Math.max(1, Math.abs(xEnd - center));
    ctx.globalAlpha = significant ? 1 : 0.35;
    ctx.fillStyle = panel.color;
    ctx.fillRect(barLeft, mid - 5, barWidth, 10);
    ctx.globalAlpha = 1;
    // Its 95% interval.
    const lowX = xFor(row.low);
    const highX = xFor(row.high);
    ctx.strokeStyle = ink.whisker;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(lowX, mid);
    ctx.lineTo(highX, mid);
    ctx.moveTo(lowX, mid - 3);
    ctx.lineTo(lowX, mid + 3);
    ctx.moveTo(highX, mid - 3);
    ctx.lineTo(highX, mid + 3);
    ctx.stroke();
    // The two rates, and stars for the test.
    ctx.textAlign = 'left';
    ctx.font = font(10, significant ? '600' : '');
    ctx.fillStyle = significant ? ink.text : ink.muted;
    ctx.fillText(`${pct(row.rate)} vs ${pct(row.restRate)} ${significanceStars(row.qValue)}`.trim(), x1 + 6, mid);
  }

  // Shared axis.
  const ay = layout.axisY;
  ctx.fillStyle = ink.muted;
  ctx.font = font(10);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const tick of ticks) {
    const label = tick === 0 ? '0' : `${tick > 0 ? '+' : '−'}${Math.abs(tick)}`;
    ctx.fillText(label, center + tick * scale, ay);
  }
  ctx.fillText('percentage points vs the other clusters', center, ay + 13 * (layout.axisLines - 1));
  ctx.textAlign = 'left';
  ctx.fillText('← less common', x0, ay + 13);
  ctx.textAlign = 'right';
  ctx.fillText('more common →', x1, ay + 13);
}

const isDarkTheme = () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark');

/**
 * "What sets each cluster apart": for each labeling rule, the share of a
 * cluster's reads with a matching footprint minus the share in all the other
 * clusters, one small panel per cluster (the picked ones, or all).
 */
export function EnrichmentTabContent({
  enrichmentData,
  enrichmentLoading,
  enrichmentError = null,
  enabledRules,
  clusterData,
  allClusterData = clusterData,
  containerWidth,
  pickKeys = [],
}: {
  enrichmentData: Map<string, Map<number, EnrichmentResult>> | null;
  enrichmentLoading: boolean;
  enrichmentError?: string | null;
  enabledRules: ColorRule[];
  clusterData: Array<{ cluster: number; color: string; counts: number[]; totalCount: number }>;
  allClusterData?: Array<{ cluster: number; color: string; counts: number[]; totalCount: number }>;
  containerWidth: number;
  /** The panel state keys a cluster pick applies to (the app's shared cluster selection). */
  pickKeys?: string[];
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const picks = useClusterPicks(pickKeys);
  const shownClusters = useMemo(() => pickedClusterData(clusterData, picks.picked), [clusterData, picks.picked]);
  // The test family is every cluster (hidden or not picked), so a q-value doesn't change with the view.
  const inferenceFamily = useMemo(
    () => enrichmentData
      ? computeEnrichmentInference(enrichmentData, enabledRules, allClusterData)
      : [],
    [enrichmentData, enabledRules, allClusterData],
  );
  const inferenceByKey = useMemo(
    () => new Map(inferenceFamily.map(item => [`${item.ruleId}:${item.cluster}`, item])),
    [inferenceFamily],
  );

  // Rules where every cluster sits at 100% (or 0%) say nothing about the
  // clusters: they go in a note, not the chart.
  const { plotted: plottedRules, allMatched, noneMatched } = useMemo(
    () => enrichmentData
      ? splitUniformRules(enrichmentData, enabledRules, allClusterData)
      : { plotted: enabledRules, allMatched: [], noneMatched: [] },
    [enrichmentData, enabledRules, allClusterData],
  );

  const panels = useMemo(
    () => enrichmentData ? computeDifferencePanels(enrichmentData, plottedRules, shownClusters, inferenceByKey) : [],
    [enrichmentData, plottedRules, shownClusters, inferenceByKey],
  );
  const shownInferences = useMemo(() => {
    const shown = new Set(shownClusters.map(item => item.cluster));
    return inferenceFamily.filter(item => shown.has(item.cluster));
  }, [inferenceFamily, shownClusters]);
  // The plotted difference and interval of each row, for the text list (keyboard and screen readers).
  const differenceByKey = useMemo(() => new Map(panels.flatMap(panel =>
    panel.rows.map(row => [`${row.ruleId}:${panel.cluster}`, row] as const))), [panels]);

  const chartWidth = Math.max(220, containerWidth - 16);
  const layout = useMemo(() => differencesLayout(chartWidth, panels), [chartWidth, panels]);
  const chartHeight = layout.height;

  // Exports use dark ink on a light page; the screen follows the app's theme.
  const drawFn = useCallback((ctx: CanvasRenderingContext2D, w: number, h: number) => {
    drawDifferences(ctx, w, h, panels, LIGHT_INK);
  }, [panels]);

  const [hoverTitle, setHoverTitle] = useState('');
  const onCanvasMove = useCallback((event: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const hit = differencesHitTest(event.clientY - rect.top, layout);
    if (!hit) { setHoverTitle(''); return; }
    const row = panels[hit.panel].rows[hit.row];
    const clusterLabel = getClusterLabel(panels[hit.panel].cluster, true);
    setHoverTitle(
      `${row.ruleName} · ${clusterLabel}: ${(row.rate * 100).toFixed(1)}% of its reads `
      + `(${row.matched.toLocaleString()} of ${row.total.toLocaleString()}) vs ${(row.restRate * 100).toFixed(1)}% in the other clusters `
      + `(${row.restMatched.toLocaleString()} of ${row.restTotal.toLocaleString()}). `
      + `Difference ${(row.difference * 100).toFixed(1)} points (95% interval ${(row.low * 100).toFixed(1)} to ${(row.high * 100).toFixed(1)}); `
      + `odds ratio ${row.oddsRatio.toFixed(2)}; q=${formatPValue(row.qValue)}`,
    );
  }, [layout, panels]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || panels.length === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = chartWidth * dpr;
    canvas.height = chartHeight * dpr;
    canvas.style.width = `${chartWidth}px`;
    canvas.style.height = `${chartHeight}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawDifferences(ctx, chartWidth, chartHeight, panels, isDarkTheme() ? DARK_INK : LIGHT_INK);
  }, [panels, chartWidth, chartHeight]);

  if (enrichmentLoading) {
    return (
      <AnalysisStatus kind="loading" center>
        Comparing the clusters...
      </AnalysisStatus>
    );
  }

  if (enrichmentError && !enrichmentData) {
    return (
      <AnalysisStatus kind="error" center>
        {`Differences unavailable: ${enrichmentError}`}
      </AnalysisStatus>
    );
  }

  if (!enrichmentData || clusterData.length === 0) {
    return (
      <AnalysisStatus kind="empty" center>
        No data to compare the clusters.
      </AnalysisStatus>
    );
  }

  const uniformNote = (allMatched.length > 0 || noneMatched.length > 0) && (
    <div className="text-[11px] text-gray-500 dark:text-gray-400" data-testid="enrichment-uniform-note">
      {allMatched.length > 0 && <>In every read of every cluster, not plotted: {allMatched.map(rule => rule.name).join(', ')}. </>}
      {noneMatched.length > 0 && <>In no read of any cluster, not plotted: {noneMatched.map(rule => rule.name).join(', ')}.</>}
    </div>
  );

  if (plottedRules.length === 0) {
    return (
      <div className="space-y-1">
        <AnalysisStatus kind="empty" center>
          No labeling rule tells these clusters apart.
        </AnalysisStatus>
        {uniformNote}
      </div>
    );
  }

  return (
    <div className="space-y-1.5" data-testid="cluster-differences">
      <div>
        <div className="text-[12px] font-semibold text-gray-700 dark:text-gray-200">What sets each cluster apart</div>
        <div className="text-[11px] text-gray-500 dark:text-gray-400">
          For each labeling rule: the share of the cluster's reads with a matching footprint, minus the share
          in all the other clusters. Bars to the right are features more common in the cluster; faded bars are
          not significant (q {'≥'} 0.05). Hover a row for the counts. The reads compared are those loaded for
          the view (a sample when the region has many).
        </div>
      </div>
      <ClusterPickChips clusters={clusterData} picks={picks} testId="differences-picks" />
      <div className="relative group">
        <canvas
          ref={canvasRef}
          className="block"
          title={hoverTitle}
          onMouseMove={onCanvasMove}
          onMouseLeave={() => setHoverTitle('')}
          data-testid="differences-chart"
          role="img"
          aria-label={`What sets each cluster apart: ${panels.length} cluster${panels.length !== 1 ? 's' : ''} compared on ${
            plottedRules.length} labeling rule${plottedRules.length !== 1 ? 's' : ''}. Every value is in the list of tests below.`}
          data-clusters={panels.map(panel => getClusterLabel(panel.cluster, true)).join(',')}
        />
        <ChartSaveButton
          canvasRef={canvasRef}
          filename="cluster_differences"
          drawFn={drawFn}
          width={chartWidth}
          height={chartHeight}
          dataTsv={() => formatEnrichmentTsv(enrichmentData, enabledRules, shownClusters, allClusterData)}
        />
        <ChartMaximizeButton
          title="What sets each cluster apart"
          filename="cluster_differences"
          renderChart={(w, _h) => (
            <EnrichmentTabContent
              enrichmentData={enrichmentData}
              enrichmentLoading={enrichmentLoading}
              enabledRules={enabledRules}
              clusterData={clusterData}
              allClusterData={allClusterData}
              containerWidth={w}
              pickKeys={pickKeys}
            />
          )}
        />
      </div>
      {uniformNote}
      {shownInferences.length > 0 && (
        <details className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
          <summary className="cursor-pointer font-medium">Cluster-vs-rest Fisher tests (BH-corrected), with every plotted difference</summary>
          <div className="mt-1 max-h-36 space-y-0.5 overflow-y-auto font-mono">
            {shownInferences.map(item => {
              const rule = enabledRules.find(candidate => candidate.id === item.ruleId);
              const diff = differenceByKey.get(`${item.ruleId}:${item.cluster}`);
              return (
                <div key={`${item.ruleId}:${item.cluster}`}>
                  {rule?.name ?? item.ruleId} · {getClusterLabel(item.cluster, true)}:{' '}
                  {item.matched}/{item.total} vs rest {item.restMatched}/{item.restTotal};{' '}
                  {diff && <>{'Δ='}{(diff.difference * 100).toFixed(1)} pts (95% {(diff.low * 100).toFixed(1)} to {(diff.high * 100).toFixed(1)});{' '}</>}
                  OR={item.oddsRatio.toFixed(2)}; p={formatPValue(item.pValue)}; q={formatPValue(item.qValue)}
                  {item.qValue < 0.05 ? ' *' : ''}
                </div>
              );
            })}
          </div>
        </details>
      )}
      <div className="mt-1 text-[11px] italic text-ink-secondary">
        Whiskers are 95% intervals (Newcombe); tests are Fisher exact, cluster vs all other clusters, BH-corrected over
        every rule and cluster. Reads are the units: this does not replace biological replicates.
      </div>
    </div>
  );
}
