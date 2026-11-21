import { setRunResult, type RunTone } from '../stores/runResultStore';
import type { ClusterTargetPlan } from './clusterTargets';

/** Keep planning advice with the outcome, never as a result of a still-pending run. */
export function clusterRunReporter(run: number, advice?: ClusterTargetPlan['advice']) {
  let adviceReported = false;
  return (tone: RunTone, text: string, panelIds?: string[]) => {
    const note = tone !== 'error' && !adviceReported ? advice : undefined;
    if (note) adviceReported = true;
    // Publish the outcome, its panels and the advice together. A note with this run's
    // number must not imply completion before the response has even arrived.
    setRunResult('cluster', {
      tone: note && tone === 'done' ? 'note' : tone,
      text: note ? `${note.text} ${text}` : text,
      ...(note?.action ? { action: note.action } : {}),
      ...(panelIds?.length ? { panelIds } : {}),
    }, run);
  };
}
