/**
 * The nucleosome job this session runs (browser/services/nuc/jobs.py), polled until it ends. When it ends the
 * datasets it touched are read again (their nucsz / nucseg layers and their source identity, which moves read
 * tracks to fetch rows that carry the new layers), the layers are switched on, and `revision` moves so every
 * nucleosome panel fetches its summaries again (transient, not saved).
 */
import { create } from 'zustand';
import { useBrowserStore } from '../../stores/browserStore';
import { cancelNucJob, getNucJob, listNucJobs, submitNucJob, type NucJobRequest } from './api';
import type { NucJob } from './types';

const LIVE = new Set(['queued', 'running', 'cancelling']);
/** Switched on after a Compute. Regularity is not: its tiles are computed on demand (the Regularity view turns it on). */
export const NUC_LAYERS = ['nucsz', 'nucseg'] as const;

interface NucJobStore {
  job: NucJob | null;
  /** The panel that started the job (its JobStatus shows it). */
  panelId: string | null;
  /** Moves whenever stored nucleosome outputs change (a job ended). */
  revision: number;
  /** A submission is on its way (its POST not answered yet): busy like a live job, for every caller. */
  submitting: boolean;
  error: string;
  followLatest: (panelId: string) => Promise<void>;
  submit: (request: NucJobRequest, panelId: string) => Promise<void>;
  /** Stop the job. `user`: the job card's Cancel, which also keeps automatic starts (the panel's Auto-Analyse, the
   * cluster views) from analysing the cancelled views again until the user chooses Analyse there. */
  cancel: (options?: { user?: boolean }) => Promise<void>;
  clear: () => void;
}

let timer: ReturnType<typeof setTimeout> | null = null;
let requestVersion = 0;
let followVersion = 0;
const finished = new Set<string>();
/** The request each job of this tab was submitted with (what a user Cancel vetoes). */
const jobRequests = new Map<string, NucJobRequest>();

type JobView = { datasetId: string; chrom: string; start: number; end: number };
const viewKey = (v: JobView) => `${v.datasetId}|${v.chrom}|${v.start}|${v.end}`;
/** The dataset views a request analyses (its per-dataset views, or its one view for every dataset). */
export function requestViews(request: Pick<NucJobRequest, 'datasets' | 'views' | 'chrom' | 'start' | 'end'>): JobView[] {
  const out = [...(request.views ?? [])];
  if (request.chrom && (request.end ?? 0) > (request.start ?? 0)) {
    for (const d of request.datasets) out.push({ datasetId: d, chrom: request.chrom, start: request.start ?? 0, end: request.end ?? 0 });
  }
  return out;
}
/** Views whose Analyse the user cancelled: no automatic start analyses them again until the user chooses Analyse. */
const CANCELLED_VIEWS = new Set<string>();
/** True when any of these views had its Analyse cancelled by the user (automatic starts leave them alone). */
export function autoAnalyseVetoed(views: readonly JobView[]): boolean {
  return views.some(v => CANCELLED_VIEWS.has(viewKey(v)));
}
/** The user chose Analyse for these views: automatic starts may analyse them again. */
export function clearAutoAnalyseVeto(views: readonly JobView[]): void {
  for (const v of views) CANCELLED_VIEWS.delete(viewKey(v));
}

/** Follow exactly this job, including a reused submit response. Terminal cancellations never resubmit. */
async function follow(job: NucJob, panelId: string): Promise<void> {
  const version = ++followVersion;
  if (timer) clearTimeout(timer);
  // (a submission's reservation ends in the same update that shows its job)
  useNucJob.setState({ job, panelId, error: '', submitting: false });
  if (!LIVE.has(job.status)) { await finish(job); return; }
  const poll = async () => {
    if (version !== followVersion) return;
    try {
      const next = await getNucJob(job.job_id);
      if (version !== followVersion) return;
      useNucJob.setState({ job: next });
      if (!LIVE.has(next.status)) { await finish(next); return; }
    } catch { /* the next poll retries */ }
    if (version === followVersion) timer = setTimeout(() => { void poll(); }, 700);
  };
  timer = setTimeout(() => { void poll(); }, 300);
}

/** Once per job, when it ends: read the touched datasets again, switch the layers on, move the revision, all in one
 * update (one render: read tracks and panels fetch once, not once per store change). */
