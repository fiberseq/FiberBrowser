import type { ClusterVPlotData, VPlotMode } from '../../../api/clustering';
import { VPlotChart } from '../../charts/VPlotChart';
import {
  AnalysisSettingsSection,
  AnalysisStatus,
  AnalysisToggleGroup,
  VPlotControls,
} from '../shared';
import type { ClusterSummary } from './OverviewTabContent';
import { getClusterLabel } from '../../tracks/ReadTrack';
import { pickedClusterData, useClusterPicks } from './clusterPicks';
import { ClusterPickChips } from './ClusterPickChips';

/** What a V-plot of this mode shows, in a sentence. */
export function vplotModeCaption(mode: VPlotMode, rowNormalize: boolean): string {
  const what = mode === 'span'
    ? 'Full footprint: each footprint fills every position it covers, in the row of its size'
    : 'Midpoint: each footprint counted once, at its centre, in the row of its size';
  const colour = rowNormalize
    ? 'colour = how enriched that size is at each position over its average across the window (sizes with under 20 footprints left blank)'
    : 'colour = footprint count';
  return `${what}; ${colour}.`;
}

interface VPlotTabContentProps {
  vplotData: Record<string, Record<number, ClusterVPlotData>> | null;
  vplotError?: string | null;
  vplotLoading: boolean;
  showVplotSettings: boolean;
  setShowVplotSettings: (open: boolean) => void;
  vplotSettingsSummary: string;
  vplotSizeBin: number;
  setVplotSizeBin: (value: number) => void;
  vplotPosBin: number;
  setVplotPosBin: (value: number) => void;
  vplotSizeMin: number;
  setVplotSizeMin: (value: number) => void;
  vplotSizeMax: number;
  setVplotSizeMax: (value: number) => void;
  vplotLog: boolean;
  setVplotLog: (value: boolean) => void;
  vplotSmooth: number;
  setVplotSmooth: (value: number) => void;
  vplotNormalize: 'per_cluster' | 'shared';
  setVplotNormalize: (value: 'per_cluster' | 'shared') => void;
  vplotLayer: string | null;
  setVplotLayer: (value: string | null) => void;
  /** Midpoint (traditional) or full footprint. */
  vplotMode?: VPlotMode;
  setVplotMode?: (value: VPlotMode) => void;
  vplotRowNormalize?: boolean;
  setVplotRowNormalize?: (value: boolean) => void;
  /** The panel state keys a cluster pick applies to (default: datasetIds). */
  pickKeys?: string[];
  start: number;
  end: number;
  datasetIds: string[];
  multiDs: boolean;
  visibleClusterData: ClusterSummary[];
  chartWidth: number;
  isFullView?: boolean;
  getDatasetLabel: (stateKey: string) => string | undefined;
  getDatasetColor: (stateKey: string) => string | undefined;
}

