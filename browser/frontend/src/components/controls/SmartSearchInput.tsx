import { useState, useEffect, useId, useLayoutEffect, useRef, type CSSProperties, type FormEvent, type ReactNode, type Ref, type RefObject } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserStore } from '../../stores/browserStore';
import { parseCoordinates, formatCoordinates } from '../../utils/coordinates';
import { findChromInfo } from '../../utils/chromAliases';
import type { ChromInfo } from '../../types';
import { createPortal } from 'react-dom';
import {
  asyncAnswerCouldOutrank, bestSuggestion, runSearchSuggestion, searchProviders, setMainLocusBoxRunner, setPanelLocusBoxRunner,
  type SearchContext, type SearchGroup, type SearchRunResult, type SearchSuggestion,
} from '../../utils/search/providers';
import '../../utils/search/builtinProviders';
import { useProviderSearch } from '../../hooks/useProviderSearch';
import { flattenPastedList } from '../../utils/readNames';
import { beginNavigationIntent, contextReference, supersedeNavigationIntents, type NavigationTarget } from '../../utils/search/navigationIntent';
import { SearchSuggestionList, useSuggestionList } from './SearchSuggestions';

/**
 * The locus box (the main one, and each panel's own): what is typed goes to
 * the search providers (utils/search/providers): coordinates, genes ("gene",
 * "gene +/- 2kb"), saved regions, read names. Their suggestions are listed
 * under the box, grouped; Enter runs the one chosen with the arrows, else the
 * best match (the gene named exactly so before a region of that name; read
 * names only for text shaped like one). A long run (a read search) shows its
 * progress and a Cancel button, and its outcome below the box.
 *
 * The command palette's "Go to" picks run here too (the main box), so they
 * show the same progress and outcome.
 */
interface SmartSearchInputProps {
  /** Location shown and searched from; defaults to the main view. */
  viewport?: { chrom: string; start: number; end: number };
  /** Where a result goes; defaults to moving the main view. */
  onNavigate?: (chrom: string, start: number, end: number) => void;
  /** A panel's own box: smaller, and gene search prefers the panel's chromosome. */
  compact?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  ariaLabel?: string;
  /** Grayed out (a panel linked to the main view moves with it). */
  disabled?: boolean;
  /** Why it is grayed out (its tooltip then). */
  disabledReason?: string;
  /** A panel on another assembly: its reference's key (gene and region search ask that reference). */
  genome?: string | null;
  /** That reference's chromosomes (coordinates are checked against them); default the main genome's. */
  chroms?: ChromInfo[];
  /** A panel's own box: that panel (answers that come back later check it hasn't moved meanwhile). */
  panelId?: string;
}

/**
 * A status line under the box. While the box is grayed out (the main box with
 * "Each panel navigates" on: its toolbar group is faded), the line is drawn
 * outside that group (in the page, at the same place) so a palette pick's
 * outcome ("<read> at chr3L:…") is readable and opaque, not a faded overlay
 * on the toolbar below (audit L6).
 */
function StatusBubble({ anchor, detached, children }: { anchor: RefObject<HTMLDivElement | null>; detached: boolean; children: ReactNode }) {
  const [style, setStyle] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    if (!detached) { setStyle(null); return; }
    const place = () => {
      const r = anchor.current?.getBoundingClientRect();
      if (r) setStyle({ position: 'fixed', left: r.left, top: r.top, width: r.width, height: r.height, pointerEvents: 'none', zIndex: 60 });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchor, detached]);
  if (!detached || typeof document === 'undefined') return <>{children}</>;
  return createPortal(
    <div data-testid="location-search-status-layer" style={style ?? { position: 'fixed', left: 0, top: 0, pointerEvents: 'none', zIndex: 60 }}>{children}</div>,
    document.body,
  );
}

/** The short tag of a suggestion in the status line. */
const KIND_TAG: Record<string, string> = { locus: 'Locus', gene: 'Gene', region: 'Region', category: 'Regions', read: 'Read' };

