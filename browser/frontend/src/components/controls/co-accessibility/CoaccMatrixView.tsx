import type { CoaccMetadata } from '../../../api/coaccessibility';
import type { Dataset, Gene } from '../../../types';
import { getDatasetDisplayLabel, getDatasetHoverLabel } from '../../../utils/datasetLabels';
import { MatrixCanvas, type MatrixRequestState } from './MatrixCanvas';

export interface CoaccMatrixSettings {
  normalization: string; scaling: string; colormap: string; minCoverage: number; binSize: number;
  signalType: string; layer: string | null;
}

/**
 * The matrix is square and takes the panel's width (it was capped at 400 px,
 * a small square in a wide panel), up to a size that still fits the screen
 * height with the panel's header above it. One matrix per dataset is smaller.
 */
export function coaccMatrixSize(
  containerWidth: number,
  { fullView = false, perDataset = false, viewportHeight = Infinity }: { fullView?: boolean; perDataset?: boolean; viewportHeight?: number } = {},
): number {
  const cap = perDataset ? (fullView ? 640 : 480) : (fullView ? 1000 : 760);
  // A single matrix also fits the window's height below the toolbar and the
  // panel's header, so it is seen whole without scrolling.
  const heightCap = perDataset ? Infinity : Math.max(320, viewportHeight - 340);
  return Math.max(160, Math.min(Math.max(containerWidth - 8, 0), cap, heightCap));
}

function formatBp(bp: number): string {
  if (bp >= 1e6) return `${(bp / 1e6).toFixed(1)}Mb`;
  if (bp >= 1e3) return `${(bp / 1e3).toFixed(1)}kb`;
  return `${bp}bp`;
}

/**
 * The position x position matrix of the view (Co-accessibility; the NFR pairs tab's Position correlation): one matrix
 * of the datasets combined, or one per dataset, each with its read scope. The server draws them (MatrixCanvas).
 */
export function CoaccMatrixView({
  chrom, start, end, genome, reversed, datasets, datasetIds, perDataset, settings, readIds, readIdsByDataset, readIdsForDataset,
  singleMaxSize, multiMaxSize, genes, refreshKey = 0, metadata, onMetadata, onRequestState,
}: {
  genome?: string | null; reversed?: boolean;
  chrom: string; start: number; end: number; datasets: Dataset[]; datasetIds: string[]; perDataset: boolean;
  settings: CoaccMatrixSettings;
  readIds?: string[]; readIdsByDataset?: Record<string, string[]>;
  /** One dataset's read scope (undefined: all its reads). */
  readIdsForDataset: (datasetId: string) => string[] | undefined;
  singleMaxSize: number; multiMaxSize: number; genes: Gene[]; refreshKey?: number;
  metadata?: CoaccMetadata | null;
  onMetadata?: (meta: CoaccMetadata) => void;
  onRequestState?: (state: MatrixRequestState) => void;
}) {
  const common = {
    chrom, start, end, genome, reversed, normalization: settings.normalization, scaling: settings.scaling, colormap: settings.colormap,
    minCoverage: settings.minCoverage, binSize: settings.binSize, signalType: settings.signalType, layer: settings.layer, genes, refreshKey,
  };
  if (!perDataset) {
    return (
      <div className="flex flex-col items-center gap-1">
        <MatrixCanvas {...common} datasetIds={datasetIds} readIds={readIds} readIdsByDataset={readIdsByDataset}
          maxSize={singleMaxSize} onMetadata={onMetadata} onRequestState={onRequestState} />
        {metadata && (
          <div data-testid="coacc-metadata" className="text-[11px] text-gray-500 flex flex-wrap gap-x-3 gap-y-0.5 px-1">
            <span>{metadata.n_reads} reads</span>
            <span>{formatBp(metadata.bin_size)} bins</span>
            <span>cov {metadata.coverage_median}x</span>
            <span>{Math.round(metadata.masked_fraction * 100)}% masked</span>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {datasetIds.map(dsId => {
        const ds = datasets.find(d => d.id === dsId);
        if (!ds) return null;
        const dsReadIds = readIdsForDataset(dsId);
        return (
          <div key={dsId} className="flex flex-col gap-0.5">
            <div className="text-[11px] flex items-center gap-1 px-0.5">
              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: ds.color }} />
              <span className="truncate text-gray-600 dark:text-gray-300" title={getDatasetHoverLabel(ds)}>
                {getDatasetDisplayLabel(ds)}
              </span>
            </div>
            <MatrixCanvas {...common} datasetIds={[dsId]}
              readIdsByDataset={dsReadIds !== undefined ? { [dsId]: dsReadIds } : undefined}
              maxSize={multiMaxSize}
              onMetadata={dsId === datasetIds[0] ? onMetadata : undefined}
              onRequestState={dsId === datasetIds[0] ? onRequestState : undefined} />
          </div>
        );
      })}
    </div>
  );
}
