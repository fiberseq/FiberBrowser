/**
 * One line about the reference the page chose for the user ("The saved reference (sacCer3) was not restored: ..."),
 * shown above the reads until dismissed (utils/startupReference.ts), and whether the user picked a reference in this
 * page. Nothing switches the reference on its own: a better-fitting pinned or recent genome is only offered.
 */
import { create } from 'zustand';

interface ReferenceNoticeStore {
  notice: string | null;
  setNotice: (notice: string | null) => void;
  /** The user loaded a reference in this page (genome list, a FASTA, a recent genome, a restore). */
  userChose: boolean;
  markUserChose: () => void;
}

export const useReferenceNoticeStore = create<ReferenceNoticeStore>(set => ({
  notice: null,
  setNotice: notice => set({ notice }),
  userChose: false,
  markUserChose: () => set({ userChose: true }),
}));

/** The user loaded a reference (call from every loader the user drives). */
export function markReferenceChosen(): void {
  useReferenceNoticeStore.getState().markUserChose();
}
