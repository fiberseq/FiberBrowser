/**
 * Identification jobs, per insertion cluster. Polling lives here (module level),
 * not in the panel, so a job keeps going while the user switches tabs, opens
 * another insertion or closes the lens; the result lands in this store, in the
 * lens PanelConfig (``insertionIdentify``, saved with sessions) and raises the
 * tab's badge when it finishes out of sight.
 */
import { create } from 'zustand';
import { fetchJson } from '../../api/sharedFetch';
import { useBrowserStore } from '../../stores/browserStore';
import { INSERTION_LENS_PANEL } from './insertionLensTarget';
import {
  addSaved, slimResult, type DfamHit, type IdentifyJob, type IdentifyResult, type SavedIdentify,
} from './identifyModel';

export interface IdentifyEntry {
  status: 'running' | 'done' | 'error' | 'cancelled';
  progress: number;
  message: string;
  jobId?: string;
  result?: IdentifyResult;
  error?: string;
  missingTools?: boolean;
  /** Finished while its Identify tab was not on screen. */
  unseen: boolean;
  /** When this run started and ended (ms): the shared job status's elapsed time. */
  startedAt?: number;
  finishedAt?: number;
}

export interface DfamEntry {
  status: 'running' | 'done' | 'error';
  message: string;
  jobId?: string;
  hits?: DfamHit[];
  url?: string;
  error?: string;
}

interface IdentifyState {
  entries: Record<string, IdentifyEntry>;
  dfam: Record<string, DfamEntry>;
}

export const useIdentifyStore = create<IdentifyState>(() => ({ entries: {}, dfam: {} }));

const POLL_MS = 1000;
let visibleKey: string | null = null;
/** Each start of a cluster's job gets a generation; replies for an older one are dropped. */
const generations = new Map<string, number>();
const nextGeneration = (key: string) => { const g = (generations.get(key) ?? 0) + 1; generations.set(key, g); return g; };
const isCurrent = (key: string, gen: number) => generations.get(key) === gen;

/** The Identify tab tells the store which cluster it shows (null when hidden). */
export function setVisibleIdentifyKey(key: string | null): void {
  visibleKey = key;
  if (key) markIdentifySeen(key);
}

export function markIdentifySeen(key: string): void {
  const entry = useIdentifyStore.getState().entries[key];
  if (entry?.unseen) patch(key, { unseen: false });
}

function patch(key: string, value: Partial<IdentifyEntry>): void {
  useIdentifyStore.setState(s => ({
    entries: { ...s.entries, [key]: { ...(s.entries[key] ?? { status: 'running', progress: 0, message: '', unseen: false }), ...value } },
  }));
}

function patchDfam(key: string, value: Partial<DfamEntry>): void {
  useIdentifyStore.setState(s => ({
    dfam: { ...s.dfam, [key]: { ...(s.dfam[key] ?? { status: 'running', message: '' }), ...value } },
  }));
}

