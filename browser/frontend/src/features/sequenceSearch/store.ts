/**
 * Find sequence in genome: the query, the settings, the running search and its result. Polling lives here
 * (module level), not in the panel, so a search keeps going while the panel is folded or closed; the result
 * stays until the next search.
 *
 * The server (routers/sequence_search.py) runs each search as a background job: POST starts it (a bad query or
 * no genome is answered at once), GET polls it, DELETE cancels it (a BLAST database build too).
 */
import { create } from 'zustand';
import { fetchJson } from '../../api/sharedFetch';
import { useBrowserStore } from '../../stores/browserStore';
import { findChromInfo } from '../../utils/chromAliases';
import { mainGenomeKey, regionTarget } from '../../utils/regionNavigation';
import { supersedeNavigationIntents } from '../../utils/search/navigationIntent';
import { registerBackendBedTrack } from './track';
import {
  DEFAULT_SETTINGS, hitLocus, hitWindow, parseSequence,
  type SearchResult, type SearchSettings, type SequenceHit,
} from './model';

export const SEQUENCE_SEARCH_PANEL = 'sequence-search';
/** The one highlight a search's clicked hit gets (moved to the next hit clicked, never one per click). */
export const HIT_HIGHLIGHT_ID = 'seqsearch-hit';

export interface SearchStatus {
  genome: string | null;
  genome_loaded: boolean;
  searchable: boolean;
  problem: { code: string; message: string } | null;
  plasmids: string[];
  reference_id: string;
  blast: { available: boolean; blastn: boolean; makeblastdb: boolean; db_ready: boolean; hint: string };
  defaults: SearchSettings;
}

export type RunState = 'idle' | 'running' | 'done' | 'error' | 'cancelled';

export interface SequenceSearchState {
  query: string;
  settings: SearchSettings;
  status: SearchStatus | null;
  statusError: string | null;
  run: RunState;
  jobId: string | null;
  message: string;
  progress: number;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  errorCode: string | null;
  result: SearchResult | null;
  /** The hit last clicked (its index in result.hits). */
  activeHit: number | null;
  /** The track the hits were added as (this result's). */
  trackJobId: string | null;
  notice: string | null;
  /** The loaded reference changed and the status has not been re-read since: hits can't be followed or added. */
  referencePending: boolean;
}

const initial = (): SequenceSearchState => ({
  query: '', settings: { ...DEFAULT_SETTINGS }, status: null, statusError: null,
  run: 'idle', jobId: null, message: '', progress: 0, startedAt: null, finishedAt: null,
  error: null, errorCode: null, result: null, activeHit: null, trackJobId: null, notice: null, referencePending: false,
});

export const useSequenceSearch = create<SequenceSearchState>(() => initial());

/** Back to the start (tests). */
export function resetSequenceSearch(): void {
  generation += 1;
  wantedStart = null;
  inFlight.clear();
  deferred.length = 0;
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  useSequenceSearch.setState(initial(), true);
}

const POLL_MS = 400;
let generation = 0;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let settingsTouched = false;
/** The search identity (canonical sequence and settings) of the latest start still wanted (null after Cancel): a
 *  superseded or cancelled start's job is cancelled when its reply arrives, unless the latest start asks for the same
 *  search (the server returns the same running job for it). */
let wantedStart: string | null = null;
/** The identities of the start requests not answered yet (by generation). */
const inFlight = new Map<number, string>();
/** Jobs of superseded starts whose equivalent newer start had not answered yet: kept until it answers (it may be
 *  given the same job), then cancelled unless it was. */
const deferred: Array<{ jobId: string; identity: string }> = [];

