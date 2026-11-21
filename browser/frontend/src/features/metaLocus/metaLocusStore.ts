/**
 * The meta-locus: a BED file's reads pooled into one virtual locus (the contig `meta:<pool id>`), shown in the main
 * browser exactly like any locus; only the coordinates differ (-flank..+flank around each site's anchor).
 *
 * A small store of its own (not the browser store), like the Plots workspace: undo never rebuilds a pool. Meta mode
 * is simply "the main view is on a meta contig" (isMetaChrom), so any jump to a real locus leaves it; the pool and
 * its working set stay here for Back.
 */
import { create } from 'zustand';
import { useBrowserStore } from '../../stores/browserStore';
import {
  cancelMetaLocusPool, findMoreMetaLocus, metaLocusStatus, probeMetaLocusPool, refillMetaLocus, setMetaLocusView, startMetaLocusPool,
  type ClusterEstimate, type FindMoreResult, type MetaLocusSpec, type MetaLocusStatus, type MetaLocusView, type MetaLocusViewRequest,
} from './api';
import { isMetaChrom, metaLabel, metaReadLimit, setMetaContigWidth } from './metaChrom';
import { getBrowserPerformanceProfile } from '../../utils/performanceProfile';
import { withMetaUrlParams, type MetaUrlState } from './metaUrl';

export const DEFAULT_FLANK = 10_000;
export const MAX_FLANK = 50_000;
export const DEFAULT_COUNT = 2000;
export const MORE_STEP = 1000;
const POLL_MS = 400;

export interface RealLocus { chrom: string; start: number; end: number }

export interface FindMoreSummary extends FindMoreResult { requested: number }

export interface MetaLocusState {
  dialogOpen: boolean;
  /** The pool's spec as asked (for sessions) and the working-set settings. */
  spec: MetaLocusSpec | null;
  count: number;
  seed: number;
  status: MetaLocusStatus | null;
  view: MetaLocusView | null;
  /** The real locus the main view was on before entering (Back). */
  lastRealLocus: RealLocus | null;
  /** The latest "Find more like this" and "Keep workspace full" answers (honest frequencies). */
  findMore: FindMoreSummary | null;
  refill: { per_cluster: ClusterEstimate[]; scanned: number } | null;
  keepFull: boolean;
  busy: boolean;
  error: string | null;
  /** A small, non-blocking message (e.g. a link's BED is gone); dismissible. */
  notice: string | null;
}

const initial: MetaLocusState = {
  dialogOpen: false, spec: null, count: DEFAULT_COUNT, seed: 1, status: null, view: null, lastRealLocus: null,
  findMore: null, refill: null, keepFull: false, busy: false, error: null, notice: null,
};

export const useMetaLocusStore = create<MetaLocusState>(() => ({ ...initial }));

// "Back to real locus" goes to the last real locus the main view was on before it entered the meta contig, whatever
// way it entered (Open, the "↩" control, navigation Back from an opened site, a link).
useBrowserStore.subscribe((s, prev) => {
  if (s.chrom !== prev.chrom && isMetaChrom(s.chrom) && prev.chrom && !isMetaChrom(prev.chrom)) {
    useMetaLocusStore.setState({ lastRealLocus: { chrom: prev.chrom, start: prev.start, end: prev.end } });
  }
});

// The viewport clamps pans to the meta contig's ends: tell it each pool's width as soon as it is known.
useMetaLocusStore.subscribe(s => {
  const chrom = poolChrom(s.status);
  if (chrom) setMetaContigWidth(chrom, poolWidth(s.status));
});

export const openMetaLocusDialog = (): boolean => { useMetaLocusStore.setState({ dialogOpen: true, error: null }); return true; };
export const closeMetaLocusDialog = (): void => useMetaLocusStore.setState({ dialogOpen: false });

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pollToken = 0;

function stopPolling(): void {
  pollToken += 1;
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}

