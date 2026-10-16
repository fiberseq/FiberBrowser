import { useAnalysisLoci } from '../../hooks/useAnalysisLoci';
import { panelReversed } from '../../hooks/usePanelDisplayStore';
import { useLocusGenes } from '../../hooks/useLocusGenes';
import { AnalysisRegionChoice } from './shared/AnalysisRegionChoice';
import { useState, useEffect, useCallback, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../stores/browserStore';
import { useCoaccStore } from '../../stores/coaccStore';
import type { CoaccSignalType } from '../../stores/coaccStore';
import { getCoaccMatrixData, type CoaccMetadata } from '../../api/coaccessibility';
import { downloadTextFile, exportTimestamp, formatTsv, safeFilenamePart } from '../../utils/analysisExport';
import { buildCoaccPythonCommand } from '../../utils/coaccessibilityExport';
import { getLayerLabel } from '../../utils/layerColors';
import { getDatasetDisplayLabel, getDatasetHoverLabel } from '../../utils/datasetLabels';
import {
  AnalysisButton,
  AnalysisExportGroup,
  AnalysisPanelHeader,
  AnalysisPanelShell,
  AnalysisRunSummary,
  AnalysisStatus,
  LayerSelector,
} from './shared';
import type { AnalysisStatusKind } from './shared';
import { useContainerWidth } from '../../hooks/useContainerWidth';
import { CoaccSettingsSection } from './co-accessibility/CoaccSettingsSection';
import { type MatrixRequestState } from './co-accessibility/MatrixCanvas';
import { CoaccMatrixView, coaccMatrixSize } from './co-accessibility/CoaccMatrixView';
import { useCoaccScope } from './co-accessibility/useCoaccScope';

interface Props {
  isFullView?: boolean;
}

const COACCESS_TABS = [
  { key: 'matrix' as const, label: 'Matrix' },
];

function formatBp(bp: number): string {
  if (bp >= 1e6) return `${(bp / 1e6).toFixed(1)}Mb`;
  if (bp >= 1e3) return `${(bp / 1e3).toFixed(1)}kb`;
  return `${bp}bp`;
}

const COACC_SIGNAL_LABELS: Record<CoaccSignalType, string> = {
  accessibility: 'Accessibility',
  nucleosome: 'Nucleosome',
  small_fp: 'Small footprint',
  linker: 'Linker',
  all_fp: 'All footprints',
};

function formatCoaccSignalLabel(signalType: string, layer: string | null): string {
  if (layer) return `${getLayerLabel(layer)} layer`;
  return COACC_SIGNAL_LABELS[signalType as CoaccSignalType] ?? signalType.replace(/_/g, ' ');
}

function coaccExportStatusKind(status: string): AnalysisStatusKind {
  const lower = status.toLowerCase();
  if (lower.includes('failed') || lower.includes('could not') || lower.includes('timed out')) return 'error';
  if (lower.includes('exporting') || lower.includes('refreshing')) return 'loading';
  if (lower.includes('exported') || lower.includes('copied') || lower.includes('refreshed')) return 'success';
  return 'info';
}

export { coaccMatrixSize } from './co-accessibility/CoaccMatrixView';

// ── Main panel ──

export function CoAccessibilityPanel({ isFullView }: Props) {
  const {
    datasets, filteredReadIds,
    analysisSampleSeed, activeColormap, footprintFilterKey, selectedGenes, readFilterSources,
  } = useBrowserStore(useShallow(s => ({
    datasets: s.datasets,
    filteredReadIds: s.filteredReadIds,
    analysisSampleSeed: s.analysisSampleSeed,
    activeColormap: s.activeColormap,
    footprintFilterKey: s.footprintFilterKey,
    selectedGenes: s.selectedGenes,
    readFilterSources: s.readFilterSources,
  })));

  const [showSettings, setShowSettings] = useState(false);
  const [displayMode, setDisplayMode] = useState<'combined' | 'per-dataset'>('combined');
  const [metadata, setMetadata] = useState<CoaccMetadata | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState<string | null>(null);

  const [containerWidth, containerRef] = useContainerWidth(280);
  // The reads the matrix counts: the targeted panels, their cluster focus and read filters (shared with the NFR pairs
  // tab's Position correlation).
  const { targetDatasetIds, targetStateKeys, hasClusterFocus, effectiveReadIds, effectiveReadIdsByDataset, readIdsForDataset } = useCoaccScope();

  const loci = useAnalysisLoci(targetStateKeys);
  const locus = loci.length === 1 ? loci[0] : null;
  const { chrom = '', start = 0, end = 0, genome = null } = locus ?? {};
  const reversed = useBrowserStore(s => panelReversed(s, locus?.panelIds[0] ?? null));
  const genes = useLocusGenes(chrom, start, end, genome);

  // Co-acc track mode toggles
  const {
    coaccTrackMode,
    toggleCoaccTrackMode,
    signalType,
    setSignalType,
    layer,
    setLayer,
    normalization,
    setNormalization,
    scaling,
    setScaling,
    colormap,
    setColormap,
    minCoverage,
    setMinCoverage,
    binSize,
    setBinSize,
  } = useCoaccStore(useShallow(s => ({
    coaccTrackMode: s.coaccTrackMode,
    toggleCoaccTrackMode: s.toggleCoaccTrackMode,
    signalType: s.coaccSignalType,
    setSignalType: s.setCoaccSignalType,
    layer: s.coaccLayer,
    setLayer: s.setCoaccLayer,
    normalization: s.coaccNormalization,
    setNormalization: s.setCoaccNormalization,
    scaling: s.coaccScaling,
    setScaling: s.setCoaccScaling,
    colormap: s.coaccColormap,
    setColormap: s.setCoaccColormap,
    minCoverage: s.coaccMinCoverage,
    setMinCoverage: s.setCoaccMinCoverage,
    binSize: s.coaccBinSize,
    setBinSize: s.setCoaccBinSize,
  })));

  // An empty set is an applied filter (one that matched nothing); no filter is null.
  const hasActiveFilter = hasClusterFocus || targetStateKeys.some(sk => filteredReadIds[sk] != null);
  const hasReadFilter = targetStateKeys.some(sk => filteredReadIds[sk] != null);
  const activeReadFilterSource = useMemo(
    () => targetStateKeys.map(sk => readFilterSources[sk]).find(Boolean) ?? null,
    [readFilterSources, targetStateKeys],
  );

  const regionWidth = end - start;
  const hasDatasets = datasets.length > 0 && !!locus;
  const isWideViewport = regionWidth > 100000;

  // Auto-set display mode when datasets change
  useEffect(() => {
    if (datasets.length > 1) setDisplayMode('per-dataset');
    else setDisplayMode('combined');
  }, [datasets.length]);

  // Per-dataset vs combined
  const showPerDataset = displayMode === 'per-dataset' && targetDatasetIds.length > 1;
  const singleMaxSize = coaccMatrixSize(containerWidth, {
    fullView: isFullView,
    viewportHeight: typeof window !== 'undefined' ? window.innerHeight : Infinity,
  });
  const multiMaxSize = coaccMatrixSize(containerWidth, { fullView: isFullView, perDataset: true });
  const targetDatasetLabel = targetDatasetIds.length === 0
    ? 'No datasets'
    : targetDatasetIds.length === 1
      ? getDatasetDisplayLabel(datasets.find(d => d.id === targetDatasetIds[0]) ?? {
        id: targetDatasetIds[0],
        label: targetDatasetIds[0],
        path: '',
      })
      : `${targetDatasetIds.length} datasets`;

  const signalLabel = signalType === 'accessibility' && !layer ? '' : ` · ${formatCoaccSignalLabel(signalType, layer)}`;
  const settingsSummary = metadata
    ? `${formatBp(metadata.bin_size)} · ${normalization}${signalLabel}`
    : `${normalization}${signalLabel}`;
  const enabledQualityFilterCount = activeColormap.qualityFilters.filter(filter => filter.enabled).length;
  const coaccReadCountLabel = effectiveReadIds !== undefined
    ? `${effectiveReadIds.length.toLocaleString()} scoped reads`
    : 'all eligible reads';
  const filterSource = footprintFilterKey
    ? 'footprint-cooccurrence'
    : activeReadFilterSource
      ? activeReadFilterSource.target
      : hasReadFilter && selectedGenes.length > 0
        ? 'transcription-filters'
      : hasClusterFocus
        ? 'cluster-detail'
        : null;
  const filterSourceLabel = footprintFilterKey
    ? 'Footprints > Co-occupancy'
    : activeReadFilterSource
      ? activeReadFilterSource.label
      : hasReadFilter && selectedGenes.length > 0
        ? 'Transcription > Filters'
      : hasClusterFocus
        ? 'Clusters'
        : 'active read filter';
  const filterLabel = hasClusterFocus && hasReadFilter
    ? 'Cluster + read filter'
    : hasClusterFocus
      ? 'Cluster focus'
      : hasReadFilter
        ? 'Read filter'
        : 'Active read filter';
  const analysisInputs = [
    `${formatBp(regionWidth)} window`,
    targetDatasetLabel,
    formatCoaccSignalLabel(signalType, layer),
    coaccReadCountLabel,
  ];
  const analysisOutputs = metadata
    ? [
        `${metadata.n_reads.toLocaleString()} reads`,
        `${metadata.n_bins.toLocaleString()} bins (${formatBp(metadata.bin_size)})`,
        `${Math.round(metadata.masked_fraction * 100)}% masked`,
      ]
    : [];

  const coaccRequestOptions = useMemo(() => ({
    panelGenome: genome,
    binSize: binSize || undefined,
    datasetIds: targetDatasetIds.length > 0 ? targetDatasetIds : undefined,
    normalization,
    minCoverage,
    readIdsByDataset: effectiveReadIdsByDataset,
    signalType,
    layer,
    sampleSeed: analysisSampleSeed,
  }), [genome, analysisSampleSeed, binSize, effectiveReadIdsByDataset, layer, minCoverage, normalization, signalType, targetDatasetIds]);

  const matrixFilenameBase = useCallback((suffix: string) => [
    'coacc',
    safeFilenamePart(chrom),
    `${start}-${end}`,
    safeFilenamePart(normalization),
    safeFilenamePart(layer ?? signalType),
    suffix,
    exportTimestamp(),
  ].filter(Boolean).join('_'), [chrom, end, layer, normalization, signalType, start]);

  const handleRefresh = useCallback(() => {
    if (!hasDatasets) {
      setExportStatus('Load datasets before refreshing');
      return;
    }
    setMetadata(null);
    setExportStatus('Refreshing matrix...');
    setRefreshKey(k => k + 1);
  }, [hasDatasets]);

  const handleExportJson = useCallback(async () => {
    setExporting(true);
    setExportStatus('Exporting JSON...');
    try {
      const data = await getCoaccMatrixData(chrom, start, end, coaccRequestOptions);
      const payload = {
        kind: 'fiberbrowser.coaccessibility.v1',
        exported_at: new Date().toISOString(),
        settings: {
          chrom, start, end,
          display_mode: displayMode,
          scaling,
          colormap,
          ...coaccRequestOptions,
          read_filter: {
            active: hasActiveFilter,
            source: filterSourceLabel,
            read_count: effectiveReadIds?.length ?? null,
            read_ids: effectiveReadIds ?? null,
          },
        },
        metadata,
        data,
      };
      downloadTextFile(
        JSON.stringify(payload, null, 2),
        `${matrixFilenameBase('matrix')}.json`,
        'application/json',
      );
      setExportStatus('Exported matrix JSON');
    } catch (err) {
      setExportStatus(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setExporting(false);
    }
  }, [chrom, coaccRequestOptions, colormap, displayMode, effectiveReadIds, end, filterSourceLabel, hasActiveFilter, matrixFilenameBase, metadata, scaling, start]);

  const handleExportTsv = useCallback(async () => {
    setExporting(true);
    setExportStatus('Exporting TSV...');
    try {
      const data = await getCoaccMatrixData(chrom, start, end, coaccRequestOptions);
      const labels = Array.from({ length: data.n_bins }, (_, i) => {
        const binStart = data.start + i * data.bin_size;
        return `${data.chrom}:${binStart}-${Math.min(data.end, binStart + data.bin_size)}`;
      });
      const rows: unknown[][] = [
        ['bin', ...labels],
        ...data.matrix.map((row, i) => [labels[i], ...row]),
      ];
      downloadTextFile(
        formatTsv(rows),
        `${matrixFilenameBase('matrix')}.tsv`,
        'text/tab-separated-values',
      );
      setExportStatus('Exported matrix TSV');
    } catch (err) {
      setExportStatus(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setExporting(false);
    }
  }, [chrom, coaccRequestOptions, end, matrixFilenameBase, start]);

  const handleCopyPython = useCallback(async () => {
    const result = buildCoaccPythonCommand({
      chrom,
      start,
      end,
      datasetIds: targetDatasetIds,
      normalization,
      minCoverage,
      binSize,
      signalType,
      layer,
      readIds: effectiveReadIds,
      readIdsByDataset: effectiveReadIdsByDataset,
      sampleSeed: analysisSampleSeed,
    });
    try {
      await navigator.clipboard.writeText(result.command);
      if (!result.exact) {
        setExportStatus(`${result.omittedReadCount.toLocaleString()} scoped read IDs not copied; export JSON for exact scope`);
      } else if (result.includedReadCount > 0) {
        setExportStatus(`Copied exact Python command with ${result.includedReadCount.toLocaleString()} scoped read IDs`);
      } else {
        setExportStatus('Copied Python command');
      }
    } catch {
      setExportStatus('Could not copy Python command');
    }
  }, [analysisSampleSeed, binSize, chrom, effectiveReadIds, effectiveReadIdsByDataset, end, layer, minCoverage, normalization, signalType, start, targetDatasetIds]);
  const handleMetadata = useCallback((meta: CoaccMetadata) => {
    setMetadata(meta);
  }, []);
  const handleMatrixRequestState = useCallback((state: MatrixRequestState) => {
    setExportStatus(prev => {
      if (prev !== 'Refreshing matrix...') return prev;
      if (state.phase === 'success') return 'Matrix refreshed';
      if (state.phase === 'empty') return `Matrix refreshed: ${state.message.toLowerCase()}`;
      return `Matrix refresh failed: ${state.message}`;
    });
  }, []);

  return (
    <div ref={containerRef} className={`flex flex-col text-[11px] ${isFullView ? 'h-full min-h-0' : ''}`}>
      <AnalysisPanelShell
        tabs={COACCESS_TABS}
        activeTab="matrix"
        onTabChange={() => {}}
        theme="teal"
        layout="standard"
        isFullView={isFullView}
        className={isFullView ? 'flex h-full min-h-0 flex-col' : ''}
        bodyMode={isFullView ? 'fill' : 'none'}
        header={
          <div className="space-y-2">
            <AnalysisPanelHeader
              detail="Which positions open together, position by position: every pair of positions in the view is compared across the same molecules, and each square shows how often the two share a state (accessible, nucleosome or footprint; set in Settings)."
              theme="teal"
            />
            <div className="flex flex-wrap items-center gap-1">
              <span className="mr-1 text-[12px] text-gray-700 dark:text-gray-200" title={`${formatBp(regionWidth)} window · ${targetDatasetLabel}`}>
                {formatBp(regionWidth)} window · <span className="font-medium">{targetDatasetLabel}</span>
              </span>
              <AnalysisButton
                data-testid="coacc-refresh-button"
                theme="teal"
                variant="soft"
                onClick={handleRefresh}
                disabled={!hasDatasets}
                title="Recompute the current matrix"
              >
                Refresh
              </AnalysisButton>
              <AnalysisExportGroup>
                <AnalysisButton
                  data-testid="coacc-export-json-button"
                  variant="neutral"
                  onClick={handleExportJson}
                  disabled={!hasDatasets || exporting}
                  title="Export reproducible matrix settings and JSON data"
                >
                  JSON
                </AnalysisButton>
                <AnalysisButton
                  data-testid="coacc-export-tsv-button"
                  variant="neutral"
                  onClick={handleExportTsv}
                  disabled={!hasDatasets || exporting}
                  title="Export matrix values as TSV"
                >
                  TSV
                </AnalysisButton>
                <AnalysisButton
                  data-testid="coacc-copy-python-button"
                  variant="neutral"
                  onClick={handleCopyPython}
                  disabled={!hasDatasets}
                  title="Copy equivalent BrowserClient command"
                >
                  Python
                </AnalysisButton>
              </AnalysisExportGroup>
            </div>
          </div>
        }
        summary={
          <div className="space-y-1.5">
            <AnalysisRunSummary
              seed={analysisSampleSeed}
              filterActive={hasActiveFilter}
              filterLabel={filterLabel}
              filterSource={filterSource}
              filterSourceLabel={filterSourceLabel}
              qualityFilterCount={enabledQualityFilterCount}
              inputs={analysisInputs}
              outputs={analysisOutputs}
            />
            <div data-tour="coacc-layer">
              <LayerSelector
                value={layer}
                onChange={setLayer}
                allLabel="Default"
                title="Layer"
                variant="chips"
              />
            </div>
            {exportStatus && (
              <div data-testid="coacc-status">
                <AnalysisStatus kind={coaccExportStatusKind(exportStatus)} compact>
                  {exportStatus}
                </AnalysisStatus>
              </div>
            )}
          </div>
        }
      >
      <CoaccSettingsSection
        open={showSettings}
        onOpenChange={setShowSettings}
        summary={settingsSummary}
        signalType={signalType}
        setSignalType={setSignalType}
        setLayer={setLayer}
        normalization={normalization}
        setNormalization={setNormalization}
        scaling={scaling}
        setScaling={setScaling}
        colormap={colormap}
        setColormap={setColormap}
        minCoverage={minCoverage}
        setMinCoverage={setMinCoverage}
        binSize={binSize}
        setBinSize={setBinSize}
        targetDatasetCount={targetDatasetIds.length}
        displayMode={displayMode}
        setDisplayMode={setDisplayMode}
        coaccTrackMode={coaccTrackMode}
        toggleCoaccTrackMode={toggleCoaccTrackMode}
        metadata={metadata}
      />

      {/* ── Matrix display (always visible) ── */}
      {loci.length > 1 && <AnalysisRegionChoice loci={loci} what="Co-accessibility" />}
      {!datasets.length && (
        <AnalysisStatus kind="empty" center>
          Load datasets to compute co-accessibility.
        </AnalysisStatus>
      )}
      {hasDatasets && isWideViewport && (
        <AnalysisStatus kind="warning" compact>
          Co-accessibility is limited to approximately read length (~15kb).
        </AnalysisStatus>
      )}

      {hasDatasets && (
        <CoaccMatrixView
          chrom={chrom} start={start} end={end} genome={genome} reversed={reversed} datasets={datasets} datasetIds={targetDatasetIds} perDataset={showPerDataset}
          settings={{ normalization, scaling, colormap, minCoverage, binSize, signalType, layer }}
          readIds={effectiveReadIdsByDataset ? undefined : effectiveReadIds} readIdsByDataset={effectiveReadIdsByDataset}
          readIdsForDataset={readIdsForDataset} singleMaxSize={singleMaxSize} multiMaxSize={multiMaxSize} genes={genes}
          refreshKey={refreshKey} metadata={metadata} onMetadata={handleMetadata} onRequestState={handleMatrixRequestState}
        />
      )}
      </AnalysisPanelShell>
    </div>
  );
}
