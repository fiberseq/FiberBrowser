/**
 * "Reopen your last session" on launch (with crash recovery as the fallback).
 *
 * The page autosaves to IndexedDB (stores/historyStorage.ts) with the server
 * run's boot id. GET /api/session/launch (services/launch_state.py) says this
 * run's boot id and how the previous run on this port ended. On launch:
 *
 * - the save is from an earlier run that was quit normally: offer to reopen it,
 *   as the first button of the Welcome card ("Reopen last session · 2 datasets,
 *   chr2L:…"; or reopened without asking, a choice kept in the settings);
 * - a save from this run while another page of it is still open (a new tab):
 *   nothing, that page's session is live (utils/tabPresence.ts);
 * - otherwise (a crash or kill, a reload within this run, an older server, a
 *   save from before boot ids): the crash-recovery banner, when the save has
 *   work in it. The Welcome card shows beside it.
 */
import { create } from 'zustand';
import { fetchJson } from '../api/sharedFetch';
import type { SerializedState } from '../stores/historySlice';
import { isPublicMode } from './publicMode';
import { isPublicServerPage } from './publicServerFlag';
import { isSandboxPage } from './sandbox';

export type PreviousExit = 'none' | 'clean' | 'crash' | 'unknown';

export interface LaunchInfo {
  boot_id: string;
  previous_exit: PreviousExit;
  previous_boot_id: string | null;
  started?: number;
}

let launchInfoPromise: Promise<LaunchInfo | null> | null = null;

/** This server run's launch info (once per page); null from an older or unreachable server. */
export function getLaunchInfo(): Promise<LaunchInfo | null> {
  // A public server's visitors and tour tabs never reopen a session (and the route is theirs to refuse).
  if (isPublicMode() || isSandboxPage()) return Promise.resolve(null);
  if (!launchInfoPromise) {
    launchInfoPromise = fetchJson<LaunchInfo>('/api/session/launch')
      .then(info => (info && typeof info.boot_id === 'string' ? info : null))
      .catch(() => null);
  }
  return launchInfoPromise;
}

/** Tests: forget the cached launch info. */
export function resetLaunchInfoForTests(): void {
  launchInfoPromise = null;
}

/** What to do at launch after a normal quit: ask (default), reopen without asking, or start fresh. */
export type LastSessionPreference = 'ask' | 'reopen' | 'fresh';
const PREFERENCE_KEY = 'fiberbrowser.lastSessionOnLaunch';

export function getLastSessionPreference(): LastSessionPreference {
  try {
    const value = localStorage.getItem(PREFERENCE_KEY);
    return value === 'reopen' || value === 'fresh' ? value : 'ask';
  } catch {
    return 'ask';
  }
}

export function setLastSessionPreference(value: LastSessionPreference): void {
  try {
    if (value === 'ask') localStorage.removeItem(PREFERENCE_KEY);
    else localStorage.setItem(PREFERENCE_KEY, value);
  } catch { /* storage blocked: ask next time */ }
}

export interface LaunchOfferEntry {
  state: SerializedState;
  timestamp: number;
  acted?: boolean;
  bootId?: string | null;
}

/**
 * - `reopen`: offer "Reopen last session" on the Welcome card;
 * - `auto-reopen`: reopen it without asking (remembered choice);
 * - `recover`: the crash-recovery offer;
 * - `discard`: start fresh without asking (remembered): the saved session is dropped;
 * - null: nothing to offer.
 */
export type LaunchOffer = 'reopen' | 'auto-reopen' | 'recover' | 'discard' | null;

export function decideLaunchOffer(
  entry: LaunchOfferEntry | null,
  launch: LaunchInfo | null,
  options: {
    hasWork: (state: SerializedState) => boolean; preference?: LastSessionPreference;
    /** Another page of this server run is open now (utils/tabPresence.ts). */
    otherTabLive?: boolean;
  },
): LaunchOffer {
  if (!entry) return null;
  const fromEarlierRun = Boolean(entry.bootId && launch && entry.bootId !== launch.boot_id);
  // Saved in this run by a page that is still open (a new tab next to it): that page's live session, not a crash.
  if (!fromEarlierRun && entry.bootId && launch && options.otherTabLive) return null;
  if (fromEarlierRun && launch?.previous_exit === 'clean') {
    // A normal quit: anything that was open is worth offering back.
    const datasets = entry.state.datasets?.length ?? 0;
    if (datasets === 0 && !entry.acted && !options.hasWork(entry.state)) return null;
    const preference = options.preference ?? 'ask';
    if (preference === 'fresh') return 'discard';
    return preference === 'reopen' ? 'auto-reopen' : 'reopen';
  }
  return entry.acted || options.hasWork(entry.state) ? 'recover' : null;
}

