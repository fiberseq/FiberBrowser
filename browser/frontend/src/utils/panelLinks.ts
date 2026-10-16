/**
 * Links into the Footprints panel: other panels (plugin packs' too) open it at a class of a Find classes run, and the
 * Footprints panel's class rows link back to theirs (components/controls/footprint-analysis/classLinks.ts).
 */
import { useBrowserStore } from '../stores/browserStore';
import { useConsensusViewStore } from '../stores/consensusViewStore';

/** An attribute value for a CSS selector (CSS.escape where the browser has it). */
export function cssValue(v: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(v) : v.replace(/["\\]/g, '\\$&');
}
export const FOCUS_FOOTPRINT_CLASS_EVENT = 'fiberbrowser:focus-footprint-class';

export interface FocusClassDetail { jobId: string; classId: string }

/** A class to bring into view once the Footprints panel's class list for its run is mounted (it may mount later). */
let pendingClassFocus: FocusClassDetail | null = null;
export function takePendingClassFocus(jobId: string): FocusClassDetail | null {
  if (!pendingClassFocus || pendingClassFocus.jobId !== jobId) return null;
  const f = pendingClassFocus;
  pendingClassFocus = null;
  return f;
}

/** Open the Footprints panel on the Find classes run (loaded and shown if another run is), highlight the class on the
 * reads once its catalogue is there, and bring its row into view. */
export async function showFootprintClass(classJobId: string, classId: string, datasetIds: string[]): Promise<void> {
  const s = useBrowserStore.getState();
  s.openAnalysisPanel('footprint-analysis');
  window.dispatchEvent(new CustomEvent('fiberbrowser:open-footprint-analysis-tab', { detail: { tab: 'states' } }));
  pendingClassFocus = { jobId: classJobId, classId };
  const view = useConsensusViewStore.getState();
  try { await view.load(classJobId); } catch { /* the panel shows the error */ }
  const store = useConsensusViewStore.getState();
  datasetIds.forEach((datasetId, i) => store.select({ jobId: classJobId, datasetId, family: classId }, i > 0));
  window.dispatchEvent(new CustomEvent<FocusClassDetail>(FOCUS_FOOTPRINT_CLASS_EVENT, { detail: { jobId: classJobId, classId } }));
}