export function SmartSearchInput({ viewport, onNavigate, compact = false, inputRef, ariaLabel, disabled = false, disabledReason, genome, chroms: ownChroms, panelId }: SmartSearchInputProps = {}) {
  const store = useBrowserStore(useShallow(s => ({
    chrom: s.chrom, start: s.start, end: s.end, setViewport: s.setViewport, chroms: s.chroms, showRelativeCoords: s.showRelativeCoords, relativeTSS: s.relativeTSS, relativeGene: s.relativeGene,
    currentGenome: s.currentGenome, fastaPath: s.fastaPath,
    // Loaded pairs (each haplotype's FASTA) are part of the main reference's identity.
    referencePairs: (s as { referencePairs?: Array<{ fasta: string }> | null }).referencePairs,
  })));
  const { relativeTSS, relativeGene } = store;
  const chroms = ownChroms ?? store.chroms;
  const { chrom, start, end } = viewport ?? store;
  const navigate = onNavigate ?? store.setViewport;
  // Views are kept under the reference's own contig names (1 → chr1, MT →
  // chrM), whatever the user typed or the annotation calls it.
  const setViewport = (chrom: string, start: number, end: number) =>
    navigate(findChromInfo(chroms, chrom)?.name ?? chrom, start, end);
  // Relative (TSS) coordinates describe the main view only.
  const showRelativeCoords = !viewport && store.showRelativeCoords;
  const isPanelBox = Boolean(viewport) || compact;
  // Filled from the start, so a freshly focused panel box can select it.
  const [inputValue, setInputValue] = useState(() => formatCoordinates(chrom, start, end));
  const [error, setError] = useState('');
  // Progress or the outcome of a run (e.g. "Searching chr19…").
  const [info, setInfo] = useState('');
  const [searching, setSearching] = useState(false);
  const [providerRunning, setProviderRunning] = useState(false);
  const searchSeqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  // Typed by the user (not the view's own locus): the providers are asked.
  const [typing, setTyping] = useState(false);
  const [focused, setFocused] = useState(false);
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  // The view this box moves: its panel, else the main view (navigationIntent).
  const target: NavigationTarget = panelId ? { panelId } : 'main';

  // The context the providers search and run in: this box's view, navigation and reference.
  const providerContext = (signal: AbortSignal): SearchContext => ({
    source: isPanelBox ? 'panel-locus' : 'locus',
    signal,
    viewport: { chrom, start, end },
    // A panel's box moves its own panel; the main box lets each provider decide (main view, or the panel showing that place).
    navigate: onNavigate ? setViewport : undefined,
    chroms,
    genome,
    target,
    onProgress: (label) => setInfo(label),
  });

  // The reference this box searches (a panel's own, else the main genome, by its full FASTA path): another one means other answers.
  const referenceKey = contextReference({ genome }, { currentGenome: store.currentGenome, fastaPath: store.fastaPath, referencePairs: store.referencePairs } as never);
  const typed = inputValue.trim();
  const isCoordinates = Boolean(typed && parseCoordinates(typed));
  const search = useProviderSearch(
    inputValue,
    providerContext,
    `${isPanelBox ? 'panel' : 'main'}|${referenceKey}|${chrom}|${chroms.length}`,
    // Coordinates go straight there (no list); the view's own locus is not a query.
    typing && !disabled && !isCoordinates,
  );
  const list = useSuggestionList(search.groups, inputValue);
  const enterTarget = bestSuggestion(search.groups);
  const listShown = focused && typing && !disabled && list.open;

  // Update input when viewport changes externally
  useEffect(() => {
    setTyping(false);
    if (showRelativeCoords && relativeGene && relativeTSS !== null) {
      const d1 = start - relativeTSS;
      const d2 = end - relativeTSS;
      setInputValue(`${relativeGene.name} TSS ${d1 >= 0 ? '+' : ''}${d1} to ${d2 >= 0 ? '+' : ''}${d2}`);
    } else {
      setInputValue(formatCoordinates(chrom, start, end));
    }
  }, [chrom, start, end, showRelativeCoords, relativeTSS, relativeGene]);

  useEffect(() => () => {
    searchSeqRef.current += 1;
    abortRef.current?.abort();
  }, []);

  // An outcome ("<read> at chr19:…") goes after a while; progress stays while it runs.
  useEffect(() => {
    if (!info || providerRunning) return;
    const timer = window.setTimeout(() => setInfo(''), 8000);
    return () => window.clearTimeout(timer);
  }, [info, providerRunning]);

  const abortActiveSearch = () => {
    searchSeqRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setSearching(false);
    setProviderRunning(false);
  };

  const beginSearch = () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const searchSeq = searchSeqRef.current + 1;
    searchSeqRef.current = searchSeq;
    setSearching(true);
    return { controller, searchSeq };
  };

  const isCurrentSearch = (searchSeq: number, controller: AbortController) => (
    searchSeqRef.current === searchSeq && abortRef.current === controller && !controller.signal.aborted
  );

  const finishSearch = (searchSeq: number, controller: AbortController) => {
    if (!isCurrentSearch(searchSeq, controller)) return;
    abortRef.current = null;
    setSearching(false);
  };

  /** Run a suggestion here: its progress, Cancel and outcome under this box. */
  const runSuggestion = async (picked: SearchSuggestion): Promise<SearchRunResult> => {
    setTyping(false);
    list.close();
    setError('');
    if (picked.disabledReason) {
      abortActiveSearch();
      setInfo('');
      setError(picked.disabledReason);
      return { ok: false, message: picked.disabledReason };
    }
    const { controller, searchSeq } = beginSearch();
    setProviderRunning(true);
    setInfo(picked.kind === 'read' ? 'Searching…' : '');
    const res = await runSearchSuggestion(picked, providerContext(controller.signal));
    if (isCurrentSearch(searchSeq, controller)) {
      // Cancelled by the user: nothing to say; made stale (the view moved): why it did not go.
      if (res.cancelled) setInfo(res.message ?? '');
      else if (res.ok) {
        setInfo(res.message ?? '');
        rootRef.current?.querySelector('input')?.blur();
      }
      else { setInfo(''); setError(res.message || 'Not found'); }
    }
    finishSearch(searchSeq, controller);
    if (searchSeqRef.current === searchSeq) setProviderRunning(false);
    return res;
  };

  // The palette's picks run here (latest render's closure): the main box's, and a panel's own for that panel.
  const runRef = useRef(runSuggestion);
  runRef.current = runSuggestion;
  useEffect(() => {
    if (isPanelBox) return panelId ? setPanelLocusBoxRunner(panelId, s => runRef.current(s)) : undefined;
    return setMainLocusBoxRunner(s => runRef.current(s));
  }, [isPanelBox, panelId]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setInfo('');

    const trimmed = inputValue.trim();
    if (!trimmed) return;

    // A suggestion chosen with the arrow keys.
    const chosen = listShown ? list.chosen() : null;
    if (chosen) {
      await runSuggestion(chosen);
      return;
    }

    // Coordinates: straight there.
    const parsed = parseCoordinates(trimmed);
    if (parsed) {
      abortActiveSearch();
      setTyping(false);
      if (chroms.length > 0 && !findChromInfo(chroms, parsed.chrom)) {
        setError(`Unknown: ${parsed.chrom}`);
        return;
      }
      supersedeNavigationIntents(target);
      setViewport(parsed.chrom, parsed.start, parsed.end);
      rootRef.current?.querySelector('input')?.blur();
      return;
    }

    // The best match: now when no server answer could beat it, else once every provider has answered.
    let groups: SearchGroup[] = typing ? search.groups : [];
    let best = bestSuggestion(groups);
    if (!best || asyncAnswerCouldOutrank(best.score, trimmed)) {
      const { controller, searchSeq } = beginSearch();
      // A new Go to: answers still pending for this view are stale now.
      const intent = beginNavigationIntent(target);
      groups = await (search.complete() ?? searchProviders(trimmed, providerContext(controller.signal), 'all'));
      if (!isCurrentSearch(searchSeq, controller)) return;
      finishSearch(searchSeq, controller);
      // The view moved (a pan, another assembly, another Go to) while the genes were looked up: that Enter is stale.
      if (!intent.isCurrent()) return;
      best = bestSuggestion(groups);
    }
    if (best) {
      await runSuggestion(best);
      return;
    }
    const all = groups.flatMap(g => g.suggestions);
    const guesses = all.filter(s => s.guess);
    const blocked = all.find(s => s.disabledReason);
    if (guesses.length) setError(`Try: ${guesses.slice(0, 3).map(s => s.label).join(', ')}`);
    else if (blocked) setError(blocked.disabledReason!);
    else setError(`Nothing found for ${trimmed}`);
  };

  const hint = !listShown && typing && !isCoordinates ? enterTarget : null;

  return (
    <div ref={rootRef} className={`relative flex min-w-0 items-center gap-2${compact ? ' max-w-[14rem] flex-1' : ''}`}>
      <form onSubmit={handleSubmit} className={`flex min-w-0 items-center gap-1${compact ? ' flex-1' : ''}`}>
        <div className={compact ? 'relative min-w-0 flex-1' : 'relative'}>
          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500 text-sm">
            {searching ? '...' : ''}
          </span>
          <input
            type="text"
            value={inputValue}
            ref={inputRef}
            disabled={disabled}
            data-testid={compact ? 'panel-location-input' : 'location-search-input'}
            data-copilot-anchor={compact ? undefined : 'search-bar'}
            aria-label={ariaLabel ?? 'Genome location search'}
            onMouseDown={e => e.stopPropagation()}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={e => { if (listShown) list.onKeyDown(e); }}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={listShown}
            aria-controls={listId}
            aria-activedescendant={listShown && list.active >= 0 ? `${listId}-${list.active}` : undefined}
            onChange={e => {
              abortActiveSearch();
              setError('');
              setInfo('');
              setTyping(true);
              list.reopen();
              setInputValue(e.target.value);
            }}
            onPaste={e => {
              // A list of read names on several lines: a one-line box would glue them together.
              const text = e.clipboardData?.getData('text') ?? '';
              const flat = flattenPastedList(text);
              if (flat === text) return;
              e.preventDefault();
              const el = e.currentTarget;
              const from = el.selectionStart ?? el.value.length;
              const to = el.selectionEnd ?? el.value.length;
              abortActiveSearch();
              setError('');
              setInfo('');
              setTyping(true);
              list.reopen();
              setInputValue(el.value.slice(0, from) + flat + el.value.slice(to));
            }}
            className={compact ? 'w-full min-w-0 rounded border border-gray-300 bg-white px-1 py-0 font-mono text-[11px] text-gray-900 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100' : 'input-tool w-32 sm:w-56 lg:w-64 font-mono pl-2'}
            placeholder="chr:start-end, gene, region or read"
            title={disabled && disabledReason ? disabledReason : "Coordinates (chr:start-end), a gene name (TSS ± 5 kb), 'gene +/- 2kb' for a custom window around the TSS, a saved region's name, or read names (comma separated): goes to the reads and highlights them"}
          />
          {listShown && (
            <SearchSuggestionList id={listId} groups={search.groups} active={list.active} enterTarget={enterTarget}
              pending={search.pending} compact={compact} onPick={s => { void runSuggestion(s); }} onHover={list.setActive} />
          )}
        </div>
        <button
          type="submit"
          disabled={searching || disabled}
          onMouseDown={e => e.stopPropagation()}
          className={compact ? 'rounded bg-gray-200 px-1.5 text-[11px] text-gray-700 hover:bg-gray-300 disabled:opacity-40 dark:bg-gray-700 dark:text-gray-200' : 'btn-tool-primary'}
          title="Navigate to location"
          data-testid={compact ? 'panel-location-submit' : 'location-search-submit'}
        >
          Go
        </button>
      </form>

      {providerRunning && (
        <button
          type="button"
          onMouseDown={e => e.stopPropagation()}
          onClick={() => { abortActiveSearch(); setInfo(''); }}
          className={compact ? 'rounded border border-gray-300 px-1 text-[11px] text-gray-600 dark:border-gray-600 dark:text-gray-300' : 'btn-tool-default'}
          data-testid={compact ? 'panel-location-cancel' : 'location-search-cancel'}
        >
          Cancel
        </button>
      )}

      {!error && !listShown && (info || (hint && !searching)) && (
        // The best match for the text (Enter runs it) while the list is closed, a run's progress, or its outcome.
        <StatusBubble anchor={rootRef} detached={disabled}>
        <span
          role="status"
          data-testid={compact ? 'panel-location-info' : 'location-search-info'}
          className="absolute left-0 top-full z-40 mt-1 max-w-[28rem] truncate rounded border border-line bg-white px-1.5 py-0.5 text-xs text-gray-700 shadow-sm dark:border-white/10 dark:bg-gray-900 dark:text-gray-200"
          title={info || hint?.detail}
        >
          {info || (hint && (
            <><span className="font-medium text-gray-500 dark:text-gray-400">{KIND_TAG[hint.kind] ?? hint.kind}</span>{' · '}{hint.detail ?? hint.label}{' — Enter'}</>
          ))}
        </span>
        </StatusBubble>
      )}

      {error && (
        // Below the box, so a message never re-wraps the toolbar.
        <StatusBubble anchor={rootRef} detached={disabled}>
        <span role="status" data-testid={compact ? 'panel-location-error' : 'location-search-error'} className="absolute left-0 top-full z-40 mt-1 max-w-80 truncate rounded border border-red-200 bg-white px-1.5 py-0.5 text-xs text-red-600 shadow-sm dark:border-red-900 dark:bg-gray-900 dark:text-red-400" title={error}>
          {error}
        </span>
        </StatusBubble>
      )}
    </div>
  );
}