/** "2 datasets, chr2L:1,000-2,000" for the offer. */
export function describeSavedSession(state: SerializedState): string {
  const parts: string[] = [];
  const n = state.datasets?.length ?? 0;
  if (n > 0) parts.push(`${n} dataset${n === 1 ? '' : 's'}`);
  if (state.chrom) parts.push(`${state.chrom}:${(state.start ?? 0).toLocaleString()}-${(state.end ?? 0).toLocaleString()}`);
  return parts.join(', ');
}

// While the launch offer is up (or still being decided) and nothing has been
// done yet, the new page's autosave must not replace the session being offered
// (a CLI-loaded dataset would otherwise overwrite it). Undecided counts for a
// little while only: a page without the offer (public mode) saves as before.
const DECIDING_MS = 15_000;
let loadedAt = Date.now();
let offerPending = false;
let decided = false;
export function setLaunchOfferPending(pending: boolean): void {
  offerPending = pending;
  decided = true;
}
export function launchOfferPending(): boolean {
  return offerPending || (!decided && Date.now() - loadedAt < DECIDING_MS);
}
/**
 * The last session was declined (a command-line dataset took precedence, or another session was started instead of
 * reopening it): this page's session replaces it on its next save, even a save with nothing done yet ("Start fresh").
 * Crash recovery keeps the older rule (a save with work isn't replaced by an idle page).
 */
let superseded = false;
export function supersedeLastSession(): void {
  superseded = true;
}
export function lastSessionSuperseded(): boolean {
  return superseded;
}
/** Tests: back to a page that has not decided yet. */
export function resetLaunchOfferForTests(decidedNow = true): void {
  loadedAt = Date.now();
  offerPending = false;
  decided = decidedNow;
  superseded = false;
}

/**
 * What the launch offer is doing, for the rest of the page: while the offer is
 * being decided (briefly) or a session is being restored the Welcome card
 * waits (no flash over a dataset opened on the command line); the last session
 * itself is offered on the Welcome card. While a session is being restored the
 * genome-mismatch banner waits too (the page is half-restored: its buttons would
 * fight the restore).
 */
export interface LastSessionOffer {
  /** "2 datasets, chr2L:1,000-2,000". */
  summary: string;
  /** When it was saved (ms). */
  savedAt: number;
  reopen: () => void;
}

export interface LaunchUiState {
  /** Deciding whether to offer the last session (briefly, at launch). */
  deciding: boolean;
  /** The crash-recovery banner (or an automatic reopen's note) is up. */
  offerShown: boolean;
  /** The last session, offered on the Welcome card; null: none. */
  lastSession: LastSessionOffer | null;
  /** A saved session is being restored. */
  restoring: boolean;
}

/**
 * A page that will decide (CrashRecoveryBanner mounts on every local page but
 * a tour tab) starts out deciding: the decision starts in an effect, after the
 * first render has drawn the empty browser, and the Welcome card flashed for
 * that frame (~20 ms) over a dataset opened on the command line or under the
 * offer. If nothing starts deciding within the cap, the card comes back.
 */
export const LAUNCH_DECIDING_MAX_MS = 3_000;

function decidesAtLaunch(): boolean {
  if (typeof window === 'undefined') return false;
  if ((window as unknown as { __FIBERBROWSER_RENDER_MODE?: boolean }).__FIBERBROWSER_RENDER_MODE) return false;
  return !isPublicServerPage() && !isSandboxPage();
}

export const useLaunchUiStore = create<LaunchUiState>(() => ({ deciding: decidesAtLaunch(), offerShown: false, restoring: false, lastSession: null }));

let decisionStarted = false;
if (useLaunchUiStore.getState().deciding) {
  setTimeout(() => {
    if (!decisionStarted) useLaunchUiStore.setState({ deciding: false });
  }, LAUNCH_DECIDING_MAX_MS);
}

export function setLaunchUi(partial: Partial<LaunchUiState>): void {
  if (partial.deciding !== undefined) decisionStarted = true;
  useLaunchUiStore.setState(partial);
}

/** The Welcome card waits while the launch offer is being decided or a session is being restored. */
export function launchOfferHidesWelcome(s: LaunchUiState): boolean {
  return s.deciding || s.restoring;
}
