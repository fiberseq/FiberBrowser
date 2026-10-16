import { usePanelGenomeStore } from '../../stores/panelGenomeStore';
import { genomeKeyFor } from '../../utils/regionNavigation';
import { useAccessibilityStore } from './accessibilityStore';
import { startAccessibility, getAccessibilityJob, cancelAccessibility, type AccessibilityJob, type AccessibilityRequest } from './api';
import { runFromJob } from './useNfrRuns';
import { useNfrRunsStore } from './nfrRunsStore';
import { plainError } from './accessibilityView';

const running = (job: AccessibilityJob) => ['queued', 'running', 'cancelling'].includes(job.status);

/** Own the queue for the page lifetime, including while its panel is closed. */
export async function runRegionBatch(requests: (AccessibilityRequest & { genome?: string | null })[]) {
  const store = useAccessibilityStore;
  if (store.getState().batchRunning) return;
  const generation = store.getState().generation;
  const expectedReferences = requests.map(r => genomeKeyFor(r.genome));
  const current = () => store.getState().generation === generation;
  store.setState({ batchRunning: true, batchCancelled: false, batchTotal: requests.length, regionJobs: [], batchError: '' });
  try {
    for (const [index, { genome, ...request }] of requests.entries()) {
      if (!current() || store.getState().batchCancelled) break;
      const refs = usePanelGenomeStore.getState();
      if (genome !== undefined && request.dataset_ids.some(id => refs.attaching.includes(id)
        || genomeKeyFor(refs.assignments[id] ?? null) !== expectedReferences[index])) {
        throw new Error('A dataset’s reference changed. Select matched regions again before finding NFRs.');
      }
      let job = await startAccessibility(request);
      if (!current()) { if (running(job)) await cancelAccessibility(job.job_id); break; }
      store.getState().setJob(job);
      if (store.getState().batchCancelled && running(job)) {
        job = await cancelAccessibility(job.job_id);
        if (current()) store.getState().setJob(job);
      }
      while (running(job) && current()) {
        await new Promise(resolve => setTimeout(resolve, 800));
        if (!current()) break;
        job = await getAccessibilityJob(job.job_id);
        if (current()) store.getState().setJob(job);
      }
      if (!current() || job.status !== 'complete') break;
      const drawn = runFromJob(job);
      if (drawn) useNfrRunsStore.getState().putNfrRun(drawn);
      store.setState(s => ({ regionJobs: [...s.regionJobs, job] }));
      if (job.result) store.getState().setRun(job.job_id, job.result);
    }
  } catch (e) {
    if (current()) store.setState({ batchError: plainError(e) });
  } finally {
    if (current()) store.setState({ batchRunning: false });
  }
}

/** Stop queued windows and cancel the current job, including from a remounted panel. */
export async function cancelRegionBatch() {
  const store = useAccessibilityStore;
  store.setState({ batchCancelled: true });
  const { job, generation } = store.getState();
  if (!job || !running(job)) return;
  try {
    const next = await cancelAccessibility(job.job_id);
    if (store.getState().generation === generation && store.getState().job?.job_id === job.job_id) store.getState().setJob(next);
  } catch (e) { if (store.getState().generation === generation) store.setState({ batchError: plainError(e) }); }
}
