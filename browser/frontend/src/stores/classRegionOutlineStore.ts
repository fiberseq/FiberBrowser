import { create } from 'zustand';
import { getConsensusJob } from '../api/consensusWorkflow';

/**
 * The region Find classes analyses, outlined (dashed) on the ruler and reads
 * of the targeted panels while its card is open and while a run is in
 * progress (fb-n5-classregion). Screen chrome only: never in exported figures,
 * sessions or undo.
 */
export interface ClassRegionOutline {
  chrom: string;
  start: number;
  end: number;
  /** The panels' reference (PanelConfig.genome); null: the main genome. */
  genome: string | null;
  /** That reference's key (utils/regionNavigation genomeKeyFor): the main genome named, so a held outline
   *  is never drawn on another reference opened meanwhile. */
  genomeKey: string;
  /** The datasets analysed: their panels are outlined. */
  datasetIds: string[];
  /** "Find classes" (the card is open) or "Finding classes…" (a run). */
  label: string;
}

interface ClassRegionOutlineState {
  outline: ClassRegionOutline | null;
  /** The run the outline stays up for after the card closed. */
  heldForJob: string | null;
  setOutline: (outline: ClassRegionOutline | null) => void;
  /** Each run's region in words (ConsensusTools' analysedLine), by job id: class tables shown outside the card name it. */
  runRegions: Record<string, string>;
  noteRunRegions: (regions: Record<string, string>) => void;
}

export const useClassRegionOutlineStore = create<ClassRegionOutlineState>(set => ({
  outline: null,
  heldForJob: null,
  setOutline: outline => set({ outline, heldForJob: null }),
  runRegions: {},
  noteRunRegions: regions => set(s => (Object.entries(regions).every(([k, v]) => s.runRegions[k] === v)
    ? s : { runRegions: { ...s.runRegions, ...regions } })),
}));

const RUNNING = ['queued', 'running', 'cancelling'];
const POLL_MS = 2000;
/** Failed status requests in a row before the outline is let go (the server may be briefly busy). */
const MAX_POLL_ERRORS = 5;

/**
 * The card closed while a run is in progress: keep its outline until the run
 * ends (or the card reopens and takes the outline over).
 */
export function holdOutlineWhileRunning(jobId: string, outline: ClassRegionOutline): void {
  useClassRegionOutlineStore.setState({ outline, heldForJob: jobId });
  let errors = 0;
  const poll = async () => {
    if (useClassRegionOutlineStore.getState().heldForJob !== jobId) return;
    let done = false;
    try { done = !RUNNING.includes((await getConsensusJob(jobId)).status); errors = 0; }
    catch { errors += 1; done = errors >= MAX_POLL_ERRORS; }
    if (useClassRegionOutlineStore.getState().heldForJob !== jobId) return;
    if (done) useClassRegionOutlineStore.setState({ outline: null, heldForJob: null });
    else window.setTimeout(() => { void poll(); }, POLL_MS);
  };
  window.setTimeout(() => { void poll(); }, POLL_MS);
}