/** What the server's job key sees of a request: the normalized sequence and the settings (key order ignored). */
function searchIdentity(seq: string, settings: SearchSettings): string {
  const entries = Object.entries(settings as unknown as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([seq, entries]);
}

/** Cancel the deferred jobs no unanswered equivalent start can still adopt (the shown job is never cancelled here). */
function settleDeferred(): void {
  const waiting = new Set(inFlight.values());
  for (let i = deferred.length - 1; i >= 0; i--) {
    const d = deferred[i];
    if (wantedStart === d.identity && waiting.has(d.identity)) continue;
    deferred.splice(i, 1);
    if (useSequenceSearch.getState().jobId !== d.jobId) void deleteJob(d.jobId);
  }
}

const set = (patch: Partial<SequenceSearchState>) => useSequenceSearch.setState(patch);

export function setQuery(query: string): void {
  set({ query });
}

export function setSettings(patch: Partial<SearchSettings>): void {
  settingsTouched = true;
  set({ settings: { ...useSequenceSearch.getState().settings, ...patch } });
}

export function resetSettings(): void {
  settingsTouched = false;
  const defaults = useSequenceSearch.getState().status?.defaults ?? DEFAULT_SETTINGS;
  set({ settings: { ...DEFAULT_SETTINGS, ...defaults } });
}

/** The latest status request: a reply to an older one (possibly read before a reference change) is dropped. */
let statusSeq = 0;

/** What the server can search (genome, BLAST, defaults). Refreshed when the panel opens, after each search and when
 *  the loaded reference changes. Only the latest request's reply is applied; a successful one verifies the reference. */
export async function refreshStatus(): Promise<SearchStatus | null> {
  const mine = ++statusSeq;
  try {
    // A request of its own (a signal opts out of fetchJson's same-URL coalescing): joining one still out would hand
    // this newer request the answer read before a reference change, and verify the wrong reference.
    const status = await fetchJson<SearchStatus & { success?: boolean }>('/api/sequence_search/status', { signal: new AbortController().signal });
    if (mine !== statusSeq) return null;
    const patch: Partial<SequenceSearchState> = { status, statusError: null, referencePending: false };
    if (!settingsTouched && status.defaults) patch.settings = { ...DEFAULT_SETTINGS, ...status.defaults };
    set(patch);
    return status;
  } catch (err) {
    if (mine === statusSeq) set({ statusError: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

interface JobView {
  success?: boolean;
  job_id?: string;
  status?: 'queued' | 'running' | 'done' | 'error' | 'cancelled' | 'missing';
  message?: string;
  progress?: number;
  error?: string | null;
  code?: string;
  result?: SearchResult | null;
  started?: number | null;
  finished?: number | null;
}

/** Start a search for the current query (or `query`). Returns false when it could not start. */
export async function startSearch(query?: string): Promise<boolean> {
  const state = useSequenceSearch.getState();
  const text = query ?? state.query;
  if (query !== undefined) set({ query });
  const parsed = parseSequence(text, state.settings.min_length);
  if (!parsed.ok) {
    set({ run: 'error', error: parsed.error, errorCode: 'bad_query', result: null, activeHit: null });
    return false;
  }
  const gen = ++generation;
  if (pollTimer) clearTimeout(pollTimer);
  set({
    run: 'running', jobId: null, message: 'Starting', progress: 0, startedAt: Date.now(), finishedAt: null,
    error: null, errorCode: null, result: null, activeHit: null, trackJobId: null, notice: null,
  });
  const body = JSON.stringify({ sequence: text, ...state.settings });
  const identity = searchIdentity(parsed.seq, state.settings);
  wantedStart = identity;
  inFlight.set(gen, identity);
  let reply: JobView;
  try {
    reply = await fetchJson<JobView>('/api/sequence_search', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });
  } catch (err) {
    inFlight.delete(gen);
    settleDeferred();
    if (gen !== generation) return false;
    set({ run: 'error', error: err instanceof Error ? err.message : String(err), errorCode: 'request', finishedAt: Date.now() });
    return false;
  }
  inFlight.delete(gen);
  if (gen !== generation) {
    // Cancelled or superseded while the start was in flight: stop the job it started, not the one shown. While an
    // equivalent newer start has not answered, the job may be the one it gets: decided when it answers.
    if (reply.success && reply.job_id && useSequenceSearch.getState().jobId !== reply.job_id) {
      if (wantedStart === identity && [...inFlight.values()].includes(identity)) deferred.push({ jobId: reply.job_id, identity });
      else void deleteJob(reply.job_id);
    }
    settleDeferred();
    return false;
  }
  if (!reply.success || !reply.job_id) {
    set({ run: 'error', error: reply.error || 'The search could not start.', errorCode: reply.code ?? null, finishedAt: Date.now() });
    settleDeferred();
    return false;
  }
  set({ jobId: reply.job_id });
  settleDeferred();
  applyJob(reply, gen);
  return true;
}

function applyJob(job: JobView, gen: number): void {
  if (gen !== generation) return;
  const status = job.status;
  if (status === 'done' && job.result) {
    set({ run: 'done', result: job.result, progress: 1, message: 'Done', finishedAt: Date.now() });
    void refreshStatus();  // the BLAST database may be built now
    return;
  }
  if (status === 'error' || status === 'missing') {
    set({ run: 'error', error: job.error || job.message || 'The search failed.', finishedAt: Date.now() });
    return;
  }
  if (status === 'cancelled') {
    set({ run: 'cancelled', message: 'Stopped', finishedAt: Date.now() });
    return;
  }
  set({ message: job.message || 'Searching', progress: job.progress ?? 0 });
  pollTimer = setTimeout(() => void poll(gen), POLL_MS);
}

async function poll(gen: number): Promise<void> {
  const jobId = useSequenceSearch.getState().jobId;
  if (gen !== generation || !jobId) return;
  try {
    const job = await fetchJson<JobView>(`/api/sequence_search/jobs/${encodeURIComponent(jobId)}`, { cache: 'no-store' });
    applyJob(job, gen);
  } catch {
    if (gen === generation) pollTimer = setTimeout(() => void poll(gen), POLL_MS * 3);
  }
}

async function deleteJob(jobId: string): Promise<void> {
  try {
    await fetchJson(`/api/sequence_search/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
  } catch { /* the job ends on its own */ }
}

/** Stop the running search (and a BLAST database build it started). Before the start request has answered, its
 *  job is stopped when the answer arrives (startSearch). */
export async function cancelSearch(): Promise<void> {
  const { jobId, run } = useSequenceSearch.getState();
  if (run !== 'running') return;
  generation += 1;
  wantedStart = null;
  if (pollTimer) clearTimeout(pollTimer);
  set({ run: 'cancelled', message: 'Stopped', finishedAt: Date.now() });
  settleDeferred();
  if (jobId) await deleteJob(jobId);
}

export const STALE_REFERENCE_MESSAGE = 'These hits were found on a different reference than the one loaded now: search again.';
export const REFERENCE_PENDING_MESSAGE = 'Checking the loaded reference (it changed): try again in a moment.';

/** The result was computed on another reference than the one loaded now (compared by reference id, as Identify does). */
export function isStaleResult(state: Pick<SequenceSearchState, 'result' | 'status'> = useSequenceSearch.getState()): boolean {
  const { result, status } = state;
  return Boolean(result?.reference_id && status?.reference_id && result.reference_id !== status.reference_id);
}

// A reference change (another genome or FASTA, paired references, a declared genome) changes the reference id. The
// hits are blocked at once (synchronously) until the status is read again for the new reference; then a result of
// another reference is marked stale and can no longer be followed or added. A failed refresh leaves them blocked.
useBrowserStore.subscribe((s, prev) => {
  if (s.fastaPath === prev.fastaPath && s.currentGenome === prev.currentGenome && s.chroms === prev.chroms
      && s.referenceRevision === prev.referenceRevision) return;
  set({ referencePending: true });
  // Re-read once the status was ever asked for (a request still out answers for the old reference and is dropped);
  // before that, the panel's open reads it.
  const st = useSequenceSearch.getState();
  if (statusSeq > 0 || st.result || st.run === 'running') void refreshStatus();
});

/** Open the panel (with `query` filled in; `run`: search it now). */
export function openSequenceSearch(query?: string, run = false): void {
  const store = useBrowserStore.getState() as { openAnalysisPanel?: (type: string) => void };
  store.openAnalysisPanel?.(SEQUENCE_SEARCH_PANEL);
  if (query !== undefined) set({ query });
  void refreshStatus();
  if (run && query) void startSearch(query);
}

/**
 * Show a hit: the main view (or the panel that shows the main genome, with "Each panel navigates") moves to it with
 * some context, and the hit is highlighted (one highlight, moved from hit to hit). Returns why it can't, or null.
 */
export function goToHit(index: number): string | null {
  const { result } = useSequenceSearch.getState();
  const hit = result?.hits[index];
  if (!hit) return null;
  if (useSequenceSearch.getState().referencePending) {
    void refreshStatus();
    return REFERENCE_PENDING_MESSAGE;
  }
  if (isStaleResult()) return STALE_REFERENCE_MESSAGE;
  const s = useBrowserStore.getState();
  const info = findChromInfo(s.chroms, hit.chrom);
  if (s.chroms.length && !info) return `${hit.chrom} is not on the loaded genome.`;
  const chrom = info?.name ?? hit.chrom;
  const { start, end } = hitWindow(hit, info?.size);
  const genome = mainGenomeKey(s);
  const target = regionTarget(genome, s);
  supersedeNavigationIntents(target?.kind === 'panel' ? { panelId: target.panelId } : 'main');
  if (target?.kind === 'panel') {
    s.recordJump(target.panelId, { to: { chrom, start, end } });
    s.navigatePanel(target.panelId, chrom, start, end);
  } else {
    s.recordJump(null, { to: { chrom, start, end } });
    s.setViewport(chrom, start, end);
  }
  highlightHit(hit, chrom, genome);
  set({ activeHit: index });
  return null;
}

function highlightHit(hit: SequenceHit, chrom: string, genome: string): void {
  const s = useBrowserStore.getState();
  const label = `Sequence match ${hitLocus(hit)} (${hit.strand === '.' ? 'both strands' : hit.strand})`;
  const region = { chrom, start: hit.start, end: hit.end, genome, label };
  if (s.highlights.some(h => h.id === HIT_HIGHLIGHT_ID)) s.updateHighlight(HIT_HIGHLIGHT_ID, region);
  else s.addHighlight({ ...region, id: HIT_HIGHLIGHT_ID });
}

/** The finished search's hits as a temporary annotation track (this session; not saved in sessions). */
export async function addHitsTrack(): Promise<string> {
  const { jobId, result, trackJobId } = useSequenceSearch.getState();
  if (!jobId || !result?.hits.length) return 'No hits to show.';
  if (trackJobId === jobId) return 'The hits are already a track.';
  await refreshStatus();
  if (useSequenceSearch.getState().referencePending) {
    set({ notice: REFERENCE_PENDING_MESSAGE });
    return REFERENCE_PENDING_MESSAGE;
  }
  if (isStaleResult()) {
    set({ notice: STALE_REFERENCE_MESSAGE });
    return STALE_REFERENCE_MESSAGE;
  }
  try {
    const reply = await fetchJson<{ success: boolean; track_index?: number; path?: string; label?: string; message?: string }>(
      `/api/sequence_search/jobs/${encodeURIComponent(jobId)}/track`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) },
    );
    if (!reply.success || reply.track_index == null || !reply.path) {
      const message = reply.message || 'Could not add the track.';
      set({ notice: message });
      return message;
    }
    registerBackendBedTrack({ trackIndex: reply.track_index, path: reply.path, label: reply.label || 'Sequence hits' });
    const message = `Added ${result.hits.length.toLocaleString()} hits as the track “${reply.label}”.`;
    set({ trackJobId: jobId, notice: message });
    return message;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    set({ notice: message });
    return message;
  }
}

export function setNotice(notice: string | null): void {
  set({ notice });
}
