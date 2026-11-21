/** The live scan this session runs, polled until it ends; its scans then join the hub (transient). */
import { create } from 'zustand';
import { cancelScanJob, getScanJob, type ScanJob } from './api';
import { adoptScans, hubGeneration, refreshDatasetLayers } from './hubData';

interface HubJobStore {
  job: ScanJob | null;
  track: (job: ScanJob) => void;
  cancel: () => Promise<void>;
  clear: () => void;
}

const LIVE = new Set(['queued', 'running', 'cancelling']);
let timer: ReturnType<typeof setTimeout> | null = null;
/** The hub generation the tracked job was started in (its results never join a later session's hub). */
let bornFor: { jobId: string; born: number } | null = null;
/** Jobs whose results were adopted already: submission, polling and cancellation may each see the end. */
const finished = new Set<string>();

/** One idempotent completion: an ended job's scans join the hub once, whichever response saw it end. */
async function finish(job: ScanJob): Promise<void> {
  if (LIVE.has(job.status) || finished.has(job.job_id)) return;
  finished.add(job.job_id);
  const born = bornFor?.jobId === job.job_id ? bornFor.born : hubGeneration();
  await adoptScans(job.scans ?? [], born);
  void refreshDatasetLayers();
}

export const useHubJob = create<HubJobStore>((set, get) => ({
  job: null,
  track: job => {
    set({ job });
    bornFor = { jobId: job.job_id, born: hubGeneration() };
    if (timer) clearTimeout(timer);
    timer = null;
    if (!LIVE.has(job.status)) { void finish(job); return; }
    const poll = async () => {
      const current = get().job;
      if (!current || !LIVE.has(current.status)) return;
      try {
        const next = await getScanJob(current.job_id);
        if (get().job?.job_id !== next.job_id) return;
        set({ job: next });
        if (!LIVE.has(next.status)) {
          await finish(next);
          return;
        }
      } catch { /* the next poll retries */ }
      timer = setTimeout(() => { void poll(); }, 800);
    };
    timer = setTimeout(() => { void poll(); }, 400);
  },
  cancel: async () => {
    const job = get().job;
    if (!job) return;
    try {
      const next = await cancelScanJob(job.job_id);
      if (get().job?.job_id !== next.job_id) return;
      set({ job: next });
      // A cancel that raced completion answers `complete`: polling stops on it, so adopt here.
      await finish(next);
    } catch { /* polling shows the state */ }
  },
  clear: () => { if (timer) clearTimeout(timer); timer = null; set({ job: null }); },
}));