/** The pool's width (view coordinates [0, width)). */
export function poolWidth(status: MetaLocusStatus | null = useMetaLocusStore.getState().status): number {
  return Number(status?.width ?? (status?.flank_bp ? 2 * status.flank_bp : 0)) || 0;
}

export function poolChrom(status: MetaLocusStatus | null = useMetaLocusStore.getState().status): string | null {
  if (!status) return null;
  return status.chrom ?? `meta:${status.pool_id}`;
}

/** Re-fetch the reads of the virtual contig (the working set changed: same locus, other reads). */
function refreshReads(): void {
  useBrowserStore.getState().triggerRefresh();
}

function applyView(view: MetaLocusView | null | undefined): void {
  if (!view) return;
  const previous = useMetaLocusStore.getState().view;
  useMetaLocusStore.setState({ view, count: view.count ?? useMetaLocusStore.getState().count, seed: view.seed ?? useMetaLocusStore.getState().seed });
  if (!previous || previous.generation !== view.generation) refreshReads();
}

/** Show the pool in the main browser (its contig, the whole window), remembering the real locus for Back. */
export function enterMetaLocus(): void {
  const { status } = useMetaLocusStore.getState();
  const chrom = poolChrom(status);
  const width = poolWidth(status);
  if (!chrom || !width) return;
  const s = useBrowserStore.getState();
  if (!isMetaChrom(s.chrom) && s.chrom) useMetaLocusStore.setState({ lastRealLocus: { chrom: s.chrom, start: s.start, end: s.end } });
  if (s.chrom !== chrom || s.start !== 0 || s.end !== width) {
    s.recordJump(null, { to: { chrom, start: 0, end: width } });
    s.setViewport(chrom, 0, width);
  }
}

/** Back to the real locus the meta-locus was opened from. */
export function backToRealLocus(): boolean {
  const { lastRealLocus } = useMetaLocusStore.getState();
  if (!lastRealLocus) return false;
  const s = useBrowserStore.getState();
  s.recordJump(null, { to: lastRealLocus });
  s.setViewport(lastRealLocus.chrom, lastRealLocus.start, lastRealLocus.end);
  return true;
}

/** Back into the meta-locus after visiting a site. */
export function returnToMetaLocus(): boolean {
  const { status } = useMetaLocusStore.getState();
  if (status?.status !== 'ready') return false;
  enterMetaLocus();
  return true;
}

/** A building pool shows a provisional working set from this fraction on (blocks are read in a stable shuffled
 * order, so the reads so far are an unbiased sample of sites); the final one replaces it when the pool is ready. */
export const PROVISIONAL_AT = 0.25;

async function poll(poolId: string, token: number, onReady?: () => void | Promise<void>,
  onProgress?: (status: MetaLocusStatus) => void | Promise<void>): Promise<void> {
  try {
    const status = await metaLocusStatus(poolId);
    if (token !== pollToken) return;
    useMetaLocusStore.setState({ status });
    if (status.status === 'building') {
      await onProgress?.(status);
      pollTimer = setTimeout(() => void poll(poolId, token, onReady, onProgress), POLL_MS);
      return;
    }
    await settle(status, onReady);
  } catch (error) {
    if (token === pollToken) buildFailed(errorWords(error));
  }
}

/** A terminal status (from a poll or straight from Cancel): ready shows the working set, cancelled and error
 *  clean up as a build that ended without a pool. */
async function settle(status: MetaLocusStatus, onReady?: () => void | Promise<void>): Promise<void> {
  if (status.status === 'ready') await onReady?.();
  else if (status.status === 'cancelled') cancelled();
  else if (status.status === 'error') buildFailed(status.error ?? 'The pool could not be built');
}

/** The server's own words when it gave them (e.g. "No BED file at …"). */
function errorWords(error: unknown): string {
  const detail = (error as { detail?: unknown })?.detail;
  return typeof detail === 'string' && detail ? detail : error instanceof Error ? error.message : String(error);
}

