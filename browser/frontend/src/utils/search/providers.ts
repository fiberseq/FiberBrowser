/**
 * Search providers: places to go to from what the user types, shared by the
 * main locus box, each panel's locus box and the command palette. One
 * registry, one interface, for every kind of place:
 *
 * - coordinates and genes (./locusProviders),
 * - saved regions and their categories (./regionProvider),
 * - read names (./readProvider);
 *
 * all registered by ./builtinProviders (import it where suggestions are shown).
 *
 * A provider gets the query and a context (where it was typed, the view there,
 * that box's own navigation and reference, an AbortSignal) and returns
 * suggestions, now or as a promise. Providers marked `async` call the server:
 * they are asked once typing pauses, and their request is aborted when the
 * query changes. `searchProviders` asks the providers and returns the
 * suggestions grouped by provider, best first.
 *
 * Every suggestion scores on one scale (SEARCH_SCORE): a strong hit (>= 500:
 * coordinates, a read name, the gene named exactly so, a region named exactly
 * so) is listed first in the palette, and Enter in a locus box runs the best
 * runnable suggestion. An exact gene (900) always beats an exact region (700),
 * so a region named after a gene never shadows it.
 *
 * Running a suggestion takes the context it runs in (a fresh signal for
 * Cancel, progress for a long search) and answers what happened
 * (SearchRunResult: a message for the box's status line, or cancelled).
 *
 *   registerSearchProvider({
 *     id: 'bookmarks', kind: 'region', label: 'Bookmarks', order: 40,
 *     search: query => matching(query).map(b => ({
 *       id: b.id, kind: 'region', label: b.name, detail: b.locus,
 *       score: 300, run: ctx => goTo(b, ctx.navigate),
 *     })),
 *   });
 */
import type { ChromInfo } from '../../types';
import { contextReference, supersedeNavigationIntents, type NavigationTarget } from './navigationIntent';
import type { SearchTarget } from './paletteTargets';

export type SearchSuggestionKind = 'locus' | 'gene' | 'region' | 'category' | 'read' | (string & {});

/** The one score scale (higher first). */
export const SEARCH_SCORE = {
  locus: 1000,
  read: 950,
  geneExact: 900,
  regionExact: 700,
  /** At or above: a strong hit (the palette lists it before commands). */
  strong: 500,
  geneNear: 400,
  /** A spelling suggestion ("no gene named NAP: NAPA?"). */
  guess: 150,
} as const;

/** Where the query was typed and what a suggestion may act on. */
export interface SearchContext {
  /** 'locus': the main locus box; 'panel-locus': a panel's own box; 'palette': the command palette. */
  source: 'locus' | 'panel-locus' | 'palette';
  /** Aborts the search (the query changed) or the run (Cancel). */
  signal: AbortSignal;
  /** The view the box shows (searches start there; a panel's box prefers its chromosome). */
  viewport?: { chrom: string; start: number; end: number } | null;
  /** The box's own navigation (a panel's box); absent: the provider decides (the main view, or the panel showing that place). */
  navigate?: (chrom: string, start: number, end: number) => void;
  /** The box's reference's chromosomes (a panel on another assembly); absent: the main genome's. */
  chroms?: ChromInfo[];
  /** A panel's own reference (null/undefined: the main genome). */
  genome?: string | null;
  /**
   * The view a run moves (a panel's box: that panel; absent: the main view).
   * Answers that come back later check it has not moved meanwhile (./navigationIntent).
   */
  target?: NavigationTarget;
  /** Progress of a running suggestion ("Searching chr19…"). */
  onProgress?: (label: string) => void;
  /**
   * The command palette: the panels a place can go to, one per reference on
   * screen (./paletteTargets). Each provider (unless `perReference: false`) is
   * asked once per target, with that panel's own context; its suggestions
   * keep the target (`runIn`) and are labelled by reference when there are several.
   */
  targets?: readonly SearchTarget[];
}