const JSON_POST = (body: unknown): RequestInit => ({
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

/** Save a finished result on the lens panel (sessions carry it). */
function saveToPanel(key: string, result: IdentifyResult): void {
  const entry: SavedIdentify = { seqSha: result.seq_sha256, at: new Date().toISOString(), result: slimResult(result) };
  useBrowserStore.setState(s => ({
    panels: s.panels.map(p => (p.contentType === INSERTION_LENS_PANEL
      ? { ...p, insertionIdentify: addSaved(p.insertionIdentify, key, entry) } : p)),
  }));
}

function finish(key: string, result: IdentifyResult): void {
  patch(key, { status: 'done', progress: 1, message: 'Done', result, error: undefined, unseen: visibleKey !== key, finishedAt: Date.now() });
  saveToPanel(key, result);
}

async function poll(key: string, jobId: string, gen: number): Promise<void> {
  for (;;) {
    await new Promise(resolve => window.setTimeout(resolve, POLL_MS));
    const current = useIdentifyStore.getState().entries[key];
    if (!isCurrent(key, gen) || !current || current.jobId !== jobId || current.status !== 'running') return;
    let job: IdentifyJob & { success?: boolean };
    try {
      job = await fetchJson<IdentifyJob & { success?: boolean }>(`/api/insertions/identify/jobs/${encodeURIComponent(jobId)}`);
    } catch {
      continue; // a dropped poll: try again
    }
    if (!isCurrent(key, gen)) return; // replaced (or stopped) while this poll was out
    if (job.status === 'running') {
      patch(key, { progress: job.progress ?? 0, message: job.message ?? '' });
      continue;
    }
    if (job.status === 'done' && job.result) { finish(key, job.result); return; }
    if (job.status === 'cancelled') { patch(key, { status: 'cancelled', message: 'Stopped', finishedAt: Date.now() }); return; }
    patch(key, {
      status: 'error', error: job.error || (job.status === 'missing' ? 'The job is gone (the server restarted). Run it again.' : 'Failed'),
      unseen: visibleKey !== key,
    });
    return;
  }
}

export interface IdentifyParams {
  genome?: string | null;
  seq: string; chrom: string; ref: number; length: number; rmsk: boolean; libraryId?: string | null;
  /** Recompute on the server (skip its cache). */
  force?: boolean;
  /** Start a new job even if one is running for this cluster (e.g. a TE library just arrived). */
  restart?: boolean;
}

/** Start (or reuse) an identification for a cluster. Resolves once it is started, not when done. */
export async function startIdentify(key: string, params: IdentifyParams): Promise<void> {
  const current = useIdentifyStore.getState().entries[key];
  if (current?.status === 'running' && !params.force && !params.restart) return;
  if (current?.status === 'running' && current.jobId) {
    // The job it replaces is stopped (its result would be filed under the old settings).
    void fetchJson(`/api/insertions/identify/jobs/${encodeURIComponent(current.jobId)}`, { method: 'DELETE' }).catch(() => {});
  }
  const gen = nextGeneration(key);
  patch(key, { status: 'running', progress: 0, message: 'Starting', error: undefined, missingTools: false, unseen: false, jobId: undefined, startedAt: Date.now(), finishedAt: undefined });
  try {
    const res = await fetchJson<IdentifyJob & { success: boolean; cached?: boolean; missing_tools?: boolean }>(
      `/api/insertions/identify${params.genome ? `?panel_genome=${encodeURIComponent(params.genome)}` : ''}`,
      JSON_POST({ seq: params.seq, chrom: params.chrom, ref: params.ref, length: params.length, rmsk: params.rmsk,
        library_id: params.libraryId ?? null, force: Boolean(params.force) }),
    );
    if (!isCurrent(key, gen)) return;
    if (!res.success) {
      patch(key, { status: 'error', error: res.error || 'Could not start', missingTools: Boolean(res.missing_tools) });
      return;
    }
    if (res.status === 'done' && res.result) { finish(key, res.result); return; }
    if (!res.job_id) { patch(key, { status: 'error', error: 'The server did not start a job' }); return; }
    patch(key, { jobId: res.job_id, progress: res.progress ?? 0, message: res.message ?? '' });
    void poll(key, res.job_id, gen);
  } catch (err) {
    if (isCurrent(key, gen)) patch(key, { status: 'error', error: String((err as Error)?.message ?? err) });
  }
}

export async function cancelIdentify(key: string): Promise<void> {
  const entry = useIdentifyStore.getState().entries[key];
  if (!entry?.jobId || entry.status !== 'running') return;
  nextGeneration(key); // late replies of the stopped job are ignored
  patch(key, { status: 'cancelled', message: 'Stopped' });
  try {
    await fetchJson(`/api/insertions/identify/jobs/${encodeURIComponent(entry.jobId)}`, { method: 'DELETE' });
  } catch { /* the job ends on its own */ }
}

/** A result saved in the session, shown again without re-running. */
export function hydrateIdentify(key: string, saved: SavedIdentify | undefined): void {
  if (!saved || useIdentifyStore.getState().entries[key]) return;
  patch(key, { status: 'done', progress: 1, message: 'Done', result: saved.result, unseen: false });
}

/**
 * Search Dfam online. This sends the consensus to dfam.org, so it is only ever
 * called from the explicit "Send to Dfam" confirmation (``optIn`` must be true).
 */
export async function startDfamSearch(key: string, seq: string, optIn: true, organism?: string | null): Promise<void> {
  if (optIn !== true) return;
  patchDfam(key, { status: 'running', message: 'Sending to Dfam', hits: undefined, error: undefined });
  try {
    const res = await fetchJson<IdentifyJob & { success: boolean }>(
      '/api/insertions/identify/dfam', JSON_POST({ seq, opt_in: true, organism: organism ?? null }),
    );
    if (!res.success || !res.job_id) { patchDfam(key, { status: 'error', error: res.error || 'Could not start' }); return; }
    const jobId = res.job_id;
    patchDfam(key, { jobId });
    for (;;) {
      await new Promise(resolve => window.setTimeout(resolve, 2 * POLL_MS));
      let job: IdentifyJob;
      try {
        job = await fetchJson<IdentifyJob>(`/api/insertions/identify/jobs/${encodeURIComponent(jobId)}`);
      } catch { continue; }
      if (job.status === 'running') { patchDfam(key, { message: job.message ?? '' }); continue; }
      if (job.status === 'done' && job.result) {
        const r = job.result as unknown as { hits: DfamHit[]; url: string };
        patchDfam(key, { status: 'done', hits: r.hits, url: r.url, message: 'Done' });
      } else {
        patchDfam(key, { status: 'error', error: job.error || 'Dfam search failed' });
      }
      return;
    }
  } catch (err) {
    patchDfam(key, { status: 'error', error: String((err as Error)?.message ?? err) });
  }
}

/** Test helper. */
export function resetIdentifyStore(): void {
  visibleKey = null;
  generations.clear();
  useIdentifyStore.setState({ entries: {}, dfam: {} });
}