export function VPlotTabContent({
  vplotData,
  vplotError = null,
  vplotLoading,
  showVplotSettings,
  setShowVplotSettings,
  vplotSettingsSummary,
  vplotSizeBin,
  setVplotSizeBin,
  vplotPosBin,
  setVplotPosBin,
  vplotSizeMin,
  setVplotSizeMin,
  vplotSizeMax,
  setVplotSizeMax,
  vplotLog,
  setVplotLog,
  vplotSmooth,
  setVplotSmooth,
  vplotNormalize,
  setVplotNormalize,
  vplotLayer,
  setVplotLayer,
  vplotMode = 'midpoint',
  setVplotMode,
  vplotRowNormalize = false,
  setVplotRowNormalize,
  pickKeys,
  start,
  end,
  datasetIds,
  multiDs,
  visibleClusterData,
  chartWidth,
  isFullView,
  getDatasetLabel,
  getDatasetColor,
}: VPlotTabContentProps) {
  const picks = useClusterPicks(pickKeys ?? datasetIds);
  const shownClusterData = pickedClusterData(visibleClusterData, picks.picked);
  const regionMid = Math.round((start + end) / 2);
  const xLabels: [string, string, string] = [
    start.toLocaleString(),
    regionMid.toLocaleString(),
    end.toLocaleString(),
  ];

  return (
    <div className="space-y-2" data-testid="cluster-vplot" data-vplot-mode={vplotMode}>
      {setVplotMode && (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-gray-600 dark:text-gray-300">
          <span>Plot each footprint by its</span>
          <AnalysisToggleGroup<VPlotMode>
            value={vplotMode}
            onChange={value => value && setVplotMode(value)}
            theme="cyan"
            options={[
              { value: 'midpoint', label: 'Midpoint', title: 'Traditional V-plot: each footprint counted once, at its centre' },
              { value: 'span', label: 'Full footprint', title: 'Each footprint adds to every position it covers, in the row of its size' },
            ]}
          />
        </div>
      )}
      <AnalysisSettingsSection
        open={showVplotSettings}
        onOpenChange={setShowVplotSettings}
        theme="cyan"
        title="V-plot settings"
        summary={vplotSettingsSummary}
        tourId="clusters-vplot-settings"
      >
        <VPlotControls
          sizeBin={vplotSizeBin}
          onSizeBinChange={setVplotSizeBin}
          posBin={vplotPosBin}
          onPosBinChange={setVplotPosBin}
          sizeMin={vplotSizeMin}
          onSizeMinChange={setVplotSizeMin}
          sizeMax={vplotSizeMax}
          onSizeMaxChange={setVplotSizeMax}
          log={vplotLog}
          onLogChange={setVplotLog}
          smooth={vplotSmooth}
          onSmoothChange={setVplotSmooth}
          normalize={vplotNormalize}
          onNormalizeChange={setVplotNormalize}
          layer={vplotLayer}
          onLayerChange={setVplotLayer}
          rowNormalize={setVplotRowNormalize ? vplotRowNormalize : undefined}
          onRowNormalizeChange={setVplotRowNormalize}
        />
      </AnalysisSettingsSection>
      {vplotLoading && (
        <AnalysisStatus kind="loading" compact>
          Loading V-plots...
        </AnalysisStatus>
      )}
      <ClusterPickChips clusters={visibleClusterData} picks={picks} testId="vplot-picks" />
      {vplotData && datasetIds.map(sk => {
        // Keyed by panel: panels sharing a dataset each have their own clusters.
        const dsVplots = vplotData[sk];
        if (!dsVplots || 'error' in dsVplots) return null;
        return (
          <div key={sk} className="space-y-2">
            {multiDs && (
              <div className="text-[11px] flex items-center gap-1">
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: getDatasetColor(sk) }} />
                <span className="text-gray-600 dark:text-gray-300">{getDatasetLabel(sk)}</span>
              </div>
            )}
            {shownClusterData.map(cd => {
              const vp = dsVplots[cd.cluster];
              if (!vp?.matrix?.length) return null;
              return (
                <div key={cd.cluster} className="flex items-start gap-1">
                  <div className="flex items-center gap-1 pt-1 shrink-0 w-10">
                    <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: cd.color }} />
                    <span className="text-[11px] font-semibold text-gray-600 dark:text-gray-300">
                      {getClusterLabel(cd.cluster, true)}
                    </span>
                  </div>
                  <VPlotChart
                    matrix={vp.matrix}
                    sizeMin={vp.size_min}
                    sizeMax={vp.size_max}
                    windowBp={0}
                    sizeBin={vp.size_bin}
                    posBin={vp.pos_bin}
                    width={Math.max(180, chartWidth - 44)}
                    height={isFullView ? 180 : 120}
                    xLabels={xLabels}
                    filename={`vplot_${vplotMode === 'span' ? 'fullfp' : 'midpoint'}_c${cd.cluster}`}
                    bandLabels={isFullView}
                    centerCaption="x = genomic position within viewport"
                    exportNotes={{
                      vplot_mode: vplotMode === 'span' ? 'full_footprint' : 'midpoint',
                      value: vplotRowNormalize
                        ? 'size-row enrichment (row / row mean across the window; rows from <20 footprints = 0), then scaled to the plot maximum'
                        : 'footprint count, scaled to the plot maximum',
                      log1p: vplotLog,
                      smooth_sigma_bins: vplotSmooth,
                      scale: vplotNormalize,
                    }}
                  />
                </div>
              );
            })}
          </div>
        );
      })}
      {!vplotLoading && vplotError && (
        <AnalysisStatus kind="error" compact>
          {vplotError}
        </AnalysisStatus>
      )}
      {!vplotLoading && !vplotData && !vplotError && (
        <AnalysisStatus kind="empty" center>
          No V-plot data available.
        </AnalysisStatus>
      )}
      <div className="text-[11px] text-ink-secondary text-center" data-testid="vplot-caption">
        {vplotModeCaption(vplotMode, vplotRowNormalize)}
      </div>
    </div>
  );
}
