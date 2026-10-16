import type { SavedPrimer } from '../types';

export type PrimerOrderFormat = 'idt' | 'genewiz' | 'eurofins' | 'sigma' | 'generic' | 'fasta';

export interface PrimerOrderFormatDefinition {
  value: PrimerOrderFormat;
  label: string;
  filename: string;
  mimeType: string;
}

export const PRIMER_ORDER_FORMATS: PrimerOrderFormatDefinition[] = [
  { value: 'idt', label: 'IDT CSV', filename: 'primer_order_idt.csv', mimeType: 'text/csv' },
  { value: 'genewiz', label: 'Azenta/GENEWIZ CSV', filename: 'primer_order_genewiz.csv', mimeType: 'text/csv' },
  { value: 'eurofins', label: 'Eurofins Plate CSV', filename: 'primer_order_eurofins_plate.csv', mimeType: 'text/csv' },
  { value: 'sigma', label: 'Sigma/Merck CSV', filename: 'primer_order_sigma.csv', mimeType: 'text/csv' },
  { value: 'generic', label: 'Generic CSV', filename: 'primer_order_generic.csv', mimeType: 'text/csv' },
  { value: 'fasta', label: 'FASTA', filename: 'primer_order.fasta', mimeType: 'text/plain' },
];

interface PrimerOrderRow {
  name: string;
  sequence: string;
  pairName: string;
  direction: 'F' | 'R';
}

function csvCell(value: string | number | null | undefined): string {
  let text = value == null ? '' : String(value);
  // Guard against CSV/spreadsheet formula injection: cells beginning with
  // =, +, -, @, or a leading tab/CR are executed as formulas by Excel/Sheets.
  // Primer names are user-editable and these sheets get opened in spreadsheets,
  // so neutralize the leading character with a single quote.
  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvRow(values: Array<string | number | null | undefined>): string {
  return values.map(csvCell).join(',');
}

function flattenPrimerRows(primers: SavedPrimer[]): PrimerOrderRow[] {
  return primers.flatMap(sp => [
    { name: `${sp.name}_F`, sequence: sp.pair.fwd_seq, pairName: sp.name, direction: 'F' as const },
    { name: `${sp.name}_R`, sequence: sp.pair.rev_seq, pairName: sp.name, direction: 'R' as const },
  ]);
}

function wellName(index: number): string {
  const rows = 'ABCDEFGH';
  const plateIndex = index % 96;
  return `${rows[Math.floor(plateIndex / 12)]}${(plateIndex % 12) + 1}`;
}

export function formatPrimerOrder(
  primers: SavedPrimer[],
  format: PrimerOrderFormat,
): { content: string; filename: string; mimeType: string } {
  const definition = PRIMER_ORDER_FORMATS.find(item => item.value === format) ?? PRIMER_ORDER_FORMATS[0];
  const rows = flattenPrimerRows(primers);

  if (definition.value === 'fasta') {
    return {
      filename: definition.filename,
      mimeType: definition.mimeType,
      content: rows.map(row => `>${row.name}\n${row.sequence}`).join('\n'),
    };
  }

  if (definition.value === 'eurofins') {
    return {
      filename: definition.filename,
      mimeType: definition.mimeType,
      content: [
        csvRow(['Well', 'Oligo Name', 'Sequence', 'PlateName']),
        ...rows.map((row, index) => csvRow([
          wellName(index),
          row.name,
          row.sequence,
          `FiberBrowser_${Math.floor(index / 96) + 1}`,
        ])),
      ].join('\n'),
    };
  }

  if (definition.value === 'sigma') {
    return {
      filename: definition.filename,
      mimeType: definition.mimeType,
      content: [
        csvRow(['Oligo Name', 'Sequence', 'Scale', 'Notes']),
        ...rows.map(row => csvRow([row.name, row.sequence, '0.025 umol', row.pairName])),
      ].join('\n'),
    };
  }

  if (definition.value === 'generic') {
    return {
      filename: definition.filename,
      mimeType: definition.mimeType,
      content: [
        csvRow(['Name', 'Sequence', 'Direction']),
        ...rows.map(row => csvRow([row.name, row.sequence, row.direction])),
      ].join('\n'),
    };
  }

  const scale = definition.value === 'genewiz' ? '25 nmol' : '25 nmole';
  const purification = definition.value === 'genewiz' ? 'Desalted' : 'STD';
  return {
    filename: definition.filename,
    mimeType: definition.mimeType,
    content: [
      csvRow(['Name', 'Sequence', 'Scale', 'Purification']),
      ...rows.map(row => csvRow([row.name, row.sequence, scale, purification])),
    ].join('\n'),
  };
}