async function finish(job: NucJob): Promise<void> {
  if (finished.has(job.job_id)) return;
  finished.add(job.job_id);
  const touched = [...new Set(Object.values(job.results ?? {}).flatMap(r => r.datasets ?? []))];
  const apply = await fetchNucDatasets(touched);
  apply();
  if (job.status === 'complete') showNucLayers();
  useNucJob.setState(s => ({ revision: s.revision + 1 }));
}

/** Fetch the touched datasets from the server; the returned function applies their layer lists and identities to the
 * store (synchronously, so a caller can batch it with other updates). */
export async function fetchNucDatasets(ids: string[]): Promise<() => void> {
  if (!ids.length) return () => {};
  try {
    const { getDatasets } = await import('../../api/datasets');
    const res = await getDatasets();
    const byId = new Map((res.datasets ?? []).map(d => [d.id, d]));
    return () => useBrowserStore.setState(s => {
      let changed = false;
      const datasets = s.datasets.map(d => {
        const server = ids.includes(d.id) ? byId.get(d.id) : undefined;
        if (!server) return d;
        const same = d.source_identity === server.source_identity && d.regularity_identity === server.regularity_identity
          && d.patch_labels_identity === server.patch_labels_identity
          && JSON.stringify(d.available_layers) === JSON.stringify(server.available_layers)
          && JSON.stringify(d.derived_layers) === JSON.stringify(server.derived_layers);
        if (same) return d;
        changed = true;
        return { ...d, available_layers: server.available_layers, derived_layers: server.derived_layers,
          source_identity: server.source_identity, regularity_identity: server.regularity_identity,
          patch_labels_identity: server.patch_labels_identity } as typeof d;
      });
      return changed ? { datasets } : {};
    });
  } catch { return () => {}; /* the next dataset load refreshes them */ }
}

/** Read the touched datasets again from the server: layer lists and source identity (read tracks refetch). A dataset
 * whose identities and layers did not move is left as it is (no refetch). */
export async function refreshNucDatasets(ids: string[]): Promise<void> {
  (await fetchNucDatasets(ids))();
}

/**
 * One read reload per settings change. A Regularity view's parameter change asks the regularity and the geometry
 * routes at once, and each may move the datasets' regularity identity; refreshing after each answer reloads every
 * read panel twice. Each request holds the refresh while it runs (`holdNucRefresh`, taken when the request is
 * planned) and releases it with the datasets its answer updated; the union is refreshed once, when the last hold is
 * released (an aborted request releases with none).
 */
let holds = 0;
const heldIds = new Set<string>();
const heldApply: Array<() => void> = [];
let flushing: Promise<void> = Promise.resolve();
/** `release(ids, apply)`: `apply` (e.g. switching a lane on) runs with the refresh, in the same update, so a lane
 * switched on and the rows carrying it load once, not twice. */
export function holdNucRefresh(): (ids?: readonly string[], apply?: () => void) => Promise<void> {
  holds += 1;
  let released = false;
  return (ids = [], apply) => {
    if (released) return flushing;
    released = true;
    for (const id of ids) heldIds.add(id);
    if (apply) heldApply.push(apply);
    holds = Math.max(0, holds - 1);
    if (holds === 0 && (heldIds.size || heldApply.length)) {
      const all = [...heldIds];
      const fns = heldApply.splice(0);
      heldIds.clear();
      flushing = fetchNucDatasets(all).then(applyDatasets => { applyDatasets(); for (const fn of fns) fn(); });
    }
    return flushing;
  };
}

/** Tests: forget held refreshes. */
export function resetNucRefreshHolds(): void { holds = 0; heldIds.clear(); heldApply.length = 0; flushing = Promise.resolve(); }

/** Switch the nucleosome layers on (a user who turned one off keeps it off: only unset layers are switched). */
export function showNucLayers(): void {
  const st = useBrowserStore.getState();
  const enabled = st.enabledModTypes as Record<string, boolean>;
  for (const layer of NUC_LAYERS) {
    if (!Object.prototype.hasOwnProperty.call(enabled, layer)) st.toggleModType(layer as never, true);
  }
}

