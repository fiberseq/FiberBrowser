import type { ReadStatsDisplayRow } from './types';

const TABLE_COLS: { key: string; label: string; bamOnly?: boolean }[] = [
  { key: 'viewer_order', label: 'Order' },
  { key: 'read_id', label: 'Read ID' },
  { key: 'aligned_span', label: 'Span' },
  { key: 'footprint_count', label: 'FP #' },
  { key: 'avg_footprint_size', label: 'Avg FP' },
  { key: 'accessibility_pct', label: 'Acc %' },
  { key: 'methyl_pct', label: 'Mod %' },
  { key: 'mapq', label: 'MAPQ', bamOnly: true },
  { key: 'strand', label: 'Strand', bamOnly: true },
];

/** Nucleosome molecule scalars (a nucleosome scan's nucmol), shown as their own group when any row has one. */
export const NUC_TABLE_COLS: { key: string; label: string; title: string; digits: number }[] = [
  { key: 'nrl', label: 'NRL', title: 'Nucleosome repeat length (bp)', digits: 0 },
  { key: 'regularity', label: 'S', title: 'Regularity S', digits: 2 },
  { key: 'gap_cv', label: 'Gap CV', title: 'Dyad gap CV', digits: 2 },
  { key: 'lambda_acc', label: '\u03bb acc', title: 'Accessible marking rate', digits: 3 },
  { key: 'n_short', label: 'Short', title: 'Short footprints', digits: 0 },
  { key: 'n_mono', label: 'Mono', title: 'Mono footprints', digits: 0 },
  { key: 'n_multi', label: 'Multi', title: 'Multi footprints', digits: 0 },
  { key: 'n_cant_tell', label: "Can't tell", title: "Can't-tell footprints", digits: 0 },
  { key: 'reg_fraction', label: 'Regular', title: 'Regular fraction', digits: 2 },
  { key: 'disordered_fraction', label: 'Disordered', title: 'Disordered fraction', digits: 2 },
  { key: 'undetermined_fraction', label: 'Undet.', title: 'Undetermined fraction', digits: 2 },
  { key: 'n_missing', label: 'Missing', title: 'Missing nucleosomes', digits: 0 },
];

const NUC_DIGITS = new Map(NUC_TABLE_COLS.map(col => [col.key, col.digits]));

/** Whether any row has a nucleosome scalar (the Nucleosomes columns are shown then). */
export function hasNucleosomeColumns(rows: ReadStatsDisplayRow[]): boolean {
  return rows.some(row => NUC_TABLE_COLS.some(col => (row as unknown as Record<string, unknown>)[col.key] != null));
}

const MAX_TABLE_ROWS = 100;

export function TableTab({
  rows, total, sortCol, sortAsc, onSort, isBam,
}: {
  rows: ReadStatsDisplayRow[];
  total: number;
  sortCol: string;
  sortAsc: boolean;
  onSort: (col: string) => void;
  isBam: boolean;
}) {
  const baseCols = TABLE_COLS.filter(c => !c.bamOnly || isBam);
  const nucCols = hasNucleosomeColumns(rows) ? NUC_TABLE_COLS : [];
  const visibleCols: { key: string; label: string; title?: string }[] = [...baseCols, ...nucCols];
  const displayRows = rows.slice(0, MAX_TABLE_ROWS);

  return (
    <div>
      <div className="overflow-auto max-h-[400px]">
        <table className="w-full text-[11px] border-collapse">
          <thead>
            {nucCols.length > 0 && (
              <tr className="text-[10px] text-ink-muted">
                <th colSpan={baseCols.length} />
                <th colSpan={nucCols.length} className="px-1 text-left font-medium border-b border-gray-200 dark:border-white/10" data-testid="read-stats-nuc-group">
                  Nucleosomes
                </th>
              </tr>
            )}
            <tr className="border-b border-gray-200 dark:border-white/10">
              {visibleCols.map(col => (
                <th
                  key={col.key}
                  title={col.title}
                  onClick={() => onSort(col.key)}
                  className="px-1 py-0.5 text-left cursor-pointer hover:bg-gray-50 dark:hover:bg-white/5 whitespace-nowrap"
                >
                  {col.label}
                  {sortCol === col.key && (
                    <span className="ml-0.5 text-violet-500">{sortAsc ? '\u25B2' : '\u25BC'}</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {displayRows.map((row, i) => (
              <tr key={i} className="border-b border-gray-50 dark:border-white/5 hover:bg-gray-50 dark:hover:bg-white/5">
                {visibleCols.map(col => (
                  <td key={col.key} className="px-1 py-0.5 whitespace-nowrap">
                    {formatCell(col.key, (row as unknown as Record<string, unknown>)[col.key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* The read count is in the panel header; say only when the table is cut. */}
      {total > MAX_TABLE_ROWS && (
        <div className="mt-1 text-[11px] text-ink-muted" data-testid="read-stats-table-cap">
          First {MAX_TABLE_ROWS} rows; TSV and JSON have all {total.toLocaleString()}.
        </div>
      )}
    </div>
  );
}

function formatCell(col: string, val: unknown): string {
  if (val == null) return '-';
  if (col === 'read_id') {
    const s = String(val);
    return s.length > 20 ? s.slice(0, 8) + '...' + s.slice(-8) : s;
  }
  if (typeof val === 'number') {
    if (col === 'accessibility_pct' || col === 'avg_footprint_size' || col === 'methyl_pct') return val.toFixed(1);
    const digits = NUC_DIGITS.get(col);
    if (digits) return val.toFixed(digits);
    return String(Math.round(val));
  }
  return String(val);
}
