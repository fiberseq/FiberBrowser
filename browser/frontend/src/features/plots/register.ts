/**
 * The Plots workspace (PLOTS_PANEL_PLAN.md): its saved state (plots and saved plots, with the session). The view
 * itself mounts in components/Browser.tsx; keys are in hooks/useKeyboardShortcuts; commands in utils/appCommands.
 * Called once from features/register.ts.
 */
import { useBrowserStore } from '../../stores/browserStore';
import { registerPlotsState } from './plotsState';
import { setWorkspace, workspaceHeld, workspaceOpen } from './workspace';
import { registerCoaccEntry } from './coaccEntry';
import { registerWindowQuant } from '../windowQuant/register';

let done = false;

/** A panel opened while a workspace covers the reads (a rail tile, ⌘K): show it, back in the browser. */
export function openedAnalysisPanel(panels: { id: string; contentType?: string }[], previous: { id: string }[]): boolean {
  if (panels.length <= previous.length) return false;
  const before = new Set(previous.map(p => p.id));
  return panels.some(p => !before.has(p.id) && p.contentType !== 'dataset');
}

export function registerPlots(): void {
  if (done) return;
  done = true;
  registerPlotsState();
  registerWindowQuant();
  registerCoaccEntry();
  useBrowserStore.subscribe((s, prev) => {
    if (s.panels === prev.panels || !workspaceOpen() || workspaceHeld()) return;
    if (openedAnalysisPanel(s.panels, prev.panels)) setWorkspace('browser');
  });
}