export const useNucJob = create<NucJobStore>((set, get) => ({
  job: null,
  panelId: null,
  revision: 0,
  submitting: false,
  error: '',
  followLatest: async panelId => {
    const version = requestVersion;
    try {
      const { jobs } = await listNucJobs();
      if (version !== requestVersion) return;
      const newest = jobs.filter(j => LIVE.has(j.status)).sort((a, b) => b.created_at - a.created_at)[0];
      const current = get().job;
      if (newest && (!current || newest.created_at > current.created_at)) await follow(newest, panelId);
    } catch { /* a later mount or submit can reconnect */ }
  },
  submit: async (request, panelId) => {
    // One submission at a time, reserved synchronously: a second caller (another panel, a cluster view, an automatic
    // start) arriving before this POST is answered sees the store busy and never sends a request that would replace
    // this one on the server.
    if (isNucBusy()) return;
    const version = ++requestVersion;
    set({ error: '', submitting: true });
    let job: NucJob;
    try {
      job = await submitNucJob(request);
      jobRequests.set(job.job_id, request);
      if (jobRequests.size > 32) jobRequests.delete(jobRequests.keys().next().value as string);
    } catch (e) {
      if (version === requestVersion) set({ error: String((e as Error).message ?? e), submitting: false });
      else set({ submitting: false });
      return;
    }
    // the job is shown (live) in the same update that releases the reservation: never a moment when neither holds
    if (version === requestVersion) await follow(job, panelId);
    else set({ submitting: false });
  },
  cancel: async options => {
    const job = get().job;
    if (!job) return;
    if (options?.user && LIVE.has(job.status)) {
      const request = jobRequests.get(job.job_id);
      const views = request ? requestViews(request)
        : job.view?.chrom ? requestViews({ datasets: job.datasets.map(d => d.datasetId), chrom: job.view.chrom, start: job.view.start, end: job.view.end }) : [];
      for (const v of views) CANCELLED_VIEWS.add(viewKey(v));
    }
    try {
      const next = await cancelNucJob(job.job_id);
      if (get().job?.job_id !== next.job_id) return;
      set({ job: next });
      if (!LIVE.has(next.status)) await finish(next);
    } catch { /* polling shows the state */ }
  },
  clear: () => {
    requestVersion++; followVersion++;
    if (timer) clearTimeout(timer);
    timer = null;
    set({ job: null, panelId: null, error: '', submitting: false });
  },
}));

/**
 * A read-side request (regularity, geometries, sites) came back superseded (409): make sure its re-ask comes. The
 * re-ask itself is the caller's effect running again when `revision` moves, which happens once the Analyse that
 * replaced it ends (`finish`), so no request is repeated by hand. The only gap is an Analyse this tab does not follow
 * (another tab's, or one whose submit raced the store): follow it, or, when it has ended already, finish it here
 * (its datasets read again, the revision moved). One shared GET however many requests were dropped at once.
 */
export async function resyncAfterSuperseded(panelId: string | null | undefined): Promise<void> {
  try {
    const { jobs } = await listNucJobs();
    const newest = [...jobs].sort((a, b) => b.created_at - a.created_at)[0];
    const st = useNucJob.getState();
    if (!newest || st.submitting || st.job?.job_id === newest.job_id) return;   // followed: its end moves the revision
    if (LIVE.has(newest.status)) {
      if (!st.job || !LIVE.has(st.job.status) || newest.created_at > st.job.created_at) await follow(newest, panelId ?? st.panelId ?? 'nucleosomes');
    } else if (!finished.has(newest.job_id)) {
      await finish(newest);
    }
  } catch { /* a later answer or mount reconnects */ }
}

export const isLiveJob = (job: NucJob | null) => Boolean(job && LIVE.has(job.status));
/** An Analyse is running or being submitted (the server runs one at a time: a new request would replace it). */
export function isNucBusy(): boolean {
  const st = useNucJob.getState();
  return st.submitting || isLiveJob(st.job);
}
/** Hook: an Analyse is running or being submitted. */
export const useNucBusy = () => useNucJob(s => s.submitting || isLiveJob(s.job));
export const isReplacedJob = (job: NucJob) => job.status === 'cancelled' && job.message === 'Replaced by a newer run';

/**
 * Analyse a view for a caller other than the panel's own button (the cluster views, an automatic start): the server
 * runs one nucleosome job at a time and a different request replaces the running one, so a live job is never
 * superseded. 'waiting': a job runs (its end moves `revision`; the caller asks again then). 'submitted' / 'error'
 * (the store's `error` says why).
 */
export async function analyseUnlessBusy(request: NucJobRequest, panelId: string): Promise<'waiting' | 'submitted' | 'error'> {
  if (isNucBusy()) return 'waiting';
  await useNucJob.getState().submit(request, panelId);
  const st = useNucJob.getState();
  return st.error ? 'error' : 'submitted';
}
