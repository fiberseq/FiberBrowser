import type { FootprintAnalysisResult } from '../api/footprints';
import type { FootprintGroup } from '../types';
import type { Dataset } from '../types/dataset';
import { formatTsv } from './analysisExport';

type CooccurrenceRow = Array<string | number>;

const HEADER: CooccurrenceRow = [
  'scope',
  'dataset_id',
  'dataset_label',
  'total_reads',
  'group_i',
  'group_i_name',
  'group_j',
  'group_j_name',
  'cell',
  'n_reads',
  'odds_ratio',
  'p_value',
  'q_value',
  'read_ids',
];

function joinReadIds(ids?: string[]): string {
  return (ids ?? []).join(',');
}

export function buildFootprintCooccurrenceRows(
  result: FootprintAnalysisResult | null,
  footprintGroups: FootprintGroup[],
  datasets: Dataset[],
): CooccurrenceRow[] {
  if (!result?.co_occupancy) return [HEADER];
  const enabledGroups = footprintGroups.filter(group => group.enabled);
  const rows: CooccurrenceRow[] = [HEADER];

  for (const dataset of datasets) {
    const coOcc = result.co_occupancy[dataset.id];
    if (!coOcc) continue;

    for (let gi = 0; gi < (coOcc.per_group ?? []).length; gi++) {
      const group = enabledGroups[gi];
      if (!group) continue;
      const summary = coOcc.per_group?.[gi];
      if (!summary) continue;
      rows.push([
        'single',
        dataset.id,
        dataset.label,
        coOcc.total_reads,
        gi,
        group.name,
        '',
        '',
        'with',
        summary.n_with,
        '',
        '',
        '',
        joinReadIds(summary.ids_with),
      ]);
      rows.push([
        'single',
        dataset.id,
        dataset.label,
        coOcc.total_reads,
        gi,
        group.name,
        '',
        '',
        'without',
        summary.n_without,
        '',
        '',
        '',
        joinReadIds(summary.ids_without),
      ]);
    }

    for (const pair of coOcc.pairs ?? []) {
      const groupI = enabledGroups[pair.group_i];
      const groupJ = enabledGroups[pair.group_j];
      if (!groupI || !groupJ) continue;
      const cells = [
        ['both', pair.n_both, pair.ids_both],
        ['i_only', pair.n_i_only, pair.ids_i_only],
        ['j_only', pair.n_j_only, pair.ids_j_only],
        ['neither', pair.n_neither, pair.ids_neither],
      ] as const;
      for (const [cell, nReads, ids] of cells) {
        rows.push([
          'pair',
          dataset.id,
          dataset.label,
          coOcc.total_reads,
          pair.group_i,
          groupI.name,
          pair.group_j,
          groupJ.name,
          cell,
          nReads,
          pair.odds_ratio == null || Number.isNaN(pair.odds_ratio) ? 'NA' : Number.isFinite(pair.odds_ratio) ? pair.odds_ratio : 'inf',
          pair.p_value ?? 'NA',
          pair.q_value ?? '',
          joinReadIds(ids),
        ]);
      }
    }
  }

  return rows;
}

export function formatFootprintCooccurrenceTsv(
  result: FootprintAnalysisResult | null,
  footprintGroups: FootprintGroup[],
  datasets: Dataset[],
): string {
  return formatTsv(buildFootprintCooccurrenceRows(result, footprintGroups, datasets));
}