/** A build that failed (or was cancelled): back to the real locus, and the dialog again with the error. */
function buildFailed(message: string | null): void {
  const s = useBrowserStore.getState();
  if (isMetaChrom(s.chrom)) backToRealLocus();
  useMetaLocusStore.setState(message ? { error: message, dialogOpen: true } : { error: null });
}

const LAST_SETTINGS_KEY = 'fiberbrowser.metaLocus.lastSettings';
export interface MetaLocusLastSettings { bed_path?: string; anchor?: MetaLocusSpec['anchor']; flank_bp?: number; count?: number; seed?: number; dataset_ids?: string[] }
/** The dialog's last-used settings (this browser only; a convenience, never relied on). */
export function lastSettings(): MetaLocusLastSettings {
  try { return JSON.parse(localStorage.getItem(LAST_SETTINGS_KEY) || '{}') as MetaLocusLastSettings; } catch { return {}; }
}
export function rememberSettings(settings: MetaLocusLastSettings): void {
  try { localStorage.setItem(LAST_SETTINGS_KEY, JSON.stringify(settings)); } catch { /* storage off: nothing kept */ }
}

/** Ask the server for the working set (count, seed) and show it. */
async function initialView(poolId: string, request: MetaLocusViewRequest): Promise<void> {
  const view = await setMetaLocusView(poolId, request);
  applyView(view);
}

/**
 * Open a BED as a meta-locus: start the pool (built in the background; a cached pool is ready at once), follow its
 * progress, then set the working set and show it.
 */
export async function openMetaLocus(spec: MetaLocusSpec, options: { count?: number; seed?: number; extra_entries?: Array<[string, string, number]>; navigate?: boolean | 'if-moved' } = {}): Promise<void> {
  stopPolling();
  const count = options.count ?? useMetaLocusStore.getState().count ?? DEFAULT_COUNT;
  const seed = options.seed ?? 1;
  // The dialog stays open until the server has accepted the BED: a bad path, an unreadable BED or no dataset is
  // answered in the dialog (store.error), never silently.
  useMetaLocusStore.setState({ count, seed, error: null, busy: true });
  try {
    const status = await startMetaLocusPool(spec);
    if (status.status === 'error') { useMetaLocusStore.setState({ error: status.error ?? 'The pool could not be built' }); return; }
    const savedPath = typeof status.spec?.bed_path === 'string' ? status.spec.bed_path : spec.bed_path;
    const { bed_text: _text, ...kept } = spec;
    useMetaLocusStore.setState({ status, spec: { ...kept, bed_path: savedPath }, findMore: null, refill: null, view: null, dialogOpen: false });
    // A restore's added reads are sent even when empty: [] says "none", so reads the pool gained since (refill, find
    // more) are not kept. Only a fresh Open (no list given) leaves the pool's own.
    const extra = options.extra_entries !== undefined ? { extra_entries: options.extra_entries } : {};
    const go = () => {
      if (options.navigate === 'if-moved') {
        // A restored session already shows its meta contig (zoom and clusters kept): move only if the pool is another.
        if (useBrowserStore.getState().chrom !== poolChrom(useMetaLocusStore.getState().status)) enterMetaLocus();
      } else if (options.navigate !== false) enterMetaLocus();
    };
    // On Open the view moves to the meta-locus at once: while the pool builds, the progress strip and the read
    // panels say so (provisional reads from PROVISIONAL_AT, the final working set when ready).
    go();
    const token = ++pollToken;
    let provisional = false;
    const ready = async () => {
      await initialView(status.pool_id, { seed, count, ...extra });
      go();
    };
    const progress = async (st: MetaLocusStatus) => {
      if (!provisional && Number(st.progress?.fraction ?? 0) >= PROVISIONAL_AT) {
        provisional = true;
        await initialView(st.pool_id, { seed, count });
      }
    };
    if (status.status === 'ready') await ready();
    else if (status.status === 'building') await poll(status.pool_id, token, ready, progress);
  } catch (error) {
    useMetaLocusStore.setState({ error: errorWords(error), dialogOpen: options.navigate === 'if-moved' ? useMetaLocusStore.getState().dialogOpen : true });
  } finally {
    useMetaLocusStore.setState({ busy: false });
  }
}

