import { useState, useEffect, useMemo, useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore, getTargetDatasetIds } from '../../stores/browserStore';
import { fetchPol2COM, type Pol2COMResult } from '../../api/transcription';
import { getDatasetDisplayLabel, getDatasetHoverLabel } from '../../utils/datasetLabels';
import { HeatmapChart } from './HeatmapChart';
import { formatTsv } from '../../utils/analysisExport';

interface Pol2COMViewProps {
  width: number;
  height: number;
  isFullView?: boolean;
}

function formatBp(bp: number): string {
  if (bp >= 1_000_000) return `${(bp / 1_000_000).toFixed(1)} Mb`;
  if (bp >= 1_000) return `${(bp / 1_000).toFixed(1)} kb`;
  return `${bp} bp`;
}

function formatPol2MatrixTsv(
  result: Pol2COMResult,
  matrix: number[][],
  datasetId: string,
  matrixKind: 'pol2_occupancy' | 'accessibility_smoothed',
): string {
  const rows: unknown[][] = [[
    'matrix_kind', 'dataset_id', 'row_index', 'read_id', 'center_of_mass',
    'bin_index', 'value', 'n_bins', 'gene_body_size', 'viewport_size',
  ]];
  matrix.forEach((row, rowIndex) => {
    row.forEach((value, binIndex) => {
      rows.push([
        matrixKind, datasetId, rowIndex, result.read_ids[rowIndex], result.com_values[rowIndex],
        binIndex, value, result.n_bins, result.gene_body_size, result.viewport_size,
      ]);
    });
  });
  return formatTsv(rows);
}

export function Pol2COMView({ width, height, isFullView }: Pol2COMViewProps) {
  const {
    chrom, start, end,
    selectedGenes,
    datasets,
    selectedDatasets,
    panels,
    spanningOnly,
    analysisSampleSeed,
  } = useBrowserStore(useShallow(s => ({
    chrom: s.chrom, start: s.start, end: s.end,
    selectedGenes: s.selectedGenes,
    datasets: s.datasets,
    selectedDatasets: s.selectedDatasets,
    panels: s.panels,
    spanningOnly: s.spanningOnly,
    analysisSampleSeed: s.analysisSampleSeed,
  })));

  const [results, setResults] = useState<Record<string, Pol2COMResult> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [smoothSigma, setSmoothSigma] = useState(3);

  const targetDatasetIds = useMemo(() =>
    getTargetDatasetIds(selectedDatasets, panels, datasets),
    [selectedDatasets, panels, datasets]
  );

  const targetDatasets = useMemo(() =>
    targetDatasetIds.map(id => datasets.find(d => d.id === id)).filter(Boolean) as typeof datasets,
    [datasets, targetDatasetIds]
  );

  const geneIds = useMemo(() => selectedGenes.map(g => g.id), [selectedGenes]);

  const doFetch = useCallback(() => {
    if (geneIds.length === 0 || targetDatasetIds.length === 0) {
      setResults(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchPol2COM(chrom, start, end, spanningOnly, targetDatasetIds, geneIds,
      undefined, undefined, undefined, smoothSigma, analysisSampleSeed)
      .then(res => {
        if (!cancelled) setResults(res.results);
      })
      .catch(err => {
        if (!cancelled) setError(err.message || 'Failed to fetch Pol II COM data');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [chrom, start, end, spanningOnly, targetDatasetIds, geneIds, smoothSigma, analysisSampleSeed]);

  useEffect(() => {
    return doFetch();
  }, [doFetch]);

  if (geneIds.length === 0) {
    return (
      <div className="flex items-center justify-center text-ink-secondary text-xs p-4" style={{ height }}>
        Select a gene to view Pol II center-of-mass heatmaps.
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center text-amber-600 text-xs p-4" style={{ height }}>
        Computing Pol II center-of-mass...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center text-red-500 text-xs p-4" style={{ height }}>
        {error}
      </div>
    );
  }

  if (!results || Object.keys(results).length === 0) {
    return (
      <div className="flex items-center justify-center text-ink-secondary text-xs p-4" style={{ height }}>
        No Pol II COM data available.
      </div>
    );
  }

  const heatmapW = Math.max(150, width - 16);
  const emptyDatasets = targetDatasets.filter(ds => !results[ds.id] || results[ds.id].n_reads === 0);
  const heatmapH = isFullView ? 350 : 220;

  return (
    <div className="space-y-3 p-1">
      {/* Y-axis smoothing control */}
      <div className="flex items-center gap-2 text-[11px] text-gray-500">
        <label className="flex-shrink-0">Y smooth:</label>
        <input
          type="range"
          min={0}
          max={20}
          step={1}
          value={smoothSigma}
          onChange={e => setSmoothSigma(Number(e.target.value))}
          className="flex-1 h-1 accent-amber-500"
        />
        <span className="w-8 text-right tabular-nums">{smoothSigma === 0 ? 'off' : `${smoothSigma}r`}</span>
      </div>
      {/* Datasets without Pol II footprints here: one plain note, not a chart each. */}
      {emptyDatasets.length > 0 && (
        <div className="text-[11px] text-ink-muted break-words" data-testid="pol2com-empty">
          No reads with Pol II footprints in these genes: {emptyDatasets.map((ds, i) => (
            <span key={ds.id} title={getDatasetHoverLabel(ds)}>{i > 0 ? ', ' : ''}{getDatasetDisplayLabel(ds)}</span>
          ))}.
        </div>
      )}
      {targetDatasets.map(ds => {
        const r = results[ds.id];
        if (!r || r.n_reads === 0) return null;
        const vpLabel = r.viewport_size ? formatBp(r.viewport_size) : formatBp(end - start);
        return (
          <div key={ds.id} className="space-y-1">
            <div className="text-[11px] flex min-w-0 items-center gap-1 font-semibold text-gray-600 dark:text-gray-300">
              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: ds.color }} />
              <span className="truncate" title={getDatasetHoverLabel(ds)}>{getDatasetDisplayLabel(ds)}</span>
              <span className="shrink-0 text-[11px] font-normal text-ink-secondary">({r.n_reads.toLocaleString()} reads)</span>
            </div>
            <HeatmapChart
              matrix={r.binary_matrix}
              colormap="grayscale"
              width={heatmapW}
              height={heatmapH}
              title={`Pol II occupancy \u2014 gene body (${formatBp(r.gene_body_size)})`}
              colorbarLabel="Occupied"
              filename={`pol2_occupancy_${ds.id}`}
              dataTsv={() => formatPol2MatrixTsv(r, r.binary_matrix, ds.id, 'pol2_occupancy')}
            />
            <HeatmapChart
              matrix={r.smoothed_matrix}
              colormap="viridis"
              width={heatmapW}
              height={heatmapH}
              title={`Accessibility (>100 bp) \u2014 viewport (${vpLabel})`}
              colorbarLabel="Accessible"
              filename={`pol2_accessibility_${ds.id}`}
              dataTsv={() => formatPol2MatrixTsv(r, r.smoothed_matrix, ds.id, 'accessibility_smoothed')}
            />
          </div>
        );
      })}
    </div>
  );
}
