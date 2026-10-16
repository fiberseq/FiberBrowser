/**
 * Navigation intents (fb-r5-search): the one guard every search answer that
 * comes back later (a read lookup, a gene the server suggested, an Enter that
 * waited for the gene list) passes before it moves a view or selects reads.
 *
 * An intent is taken when the user asks (before the first await): which view
 * it will move (its target: the main view, or one panel's own), and a
 * sequence number per target. It is still current only while
 *
 * - no later intent was taken for the same target (only the latest Go to
 *   moves it; a panel's Linked peers, which move with it, count as the same
 *   target),
 * - the target has not moved at all since (a pan or zoom, even one that came
 *   back to the same place, a resize, another assembly or FASTA, a closed
 *   panel), and
 * - no other session or snapshot was opened.
 *
 * A read found from the main box goes to the panel that has it; such an
 * answer also checks that panel has not moved (`isCurrent([panel])`).
 */
import { useBrowserStore } from '../../stores/browserStore';
import { useReadActionsStore } from '../../stores/readActionsStore';
import { linkGroupPeers } from '../panelNavigation';

/** The view an answer moves: the main one, or a panel's own (its locus box). */
export type NavigationTarget = 'main' | { panelId: string };

type Store = ReturnType<typeof useBrowserStore.getState>;

type ReferenceFields = Pick<Store, 'currentGenome' | 'fastaPath'> & { referencePairs?: Array<{ fasta: string }> | null };

/**
 * The main genome, exactly: its registry id, FASTA path and the FASTA of each
 * loaded pair (two FASTAs both called reference.fa are two references, unlike
 * the region catalog's key; replacing one haplotype's FASTA is another reference).
 */
export function mainReferenceIdentity(s: Pick<Store, 'currentGenome' | 'fastaPath'> = useBrowserStore.getState()): string {
  const pairs = (s as ReferenceFields).referencePairs;
  return JSON.stringify([s.currentGenome || null, s.fastaPath || null, Array.isArray(pairs) ? pairs.map(p => p?.fasta ?? null) : null]);
}

/** The reference a search context's answers are coordinates on (a panel's own, else the main genome). */
export function contextReference(ctx: { genome?: string | null }, s: Pick<Store, 'currentGenome' | 'fastaPath'> = useBrowserStore.getState()): string {
  return ctx.genome ? `panel:${ctx.genome}` : mainReferenceIdentity(s);
}

const keyOf = (target: NavigationTarget | null | undefined): string =>
  (!target || target === 'main' ? 'main' : `panel:${target.panelId}`);

/** What a target shows (reference and locus); null: it is gone (a closed panel). */
function viewOf(key: string, s: Store): string | null {
  if (key === 'main') return JSON.stringify([mainReferenceIdentity(s), s.chrom, s.start, s.end]);
  const panel = s.panels.find(p => `panel:${p.id}` === key);
  if (!panel) return null;
  const vp = panel.viewportOverride ?? { chrom: s.chrom, start: s.start, end: s.end };
  return JSON.stringify([panel.genome ? `panel:${panel.genome}` : mainReferenceIdentity(s), vp.chrom, vp.start, vp.end]);
}

// Each target's moves, counted as they happen (so a pan away and back is a move).
const moveCount = new Map<string, number>();
const lastView = new Map<string, string | null>();
let watching = false;

function noteViews(s: Store): void {
  const keys = ['main', ...s.panels.map(p => `panel:${p.id}`), ...[...lastView.keys()].filter(k => k !== 'main')];
  for (const key of new Set(keys)) {
    const view = viewOf(key, s);
    if (lastView.has(key) && lastView.get(key) !== view) moveCount.set(key, (moveCount.get(key) ?? 0) + 1);
    if (view === null) lastView.delete(key);
    else lastView.set(key, view);
  }
}

function watch(): void {
  if (watching) return;
  watching = true;
  noteViews(useBrowserStore.getState());
  useBrowserStore.subscribe((s, prev) => {
    if (s.panels === prev.panels && s.chrom === prev.chrom && s.start === prev.start && s.end === prev.end
      && s.currentGenome === prev.currentGenome && s.fastaPath === prev.fastaPath
      && (s as ReferenceFields).referencePairs === (prev as ReferenceFields).referencePairs) return;
    noteViews(s);
  });
}

/** The sequence keys a Go to on `target` supersedes: itself, and a panel's Linked peers (they move together). */
function groupKeys(target: NavigationTarget | null | undefined, s: Store = useBrowserStore.getState()): string[] {
  if (!target || target === 'main') return ['main'];
  const panel = s.panels.find(p => p.id === target.panelId);
  if (!panel) return [keyOf(target)];
  return linkGroupPeers(s.panels, panel, s.navigationMode).map(id => `panel:${id}`);
}

const sequences = new Map<string, number>();

export interface NavigationIntent {
  readonly target: NavigationTarget;
  /**
   * Still the latest for its target, which has not moved, in the same session.
   * `alsoUnmoved`: other views the answer will move (the panel that has a read):
   * they must not have moved, nor been asked to go elsewhere meanwhile.
   */
  isCurrent(alsoUnmoved?: NavigationTarget[]): boolean;
}

/**
 * Take an intent for `target` now. By default it supersedes the target's
 * pending ones (the latest request wins); `{ supersede: false }` only watches.
 */
export function beginNavigationIntent(
  target: NavigationTarget | null | undefined = 'main',
  { supersede = true }: { supersede?: boolean } = {},
): NavigationIntent {
  watch();
  const key = keyOf(target);
  if (supersede) supersedeNavigationIntents(target);
  const seq = sequences.get(key) ?? 0;
  const moves = new Map(moveCount);
  const asked = new Map(sequences);
  const s0 = useBrowserStore.getState();
  const exists = viewOf(key, s0) !== null;
  const epoch = useReadActionsStore.getState().epoch;
  const unmoved = (k: string) => (moveCount.get(k) ?? 0) === (moves.get(k) ?? 0) && viewOf(k, useBrowserStore.getState()) !== null;
  return {
    target: target ?? 'main',
    isCurrent: (alsoUnmoved = []) => (
      exists
      && (sequences.get(key) ?? 0) === seq
      && useReadActionsStore.getState().epoch === epoch
      && unmoved(key)
      && alsoUnmoved.every(t => unmoved(keyOf(t)) && (sequences.get(keyOf(t)) ?? 0) === (asked.get(keyOf(t)) ?? 0))
    ),
  };
}

/** A navigation made at once (a locus, a gene already known): the target's pending answers are stale. */
export function supersedeNavigationIntents(target: NavigationTarget | null | undefined = 'main'): void {
  for (const key of groupKeys(target)) sequences.set(key, (sequences.get(key) ?? 0) + 1);
}
