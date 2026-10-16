import { useEffect, useRef, useState } from 'react';
import {
  asyncProviderMightAnswer, orderGroups, searchProviders, searchProvidersNow, getSearchProviders,
  type SearchContext, type SearchGroup,
} from '../utils/search/providers';

export const SEARCH_DEBOUNCE_MS = 180;
const EMPTY: SearchGroup[] = [];

/**
 * The search providers' answers for a query, as both the locus boxes and the
 * command palette show them: the immediate providers at once, the server ones
 * (genes) once typing pauses, each request aborted when the query changes.
 *
 * `makeContext` builds the context for a search (it is read when the query or
 * `contextKey` changes, so a new callback each render costs nothing).
 * `complete()` waits for every provider's answer for the current query (Enter
 * before the debounce: it starts the server search at once, and asks nothing twice);
 * it answers nothing once that search is aborted (the query or context changed).
 * Answers are kept with the context they were asked in: once `contextKey`
 * changes (another assembly), the old ones are never returned, not even for
 * the render before the new search starts.
 */
export function useProviderSearch(
  query: string,
  makeContext: (signal: AbortSignal) => SearchContext,
  contextKey: string,
  enabled = true,
): { groups: SearchGroup[]; pending: boolean; complete: () => Promise<SearchGroup[]> | null } {
  const [answer, setAnswer] = useState<{ contextKey: string; query: string; groups: SearchGroup[]; pending: boolean }>(
    { contextKey, query: query.trim(), groups: [], pending: false },
  );
  const [version, setVersion] = useState(0);
  const contextRef = useRef(makeContext);
  contextRef.current = makeContext;
  const current = useRef<{ query: string; contextKey: string; all: () => Promise<SearchGroup[]> } | null>(null);

  // A provider's answers changed (a renamed region): ask again.
  useEffect(() => {
    const offs = getSearchProviders().map(p => p.subscribe?.(() => setVersion(v => v + 1)));
    return () => { for (const off of offs) off?.(); };
  }, []);

  const trimmed = query.trim();
  useEffect(() => {
    current.current = null;
    if (!enabled || !trimmed) {
      setAnswer({ contextKey, query: trimmed, groups: [], pending: false });
      return;
    }
    const controller = new AbortController();
    const ctx = contextRef.current(controller.signal);
    const now = searchProvidersNow(trimmed, ctx);
    // (A server provider that can't answer this query isn't waited for: a command's words aren't a gene.)
    const hasAsync = asyncProviderMightAnswer(trimmed);
    setAnswer({ contextKey, query: trimmed, groups: orderGroups(now), pending: hasAsync });
    let later: Promise<SearchGroup[]> | null = null;
    // Aborted (the query or context changed): nothing, so an Enter waiting on it runs nothing stale.
    const all = () => {
      if (!later) {
        later = searchProviders(trimmed, ctx, 'async').then(found => (controller.signal.aborted ? [] : orderGroups([...now, ...found])));
        // Asked early (Enter before the typing pause): listed as soon as it answers.
        void later.then(found => {
          if (!controller.signal.aborted) setAnswer({ contextKey, query: trimmed, groups: found, pending: false });
        });
      }
      return later;
    };
    current.current = { query: trimmed, contextKey, all };
    if (!hasAsync) return () => controller.abort();
    const timer = window.setTimeout(() => { void all(); }, SEARCH_DEBOUNCE_MS);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [trimmed, contextKey, enabled, version]);

  // Asked in another context, or for the text before (a key pressed before this text's
  // search has started): not answers for this one (still to come).
  const fresh = answer.contextKey === contextKey && answer.query === trimmed;
  return {
    groups: fresh ? answer.groups : EMPTY,
    pending: fresh ? answer.pending : Boolean(enabled && trimmed),
    complete: () => (current.current && current.current.query === trimmed && current.current.contextKey === contextKey ? current.current.all() : null),
  };
}
