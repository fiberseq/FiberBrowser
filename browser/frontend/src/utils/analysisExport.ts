import { wilsonInterval } from './statistics';

export function exportTimestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
}

export function safeFilenamePart(value: unknown): string {
  return String(value ?? 'unknown')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9_.-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || 'unknown';
}

export function downloadTextFile(content: string, filename: string, mimeType = 'text/plain') {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function formatTsvCell(value: unknown): string {
  if (value == null) return '';
  const original = String(value);
  // Labels and identifiers can originate in user-provided BED/GTF metadata.
  // Neutralize spreadsheet formula prefixes while leaving genuine numeric
  // values (including negative numbers) machine-readable. A strand on its own
  // ("+" or "-") is no formula: written as is, so R and pandas read the column.
  const text = typeof value === 'string' && /^[\t\r\n ]*[=+\-@]/.test(original) && !/^[+-]$/.test(original)
    ? `'${original}`
    : original;
  if (!/[\t\n\r"]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

export function formatTsv(rows: unknown[][]): string {
  return rows.map(row => row.map(formatTsvCell).join('\t')).join('\n') + '\n';
}

export interface ExportHistogramGroup {
  label: string;
  bars: Array<{
    label: string;
    value: number;
    color?: string;
    ciLow?: number;
    ciHigh?: number;
    n?: number;
  }>;
}

export function formatHistogramChartTsv(groups: ExportHistogramGroup[]): string {
  const rows: unknown[][] = [['group', 'series', 'value', 'ci_low', 'ci_high', 'n', 'color']];
  for (const group of groups) {
    for (const bar of group.bars) {
      rows.push([
        group.label,
        bar.label,
        bar.value,
        bar.ciLow,
        bar.ciHigh,
        bar.n,
        bar.color,
      ]);
    }
  }
  return formatTsv(rows);
}

export interface ExportProfileSeries {
  label: string;
  data: number[];
  color?: string;
  ciLow?: number[];
  ciHigh?: number[];
  n?: number;
}

export function formatProfileChartTsv(
  series: ExportProfileSeries[],
  options: { windowBp?: number; isReversed?: boolean } = {},
): string {
  const rows: unknown[][] = [[
    'series', 'display_index', 'source_index', 'relative_position_bp',
    'value', 'ci_low', 'ci_high', 'n', 'color',
  ]];
  for (const entry of series) {
    const length = entry.data.length;
    for (let displayIndex = 0; displayIndex < length; displayIndex++) {
      const sourceIndex = options.isReversed ? length - 1 - displayIndex : displayIndex;
      const relativePosition = options.windowBp == null
        ? undefined
        : length <= 1
          ? 0
          : -options.windowBp + (2 * options.windowBp * displayIndex) / (length - 1);
      rows.push([
        entry.label,
        displayIndex,
        sourceIndex,
        relativePosition,
        entry.data[sourceIndex],
        entry.ciLow?.[sourceIndex],
        entry.ciHigh?.[sourceIndex],
        entry.n,
        entry.color,
      ]);
    }
  }
  return formatTsv(rows);
}

export interface ExportDonutSegment {
  label: string;
  value: number;
  color?: string;
}

export function formatDonutChartTsv(segments: ExportDonutSegment[]): string {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  return formatTsv([
    ['segment', 'count', 'total', 'fraction', 'percent', 'ci_low', 'ci_high', 'color'],
    ...segments.map(segment => {
      const interval = total > 0 ? wilsonInterval(segment.value, total) : undefined;
      return [
        segment.label,
        segment.value,
        total,
        total > 0 ? segment.value / total : 0,
        total > 0 ? (segment.value / total) * 100 : 0,
        interval?.low,
        interval?.high,
        segment.color,
      ];
    }),
  ]);
}

export function formatHeatmapChartTsv(
  matrix: number[][],
  options: {
    valueMatrix?: number[][];
    rowLabels?: string[];
    colLabels?: string[];
  } = {},
): string {
  const rows: unknown[][] = [[
    'row_index', 'row_label', 'column_index', 'column_label',
    'color_value', 'display_value',
  ]];
  for (let rowIndex = 0; rowIndex < matrix.length; rowIndex++) {
    for (let columnIndex = 0; columnIndex < (matrix[rowIndex]?.length ?? 0); columnIndex++) {
      rows.push([
        rowIndex,
        options.rowLabels?.[rowIndex] ?? rowIndex,
        columnIndex,
        options.colLabels?.[columnIndex] ?? columnIndex,
        matrix[rowIndex][columnIndex],
        options.valueMatrix?.[rowIndex]?.[columnIndex] ?? matrix[rowIndex][columnIndex],
      ]);
    }
  }
  return formatTsv(rows);
}

export function formatContactMatrixTsv(options: {
  matrix: number[][];
  chrom: string;
  xStart: number;
  xEnd: number;
  yStart: number;
  yEnd: number;
  resolution: number;
  normalization: string;
}): string {
  const rows: unknown[][] = [[
    'chrom', 'row_index', 'y_start', 'y_end',
    'column_index', 'x_start', 'x_end', 'value',
    'resolution', 'normalization',
  ]];
  for (let rowIndex = 0; rowIndex < options.matrix.length; rowIndex++) {
    for (let columnIndex = 0; columnIndex < (options.matrix[rowIndex]?.length ?? 0); columnIndex++) {
      rows.push([
        options.chrom,
        rowIndex,
        options.yStart + rowIndex * options.resolution,
        Math.min(options.yEnd, options.yStart + (rowIndex + 1) * options.resolution),
        columnIndex,
        options.xStart + columnIndex * options.resolution,
        Math.min(options.xEnd, options.xStart + (columnIndex + 1) * options.resolution),
        options.matrix[rowIndex][columnIndex],
        options.resolution,
        options.normalization,
      ]);
    }
  }
  return formatTsv(rows);
}

interface ExportCompactRead {
  id: string;
  intervals?: Array<[number, number, number]>;
  qualities?: number[];
  layers?: Record<string, {
    intervals?: Array<[number, number, number]>;
    qualities?: number[][];
    quality_names?: string[];
  }>;
  methyl?: unknown;
  methyl_m6a?: number[];
  methyl_m5c?: number[];
  deam?: Array<[number, number]>;
  cigar?: Array<Record<string, unknown>>;
}

/** One region's reads (a working-set request): its datasets' reads, where they are, on which reference. */
export interface WorkingSetBlock {
  datasets: Record<string, { reads?: ExportCompactRead[] }>;
  chrom: string;
  regionStart: number;
  /** The reference's key (hg38, dm6, a FASTA's name). */
  reference?: string;
}

/**
 * Long-form read/layer records sufficient to reconstruct viewport-derived
 * plots: one block per region (each panel locus and reference), every row
 * ending with its reference and chromosome.
 */
export function formatWorkingSetReadsTsv(options: WorkingSetBlock | { blocks: WorkingSetBlock[] }): string {
  const rows: unknown[][] = [[
    'record_type', 'dataset_id', 'read_id', 'layer', 'record_index',
    'start_relative', 'end_relative', 'start_genomic', 'end_genomic', 'value',
    'quality_names', 'qualities', 'modification_type', 'cigar_json', 'reference', 'chrom',
  ]];
  const blocks = 'blocks' in options ? options.blocks : [options];
  for (const block of blocks) appendWorkingSetRows(rows, block);
  return formatTsv(rows);
}

function appendWorkingSetRows(out: unknown[][], options: WorkingSetBlock): void {
  const where = [options.reference ?? '', options.chrom];
  const rows = { push: (row: unknown[]) => out.push([...row, ...where]) };
  const pushMark = (datasetId: string, readId: string, type: string, position: number, index: number, value?: unknown) => {
    rows.push([
      'modification', datasetId, readId, '', index,
      position, position + 1, options.regionStart + position, options.regionStart + position + 1,
      value, '', '', type, '',
    ]);
  };
  for (const [datasetId, dataset] of Object.entries(options.datasets)) {
    for (const read of dataset.reads ?? []) {
      (read.intervals ?? []).forEach((interval, index) => {
        rows.push([
          'interval', datasetId, read.id, 'primary', index,
          interval[0], interval[1], options.regionStart + interval[0], options.regionStart + interval[1], interval[2],
          '', read.qualities?.[index], '', '',
        ]);
      });
      for (const [layerName, layer] of Object.entries(read.layers ?? {})) {
        (layer.intervals ?? []).forEach((interval, index) => {
          const qualities = layer.qualities?.map(values => values[index]);
          rows.push([
            'interval', datasetId, read.id, layerName, index,
            interval[0], interval[1], options.regionStart + interval[0], options.regionStart + interval[1], interval[2],
            (layer.quality_names ?? []).join(','), qualities ? JSON.stringify(qualities) : '', '', '',
          ]);
        });
      }
      (read.methyl_m6a ?? []).forEach((position, index) => pushMark(datasetId, read.id, 'm6a', position, index));
      (read.methyl_m5c ?? []).forEach((position, index) => pushMark(datasetId, read.id, 'm5c', position, index));
      (read.deam ?? []).forEach(([position, block], index) => pushMark(datasetId, read.id, 'deamination', position, index, block));
      if (Array.isArray(read.methyl)) {
        read.methyl.forEach((mark, index) => {
          if (typeof mark === 'number') pushMark(datasetId, read.id, 'legacy_methyl', mark, index);
        });
      }
      (read.cigar ?? []).forEach((event, index) => {
        rows.push(['cigar', datasetId, read.id, '', index, '', '', '', '', '', '', '', '', JSON.stringify(event)]);
      });
    }
  }
}

export function formatVPlotChartTsv(
  matrix: number[][],
  options: {
    sizeMin: number;
    sizeBin: number;
    windowBp: number;
    posBin: number;
    /** `# key: value` lines before the header (how the matrix was made). */
    notes?: Record<string, string | number | boolean>;
    /** Position of the first column; default -windowBp (a centred window). */
    positionOrigin?: number;
  },
): string {
  const origin = options.positionOrigin ?? -options.windowBp;
  const notes = Object.entries({ ...(options.notes ?? {}), ...(options.positionOrigin != null ? { position_origin: options.positionOrigin } : {}) })
    .map(([key, value]) => `# ${key}: ${value}\n`).join('');
  const rows: unknown[][] = [[
    'size_bin_index', 'size_start_bp', 'size_end_bp',
    'position_bin_index', 'relative_start_bp', 'relative_end_bp', 'value',
  ]];
  for (let rowIndex = 0; rowIndex < matrix.length; rowIndex++) {
    for (let columnIndex = 0; columnIndex < (matrix[rowIndex]?.length ?? 0); columnIndex++) {
      rows.push([
        rowIndex,
        options.sizeMin + rowIndex * options.sizeBin,
        options.sizeMin + (rowIndex + 1) * options.sizeBin,
        columnIndex,
        origin + columnIndex * options.posBin,
        origin + (columnIndex + 1) * options.posBin,
        matrix[rowIndex][columnIndex],
      ]);
    }
  }
  return notes + formatTsv(rows);
}

export function formatScatterChartTsv(options: {
  coordsX: number[];
  coordsY: number[];
  labels: number[];
  pointIds?: string[];
  datasetIds?: string[];
}): string {
  const length = Math.max(options.coordsX.length, options.coordsY.length);
  return formatTsv([
    ['point_index', 'point_id', 'dataset_id', 'cluster', 'x', 'y'],
    ...Array.from({ length }, (_, index) => [
      index,
      options.pointIds?.[index],
      options.datasetIds?.[index],
      options.labels[index],
      options.coordsX[index],
      options.coordsY[index],
    ]),
  ]);
}

export function formatSignalProfileTsv(options: {
  signal: number[];
  thresholds: number[];
  thresholdLabels?: string[];
  peaks?: Array<{ start: number; end: number; layer?: number; score?: number; threshold?: number }>;
  viewStart: number;
  viewEnd?: number;
}): string {
  const rows: unknown[][] = [[
    'record_type', 'index', 'start', 'end', 'value',
    'label', 'layer', 'score', 'threshold',
  ]];
  const regionEnd = options.viewEnd ?? options.viewStart + options.signal.length;
  const binWidth = options.signal.length > 0
    ? (regionEnd - options.viewStart) / options.signal.length
    : 0;
  options.signal.forEach((value, index) => {
    rows.push([
      'signal',
      index,
      options.viewStart + index * binWidth,
      options.viewStart + (index + 1) * binWidth,
      value,
      '', '', '', '',
    ]);
  });
  options.thresholds.forEach((threshold, index) => {
    rows.push([
      'threshold', index, options.viewStart, regionEnd, threshold,
      options.thresholdLabels?.[index] ?? `threshold_${index + 1}`, '', '', threshold,
    ]);
  });
  (options.peaks ?? []).forEach((peak, index) => {
    rows.push([
      'peak', index, peak.start, peak.end, '', '',
      peak.layer, peak.score, peak.threshold,
    ]);
  });
  return formatTsv(rows);
}

export function formatSequenceLogoTsv(
  pwm: { A: number[]; C: number[]; G: number[]; T: number[] },
  highlightRange?: [number, number],
): string {
  const bases = ['A', 'C', 'G', 'T'] as const;
  const rows: unknown[][] = [[
    'position', 'base', 'input_value', 'probability',
    'information_content_bits', 'letter_height_bits', 'highlighted',
  ]];
  for (let position = 0; position < pwm.A.length; position++) {
    const values = bases.map(base => pwm[base][position] ?? 0);
    const total = values.reduce((sum, value) => sum + value, 0);
    const probabilities = total > 0
      ? values.map(value => value / total)
      : values.map(() => 0.25);
    const information = Math.max(
      0,
      2 + probabilities.reduce((sum, probability) => (
        probability > 0 ? sum + probability * Math.log2(probability) : sum
      ), 0),
    );
    for (let baseIndex = 0; baseIndex < bases.length; baseIndex++) {
      rows.push([
        position + 1,
        bases[baseIndex],
        values[baseIndex],
        probabilities[baseIndex],
        information,
        probabilities[baseIndex] * information,
        highlightRange ? position >= highlightRange[0] && position < highlightRange[1] : false,
      ]);
    }
  }
  return formatTsv(rows);
}

export function toPythonLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'None';
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(toPythonLiteral).join(', ')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined);
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}: ${toPythonLiteral(v)}`).join(', ')}}`;
  }
  return JSON.stringify(String(value));
}
