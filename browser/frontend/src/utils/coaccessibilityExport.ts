import { toPythonLiteral } from './analysisExport';

export const COACC_PYTHON_READ_ID_INLINE_LIMIT = 10000;

export interface CoaccPythonCommandOptions {
  chrom: string;
  start: number;
  end: number;
  datasetIds: string[];
  normalization: string;
  minCoverage: number;
  binSize: number;
  signalType: string;
  layer: string | null;
  readIds?: string[];
  readIdsByDataset?: Record<string, string[]>;
  sampleSeed: string;
  inlineReadIdLimit?: number;
}

export interface CoaccPythonCommandResult {
  command: string;
  includedReadCount: number;
  omittedReadCount: number;
  exact: boolean;
}

export function buildCoaccPythonCommand({
  chrom,
  start,
  end,
  datasetIds,
  normalization,
  minCoverage,
  binSize,
  signalType,
  layer,
  readIds,
  readIdsByDataset,
  sampleSeed,
  inlineReadIdLimit = COACC_PYTHON_READ_ID_INLINE_LIMIT,
}: CoaccPythonCommandOptions): CoaccPythonCommandResult {
  const scopedReadCount = readIdsByDataset
    ? Object.values(readIdsByDataset).reduce((sum, ids) => sum + ids.length, 0)
    : 0;
  const hasDatasetScope = readIdsByDataset ? Object.keys(readIdsByDataset).length > 0 : false;
  const flatReadCount = readIds?.length ?? 0;
  const activeReadCount = scopedReadCount || flatReadCount;
  const canInlineReadIds = activeReadCount <= inlineReadIdLimit;
  const readIdsForCommand = canInlineReadIds && !hasDatasetScope ? (readIds ?? null) : null;
  const readIdsByDatasetForCommand = canInlineReadIds && hasDatasetScope ? (readIdsByDataset ?? null) : null;
  const omittedReadCount = canInlineReadIds ? 0 : activeReadCount;
  const command = [
    'client.get_coacc_matrix_data(',
    `chrom=${toPythonLiteral(chrom)}, `,
    `start=${start}, `,
    `end=${end}, `,
    `dataset_ids=${toPythonLiteral(datasetIds)}, `,
    `normalization=${toPythonLiteral(normalization)}, `,
    `min_coverage=${minCoverage}, `,
    `bin_size=${binSize || 0}, `,
    `signal_type=${toPythonLiteral(signalType)}, `,
    `layer=${toPythonLiteral(layer)}, `,
    `read_ids=${toPythonLiteral(readIdsForCommand)}, `,
    `read_ids_by_dataset=${toPythonLiteral(readIdsByDatasetForCommand)}, `,
    `sample_seed=${toPythonLiteral(sampleSeed)}`,
    ')',
  ].join('');

  if (omittedReadCount === 0) {
    return {
      command,
      includedReadCount: activeReadCount,
      omittedReadCount: 0,
      exact: true,
    };
  }

  return {
    command: [
      `# ${omittedReadCount.toLocaleString()} scoped read IDs were too large to inline.`,
      '# Use the panel JSON export for an exact, reloadable read scope.',
      command,
    ].join('\n'),
    includedReadCount: 0,
    omittedReadCount,
    exact: false,
  };
}