export interface SearchRunResult {
  ok: boolean;
  /** What happened, for the box's status line ("Read not found…"). */
  message?: string;
  cancelled?: boolean;
}

export interface SearchSuggestion {
  /** Unique within its provider. */
  id: string;
  /** What it is (shown as a tag / icon). */
  kind: SearchSuggestionKind;
  /** The place: "NAPA", "chr1:1,000-2,000", a region's name, a read name. The palette shows "Go to <label>". */
  label: string;
  /** A second line: the coordinates, the region's category, what running it does. */
  detail?: string;
  /** SEARCH_SCORE's scale. */
  score: number;
  /** Shown instead of running (e.g. the main view can't move from here). */
  disabledReason?: string;
  /** A spelling suggestion: listed, but never what Enter runs by itself. */
  guess?: boolean;
  /**
   * Coordinates on this reference (navigationIntent.contextReference of the
   * search's context): refused when run where another reference is shown
   * (the assembly changed between the search and the run).
   */
  reference?: string;
  /** Found for this palette target (SearchContext.targets): it runs there (that panel's locus box). */
  runIn?: SearchTarget;
  /** The reference it is on, when the palette shows several ("dm6"). */
  referenceLabel?: string;
  run: (ctx: SearchContext) => SearchRunResult | string | null | void | Promise<SearchRunResult | string | null | void>;
}

export interface SearchProvider {
  id: string;
  kind: SearchSuggestionKind;
  /** The group heading: "Loci", "Genes", "Regions", "Reads". */
  label: string;
  /** Group order (lower first) when scores tie. */
  order?: number;
  /** Calls the server: asked once typing pauses, its request aborted when the query changes. */
  async?: boolean;
  /** The best score it can give (an async provider's: a sync hit above it is run without waiting). */
  maxScore?: number;
  /**
   * Whether it could answer this query at all (an async provider's: when it can't,
   * nothing waits for it). Absent: it could.
   */
  mightAnswer?(query: string): boolean;
  /**
   * Asked once per palette target (each reference on screen), default true.
   * False: asked once with the palette's own context (read names: the read's
   * own panel shows it, whatever the reference).
   */
  perReference?: boolean;
  search(query: string, ctx: SearchContext): SearchSuggestion[] | Promise<SearchSuggestion[]>;
  /** Its answers changed (a renamed region): the open lists ask again. Returns the unsubscribe. */
  subscribe?(onChange: () => void): () => void;
}

export interface SearchGroup {
  provider: SearchProvider;
  suggestions: SearchSuggestion[];
}

const providers = new Map<string, SearchProvider>();

/** Add (or replace, by id) a provider; returns the function that removes it. */
export function registerSearchProvider(provider: SearchProvider): () => void {
  providers.set(provider.id, provider);
  return () => {
    if (providers.get(provider.id) === provider) providers.delete(provider.id);
  };
}

