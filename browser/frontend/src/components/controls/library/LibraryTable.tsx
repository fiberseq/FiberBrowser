import type { LibraryEntry } from '../../../api/library';
import {
  KIND_LABELS, chemistryLabel, entryDate, qcVerdict, referenceLabel, rerunExplanation, type SortKey, type SortState,
} from '../../../utils/library';
import { verdictBasisTitle } from '../../../utils/qcView';
import { ChevronDown } from '../../ui/Icons';

const COLUMNS: { key: SortKey; label: string; className?: string }[] = [
  { key: 'label', label: 'Name' },
  { key: 'kind', label: 'Kind' },
  { key: 'chemistry', label: 'Chemistry' },
  { key: 'reference', label: 'Genome / plasmid' },
  { key: 'reads', label: 'Reads', className: 'text-right' },
  { key: 'qc', label: 'QC' },
  { key: 'date', label: 'Date' },
  { key: 'folder', label: 'Folder' },
];

const VERDICT_CLASS: Record<string, string> = {
  PASS: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
  WARN: 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100',
  FAIL: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
};

export function Badge({ children, tone = 'muted', title, testId }: { children: React.ReactNode; tone?: 'muted' | 'warn' | 'error' | 'info'; title?: string; testId?: string }) {
  const cls = {
    muted: 'bg-gray-100 text-gray-600 dark:bg-white/10 dark:text-gray-300',
    warn: 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100',
    error: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
    info: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200',
  }[tone];
  return <span className={`inline-block rounded px-1.5 py-px text-[11px] font-medium ${cls}`} title={title} data-testid={testId}>{children}</span>;
}

/** FiberHMM 3.0.1's warning (bam_tags.UNVERIFIABLE_FRAME_WARNING). */
export const FRAME_UNVERIFIABLE_TEXT = "The header has no FiberHMM/fibertools provenance, so footprint coordinates on "
  + "reverse reads can't be confirmed; re-call with FiberHMM 3.0.";

export function EntryBadges({ entry }: { entry: LibraryEntry }) {
  return (
    <>
      {entry.rerun && (
        <Badge tone={entry.rerun === 'rerun-required' ? 'error' : entry.rerun === 'possible' ? 'info' : 'warn'} testId="library-rerun-badge"
          title={rerunExplanation(entry)}>
          {entry.rerun === 'rerun-required' ? 'Needs re-run' : entry.rerun === 'possible' ? 'May need re-run' : 'Re-run recommended'}
        </Badge>
      )}
      {entry.frame_unverifiable && (
        <Badge tone="warn" testId="library-frame-badge" title={FRAME_UNVERIFIABLE_TEXT}>Frame unconfirmed</Badge>
      )}
      {!entry.available && <Badge tone="error" testId="library-missing-badge" title="Not at its saved location">Missing</Badge>}
      {entry.available && entry.cloud_only && <Badge tone="info" title="Only in the cloud (online-only file): make it available offline to open it">Cloud</Badge>}
      {entry.available && entry.changed && <Badge tone="warn" title="Modified since it was last read: Re-scan">Changed</Badge>}
      {entry.role === 'aligned' && <Badge title="The aligned (not yet called) BAM of a run">aligned</Badge>}
      {entry.error && <Badge tone="error" title={entry.error}>unreadable</Badge>}
      {!entry.error && entry.sidecar_errors?.length ? (
        <Badge tone="warn" title={entry.sidecar_errors.join('\n')} testId="library-sidecar-badge">QC file unreadable</Badge>
      ) : null}
    </>
  );
}

interface Props {
  entries: LibraryEntry[];
  sort: SortState;
  onSort: (key: SortKey) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  checked: string[];
  onToggle: (id: string) => void;
  onToggleAll: (ids: string[], on: boolean) => void;
  onOpen?: (entry: LibraryEntry) => void;
}

