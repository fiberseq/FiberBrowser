import type { FirePeak, PeakMode, PeakRule } from '../types';

export const PEAK_BED_COLUMNS = [
  'chrom',
  'start',
  'end',
  'name',
  'bed_score',
  'strand',
  'rule_id',
  'rule_name',
  'source',
  'layer',
  'signal_score',
  'threshold',
  'selected',
  'mode',
  'is_custom',
  'color',
] as const;

export interface PeakBedExportEntry {
  chrom: string;
  peak: FirePeak;
  rule?: PeakRule;
  selected?: boolean;
  mode?: PeakMode;
}

export interface ParsedPeakBedEntry {
  chrom: string;
  start: number;
  end: number;
  name?: string;
  score?: number;
  ruleId?: string;
  ruleName?: string;
  source?: string;
  layer?: number;
  threshold?: number;
  selected?: boolean;
  mode?: PeakMode;
  isCustom?: boolean;
  color?: string;
}

function bedField(value: unknown): string {
  if (value === undefined || value === null || value === '') return '.';
  return String(value).replace(/[\t\r\n]/g, ' ');
}

function parseOptionalString(value: string | undefined): string | undefined {
  if (!value || value === '.') return undefined;
  return value;
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (!value || value === '.') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseOptionalBool(value: string | undefined): boolean | undefined {
  const normalized = (value ?? '').trim().toLowerCase();
  if (!normalized || normalized === '.') return undefined;
  if (['1', 'true', 'yes', 'selected'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'unselected'].includes(normalized)) return false;
  return undefined;
}

function parseLayer(value: string | undefined): number | undefined {
  const numeric = parseOptionalNumber(value);
  if (numeric !== undefined) return numeric;
  const normalized = (value ?? '').trim().toLowerCase();
  if (normalized === 'strong') return 0;
  if (normalized === 'medium') return 1;
  if (normalized === 'weak') return 2;
  if (normalized === 'rare') return 3;
  const match = normalized.match(/^l(\d+)$/);
  return match ? Number(match[1]) : undefined;
}

function bedScore(score: number | undefined): number {
  if (!Number.isFinite(score)) return 0;
  const scaled = (score ?? 0) <= 1 ? (score ?? 0) * 1000 : (score ?? 0);
  return Math.max(0, Math.min(1000, Math.round(scaled)));
}

/**
 * fiberbrowser_peaks_v1 BED. A BED holds one assembly's coordinates: with
 * `reference` (the peaks' reference key), a `# reference=` line names it.
 */
export function formatPeakBed(entries: PeakBedExportEntry[], options: { reference?: string } = {}): string {
  const lines = [
    '# fiberbrowser_peaks_v1',
    `# columns=${PEAK_BED_COLUMNS.join('\t')}`,
    ...(options.reference ? [`# reference=${options.reference.replace(/[\t\r\n]/g, ' ')}`] : []),
  ];

  const sorted = [...entries].sort((a, b) => {
    const chromCompare = a.chrom.localeCompare(b.chrom);
    if (chromCompare !== 0) return chromCompare;
    return a.peak.start - b.peak.start || a.peak.end - b.peak.end;
  });

  for (const { chrom, peak, rule, selected = false, mode = 'accessibility' } of sorted) {
    const name = peak.sourceLabel || rule?.name || (peak.isCustom ? 'custom_peak' : `peak_${peak.index}`);
    const row = [
      chrom,
      peak.start,
      peak.end,
      name,
      bedScore(peak.score),
      '.',
      peak.ruleId || rule?.id,
      rule?.name,
      rule?.source,
      peak.layer ?? 0,
      peak.score,
      peak.threshold,
      selected ? 1 : 0,
      mode,
      peak.isCustom ? 1 : 0,
      peak.sourceColor || rule?.color,
    ].map(bedField);
    lines.push(row.join('\t'));
  }

  return `${lines.join('\n')}\n`;
}

export function parsePeakBed(text: string): ParsedPeakBedEntry[] {
  const entries: ParsedPeakBedEntry[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('track') || line.startsWith('browser')) {
      continue;
    }

    const fields = line.includes('\t') ? line.split('\t') : line.split(/\s+/);
    if (fields.length < 3) continue;

    const chrom = fields[0];
    const start = Number(fields[1]);
    const end = Number(fields[2]);
    if (!chrom || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      continue;
    }

    const exactScore = parseOptionalNumber(fields[10]);
    const bedScoreValue = parseOptionalNumber(fields[4]);
    const inferredScore = exactScore ?? (
      bedScoreValue !== undefined && bedScoreValue > 0
        ? bedScoreValue / 1000
        : undefined
    );

    entries.push({
      chrom,
      start: Math.max(0, Math.floor(start)),
      end: Math.max(0, Math.ceil(end)),
      name: parseOptionalString(fields[3]),
      score: inferredScore,
      ruleId: parseOptionalString(fields[6]),
      ruleName: parseOptionalString(fields[7]),
      source: parseOptionalString(fields[8]),
      layer: parseLayer(fields[9]),
      threshold: parseOptionalNumber(fields[11]),
      selected: parseOptionalBool(fields[12]),
      mode: parseOptionalString(fields[13]) as PeakMode | undefined,
      isCustom: parseOptionalBool(fields[14]),
      color: parseOptionalString(fields[15]),
    });
  }

  return entries;
}
