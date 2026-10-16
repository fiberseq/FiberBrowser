import type { AccessibilityResult } from '../api';
import { nfrColor } from '../accessibilityView';
import { nfrMembers } from '../nfrPairsLayout';

/**
 * The NFRs of the arcs, each folded to one element or shown as its variants (one state with the matrix and the NFR
 * track over the reads): a chip per NFR with several variants, and all at once. A folded NFR with pairs between its
 * own variants says how many (they have no arc until it is unfolded).
 */
export function NfrFoldChips({ result, expanded, onToggle, inner }: {
  result: AccessibilityResult; expanded: readonly string[]; onToggle: (nfrId: string, open: boolean) => void;
  inner?: Map<string, number>;
}) {
  const groups = [...nfrMembers(result)].filter(([, m]) => m.length > 1);
  if (!groups.length) return null;
  const allOpen = groups.every(([id]) => expanded.includes(id));
  return (
    <div className="mb-1 flex flex-wrap items-center gap-1 text-[11px]" data-testid="nfr-fold-chips">
      <span className="text-ink-muted">Variants:</span>
      {groups.map(([id, members]) => {
        const open = expanded.includes(id);
        const n = inner?.get(id) ?? 0;
        return (
          <button key={id} type="button" onClick={() => onToggle(id, !open)} aria-expanded={open} data-testid="nfr-fold-chip" data-nfr={id}
            title={open ? `Fold ${id} to one element` : `Show ${id}'s ${members.length} variants${n ? ` (${n} pair${n === 1 ? '' : 's'} between them)` : ''}`}
            className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-px ${open ? 'border-fuchsia-300 bg-fuchsia-50 dark:border-fuchsia-700 dark:bg-fuchsia-900/20' : 'border-gray-200 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-white/5'}`}>
            <span className="inline-block h-2 w-2 rounded-sm" style={{ background: nfrColor(id) }} />
            {id} · {members.length}
            {!open && n > 0 && <span className="text-[10px] text-orange-700 dark:text-orange-300">({n} inside)</span>}
            <span aria-hidden="true" className="text-ink-muted">{open ? '▾' : '▸'}</span>
          </button>
        );
      })}
      {groups.length > 1 && (
        <button type="button" data-testid="nfr-fold-all" onClick={() => groups.forEach(([id]) => onToggle(id, !allOpen))}
          className="rounded px-1 text-fuchsia-700 hover:bg-fuchsia-50 dark:text-fuchsia-300 dark:hover:bg-white/5">{allOpen ? 'Fold all' : 'Show all'}</button>
      )}
    </div>
  );
}