/**
 * Cancel the building pool. The server only asks its build to stop (the answer can still say "building"), so the
 * status is followed until it is terminal; a cancelled build then clears its provisional reads and returns to the
 * real locus, like any build that ends without a pool.
 */
export async function cancelMetaLocus(): Promise<void> {
  const { status } = useMetaLocusStore.getState();
  if (!status) return;
  // The open's own poll (with its provisional / ready steps) is replaced by one that only waits for the end.
  stopPolling();
  const token = ++pollToken;
  try {
    const next = await cancelMetaLocusPool(status.pool_id);
    if (token !== pollToken) return;
    useMetaLocusStore.setState({ status: next });
    // The build may have finished (or failed) before it could stop: show its working set as an Open would.
    const finished = async () => {
      const { seed, count } = useMetaLocusStore.getState();
      await initialView(status.pool_id, { seed, count });
    };
    if (next.status === 'building') {
      pollTimer = setTimeout(() => void poll(status.pool_id, token, finished), POLL_MS);
    } else {
      await settle(next, finished);
    }
  } catch (error) {
    if (token !== pollToken) return;
    useMetaLocusStore.setState({ error: error instanceof Error ? error.message : String(error) });
    // The cancel request failed, the build did not: keep following it (the strip must not freeze on "Building").
    if (useMetaLocusStore.getState().status?.status === 'building') {
      pollTimer = setTimeout(() => void poll(status.pool_id, token, async () => {
        const { seed, count } = useMetaLocusStore.getState();
        await initialView(status.pool_id, { seed, count });
      }), POLL_MS);
    }
  }
}

/** A build that ended cancelled: no provisional reads left, back to the real locus. */
function cancelled(): void {
  useMetaLocusStore.setState({ view: null });
  buildFailed(null);
}

