import { useCallback, useMemo, useState, type ReactNode } from 'react';
import type { ProjectionMethod, ProjectionResponse } from '../../../api/clustering';
import { getClusterColor, getClusterLabel } from '../../tracks/ReadTrack';
import { ScatterChart } from '../../charts/ScatterChart';
import type { DissolveArrow, PointClickModifiers } from '../../charts/ScatterChart';
import { getDatasetDisplayLabel, getDatasetHoverLabel } from '../../../utils/datasetLabels';
import { MERGE_STRATEGIES, describeMergeSettings, mergeStrategyInfo, type MergeStrategy } from '../../../utils/mergeStrategies';
import {
  AnalysisButton,
  AnalysisSettingsSection,
  AnalysisStatus,
  AnalysisToggleGroup,
} from '../shared';
import { Download, Sliders } from '../../ui/Icons';
import { MergeToggleChip } from './MergeToggleChip';
import { focusSummary, mapSize } from './projectionMapModel';

/** Plain-language help for each projection method (button titles and the help section). */
export const PROJECTION_METHOD_HELP: Record<ProjectionMethod, string> = {
  tsne: 't-SNE (default): reads with similar footprints at the clustered peaks sit next to each other. '
    + 'Trust who is next to whom; the distance between groups, the size of a group and the empty space '
    + 'between groups are not meaningful. The same reads and seed always give the same map.',
  umap: 'UMAP: like t-SNE it keeps neighbours together, and keeps somewhat more of the large-scale layout. '
    + 'Needs the umap-learn package (falls back to PCA without it).',
  pca: 'PCA: a straight-line view along the two directions in which reads differ most. Distances are '
    + 'faithful, but groups that differ in many small ways can overlap.',
};

export type ProjectionView = 'before' | 'after' | 'side-by-side';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
const MOD = isMac ? '⌘' : 'Ctrl';

export interface ProjectionMapProps {
  projectionData: ProjectionResponse | null;
  projectionLoading: boolean;
  projectionError: string | null;
  /** Why the projection shows only some of the clustered panels, if it does. */
  projectionNote?: string | null;
  projectionMethod: ProjectionMethod;
  setProjectionMethod: (m: ProjectionMethod) => void;
  projectionView: ProjectionView;
  setProjectionView: (v: ProjectionView) => void;
  projectionHighlightDs: Set<string> | null;
  setProjectionHighlightDs: (s: Set<string> | null) => void;
  /** Merge similar clusters' settings (shared with every Merge button). */
  merge: { minFraction: number; strategy: MergeStrategy; threshold: number };
  onMergeSettings: (patch: { minFraction?: number; strategy?: MergeStrategy; threshold?: number }) => void;
  showMergeSettings: boolean;
  setShowMergeSettings: (open: boolean) => void;
  /** The width the map has. */
  width: number;
  /** The tallest the map may be. */
  maxHeight?: number;
  datasets: Array<{ id: string; label?: string; color?: string }>;
  onApplyAutocull: () => Promise<void> | void;
  culling: boolean;
  /** Download the per-read table of the shown map. */
  onExport?: () => Promise<void> | void;
  /** The current clusters (legend), in the panel's order. */
  clusters: Array<{ cluster: number; color: string; totalCount: number }>;
  /** The cluster focus (null: all shown) and the selected clusters, as everywhere else. */
  focus: Set<number> | null;
  selected: Set<number>;
  onFocusCluster: (cluster: number, additive: boolean) => void;
  onClearFocus: () => void;
  /** Outline one read in every panel (the read menu's Highlight read). */
  onShowRead: (readId: string) => void;
}

/**
 * The read map (fb-n5-projection): t-SNE (default) / UMAP / PCA of the
 * clustered reads, with the Merge similar clusters preview (before / after /
 * side by side). Clicking a dot or a legend entry focuses its cluster — the
 * same focus the read panel and charts follow; ⇧ adds clusters; Escape or
 * a click on the only focused cluster clears it. ⌘-click (or Show read)
 * outlines that read in every panel. Uses the joint projection from
 * /api/cluster_projection so points from different datasets share axes.
 */