export function getSearchProviders(): SearchProvider[] {
  return [...providers.values()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
}

const byScore = (a: SearchSuggestion, b: SearchSuggestion) => b.score - a.score || a.label.localeCompare(b.label);

/** The context of one palette target (its panel's own box). */
function targetContext(ctx: SearchContext, target: SearchTarget): SearchContext {
  return { ...ctx, ...target.context, targets: undefined };
}

/**
 * One provider's suggestions for every palette target: ids made unique per
 * target, labelled by reference when there are several; a place offered on
 * one reference is not also listed disabled for another ("No chromosome chr2R
 * in this reference"), unless no reference has it.
 */
function mergeTargets(perTarget: Array<{ target: SearchTarget; suggestions: SearchSuggestion[] }>, labelled: boolean): SearchSuggestion[] {
  const out: SearchSuggestion[] = [];
  // One target: the ids as the provider gave them (as the locus boxes list them).
  const several = perTarget.length > 1;
  for (const { target, suggestions } of perTarget) {
    for (const s of suggestions) {
      out.push({
        ...s,
        id: several ? `${target.key}|${s.id}` : s.id,
        runIn: target,
        ...(labelled ? { referenceLabel: target.referenceLabel } : {}),
      });
    }
  }
  if (!several) return out;
  const baseId = (s: SearchSuggestion) => s.id.slice(s.id.indexOf('|') + 1);
  const enabled = new Set(out.filter(s => !s.disabledReason).map(baseId));
  const keptDisabled = new Set<string>();
  return out.filter(s => {
    if (!s.disabledReason) return true;
    const id = baseId(s);
    if (enabled.has(id) || keptDisabled.has(id)) return false;
    keptDisabled.add(id);
    return true;
  });
}

/** Ask one provider: once, or once per palette target. */
function askProvider(
  provider: SearchProvider,
  query: string,
  ctx: SearchContext,
): SearchSuggestion[] | Promise<SearchSuggestion[]> {
  const targets = ctx.targets;
  if (!targets?.length || provider.perReference === false) return provider.search(query, { ...ctx, targets: undefined });
  const labelled = new Set(targets.map(t => t.genomeKey)).size > 1;
  const answers = targets.map(target => {
    try {
      return provider.search(query, targetContext(ctx, target));
    } catch {
      return [];
    }
  });
  if (answers.every(Array.isArray)) {
    return mergeTargets((answers as SearchSuggestion[][]).map((suggestions, i) => ({ target: targets[i], suggestions })), labelled);
  }
  return Promise.all(answers.map(a => Promise.resolve(a).catch(() => [] as SearchSuggestion[])))
    .then(all => mergeTargets(all.map((suggestions, i) => ({ target: targets[i], suggestions })), labelled));
}

/**
 * Ask the providers (`which`: 'sync' only the immediate ones, 'async' only the
 * server ones, 'all' both). A provider that throws or is aborted gives nothing.
 */
export async function searchProviders(
  query: string,
  ctx: SearchContext,
  which: 'sync' | 'async' | 'all' = 'all',
): Promise<SearchGroup[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const chosen = getSearchProviders().filter(p => which === 'all' || (which === 'async') === Boolean(p.async));
  const groups = await Promise.all(chosen.map(async provider => {
    try {
      const suggestions = await askProvider(provider, trimmed, ctx);
      return { provider, suggestions: [...suggestions].sort(byScore) };
    } catch {
      return { provider, suggestions: [] };
    }
  }));
  if (ctx.signal.aborted) return [];
  return groups.filter(group => group.suggestions.length > 0);
}

/** The immediate providers' suggestions without waiting (for the first frame). */
export function searchProvidersNow(query: string, ctx: SearchContext): SearchGroup[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const out: SearchGroup[] = [];
  for (const provider of getSearchProviders()) {
    if (provider.async) continue;
    try {
      const result = askProvider(provider, trimmed, ctx);
      if (Array.isArray(result) && result.length > 0) out.push({ provider, suggestions: [...result].sort(byScore) });
    } catch { /* nothing from this one */ }
  }
  return out;
}

/** Groups ordered by their best suggestion (ties: provider order); each group's suggestions best first. */
export function orderGroups(groups: readonly SearchGroup[]): SearchGroup[] {
  return [...groups]
    .filter(g => g.suggestions.length > 0)
    .map(g => ({ provider: g.provider, suggestions: [...g.suggestions].sort(byScore) }))
    .sort((a, b) => b.suggestions[0].score - a.suggestions[0].score || (a.provider.order ?? 100) - (b.provider.order ?? 100));
}

/** What Enter runs: the best suggestion that can run and isn't a spelling guess. */
export function bestSuggestion(groups: readonly SearchGroup[]): SearchSuggestion | null {
  let best: SearchSuggestion | null = null;
  for (const group of groups) {
    for (const s of group.suggestions) {
      if (s.disabledReason || s.guess) continue;
      if (!best || s.score > best.score) best = s;
    }
  }
  return best;
}

/** The best score any server provider could still give (for this query, if given): a sync hit above it needn't wait. */
export function asyncScoreCeiling(query?: string): number {
  let max = -Infinity;
  for (const p of providers.values()) {
    if (!p.async) continue;
    if (query !== undefined && p.mightAnswer && !p.mightAnswer(query)) continue;
    max = Math.max(max, p.maxScore ?? Infinity);
  }
  return max;
}

/** Whether a server provider could answer this query at all (else nothing need wait for one). */
export function asyncProviderMightAnswer(query: string): boolean {
  return asyncScoreCeiling(query) > -Infinity;
}

/**
 * Whether a server answer still to come for this query (a gene) could outrank a
 * hit scored so (undefined: not a place, e.g. a command, which an exact gene is
 * listed above, or nothing listed yet).
 * Enter then waits for the server before running the best match (the locus
 * boxes and the command palette alike); above the ceiling it runs at once.
 */
export function asyncAnswerCouldOutrank(score: number | undefined, query: string): boolean {
  if (!asyncProviderMightAnswer(query)) return false;
  return score === undefined || score <= asyncScoreCeiling(query);
}

/** A run's answer in one shape: nothing → ok; a string → what went wrong. */
export function normalizeRunResult(result: SearchRunResult | string | null | void): SearchRunResult {
  if (result && typeof result === 'object') return result;
  if (typeof result === 'string' && result) return { ok: false, message: result };
  return { ok: true };
}

/** Run a suggestion and answer what happened (an abort is a cancel, a throw a failure). */
export async function runSearchSuggestion(suggestion: SearchSuggestion, ctx: SearchContext): Promise<SearchRunResult> {
  if (suggestion.disabledReason) return { ok: false, message: suggestion.disabledReason };
  if (suggestion.reference != null && suggestion.reference !== contextReference(ctx)) {
    return { ok: false, message: `The reference changed since ${suggestion.label} was found: search again.` };
  }
  // A new Go to, even to where the view already is: answers still pending for this view are stale.
  supersedeNavigationIntents(ctx.target);
  try {
    const res = normalizeRunResult(await suggestion.run(ctx));
    return ctx.signal.aborted ? { ok: false, cancelled: true } : res;
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError' || ctx.signal.aborted) return { ok: false, cancelled: true };
    return { ok: false, message: 'Search failed' };
  }
}

/**
 * The main locus box runs what the palette picks (it shows the progress, Cancel
 * and the outcome, as if typed there). Registered while it is mounted.
 */
type MainBoxRunner = (suggestion: SearchSuggestion) => Promise<SearchRunResult>;
let mainBoxRunner: MainBoxRunner | null = null;
/** Each panel's own locus box, while mounted (a palette pick for that panel runs there). */
const panelBoxRunners = new Map<string, MainBoxRunner>();

export function setMainLocusBoxRunner(runner: MainBoxRunner): () => void {
  mainBoxRunner = runner;
  return () => { if (mainBoxRunner === runner) mainBoxRunner = null; };
}

export function setPanelLocusBoxRunner(panelId: string, runner: MainBoxRunner): () => void {
  panelBoxRunners.set(panelId, runner);
  return () => { if (panelBoxRunners.get(panelId) === runner) panelBoxRunners.delete(panelId); };
}

/**
 * Run a suggestion chosen in the palette where it was found for: the panel's
 * own locus box (a target panel), else the main locus box; when that box is
 * not on screen, on its own with the context it was found in.
 */
export function runFromPalette(suggestion: SearchSuggestion): Promise<SearchRunResult> {
  const panelId = suggestion.runIn?.panelId;
  if (panelId) {
    const runner = panelBoxRunners.get(panelId);
    if (runner) return runner(suggestion);
    return runSearchSuggestion(suggestion, { source: 'palette', signal: new AbortController().signal, ...suggestion.runIn!.context });
  }
  if (mainBoxRunner) return mainBoxRunner(suggestion);
  return runSearchSuggestion(suggestion, { source: 'palette', signal: new AbortController().signal, ...(suggestion.runIn?.context ?? {}) });
}
