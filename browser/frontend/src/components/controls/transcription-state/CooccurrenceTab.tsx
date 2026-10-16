import { useMemo } from 'react';
import { HeatmapChart } from '../../charts/HeatmapChart';
import { getDatasetDisplayLabel } from '../../../utils/datasetLabels';
import { AnalysisStatus } from '../shared';
import {
  benjaminiHochberg,
  fisherExactTwoSided,
  formatPValue,
  oddsRatio2x2,
} from '../../../utils/statistics';
import { formatTsv } from '../../../utils/analysisExport';

interface DatasetDisplay {
  id: string;
  label: string;
  color: string;
}

const STATE_LABELS = ['Pause', 'PIC', 'Elong.'];

interface PairwiseStateStatistic {
  datasetId: string;
  stateI: number;
  stateJ: number;
  oddsRatio: number;
  pValue: number;
  qValue: number;
}

export function formatTranscriptionCooccurrenceTsv(
  datasetId: string,
  data: { matrix: number[][]; rawMatrix: number[][]; totalReads: number },
  pairwiseStats: PairwiseStateStatistic[],
): string {
  const rows: unknown[][] = [[
    'record_type', 'dataset_id', 'total_reads', 'state_i', 'state_j',
    'color_value', 'raw_count', 'both', 'i_only', 'j_only', 'neither',
    'odds_ratio', 'p_value', 'q_value',
  ]];
  for (let i = 0; i < data.matrix.length; i++) {
    for (let j = 0; j < (data.matrix[i]?.length ?? 0); j++) {
      rows.push([
        'cell', datasetId, data.totalReads, STATE_LABELS[i], STATE_LABELS[j],
        data.matrix[i][j], data.rawMatrix[i]?.[j], '', '', '', '', '', '', '',
      ]);
    }
  }
  for (const statistic of pairwiseStats.filter(item => item.datasetId === datasetId)) {
    const both = data.rawMatrix[statistic.stateI]?.[statistic.stateJ] ?? 0;
    const iOnly = Math.max(0, (data.rawMatrix[statistic.stateI]?.[statistic.stateI] ?? 0) - both);
    const jOnly = Math.max(0, (data.rawMatrix[statistic.stateJ]?.[statistic.stateJ] ?? 0) - both);
    const neither = Math.max(0, data.totalReads - both - iOnly - jOnly);
    rows.push([
      'test', datasetId, data.totalReads,
      STATE_LABELS[statistic.stateI], STATE_LABELS[statistic.stateJ], '', '',
      both, iOnly, jOnly, neither, statistic.oddsRatio, statistic.pValue, statistic.qValue,
    ]);
  }
  return formatTsv(rows);
}

/**
 * One state matrix per dataset with reads, side by side while each stays at
 * least 200 px wide (they wrap otherwise), near-square cells, and never
 * wider than the panel.
 */
export function cooccurrenceMatrixSize(chartWidth: number, count: number, fullView: boolean): { width: number; height: number } {
  const gap = 12;
  const perRow = Math.max(1, Math.min(count, Math.floor((chartWidth + gap) / (200 + gap))));
  const width = Math.max(160, Math.min(fullView ? 420 : 340, Math.floor((chartWidth - gap * (perRow - 1)) / perRow)));
  // Labels take ~45 px on the left and ~40 px on the right: cells near square.
  const height = Math.round(Math.max(160, width - 60));
  return { width, height };
}