export function ProjectionMap({
  projectionData,
  projectionLoading,
  projectionError,
  projectionNote = null,
  projectionMethod,
  setProjectionMethod,
  projectionView,
  setProjectionView,
  projectionHighlightDs,
  setProjectionHighlightDs,
  merge,
  onMergeSettings,
  showMergeSettings,
  setShowMergeSettings,
  width,
  maxHeight = 680,
  datasets,
  onApplyAutocull,
  culling,
  onExport,
  clusters,
  focus,
  selected,
  onFocusCluster,
  onClearFocus,
  onShowRead,
}: ProjectionMapProps) {
  const clusterColors = useMemo(() => {
    const out: Record<number, string> = {};
    if (!projectionData) return out;
    const all = new Set<number>(projectionData.labels_before);
    for (const c of projectionData.labels_after ?? []) all.add(c);
    for (const c of all) out[c] = getClusterColor(c);
    return out;
  }, [projectionData]);

  const dissolvedClusterIds = useMemo(() => new Set(projectionData?.dissolved.map(d => d.cluster) ?? []), [projectionData]);

  const dissolveArrows = useMemo<DissolveArrow[]>(() => {
    if (!projectionData || !projectionData.cluster_centroids_after) return [];
    const before = projectionData.cluster_centroids_before;
    const after = projectionData.cluster_centroids_after;
    const arrows: DissolveArrow[] = [];
    for (const d of projectionData.dissolved) {
      const from = before[String(d.cluster)];
      const target = d.dominant_target;
      if (!from || target == null) continue;
      const to = after[String(target)];
      if (!to) continue;
      arrows.push({ from: [from[0], from[1]], to: [to[0], to[1]], fromCluster: d.cluster, toCluster: target, count: d.count });
    }
    return arrows;
  }, [projectionData]);

  const toCentroids = (src: Record<string, [number, number]> | null | undefined) => {
    if (!src) return undefined;
    const out: Record<number, [number, number]> = {};
    for (const [k, v] of Object.entries(src)) out[parseInt(k, 10)] = v;
    return out;
  };
  const centroidsBefore = useMemo(() => toCentroids(projectionData?.cluster_centroids_before), [projectionData]);
  const centroidsAfter = useMemo(() => toCentroids(projectionData?.cluster_centroids_after), [projectionData]);

  const axisLabel = (axis: 0 | 1) => {
    if (projectionData?.method === 'pca' && projectionData.variance_explained) {
      return `PC${axis + 1} (${(projectionData.variance_explained[axis] * 100).toFixed(1)}%)`;
    }
    if (projectionData?.method === 'umap') return `UMAP ${axis + 1}`;
    if (projectionData?.method === 'tsne') return `t-SNE ${axis + 1}`;
    return `Dim ${axis + 1}`;
  };

  const toggleDsHighlight = useCallback((dsId: string) => {
    const next = new Set(projectionHighlightDs ?? []);
    if (next.has(dsId)) next.delete(dsId);
    else next.add(dsId);
    setProjectionHighlightDs(next.size === 0 ? null : next);
  }, [projectionHighlightDs, setProjectionHighlightDs]);

  const [showHelp, setShowHelp] = useState(false);
  const [exporting, setExporting] = useState(false);
  // The last dot clicked, by dataset and read (a new map may order its reads otherwise):
  // its read can be shown in the panels from here (keyboard too).
  const [picked, setPicked] = useState<{ datasetId: string; readId: string } | null>(null);
  const handleExport = useCallback(async () => {
    if (!onExport || exporting) return;
    setExporting(true);
    try { await onExport(); } finally { setExporting(false); }
  }, [exporting, onExport]);

  const datasetLabel = useCallback((id: string) => {
    const ds = datasets.find(d => d.id === id);
    return ds ? getDatasetDisplayLabel(ds) : id;
  }, [datasets]);

  const params = projectionData?.projection_params ?? null;
  const placedCount = projectionData?.embedded ? projectionData.embedded.filter(v => !v).length : 0;
  const sideBySide = projectionView === 'side-by-side';
  const size = mapSize(width, sideBySide, maxHeight);
  const hasAfter = !!projectionData?.labels_after;
  const pickedRead = useMemo(() => {
    if (!projectionData || !picked) return null;
    for (let i = 0; i < projectionData.read_ids.length; i++) {
      if (projectionData.read_ids[i] === picked.readId && projectionData.dataset_ids[i] === picked.datasetId) return i;
    }
    return null;  // not on this map
  }, [picked, projectionData]);

  const handlePointClick = useCallback((index: number, mods: PointClickModifiers) => {
    if (!projectionData) return;
    setPicked({ datasetId: projectionData.dataset_ids[index], readId: projectionData.read_ids[index] });
    if (mods.metaKey) {
      onShowRead(projectionData.read_ids[index]);
      return;
    }
    // Focus is about the clusters the reads are in now (also on an after-merge preview).
    onFocusCluster(projectionData.labels_before[index], mods.shiftKey);
  }, [onFocusCluster, onShowRead, projectionData]);

  const renderTooltip = useCallback((index: number): ReactNode => {
    if (!projectionData) return null;
    const now = projectionData.labels_before[index];
    const after = projectionData.labels_after?.[index];
    const strand = projectionData.strands?.[index];
    const orientation = projectionData.alignment_strands?.[index];
    return (
      <>
        <div className="font-mono text-[11px] break-all text-gray-900 dark:text-gray-100">{projectionData.read_ids[index]}</div>
        <div className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: getClusterColor(now) }} />
          {getClusterLabel(now, true)}
          {after != null && after !== now && <span className="text-gray-500 dark:text-gray-400">→ {getClusterLabel(after, true)} after merge</span>}
        </div>
        <div className="text-gray-500 dark:text-gray-400">
          {datasetLabel(projectionData.dataset_ids[index])}
          {strand ? ` · ${strand} strand` : ''}
          {orientation ? ` · aligned ${orientation}` : ''}
        </div>
        <div className="mt-0.5 text-[10px] text-gray-400">Click: focus {getClusterLabel(now, true)} · ⇧ adds · {MOD}-click: show this read</div>
      </>
    );
  }, [datasetLabel, projectionData]);

  const mapProps = projectionData ? {
    coordsX: projectionData.coords_x,
    coordsY: projectionData.coords_y,
    pointIds: projectionData.read_ids,
    datasetIds: projectionData.dataset_ids,
    clusterColors,
    highlightedClusters: focus,
    highlightLabels: projectionData.labels_before,
    selectedClusters: selected,
    highlightedDatasetIds: projectionHighlightDs,
    xLabel: axisLabel(0),
    yLabel: axisLabel(1),
    onPointClick: handlePointClick,
    renderTooltip,
    ariaLabel: `Read map (${projectionData.method}): ${projectionData.n_reads} reads coloured by cluster. Use the cluster buttons below to focus a cluster.`,
  } : null;

  const info = mergeStrategyInfo(merge.strategy);
  const thresholdShown = info.percent ? Math.round(merge.threshold * 1000) / 10 : merge.threshold;
  const focusText = focusSummary(focus, c => getClusterLabel(c, true));

  return (
    <div className="space-y-1.5" data-testid="projection-map" data-tour="clusters-projection-map">
      {/* One compact row of controls; the merge settings fold out under it. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]" data-tour="clusters-projection-controls">
        <AnalysisToggleGroup
          value={projectionMethod}
          onChange={value => { if (value) setProjectionMethod(value); }}
          theme="cyan"
          options={[
            { value: 'tsne', label: 't-SNE', title: PROJECTION_METHOD_HELP.tsne },
            { value: 'umap', label: 'UMAP', title: PROJECTION_METHOD_HELP.umap },
            { value: 'pca', label: 'PCA', title: PROJECTION_METHOD_HELP.pca },
          ]}
        />
        <AnalysisToggleGroup
          value={projectionView}
          onChange={value => { if (value) setProjectionView(value); }}
          theme="cyan"
          options={[
            { value: 'before', label: 'Clusters now', title: 'The current clusters' },
            { value: 'after', label: 'After merge', title: 'Preview Merge similar clusters with the settings below' },
            { value: 'side-by-side', label: 'Side by side', title: 'The clusters now and after Merge similar clusters, side by side' },
          ]}
        />
        {projectionLoading && <span className="text-cyan-600 dark:text-cyan-400">Projecting…</span>}
        <MergeToggleChip />
        <span className="ml-auto inline-flex flex-wrap items-center gap-1">
          <AnalysisButton
            theme="cyan"
            variant={showMergeSettings ? 'soft' : 'outline'}
            onClick={() => setShowMergeSettings(!showMergeSettings)}
            aria-expanded={showMergeSettings}
            data-testid="merge-settings-toggle"
            className="inline-flex items-center gap-1"
            title={`Merge similar clusters: ${describeMergeSettings(merge)}`}
          >
            <Sliders size={12} aria-hidden="true" /> Merge settings
          </AnalysisButton>
          <AnalysisButton
            onClick={handleExport}
            theme="cyan"
            variant="outline"
            className="inline-flex items-center gap-1"
            title="Download one row per read: read name, dataset, strand, cluster and map x/y, with the map's parameters and seed in the header"
            data-testid="projection-export"
            disabled={!onExport || exporting || !projectionData || projectionData.n_reads === 0}
          >
            <Download size={12} aria-hidden="true" /> {exporting ? 'Exporting…' : 'Export table'}
          </AnalysisButton>
        </span>
      </div>

      {showMergeSettings && (
        <div className="rounded border border-cyan-100 bg-cyan-50/40 p-1.5 text-[11px] text-gray-600 dark:border-cyan-900/40 dark:bg-cyan-950/10 dark:text-gray-300" data-testid="merge-settings">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <label className="inline-flex items-center gap-1" title={info.help}>
              <span className="text-gray-500 dark:text-gray-400">Merge by</span>
              <select
                value={merge.strategy}
                onChange={e => onMergeSettings({ strategy: e.target.value as MergeStrategy })}
                className="input-tool min-h-0 rounded px-1.5 py-0.5 text-[11px]"
                data-testid="merge-strategy"
              >
                {MERGE_STRATEGIES.map(s => <option key={s.value} value={s.value} title={s.help}>{s.label}</option>)}
              </select>
            </label>
            <label className="inline-flex items-center gap-1" title={info.help}>
              <span className="text-gray-500 dark:text-gray-400">{info.thresholdLabel}</span>
              <input
                type="number"
                min={info.percent ? info.min * 100 : info.min}
                max={info.percent ? info.max * 100 : info.max}
                step={info.percent ? 1 : info.step}
                value={thresholdShown}
                onChange={e => {
                  const v = parseFloat(e.target.value);
                  if (Number.isFinite(v)) onMergeSettings({ threshold: info.percent ? v / 100 : v });
                }}
                className="input-tool min-h-0 w-16 py-0.5 text-[11px]"
                data-testid="merge-similarity"
                aria-label={info.thresholdLabel}
              />
              <span className="text-gray-400">{info.thresholdHint}</span>
            </label>
            <label className="inline-flex items-center gap-1" title="Clusters with fewer than this share of the reads are merged into their neighbours first">
              <span className="text-gray-500 dark:text-gray-400">Smallest cluster</span>
              <input
                type="number" min={0} max={50} step={1}
                value={Math.round(merge.minFraction * 1000) / 10}
                onChange={e => {
                  const v = parseFloat(e.target.value);
                  if (Number.isFinite(v)) onMergeSettings({ minFraction: v / 100 });
                }}
                className="input-tool min-h-0 w-14 py-0.5 text-[11px]"
                data-testid="merge-min-percent"
                aria-label="Smallest cluster, % of reads"
              />
              <span className="text-gray-400">% of reads</span>
            </label>
          </div>
          <div className="mt-1 text-gray-500 dark:text-gray-400">
            {info.help} Clusters under the smallest size go first; each merged cluster&rsquo;s reads go to the nearest remaining
            cluster. The same settings apply to every Merge similar clusters button; After merge previews them here.
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {projectionView === 'before' && (
              <AnalysisButton theme="cyan" variant="soft" onClick={() => setProjectionView('side-by-side')}>
                Preview on the map
              </AnalysisButton>
            )}
            {projectionView !== 'before' && projectionData && projectionData.dissolved.length === 0 && (
              <span data-testid="merge-preview">Nothing would merge with these settings.</span>
            )}
            {projectionView !== 'before' && projectionData && projectionData.dissolved.length > 0 && (
              <AnalysisButton
                onClick={onApplyAutocull}
                disabled={culling}
                variant="warning"
                title="Merge as previewed (Unmerge switches back)"
                data-testid="merge-apply"
              >
                {culling ? 'Merging…' : `Merge ${projectionData.dissolved.length} now`}
              </AnalysisButton>
            )}
          </div>
        </div>
      )}

      {datasets.length > 1 && (
        <div className="flex flex-wrap items-center gap-1 text-[11px]">
          <span className="mr-1 text-gray-500 dark:text-gray-400">Datasets</span>
          <AnalysisButton onClick={() => setProjectionHighlightDs(null)} variant={projectionHighlightDs === null ? 'neutral' : 'outline'}>
            All
          </AnalysisButton>
          {datasets.map(ds => {
            const isOn = projectionHighlightDs?.has(ds.id) ?? false;
            return (
              <AnalysisButton
                key={ds.id}
                onClick={() => toggleDsHighlight(ds.id)}
                theme="cyan"
                variant={isOn ? 'soft' : 'outline'}
                aria-pressed={isOn}
                className={`flex items-center gap-1 ${isOn ? '' : 'opacity-60'}`}
              >
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: ds.color || '#9ca3af' }} />
                <span className="max-w-[80px] truncate" title={getDatasetHoverLabel(ds)}>{getDatasetDisplayLabel(ds)}</span>
              </AnalysisButton>
            );
          })}
        </div>
      )}

      {projectionNote && <AnalysisStatus kind="info" compact>{projectionNote}</AnalysisStatus>}
      {projectionError && <AnalysisStatus kind="error" compact>{projectionError}</AnalysisStatus>}
      {projectionData?.skipped_datasets && projectionData.skipped_datasets.length > 0 && (
        <AnalysisStatus kind="warning" compact>
          Not shown: {projectionData.skipped_datasets.join(', ')} (clustered at different peaks; select it on its own to see its projection).
        </AnalysisStatus>
      )}
      {!projectionData && !projectionLoading && !projectionError && (
        <AnalysisStatus kind="empty" center>No map yet. Run clustering first.</AnalysisStatus>
      )}
      {!projectionData && projectionLoading && (
        <div className="flex items-center justify-center rounded border border-dashed border-gray-200 text-[11px] text-gray-400 dark:border-white/10" style={{ height: Math.min(320, size.height) }}>
          Drawing the read map…
        </div>
      )}

      {projectionData && mapProps && projectionData.n_reads > 0 && (
        <>
          {sideBySide ? (
            <div className="flex gap-2">
              <ScatterChart {...mapProps} labels={projectionData.labels_before} centroids={centroidsBefore}
                width={size.width} height={size.height} title="Clusters now" filename="projection_before" />
              {hasAfter ? (
                <ScatterChart {...mapProps} labels={projectionData.labels_after!} centroids={centroidsAfter}
                  dimClusterIds={dissolvedClusterIds} dissolveArrows={dissolveArrows}
                  width={size.width} height={size.height} title="After merge" filename="projection_after" />
              ) : (
                <AnalysisStatus kind="empty" center className="flex-1">No merge preview</AnalysisStatus>
              )}
            </div>
          ) : (
            <ScatterChart
              {...mapProps}
              labels={projectionView === 'after' && hasAfter ? projectionData.labels_after! : projectionData.labels_before}
              centroids={projectionView === 'after' ? centroidsAfter : centroidsBefore}
              dimClusterIds={projectionView === 'after' ? dissolvedClusterIds : undefined}
              dissolveArrows={projectionView === 'after' ? dissolveArrows : undefined}
              width={size.width}
              height={size.height}
              title={projectionView === 'after' ? 'After merge' : undefined}
              filename={`projection_${projectionView}`}
            />
          )}

          {/* The legend: the keyboard way to focus clusters (same as clicking dots). */}
          <div className="flex flex-wrap items-center gap-1 text-[11px]" role="group" aria-label="Focus clusters on the map" data-testid="projection-legend">
            {clusters.map(({ cluster, color, totalCount }) => {
              const focused = !focus || focus.has(cluster);
              const isSelected = selected.has(cluster);
              return (
                <button
                  key={cluster}
                  type="button"
                  aria-pressed={!!focus && focus.has(cluster)}
                  data-testid={`projection-legend-${cluster}`}
                  onClick={e => onFocusCluster(cluster, e.shiftKey)}
                  title={`${getClusterLabel(cluster, false)}: ${totalCount.toLocaleString()} reads. Click to focus it, ⇧-click to add it to the focus.`}
                  className={`inline-flex items-center gap-1 rounded-fb border px-1.5 py-[1px] transition-opacity focus-visible:outline-none focus-visible:shadow-focus ${
                    focus?.has(cluster)
                      ? 'border-gray-800 bg-white text-gray-900 dark:border-gray-200 dark:bg-gray-900 dark:text-gray-100'
                      : 'border-gray-200 text-gray-600 hover:border-gray-400 dark:border-white/10 dark:text-gray-300'
                  } ${focused ? '' : 'opacity-50'} ${isSelected ? 'ring-2 ring-blue-500' : ''}`}
                >
                  <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: color }} />
                  {getClusterLabel(cluster, true)}
                  <span className="text-gray-400">{totalCount}</span>
                </button>
              );
            })}
            {focusText ? (
              <span className="ml-1 inline-flex items-center gap-1 text-gray-600 dark:text-gray-300" data-testid="projection-focus-status">
                {focusText}
                <AnalysisButton variant="outline" onClick={onClearFocus} title="Show every cluster again (Esc)">Show all</AnalysisButton>
              </span>
            ) : (
              <span className="ml-1 text-gray-400">Click a dot or a cluster to focus it · ⇧ adds · {MOD}-click shows the read</span>
            )}
          </div>

          {pickedRead !== null && (
            <div className="flex flex-wrap items-center gap-1.5 rounded border border-gray-200 px-1.5 py-1 text-[11px] text-gray-600 dark:border-white/10 dark:text-gray-300" data-testid="projection-picked-read">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: getClusterColor(projectionData.labels_before[pickedRead]) }} />
              <span className="font-mono break-all">{projectionData.read_ids[pickedRead]}</span>
              <span className="text-gray-400">{getClusterLabel(projectionData.labels_before[pickedRead], true)} · {datasetLabel(projectionData.dataset_ids[pickedRead])}</span>
              <AnalysisButton
                theme="cyan"
                variant="soft"
                className="ml-auto"
                onClick={() => onShowRead(projectionData.read_ids[pickedRead])}
                data-testid="projection-show-read"
                title="Outline this read in every panel (as the read menu's Highlight read)"
              >
                Show read
              </AnalysisButton>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 border-t pt-1 text-[11px] text-gray-500 dark:border-white/10 dark:text-gray-400">
            <span data-testid="projection-summary">
              {projectionData.n_reads} reads · {projectionData.feature_dim} features ·{' '}
              {projectionData.method === 'tsne' ? 't-SNE' : projectionData.method.toUpperCase()}
              {params?.perplexity != null && ` · perplexity ${params.perplexity}`}
              {params?.random_state != null && ` · seed ${params.random_state}`}
            </span>
            {placedCount > 0 && (
              <span
                className="text-amber-600 dark:text-amber-400"
                title={`t-SNE embedded a seeded sample of ${params?.n_embedded ?? '?'} reads; each other read is drawn at the average position of its 10 most similar embedded reads (Export marks them embedded=False).`}
              >
                {placedCount} read{placedCount === 1 ? '' : 's'} placed by nearest neighbours (over the {params?.max_reads ?? ''}-read cap)
              </span>
            )}
            {projectionView !== 'before' && projectionData.dissolved.length > 0 && (
              <span className="text-orange-600 dark:text-orange-400" data-testid="merge-preview">
                Would merge {projectionData.dissolved.length} cluster{projectionData.dissolved.length === 1 ? '' : 's'}
              </span>
            )}
            {projectionMethod !== projectionData.method && (
              <span className="text-amber-600 dark:text-amber-400">
                ({projectionMethod.toUpperCase()} unavailable, fell back to {projectionData.method.toUpperCase()})
              </span>
            )}
          </div>

          {projectionView !== 'before' && projectionData.dissolved.length > 0 && (
            <div className="space-y-0.5 pt-1">
              {projectionData.dissolved.map((d, i) => (
                <div key={i} className="flex items-center gap-1.5 text-[11px] text-gray-600 dark:text-gray-400">
                  <span className="inline-block h-2 w-2 rounded-full" style={{ background: clusterColors[d.cluster] || '#9ca3af' }} />
                  <span className="font-mono">{getClusterLabel(d.cluster, true)}</span>
                  <span className="text-gray-400">→</span>
                  <span className="inline-block h-2 w-2 rounded-full" style={{ background: d.dominant_target != null ? (clusterColors[d.dominant_target] || '#9ca3af') : '#9ca3af' }} />
                  <span className="font-mono">{d.dominant_target != null ? getClusterLabel(d.dominant_target, true) : '—'}</span>
                  <span className="text-gray-400">·</span>
                  <span>{d.count} reads</span>
                  <span className="text-gray-400">·</span>
                  <span className="italic">{d.reason.replace(/\(cos=/, '(similarity ')}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <AnalysisSettingsSection
        open={showHelp}
        onOpenChange={setShowHelp}
        theme="cyan"
        title="Reading the map"
        summary={projectionMethod === 'tsne' ? 'neighbours matter, distances don’t' : undefined}
      >
        <div className="space-y-1.5 text-[11px] text-gray-600 dark:text-gray-400" data-testid="projection-help">
          <p>Each dot is a read, placed by its footprint pattern at the peaks the clusters were built on; colours are the current clusters.</p>
          <p>{PROJECTION_METHOD_HELP[projectionMethod]}</p>
          <p>
            Click a dot (or a cluster below the map) to focus its cluster: the read panel and the charts show only it.
            ⇧-click adds clusters; click the focused cluster again, or press Esc, to show all. {MOD}-click a dot, or Show read,
            outlines that read in every panel.
          </p>
          <p>
            After merge previews Merge similar clusters with the Merge settings; after merging, Unmerge switches back to
            the clusters before it (and Merge again forward), without recomputing.
          </p>
          <p>
            <span className="font-medium">Sort &rsaquo; By projection (t-SNE)</span> orders the reads in the read panel along this map, so
            reads that are neighbours here sit next to each other there.
          </p>
          <p>
            <span className="font-medium">Cluster &rsaquo; Neighbourhoods (t-SNE graph)</span> groups reads by the same neighbour graph t-SNE
            draws this map from, and picks the number of groups itself (resolution: higher gives more, smaller groups).
            Prefer it to k-means when the map shows the groups you care about: k-means on the picture would be misled
            by the distances and sizes t-SNE distorts.
          </p>
          <p>
            Export writes one row per read (name, dataset, strand, cluster, map x/y) with the seed, perplexity and
            feature digest in the header, so the same map can be rebuilt.
          </p>
        </div>
      </AnalysisSettingsSection>
    </div>
  );
}
