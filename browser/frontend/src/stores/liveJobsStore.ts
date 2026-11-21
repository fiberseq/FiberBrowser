/**
 * Long runs other views follow (Plots' step buttons show the same progress as the panels): the Footprints panel's
 * consensus run (Find classes) and the toolbar's peak scan. The panels write; nothing else owns them.
 */
import { create } from 'zustand';
import type { ConsensusJob } from '../api/consensusWorkflow';

interface LiveJobs {
  /** The consensus run the Footprints panel shows (null: none yet). */
  consensus: ConsensusJob | null;
  /** The toolbar's peak scan is running. */
  scanning: boolean;
}

export const useLiveJobs = create<LiveJobs>(() => ({ consensus: null, scanning: false }));