export function CooccurrenceTab({
  cooccurrenceByDataset,
  targetDatasets,
  chartWidth,
  isFullView,
}: {
  cooccurrenceByDataset: Record<string, { matrix: number[][]; rawMatrix: number[][]; totalReads: number }>;
  targetDatasets: DatasetDisplay[];
  chartWidth: number;
  isFullView?: boolean;
}) {
  const pairwiseStats = useMemo(() => {
    const raw: Array<{
      datasetId: string;
      stateI: number;
      stateJ: number;
      oddsRatio: number;
      pValue: number;
    }> = [];
    for (const [datasetId, data] of Object.entries(cooccurrenceByDataset)) {
      // A dataset with no reads here has nothing to test.
      if (!(data.totalReads > 0)) continue;
      for (let i = 0; i < STATE_LABELS.length; i++) {
        for (let j = i + 1; j < STATE_LABELS.length; j++) {
          const both = data.rawMatrix[i]?.[j] ?? 0;
          const iOnly = Math.max(0, (data.rawMatrix[i]?.[i] ?? 0) - both);
          const jOnly = Math.max(0, (data.rawMatrix[j]?.[j] ?? 0) - both);
          const neither = Math.max(0, data.totalReads - both - iOnly - jOnly);
          raw.push({
            datasetId,
            stateI: i,
            stateJ: j,
            oddsRatio: oddsRatio2x2(both, iOnly, jOnly, neither),
            pValue: fisherExactTwoSided(both, iOnly, jOnly, neither),
          });
        }
      }
    }
    const qValues = benjaminiHochberg(raw.map(item => item.pValue));
    return raw.map((item, index) => ({ ...item, qValue: qValues[index] }));
  }, [cooccurrenceByDataset]);

  if (Object.keys(cooccurrenceByDataset).length === 0) {
    return (
      <AnalysisStatus kind="empty" center>
        Apply a filter first to see co-occurrence data.
      </AnalysisStatus>
    );
  }

  // Datasets with no reads for these genes get one line, not an empty matrix.
  const shown = targetDatasets.filter(ds => (cooccurrenceByDataset[ds.id]?.totalReads ?? 0) > 0);
  const empty = targetDatasets.filter(ds => cooccurrenceByDataset[ds.id] && !(cooccurrenceByDataset[ds.id].totalReads > 0));
  const size = cooccurrenceMatrixSize(chartWidth, shown.length, !!isFullView);

  return (
    <div className="space-y-3">
      {empty.length > 0 && (
        <div className="text-[11px] text-ink-muted break-words" data-testid="tx-cooccur-empty">
          No reads in these genes: {empty.map(ds => getDatasetDisplayLabel(ds)).join(', ')}.
        </div>
      )}
      <div className="flex flex-wrap gap-3 justify-center">
        {shown.map(ds => {
          const coData = cooccurrenceByDataset[ds.id];
          if (!coData) return null;
          return (
            <div key={ds.id} className="min-w-0">
              {shown.length > 1 && (
                <div className="text-[11px] flex items-center gap-1 mb-0.5">
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: ds.color }} />
                  <span className="truncate text-gray-600 dark:text-gray-300" style={{ maxWidth: size.width - 12 }} title={getDatasetDisplayLabel(ds)}>{getDatasetDisplayLabel(ds)}</span>
                </div>
              )}
              <HeatmapChart
                matrix={coData.matrix}
                valueMatrix={coData.rawMatrix}
                colormap="red-blue"
                rowLabels={STATE_LABELS}
                colLabels={STATE_LABELS}
                showValues={true}
                width={size.width}
                height={size.height}
                filename={`transcription_cooccurrence_${ds.id}`}
                dataTsv={() => formatTranscriptionCooccurrenceTsv(ds.id, coData, pairwiseStats)}
              />
              <details className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
                <summary className="cursor-pointer font-medium">Pairwise Fisher tests (BH-corrected)</summary>
                <div className="mt-0.5 space-y-0.5 font-mono">
                  {pairwiseStats.filter(item => item.datasetId === ds.id).map(item => (
                    <div key={`${item.stateI}:${item.stateJ}`}>
                      {STATE_LABELS[item.stateI]} × {STATE_LABELS[item.stateJ]}: OR={item.oddsRatio.toFixed(2)}; p={formatPValue(item.pValue)}; q={formatPValue(item.qValue)}
                      {item.qValue < 0.05 ? ' *' : ''}
                    </div>
                  ))}
                </div>
              </details>
            </div>
          );
        })}
      </div>
      <div className="text-[11px] italic text-ink-secondary">
        Cells show raw co-occurring read counts; color is normalized within dataset. Fisher tests and BH correction treat reads as units, not biological replicates.
      </div>
    </div>
  );
}
