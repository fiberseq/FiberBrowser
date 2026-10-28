/** The association run this session waits for, polled until it ends; its result joins the session's runs. */
import { create } from 'zustand';
import { useBrowserStore } from '../../stores/browserStore';
import { cancelAssocJob, getAssocJob, submitAssoc, type AssocJob, type AssocRequest } from './assocApi';
import { hubGeneration } from './hubData';
import { MAX_ASSOC_RUNS, storableRun, type AssocRun } from './hubState';

interface AssocJobStore {
  job: AssocJob | null;
  /** The run shown in the results view (a run id of featureHub.assocRuns). */
  shown: string | null;
  error: string;
  submit: (request: AssocRequest) => Promise<void>;
  cancel: () => Promise<void>;
  show: (id: string | null) => void;
  clear: () => void;
}

const LIVE = new Set(['queued', 'running', 'cancelling']);
let timer: ReturnType<typeof setTimeout> | null = null;

export function runLabel(request: AssocRequest): string {
  if (request.label) return request.label;
  const a = request.a.label || request.a.typeId || request.a.kind;
  const b = request.response ? (request.response.kind === 'phasing' ? 'nucleosome phasing' : `${request.response.module}:${request.response.column}`)
    : (request.b?.label || request.b?.typeId || (request.b?.kind === 'tf' ? 'TF footprints' : ''));
  const g = request.group && request.group.kind !== 'none' ? ` · by ${request.group.kind}` : '';
  return `${request.mode} · ${a}${b ? ` × ${b}` : ''}${g}`;
}

function remember(job: AssocJob, request: AssocRequest) {
  const run: AssocRun = storableRun({
    id: job.job_id, createdAt: new Date((job.finished_at ?? job.created_at) * 1000).toISOString(), label: runLabel(request),
    definition: request, status: job.status === 'complete' ? 'complete' : job.status === 'cancelled' ? 'cancelled' : 'error',
    ...(job.result ? { result: job.result } : {}), ...(job.error ? { error: job.error } : {}),
  });
  useBrowserStore.getState().setFeatureHub(hub => ({ assocRuns: [...hub.assocRuns.filter(r => r.id !== run.id), run].slice(-MAX_ASSOC_RUNS) }));
}

export const useAssocJob = create<AssocJobStore>((set, get) => ({
  job: null, shown: null, error: '',
  submit: async request => {
    set({ error: '' });
    // The session this run belongs to: an import while it is submitted or running drops it (never saved there).
    const born = hubGeneration();
    let job: AssocJob;
    try { job = await submitAssoc(request); }
    catch (e) { if (born === hubGeneration()) set({ error: String((e as Error).message ?? e).replace(/^API error \d+: /, '') }); return; }
    if (born !== hubGeneration()) return;
    set({ job });
    if (timer) clearTimeout(timer);
    const finish = (next: AssocJob) => {
      if (born !== hubGeneration()) return;
      if (next.status !== 'cancelled') remember(next, request);
      if (next.status === 'complete') set({ shown: next.job_id });
    };
    if (!LIVE.has(job.status)) {
      // already finished when the submission answered (a quick run): its result needs the full job
      void getAssocJob(job.job_id).then(full => { if (get().job?.job_id === full.job_id) { set({ job: full }); finish(full); } }).catch(() => finish(job));
      return;
    }
    const poll = async () => {
      const current = get().job;
      if (!current || !LIVE.has(current.status)) return;
      try {
        const next = await getAssocJob(current.job_id);
        if (get().job?.job_id !== next.job_id || born !== hubGeneration()) return;
        set({ job: next });
        if (!LIVE.has(next.status)) {
          finish(next);
          return;
        }
      } catch { /* the next poll retries */ }
      timer = setTimeout(() => { void poll(); }, 700);
    };
    timer = setTimeout(() => { void poll(); }, 300);
  },
  cancel: async () => {
    const job = get().job;
    if (!job) return;
    const born = hubGeneration();
    try {
      const next = await cancelAssocJob(job.job_id);
      // only for the job still shown, in the same session (an import or a new run meanwhile wins)
      if (born === hubGeneration() && get().job?.job_id === next.job_id && LIVE.has(get().job?.status ?? '')) set({ job: next });
    } catch { /* polling shows the state */ }
  },
  show: id => set({ shown: id }),
  clear: () => { if (timer) clearTimeout(timer); timer = null; set({ job: null, shown: null, error: '' }); },
}));
