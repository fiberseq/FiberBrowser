/**
 * The read count each read track shows ("584/3,170 visible"), keyed by the
 * panel's stateKey, so the panel header can show it instead of a badge drawn
 * over the reads.
 */
import { create } from 'zustand';

export interface ReadStatus { text: string; title: string }

interface ReadStatusState {
  byStateKey: Record<string, ReadStatus>;
  setStatus: (stateKey: string, status: ReadStatus | null) => void;
}

export const useReadStatusStore = create<ReadStatusState>((set) => ({
  byStateKey: {},
  setStatus: (stateKey, status) => set(state => {
    const current = state.byStateKey[stateKey];
    if (status && current && current.text === status.text && current.title === status.title) return state;
    if (!status && !current) return state;
    const next = { ...state.byStateKey };
    if (status) next[stateKey] = status; else delete next[stateKey];
    return { byStateKey: next };
  }),
}));
