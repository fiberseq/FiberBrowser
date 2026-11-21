import { useMemo } from 'react';
import type { FirePeak, PeakRule } from '../../types';
import { useBrowserStore } from '../../stores/browserStore';
import { generateLayerColors } from '../../utils/peakColors';
import { isBamBacked } from '../../utils/datasetKinds';
import { graphPeakSpans, graphPeakTitle, GRAPH_PEAK_ROW_HEIGHT, GRAPH_PEAK_SELECTED_COLOR } from './peakTrack';
import type { Scene } from './scene';

interface Props {
  scene: Scene;
  offset: number;
  chrom: string;
  rules: PeakRule[];
  peaks: FirePeak[];
  /** Member-scoped peaks stay on that member's bound paths, including folded members. */
  pathsByMember: Map<string, string[]>;
  /** Paths whose band reserves a peak row (those drawing reads). */
  paths: Set<string>;
}

/** One compact peak row above each path's reads. Buttons share the linear track's store actions and indices;
 * no graph-local copy of either peaks or selection is kept. */
export function GraphPeakTrack({ scene, offset, chrom, rules, peaks, pathsByMember, paths }: Props) {
  const selected = useBrowserStore(s => s.selectedPeaks);
  const datasets = useBrowserStore(s => s.datasets);
  const hasFootprints = datasets.some(d => d.available_layers?.footprint || d.layer_type === 'footprint'
    || (isBamBacked(d) && !d.available_layers));
  const colors = useMemo(() => rules.map(r => generateLayerColors(r.color, r.opacity, r.useGradient)), [rules]);
  const rows = useMemo(() => !rules.length ? [] : scene.rows.filter(row => paths.has(row.key)).map(row => {
    const lanes = rules.map((rule, i) => ({
      rule,
      peaks: peaks.filter(p => p.ruleId === rule.id
        && (!p.memberPanelId || pathsByMember.get(p.memberPanelId)?.includes(row.key)))
        .flatMap(peak => graphPeakSpans(scene, peak, row.key).map((span, j) => ({ peak, span, j }))),
      colors: colors[i],
    })).filter(lane => lane.peaks.length);
    // Compare rendered extents, including the minimum button width, across rules.
    const spans = lanes.flatMap(lane => lane.peaks.map(({ span }) => ({
      ruleId: lane.rule.id, x0: span.x0, x1: span.x0 + Math.max(3, span.x1 - span.x0),
    }))).sort((a, b) => a.x0 - b.x0);
    let rightmost: typeof spans[number] | undefined;
    const overlap = spans.some(span => {
      if (rightmost && span.ruleId !== rightmost.ruleId && span.x0 < rightmost.x1) return true;
      if (!rightmost || span.x1 > rightmost.x1) rightmost = span;
      return false;
    });
    return { path: row.key, top: row.bandTop, lanes, laneHeight: GRAPH_PEAK_ROW_HEIGHT / (overlap ? lanes.length : 1) };
  }), [scene, rules, peaks, pathsByMember, colors, paths]);
  return <div data-testid="graph-peak-track" className="pointer-events-none absolute inset-0">
    {rows.map(row => <div key={row.path} data-testid="graph-peak-row" data-path={row.path}
      className="absolute left-0 w-full" style={{ top: row.top, height: GRAPH_PEAK_ROW_HEIGHT }}>
      <span className="pointer-events-auto absolute left-1 truncate text-[9px] text-gray-500 dark:text-gray-400"
        style={{ width: scene.dataLeft - 8, lineHeight: `${GRAPH_PEAK_ROW_HEIGHT}px` }}
        title={row.lanes.length ? `Peaks · ${row.lanes.map(lane => lane.rule.name).join(', ')}` : 'Peaks'}>Peaks</span>
      <div className="absolute overflow-hidden bg-gray-50 dark:bg-gray-900/30"
        style={{ left: scene.dataLeft, width: scene.dataWidth, height: GRAPH_PEAK_ROW_HEIGHT }}>
        {row.lanes.flatMap((lane, i) => lane.peaks.map(({ peak, span, j }) => {
          const on = peak.featureIndex !== undefined || selected.has(peak.index);
          const color = lane.colors[Math.max(0, Math.min(peak.layer ?? 0, lane.colors.length - 1))];
          const title = graphPeakTitle(peak, chrom, lane.rule.name);
          const padding = Math.min(2, row.laneHeight / 4);
          return <button key={`${lane.rule.id}:${peak.index}:${j}`} type="button" data-testid="graph-peak" data-peak-index={peak.index}
            data-rule-id={lane.rule.id}
            data-path={row.path} data-tier={(peak.layer ?? 0) + 1} aria-label={title} title={title} aria-pressed={on}
            className="pointer-events-auto absolute cursor-pointer rounded-sm p-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-orange-500"
            style={{ left: span.x0 + offset - scene.dataLeft, top: (row.laneHeight < GRAPH_PEAK_ROW_HEIGHT ? i * row.laneHeight : 0) + padding,
              width: Math.max(3, span.x1 - span.x0), height: row.laneHeight - 2 * padding,
              background: color.fill, border: `${on ? 2 : 1}px solid ${on ? GRAPH_PEAK_SELECTED_COLOR : color.stroke}` }}
            onPointerDown={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()}
            onClick={e => {
              e.stopPropagation();
              const s = useBrowserStore.getState();
              if (peak.featureIndex !== undefined) s.selectFeature(s.selectedFeatures[peak.featureIndex], true);
              else if (peak.match && !peak.match.correspondenceId) s.selectMatchedGroup(peak.match.groupId, e.shiftKey || e.metaKey || e.ctrlKey);
              else s.togglePeakSelection(peak.index, hasFootprints ? 'accessibility' : 'modification');
            }} />;
        }))}
      </div>
    </div>)}
  </div>;
}
