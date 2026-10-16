/**
 * The completed Accessibility (Find variants) runs the read panels draw in their NFR channel (stores/featureStore.ts
 * nfrRuns): the run the panel shows as soon as it completes, and the session's other completed runs (started from
 * another region, in the background, or restored with a session), looked up again while one is running.
 */
import { useEffect } from 'react';
import { getAccessibilityJob, getAccessibilityJobs, type AccessibilityJob } from './api';
import { useAccessibilityStore } from './accessibilityStore';
import { useBrowserStore } from '../../stores/browserStore';
import { useNfrRunsStore, type NfrRun } from './nfrRunsStore';
import { isPublicServerPage } from '../../utils/publicServerFlag';

const RUNNING = new Set(['queued', 'running', 'cancelling']);
const POLL_RUNNING_MS = 5_000;
const POLL_IDLE_MS = 30_000;

export function runFromJob(job: AccessibilityJob): NfrRun | null {
  if (job.status !== 'complete' || !job.result) return null;
  return {
    jobId: job.job_id, result: job.result,
    datasetIds: job.result.datasets.map(d => d.dataset_id),
    createdAt: job.created_at ?? job.finished_at ?? 0,
    classJobId: job.class_job_id ?? null,
  };
}

/** Look the runs up once: drop runs the server no longer has, fetch the completed ones not known yet. */
export async function refreshNfrRuns(): Promise<{ running: boolean }> {
  // A session import meanwhile (its own runs): this answer is the previous session's.
  const generation = useAccessibilityStore.getState().generation;
  const current = () => useAccessibilityStore.getState().generation === generation;
  const { jobs } = await getAccessibilityJobs();
  if (!current()) return { running: false };
  const complete = new Set(jobs.filter(j => j.status === 'complete').map(j => j.job_id));
  const store = useNfrRunsStore.getState();
  store.dropNfrRuns(run => complete.has(run.jobId));
  const openDatasets = new Set(useBrowserStore.getState().datasets.map(d => d.id));
  const missing = jobs.filter(j => j.status === 'complete' && !useNfrRunsStore.getState().nfrRuns[j.job_id]
    && (j.request?.dataset_ids ?? []).some(id => openDatasets.has(id)));
  // Newest first, a handful at a time (each result is a few hundred kB at most: no molecules).
  for (const job of missing.reverse().slice(0, 12)) {
    try {
      const full = await getAccessibilityJob(job.job_id);
      if (!current()) break;
      const run = runFromJob(full);
      if (run) useNfrRunsStore.getState().putNfrRun(run);
    } catch { /* gone meanwhile */ }
  }
  return { running: jobs.some(j => RUNNING.has(j.status)) };
}

export function useNfrRuns(): void {
  const shownJob = useAccessibilityStore(s => s.jobId);
  const shownResult = useAccessibilityStore(s => s.result);
  const generation = useAccessibilityStore(s => s.generation);
  const runsGeneration = useNfrRunsStore(s => s.runsGeneration);
  const datasetCount = useBrowserStore(s => s.datasets.length);

  // The run the panel shows: drawn at once (its class run is looked up with the job).
  useEffect(() => {
    if (!shownJob || !shownResult) return;
    const known = useNfrRunsStore.getState().nfrRuns[shownJob];
    if (known?.result === shownResult) return;
    useNfrRunsStore.getState().putNfrRun({
      jobId: shownJob, result: shownResult, datasetIds: shownResult.datasets.map(d => d.dataset_id),
      createdAt: known?.createdAt ?? Date.now() / 1000, classJobId: known?.classJobId ?? null,
    });
    if (known?.classJobId === undefined) {
      const generation = useAccessibilityStore.getState().generation;
      void getAccessibilityJob(shownJob).then(job => {
        const run = runFromJob(job);
        if (run && useAccessibilityStore.getState().generation === generation) useNfrRunsStore.getState().putNfrRun(run);
      }).catch(() => {});
    }
  }, [shownJob, shownResult]);

  // A session import: the previous session's runs are gone.
  useEffect(() => { if (generation > 0) useNfrRunsStore.getState().dropNfrRuns(); }, [generation]);

  useEffect(() => {
    // A public server refuses the Accessibility preview: nothing to look up.
    if (isPublicServerPage()) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      let running = false;
      try { ({ running } = await refreshNfrRuns()); } catch { /* the engine is missing: nothing to draw */ }
      if (!stop) timer = setTimeout(tick, running ? POLL_RUNNING_MS : POLL_IDLE_MS);
    };
    void tick();
    return () => { stop = true; if (timer) clearTimeout(timer); };
  }, [generation, runsGeneration, datasetCount]);
}
