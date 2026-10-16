import { useMemo, useState, type KeyboardEvent } from 'react';
import type { SearchGroup, SearchSuggestion } from '../../utils/search/providers';

/**
 * The suggestion list under a locus box (main and per panel): what the search
 * providers (utils/search/providers) make of the text (loci, genes, saved
 * regions, read names), grouped, the best group first. Arrow keys move, Enter
 * or a click runs, Escape closes; with nothing chosen, Enter runs the best
 * match (marked ↵).
 */
export function useSuggestionList(groups: readonly SearchGroup[], query: string) {
  const flat = useMemo(() => groups.flatMap(g => g.suggestions), [groups]);
  // The chosen suggestion by its provider and id, not its row: server answers
  // (genes) arriving later insert rows above it without changing the choice.
  const keys = useMemo(() => groups.flatMap(g => g.suggestions.map(s => `${g.provider.id}:${s.id}`)), [groups]);
  const [chosen, setChosen] = useState<{ query: string; key: string } | null>(null);
  const [closedFor, setClosedFor] = useState<string | null>(null);
  const open = flat.length > 0 && closedFor !== query;
  // A choice belongs to the text it was made for.
  const index = open && chosen && chosen.query === query ? keys.indexOf(chosen.key) : -1;
  const choose = (i: number) => setChosen(i >= 0 && i < keys.length ? { query, key: keys[i] } : null);
  return {
    flat,
    open,
    active: index,
    setActive: choose,
    close: () => { setClosedFor(query); setChosen(null); },
    reopen: () => setClosedFor(null),
    /** Arrow keys and Escape; true when the key was used. */
    onKeyDown: (e: KeyboardEvent<HTMLInputElement>): boolean => {
      if (!open) return false;
      if (e.key === 'ArrowDown') { e.preventDefault(); choose((index + 1) % flat.length); return true; }
      if (e.key === 'ArrowUp') { e.preventDefault(); choose(index <= 0 ? flat.length - 1 : index - 1); return true; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setClosedFor(query); setChosen(null); return true; }
      return false;
    },
    /** The suggestion chosen with the arrow keys (null: Enter runs the best match). */
    chosen: (): SearchSuggestion | null => (index >= 0 ? flat[index] ?? null : null),
  };
}

const KIND_SUFFIX: Record<string, string> = { category: ' (category)' };

export function SearchSuggestionList({ groups, active, enterTarget, pending, onPick, onHover, compact, id }: {
  groups: readonly SearchGroup[];
  active: number;
  /** What Enter runs when nothing is chosen (marked ↵). */
  enterTarget: SearchSuggestion | null;
  /** Server answers (genes) still coming. */
  pending?: boolean;
  onPick: (s: SearchSuggestion) => void;
  onHover: (index: number) => void;
  compact?: boolean;
  id: string;
}) {
  if (!groups.length) return null;
  let index = -1;
  return (
    <div
      id={id}
      role="listbox"
      aria-label="Suggestions"
      className={`absolute left-0 top-full z-[60] mt-1 max-h-80 overflow-y-auto rounded-fb-lg border border-line bg-white p-1 text-left shadow-dropdown dark:border-white/10 dark:bg-dark-surface dark:shadow-dropdown-dark ${compact ? 'w-[18rem]' : 'w-[24rem]'} max-w-[calc(100vw-1rem)]`}
      data-testid="search-suggestions"
    >
      {groups.map(group => (
        <div key={group.provider.id} role="group" aria-label={group.provider.label} data-group={group.provider.id}>
          <div className="px-2 pb-0.5 pt-1 text-[10.5px] font-semibold uppercase tracking-wide text-ink-muted" aria-hidden="true">{group.provider.label}</div>
          {group.suggestions.map(s => {
            index += 1;
            const i = index;
            const isEnter = active < 0 && enterTarget === s;
            return (
              <div
                key={`${group.provider.id}:${s.id}`}
                id={`${id}-${i}`}
                role="option"
                aria-selected={i === active}
                aria-disabled={s.disabledReason ? true : undefined}
                title={s.disabledReason}
                className={`flex cursor-pointer items-start gap-2 rounded px-2 py-1 ${i === active ? 'bg-teal-50 dark:bg-teal-900/30' : 'hover:bg-gray-50 dark:hover:bg-white/5'} ${s.disabledReason ? 'opacity-55' : ''}`}
                // Before the input's blur, so the click lands.
                onMouseDown={e => { e.preventDefault(); onPick(s); }}
                onMouseEnter={() => onHover(i)}
                data-testid="search-suggestion"
                data-kind={s.kind}
                data-enter={isEnter ? 'true' : undefined}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] text-ink" data-suggestion-label>{s.label}{KIND_SUFFIX[s.kind] ?? ''}</div>
                  {(s.disabledReason || s.detail) && <div className="truncate font-mono text-[10.5px] text-ink-muted">{s.disabledReason ?? s.detail}</div>}
                </div>
                {isEnter && <kbd className="mt-0.5 shrink-0 rounded border border-line px-1 font-mono text-[10px] text-ink-muted dark:border-white/15" title="Enter goes here">↵</kbd>}
              </div>
            );
          })}
        </div>
      ))}
      {pending && <div className="px-2 py-0.5 text-[10.5px] text-ink-muted" data-testid="search-suggestions-pending">Searching…</div>}
    </div>
  );
}