/** The Library's sortable table (one row per file). */
export function LibraryTable({ entries, sort, onSort, selectedId, onSelect, checked, onToggle, onToggleAll, onOpen }: Props) {
  const checkedSet = new Set(checked);
  const allChecked = entries.length > 0 && entries.every(e => checkedSet.has(e.id));
  return (
    <table className="w-full text-[12px] border-collapse" data-testid="library-table">
      <thead className="sticky top-0 bg-white dark:bg-gray-800 z-10">
        <tr className="text-left text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-white/10">
          <th className="w-6 px-1 py-1">
            <input
              type="checkbox"
              aria-label="Select all shown"
              checked={allChecked}
              onChange={e => onToggleAll(entries.map(x => x.id), e.target.checked)}
            />
          </th>
          {COLUMNS.map(col => (
            <th key={col.key} className={`px-1.5 py-1 font-medium whitespace-nowrap ${col.className ?? ''}`}>
              <button
                type="button"
                className="hover:text-gray-900 dark:hover:text-gray-100"
                onClick={() => onSort(col.key)}
                data-testid={`library-sort-${col.key}`}
                aria-sort={sort.key === col.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
              >
                {col.label}{sort.key === col.key && <ChevronDown size={10} strokeWidth={2.5} aria-label={sort.dir === 'asc' ? 'ascending' : 'descending'} className={`ml-0.5 inline-block align-[-1px] ${sort.dir === 'asc' ? 'rotate-180' : ''}`} />}
              </button>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {entries.map(entry => {
          const verdict = qcVerdict(entry);
          const selected = entry.id === selectedId;
          return (
            <tr
              key={entry.id}
              onClick={() => onSelect(entry.id)}
              onDoubleClick={() => onOpen?.(entry)}
              className={`border-b border-gray-100 dark:border-white/5 cursor-pointer ${selected ? 'bg-blue-50 dark:bg-blue-900/30' : 'hover:bg-gray-50 dark:hover:bg-white/5'} ${entry.available ? '' : 'opacity-60'}`}
              data-testid="library-row"
              data-entry-id={entry.id}
              data-available={entry.available ? 'true' : 'false'}
            >
              <td className="px-1 py-1" onClick={e => e.stopPropagation()}>
                <input type="checkbox" aria-label={`Select ${entry.label}`} checked={checkedSet.has(entry.id)} onChange={() => onToggle(entry.id)} />
              </td>
              <td className="px-1.5 py-1 max-w-[280px]">
                <div className="truncate font-medium text-gray-800 dark:text-gray-100" title={entry.path}>{entry.label}</div>
                <div className="flex flex-wrap items-center gap-1">
                  {entry.sample && entry.sample !== entry.label && <span className="truncate text-[11px] text-gray-500">{entry.sample}</span>}
                  <EntryBadges entry={entry} />
                  {(entry.tags ?? []).map(tag => <Badge key={tag}>#{tag}</Badge>)}
                </div>
              </td>
              <td className="px-1.5 py-1 whitespace-nowrap">{KIND_LABELS[entry.kind] ?? entry.kind}</td>
              <td className="px-1.5 py-1 whitespace-nowrap">{chemistryLabel(entry)}</td>
              <td className="px-1.5 py-1 whitespace-nowrap max-w-[160px] truncate" title={referenceLabel(entry)}>{referenceLabel(entry)}</td>
              <td className="px-1.5 py-1 text-right tabular-nums">{entry.reads != null ? entry.reads.toLocaleString() : ''}</td>
              <td className="px-1.5 py-1">
                {verdict && <span className={`rounded px-1.5 py-px text-[11px] font-semibold ${VERDICT_CLASS[verdict] ?? 'bg-gray-100 dark:bg-white/10'}`} data-testid="library-qc-verdict" title={verdictBasisTitle({ ...entry.qc?.verdicts, signal_label: entry.qc?.numbers?.signal_label })}>{verdict}</span>}
              </td>
              <td className="px-1.5 py-1 whitespace-nowrap tabular-nums" title={entry.date_source ? `from ${entry.date_source}` : undefined}>{entryDate(entry)}</td>
              <td className="px-1.5 py-1 max-w-[200px] truncate text-gray-500" title={entry.folder}>{entry.folder}</td>
            </tr>
          );
        })}
        {entries.length === 0 && (
          <tr><td colSpan={COLUMNS.length + 1} className="px-2 py-6 text-center text-gray-400">No files match.</td></tr>
        )}
      </tbody>
    </table>
  );
}