async function changeView(request: MetaLocusViewRequest): Promise<void> {
  const { status } = useMetaLocusStore.getState();
  if (!status || status.status !== 'ready') return;
  useMetaLocusStore.setState({ busy: true, error: null });
  try {
    applyView(await setMetaLocusView(status.pool_id, request));
  } catch (error) {
    useMetaLocusStore.setState({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    useMetaLocusStore.setState({ busy: false });
  }
}

/** More reads: the next reads of the pool's sampling order (the shown ones stay). */
export const moreReads = (step = MORE_STEP) => changeView({ more: step });
/** Resample: a new seed (or the given one), the same working-set size. */
export function resample(seed?: number): Promise<void> {
  const next = seed ?? (useMetaLocusStore.getState().seed + 1);
  useMetaLocusStore.setState({ findMore: null, refill: null });
  return changeView({ resample: true, seed: next });
}
/** Take out the reads added by refill / find more (the display is a plain sample again). */
export function clearExtra(): Promise<void> {
  useMetaLocusStore.setState({ findMore: null, refill: null });
  return changeView({ clear_extra: true });
}

/** The main view's reads selected per dataset (state keys are dataset ids for main-view panels). */
export function selectedReadsByDataset(): Record<string, string[]> {
  const s = useBrowserStore.getState();
  const out: Record<string, string[]> = {};
  for (const [stateKey, ids] of Object.entries(s.selectedReadIds ?? {})) {
    const list = Array.isArray(ids) ? ids : [...(ids as unknown as Set<string>)];
    if (!list.length) continue;
    const panel = s.panels.find(p => (p.stateKey ?? p.datasetId) === stateKey);
    const datasetId = panel?.datasetId ?? stateKey;
    (out[datasetId] ??= []).push(...list);
  }
  return out;
}

/** "Find more like this": scan the pool for reads like the selected ones; honest frequency comes back. */
export async function findMoreLikeThis(readIds: Record<string, string[]>, k = 200): Promise<FindMoreSummary | null> {
  const { status } = useMetaLocusStore.getState();
  if (!status || status.status !== 'ready') return null;
  const requested = Object.values(readIds).reduce((n, ids) => n + ids.length, 0);
  if (!requested) return null;
  useMetaLocusStore.setState({ busy: true, error: null });
  try {
    const result = await findMoreMetaLocus(status.pool_id, { read_ids: readIds, k });
    const summary = { ...result, requested };
    useMetaLocusStore.setState({ findMore: summary });
    applyView(result.view);
    return summary;
  } catch (error) {
    useMetaLocusStore.setState({ error: error instanceof Error ? error.message : String(error) });
    return null;
  } finally {
    useMetaLocusStore.setState({ busy: false });
  }
}

/** The main panels' cluster assignments, by dataset (what refill extends). */
export function clusterAssignmentsByDataset(): Record<string, Record<string, number>> {
  const s = useBrowserStore.getState();
  const out: Record<string, Record<string, number>> = {};
  for (const [stateKey, assignments] of Object.entries(s.clusterAssignments ?? {})) {
    if (!assignments || !Object.keys(assignments).length) continue;
    const panel = s.panels.find(p => (p.stateKey ?? p.datasetId) === stateKey);
    out[panel?.datasetId ?? stateKey] = { ...(out[panel?.datasetId ?? stateKey] ?? {}), ...assignments };
  }
  return out;
}

/** "Keep workspace full": top up each cluster from the pool; per-cluster pool estimates come back. */
export async function refillWorkspace(): Promise<void> {
  const { status } = useMetaLocusStore.getState();
  if (!status || status.status !== 'ready') return;
  const assignments = clusterAssignmentsByDataset();
  if (!Object.keys(assignments).length) return;
  const peaks = (useBrowserStore.getState().clusterPeakRegions ?? []) as Array<{ start: number; end: number }>;
  useMetaLocusStore.setState({ busy: true, error: null });
  try {
    const result = await refillMetaLocus(status.pool_id, {
      assignments,
      ...(peaks.length ? { peak_regions: peaks.map(p => [p.start, p.end] as [number, number]) } : {}),
    });
    useMetaLocusStore.setState({ refill: { per_cluster: result.per_cluster ?? [], scanned: result.scanned ?? 0 } });
    if (result.assignments) {
      const s = useBrowserStore.getState();
      const merged = { ...s.clusterAssignments };
      for (const [datasetId, added] of Object.entries(result.assignments)) merged[datasetId] = { ...(merged[datasetId] ?? {}), ...added };
      useBrowserStore.setState({ clusterAssignments: merged } as never);
    }
    applyView(result.view);
  } catch (error) {
    useMetaLocusStore.setState({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    useMetaLocusStore.setState({ busy: false });
  }
}

export async function setKeepFull(on: boolean): Promise<void> {
  useMetaLocusStore.setState({ keepFull: on });
  if (on) await refillWorkspace();
  else if (useMetaLocusStore.getState().view?.extra_count) await clearExtra();
}

/** The locus box's words for the meta-locus (e.g. "promoters_tss · TSS ± 10 kb"). */
export function currentMetaLabel(): string {
  const { status } = useMetaLocusStore.getState();
  return status ? metaLabel(status) : '';
}

// ---------------------------------------------------------------------------------------------------- sessions

export interface MetaLocusSession {
  bed_path: string;
  name?: string;
  anchor: MetaLocusSpec['anchor'];
  flank_bp: number;
  policy?: string;
  count_unit?: string;
  dataset_ids?: string[];
  seed: number;
  count: number;
  extra_entries: Array<[string, string, number]>;
  lastRealLocus: RealLocus | null;
  pool_id?: string;
}

/** What a session keeps of the meta-locus (null: none open). */
export function metaLocusSessionPayload(): MetaLocusSession | null {
  const { spec, seed, count, view, lastRealLocus, status } = useMetaLocusStore.getState();
  if (!spec) return null;
  return {
    bed_path: spec.bed_path, name: spec.name, anchor: spec.anchor, flank_bp: spec.flank_bp, policy: spec.policy,
    count_unit: spec.count_unit, dataset_ids: spec.dataset_ids, seed, count,
    extra_entries: view?.extra_entries ?? [], lastRealLocus, pool_id: status?.pool_id,
  };
}

/** The pool spec a saved meta-locus reopens with (the same for the probe and the reopen, so both name one pool). */
function sessionSpec(raw: Partial<MetaLocusSession> & { bed_path: string }): MetaLocusSpec {
  return {
    bed_path: raw.bed_path, name: raw.name, anchor: raw.anchor ?? 'centre', flank_bp: Number(raw.flank_bp) || DEFAULT_FLANK,
    ...(raw.policy ? { policy: raw.policy } : {}), ...(raw.count_unit ? { count_unit: raw.count_unit } : {}),
    ...(raw.dataset_ids?.length ? { dataset_ids: raw.dataset_ids } : {}),
  };
}

/**
 * The meta contig a saved meta-locus will reopen as, asked before anything is restored (the probe builds nothing).
 * Its pool id follows the dataset ids, so datasets reopened under other ids give another contig: the saved view,
 * clusters and selections on the old contig are renamed to it instead of being cleared by the move. Null when the
 * server cannot say (no BED, an older server): nothing is renamed.
 */
export async function savedMetaPoolChrom(saved: unknown): Promise<string | null> {
  if (!saved || typeof saved !== 'object') return null;
  const raw = saved as Partial<MetaLocusSession>;
  if (!raw.bed_path) return null;
  try {
    const { name: _name, ...spec } = sessionSpec(raw as Partial<MetaLocusSession> & { bed_path: string });
    const probe = await probeMetaLocusPool(spec);
    return probe?.pool_id ? `meta:${probe.pool_id}` : null;
  } catch {
    return null;
  }
}

/**
 * Restore a session's meta-locus: re-open the pool (the server's cache makes a built pool ready at once), set the
 * saved working set (seed, count, refilled reads), then show it. `onMetaContig`: the session's view was on the meta
 * contig (it is shown again once the pool answers).
 */
export async function restoreMetaLocusSession(saved: unknown, onMetaContig: boolean): Promise<void> {
  if (!saved || typeof saved !== 'object') {
    stopPolling();
    useMetaLocusStore.setState({ ...initial });
    return;
  }
  const raw = saved as Partial<MetaLocusSession>;
  if (!raw.bed_path) return;
  const spec = sessionSpec({ ...raw, bed_path: raw.bed_path });
  // (A pool open before the restore is not this session's: its status must not pass for this one's.)
  useMetaLocusStore.setState({ lastRealLocus: raw.lastRealLocus ?? null, status: null, view: null, notice: null });
  await openMetaLocus(spec, {
    count: Number(raw.count) || DEFAULT_COUNT, seed: parseSeed(raw.seed),
    extra_entries: Array.isArray(raw.extra_entries) ? raw.extra_entries : [], navigate: onMetaContig ? 'if-moved' : false,
  });
  // enterMetaLocus remembered the session's own view as the real locus: put the saved one back.
  useMetaLocusStore.setState({ lastRealLocus: raw.lastRealLocus ?? null });
  // A BED that is gone (or a pool that cannot be opened) is said in a notice, not left as an empty meta view; the
  // view goes back to the session's real locus. (A pool still building is not a failure: its strip shows.)
  const { status, view, error } = useMetaLocusStore.getState();
  if (error && (!status || status.status === 'error' || !view)) {
    const gone = /no bed file|not found|404/i.test(error);
    useMetaLocusStore.setState({
      notice: gone ? `The meta-locus BED of this session is gone (${raw.bed_path}).` : `The meta-locus of this session could not be opened: ${error}.`,
      error: null, dialogOpen: false, status: null, spec: null, view: null,
    });
    const back = raw.lastRealLocus;
    if (back && isMetaChrom(useBrowserStore.getState().chrom)) useBrowserStore.getState().setViewport(back.chrom, back.start, back.end);
  }
}

/** A saved seed (0 is a seed like any other); 1 only when missing or not a number. */
export function parseSeed(value: unknown): number {
  if (value == null || value === '') return 1;
  const n = Number(value);
  return Number.isFinite(n) ? n : 1;
}

/** Tests: back to nothing open. */
export function resetMetaLocusForTests(): void {
  stopPolling();
  useMetaLocusStore.setState({ ...initial });
}

/**
 * The read-view limit for a view of `chrom`: the pool's whole window on the meta contig (one locus, however wide),
 * except on low-power clients, whose Open dialog caps the flank to their limit instead.
 */
export function effectiveReadLimit(chrom: string | null | undefined, maxRegionForReads: number): number {
  if (!isMetaChrom(chrom)) return maxRegionForReads;
  return metaReadLimit(chrom as string, maxRegionForReads, poolWidth(), getBrowserPerformanceProfile().tier === 'low');
}

// ---------------------------------------------------------------------------------------------------- navigation history

/** What navigation history keeps of the meta-locus a jump left (Back restores its pool and working set). */
export interface MetaHistoryPayload {
  kind: 'meta-locus';
  pool_id: string;
  spec: MetaLocusSpec;
  seed: number;
  count: number;
  extra_entries: Array<[string, string, number]>;
}

export function metaHistoryPayload(): MetaHistoryPayload | null {
  const { status, spec, seed, count, view } = useMetaLocusStore.getState();
  if (!status || !spec) return null;
  return { kind: 'meta-locus', pool_id: status.pool_id, spec, seed, count, extra_entries: view?.extra_entries ?? [] };
}

export const isMetaHistoryPayload = (x: unknown): x is MetaHistoryPayload =>
  !!x && typeof x === 'object' && (x as MetaHistoryPayload).kind === 'meta-locus' && !!(x as MetaHistoryPayload).spec;

const sameEntries = (a: Array<[string, string, number]>, b: Array<[string, string, number]>) =>
  a.length === b.length && a.every((e, i) => e[0] === b[i][0] && e[1] === b[i][1] && e[2] === b[i][2]);

/**
 * Back returned to a meta-locus view: show the working set it had (the same pool, seed, size and added reads),
 * re-opening the pool if another meta-locus was opened since.
 */
export async function restoreMetaFromHistory(m: MetaHistoryPayload): Promise<void> {
  const { status, seed, count, view } = useMetaLocusStore.getState();
  if (status?.pool_id !== m.pool_id || status.status !== 'ready') {
    await openMetaLocus(m.spec, { seed: m.seed, count: m.count, extra_entries: m.extra_entries, navigate: false });
    return;
  }
  if (seed === m.seed && count === m.count && sameEntries(view?.extra_entries ?? [], m.extra_entries)) return;
  await changeView({ seed: m.seed, count: m.count, extra_entries: m.extra_entries });
}

// ---------------------------------------------------------------------------------------------------- the address

export const dismissMetaNotice = (): void => useMetaLocusStore.setState({ notice: null });

/** What the page's address carries of the open meta-locus (null: none open). */
export function metaUrlState(): MetaUrlState | null {
  const { spec, status, seed, count, lastRealLocus } = useMetaLocusStore.getState();
  if (!spec || !status) return null;
  const sha = typeof status.spec?.regions_sha256 === 'string' ? status.spec.regions_sha256 : undefined;
  return { spec, sha, seed, count, back: lastRealLocus };
}

/** Rewrite the meta-locus keys of the address (the view on the meta contig: seed, size; off it: none). */
export function syncMetaUrl(): void {
  if (typeof window === 'undefined' || !window.history?.replaceState) return;
  const onMeta = isMetaChrom(useBrowserStore.getState().chrom);
  const params = withMetaUrlParams(new URLSearchParams(window.location.search), onMeta ? metaUrlState() : null);
  const next = params.toString();
  if (next !== window.location.search.replace(/^\?/, '')) window.history.replaceState(window.history.state, '', `${window.location.pathname}?${next}`);
}

/**
 * Open the meta-locus a link names (a reload): rebuild or reopen its pool, check the BED is the one the link was made
 * with (its content hash), set the working set, then show `viewport` (the link's span of the meta contig). A BED
 * that is gone or changed gets a small notice and the link's real locus instead.
 */
export async function restoreMetaLocusFromUrl(saved: MetaUrlState, viewport: { start: number; end: number } | null): Promise<boolean> {
  const fallback = () => {
    if (saved.back) useBrowserStore.getState().setViewport(saved.back.chrom, saved.back.start, saved.back.end);
  };
  useMetaLocusStore.setState({ lastRealLocus: saved.back ?? null });
  await openMetaLocus(saved.spec, { seed: saved.seed, count: saved.count, navigate: false });
  const { status, error } = useMetaLocusStore.getState();
  if (!status || status.status !== 'ready') {
    const gone = /no bed file|not found|404/i.test(error ?? '');
    useMetaLocusStore.setState({
      notice: gone ? `The meta-locus BED of this link is gone (${saved.spec.bed_path}).` : `The meta-locus of this link could not be opened${error ? `: ${error}` : ''}.`,
      error: null, status: null, spec: null, view: null,
    });
    fallback();
    return false;
  }
  const sha = status.spec?.regions_sha256;
  if (saved.sha && typeof sha === 'string' && sha !== saved.sha) {
    useMetaLocusStore.setState({ notice: `The BED file changed since this link was made (${saved.spec.bed_path}): open it again as a meta-locus to see its reads.` });
    fallback();
    return false;
  }
  const chrom = poolChrom(status)!;
  const width = poolWidth(status);
  const start = viewport ? Math.max(0, Math.min(viewport.start, width - 1)) : 0;
  const end = viewport ? Math.min(width, Math.max(viewport.end, start + 1)) : width;
  useBrowserStore.getState().setViewport(chrom, start, end);
  // (Entering the contig remembered the page's first view as the real locus: the link's one instead.)
  useMetaLocusStore.setState({ lastRealLocus: saved.back ?? null });
  return true;
}

// The address follows the working set (More reads, Resample, seed) and entering / leaving the meta contig.
useMetaLocusStore.subscribe((s, prev) => {
  if (s.seed !== prev.seed || s.count !== prev.count || s.status?.pool_id !== prev.status?.pool_id || s.lastRealLocus !== prev.lastRealLocus) syncMetaUrl();
});

/**
 * A BED export's first line on the meta contig: its intervals are virtual (one interval stands for that offset at
 * every site), so the file says what the contig is and which sites it pools. '' off the meta contig.
 */
export function metaBedComment(chrom: string | null | undefined): string {
  if (!isMetaChrom(chrom)) return '';
  const { status, spec } = useMetaLocusStore.getState();
  if (!status) return '';
  const offset = Number(status.axis_offset ?? -(status.flank_bp ?? 0));
  return `# meta-locus ${metaLabel(status)}: ${poolChrom(status)} is a virtual contig [0, ${poolWidth(status)}); x ${offset < 0 ? '-' : '+'} ${Math.abs(offset)} is the distance to each site's anchor (minus-strand sites flipped); sites: ${spec?.bed_path ?? ''}\n`;
}
