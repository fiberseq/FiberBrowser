/**
 * Opening the insertion lens and keeping what it shows on its PanelConfig
 * (``insertionLens``), so undo, autosave and session files carry it.
 */
import { datasetPanelView, targetPanelView } from '../../utils/panelScope';
import { panelReversed } from '../../hooks/usePanelDisplayStore';
import { useBrowserStore } from '../../stores/browserStore';
import type { InsertionLensTarget } from './insertionLensModel';

export const INSERTION_LENS_PANEL = 'insertion-lens';

/** A click position to resolve into the cluster nearest it (the panel does that). */
export interface InsertionLensSeek { genome?: string | null; reversed?: boolean; datasetId: string; chrom: string; pos: number; seek: true }

export type InsertionLensState = InsertionLensTarget | InsertionLensSeek;

export function isSeek(state: InsertionLensState | null | undefined): state is InsertionLensSeek {
  return Boolean(state && (state as InsertionLensSeek).seek);
}

export function setInsertionLensState(state: InsertionLensState | null): void {
  useBrowserStore.setState(s => ({
    panels: s.panels.map(p => (p.contentType === INSERTION_LENS_PANEL ? { ...p, insertionLens: state ?? undefined } : p)),
  }));
}

/** Open the lens on a cluster (a target) or at a clicked position (a seek). */
export function openInsertionLens(state: InsertionLensState, sourcePanelId?: string): void {
  const s = useBrowserStore.getState();
  const view = sourcePanelId ? targetPanelView(s, sourcePanelId) : datasetPanelView(s, state.datasetId);
  state = { ...state, genome: state.genome !== undefined ? state.genome : view.genome, reversed: panelReversed(s, view.panelId) };
  useBrowserStore.getState().openAnalysisPanel(INSERTION_LENS_PANEL);
  setInsertionLensState(state);
}

export function useInsertionLensState(): InsertionLensState | null {
  return useBrowserStore(s => s.panels.find(p => p.contentType === INSERTION_LENS_PANEL)?.insertionLens ?? null);
}
