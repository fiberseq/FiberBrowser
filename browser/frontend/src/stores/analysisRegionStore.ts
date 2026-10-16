import { create } from 'zustand';
import type { ClassRegionOutline } from './classRegionOutlineStore';

export type AnalysisOutline = ClassRegionOutline & { color: string };
/** Ephemeral analysis regions share the existing ruler/read outline treatment. */
export const useAnalysisRegionStore = create<{
  outlines: Record<string, AnalysisOutline[]>;
  set: (kind: string, outlines: AnalysisOutline[]) => void;
}>(set => ({ outlines: {}, set: (kind, outlines) => set(s => ({ outlines: { ...s.outlines, [kind]: outlines } })) }));

/** Keep pooled-run outlines visible when the settings card closes. A new card takes ownership. */
export function holdAnalysisRegions(kind: string, jobId: string, outlines: AnalysisOutline[]) {
  useAnalysisRegionStore.getState().set(kind, outlines);
  const owned = outlines;
  let errors = 0;
  const poll = async () => {
    if (useAnalysisRegionStore.getState().outlines[kind] !== owned) return;
    let done = false;
    try {
      const { getConsensusJob } = await import('../api/consensusWorkflow');
      done = !['queued', 'running', 'cancelling'].includes((await getConsensusJob(jobId)).status);
      errors = 0;
    } catch { done = ++errors >= 5; }
    if (useAnalysisRegionStore.getState().outlines[kind] !== owned) return;
    if (done) useAnalysisRegionStore.getState().set(kind, []);
    else window.setTimeout(() => { void poll(); }, 2000);
  };
  window.setTimeout(() => { void poll(); }, 2000);
}
