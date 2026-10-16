/**
 * The one way the UI starts the guided tour (the Tutorial panel's Start button
 * and steps, the welcome card), from the beginning or at a step.
 *
 * The tour runs in its own sandbox tab (a separate server session), so it can
 * never change the user's work. Call this straight from a click handler: the
 * new tab opens synchronously so popup blockers allow it. When no sandbox tab
 * can be opened (blocked, or a --public server where every visitor is already
 * isolated), or when this already is a sandbox tab, the tour runs here.
 */
import { runGuidedTour } from './guidedTour';
import { isSandboxTab, openTourTab } from './tourTab';

function runHere(stepId?: string): void {
  void runGuidedTour(stepId ? { stepId } : {});
}

export function startTutorialTour(stepId?: string): void {
  if (isSandboxTab()) {
    runHere(stepId);
    return;
  }
  void openTourTab(stepId ? { stepId } : undefined)
    .then(tab => { if (!tab) runHere(stepId); })
    .catch(() => runHere(stepId));
}
