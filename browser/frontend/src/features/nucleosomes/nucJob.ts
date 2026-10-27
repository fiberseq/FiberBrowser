/**
 * The nucleosome job this session runs (browser/services/nuc/jobs.py), polled until it ends. When it ends the
 * datasets it touched are read again (their nucsz / nucseg layers and their source identity, which moves read
 * tracks to fetch rows that carry the new layers), the layers are switched on, and `revision` moves so every
 * nucleosome panel fetches its summaries again (transient, not saved).
 */
import { create } from 'zustand';
import { useBrowserStore } from '../../stores/browserStore';
import { cancelNucJob, getNucJob, submitNucJob, type NucJobRequest } from './api';
import type { NucJob } from './types';

const LIVE = new Set(['queued', 'running', 'cancelling']);
export const NUC_LAYERS = ['nucsz', 'nucseg'] as const;

interface NucJobStore {
  job: NucJob | null;
  /** The panel that started the job (its JobStatus shows it). */
  panelId: string | null;
  /** Moves whenever stored nucleosome outputs change (a job ended). */
  revision: number;
  error: string;
  submit: (request: NucJobRequest, panelId: string) => Promise<void>;
  cancel: () => Promise<void>;
  clear: () => void;
}

let timer: ReturnType<typeof setTimeout> | null = null;
const finished = new Set<string>();

/** Once per job, when it ends: read the touched datasets again, switch the layers on, move the revision. */
async function finish(job: NucJob): Promise<void> {
  if (finished.has(job.job_id)) return;
  finished.add(job.job_id);
  const touched = [...new Set(Object.values(job.results ?? {}).flatMap(r => r.datasets ?? []))];
  await refreshNucDatasets(touched);
  if (job.status === 'complete') showNucLayers();
  useNucJob.setState(s => ({ revision: s.revision + 1 }));
}

/** Read the touched datasets again from the server: layer lists and source identity (read tracks refetch). */
export async function refreshNucDatasets(ids: string[]): Promise<void> {
  if (!ids.length) return;
  try {
    const { getDatasets } = await import('../../api/datasets');
    const res = await getDatasets();
    const byId = new Map((res.datasets ?? []).map(d => [d.id, d]));
    useBrowserStore.setState(s => ({
      datasets: s.datasets.map(d => {
        const server = ids.includes(d.id) ? byId.get(d.id) : undefined;
        return server ? { ...d, available_layers: server.available_layers, derived_layers: server.derived_layers,
          source_identity: server.source_identity } as typeof d : d;
      }),
    }));
  } catch { /* the next dataset load refreshes them */ }
}

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
  error: '',
  submit: async (request, panelId) => {
    set({ error: '' });
    let job: NucJob;
    try {
      job = await submitNucJob(request);
    } catch (e) {
      set({ error: String((e as Error).message ?? e) });
      return;
    }
    set({ job, panelId });
    if (timer) clearTimeout(timer);
    // A job can end before its submit response arrives: every response goes through the same end handling.
    if (!LIVE.has(job.status)) { await finish(job); return; }
    const poll = async () => {
      const current = get().job;
      if (!current || !LIVE.has(current.status)) return;
      try {
        const next = await getNucJob(current.job_id);
        if (get().job?.job_id !== next.job_id) return;
        set({ job: next });
        if (!LIVE.has(next.status)) { await finish(next); return; }
      } catch { /* the next poll retries */ }
      timer = setTimeout(() => { void poll(); }, 700);
    };
    timer = setTimeout(() => { void poll(); }, 300);
  },
  cancel: async () => {
    const job = get().job;
    if (!job) return;
    try {
      const next = await cancelNucJob(job.job_id);
      if (get().job?.job_id !== next.job_id) return;
      set({ job: next });
      if (!LIVE.has(next.status)) await finish(next);
    } catch { /* polling shows the state */ }
  },
  clear: () => { if (timer) clearTimeout(timer); timer = null; set({ job: null, panelId: null, error: '' }); },
}));

export const isLiveJob = (job: NucJob | null) => Boolean(job && LIVE.has(job.status));
