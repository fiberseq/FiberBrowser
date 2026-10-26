/** The live scan this session runs, polled until it ends; its scans then join the hub (transient). */
import { create } from 'zustand';
import { cancelScanJob, getScanJob, type ScanJob } from './api';
import { refreshDatasetLayers, refreshScans } from './hubData';

interface HubJobStore {
  job: ScanJob | null;
  track: (job: ScanJob) => void;
  cancel: () => Promise<void>;
  clear: () => void;
}

const LIVE = new Set(['queued', 'running', 'cancelling']);
let timer: ReturnType<typeof setTimeout> | null = null;

export const useHubJob = create<HubJobStore>((set, get) => ({
  job: null,
  track: job => {
    set({ job });
    if (timer) clearTimeout(timer);
    const poll = async () => {
      const current = get().job;
      if (!current || !LIVE.has(current.status)) return;
      try {
        const next = await getScanJob(current.job_id);
        if (get().job?.job_id !== next.job_id) return;
        set({ job: next });
        if (!LIVE.has(next.status)) {
          await refreshScans();
          void refreshDatasetLayers();
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
    try { set({ job: await cancelScanJob(job.job_id) }); } catch { /* polling shows the state */ }
  },
  clear: () => set({ job: null }),
}));
