/**
 * Named UI anchors Copilot points at when it teaches ("the Cluster button",
 * "the genome list"). The catalog in data/tutorialAnchors.json is shared with
 * the backend planner, which lists the ids in its system prompt and checks
 * every `explain.anchor` against it.
 *
 * `reveal` says what has to be open before the element exists or is visible:
 * an analysis panel (and a tab in it), a sidebar section (and subsection), or
 * a collapsible toolbar group.
 */
import catalog from '../data/tutorialAnchors.json';
import { useBrowserStore } from '../stores/browserStore';

export interface TutorialAnchorReveal {
  panel?: string;
  tab?: string;
  sidebar?: string;
  subsection?: string;
  /** Catalog id of a toggle to open first (a collapsed toolbar group, a dropdown chip). */
  expand?: string;
}

export interface TutorialAnchor {
  id: string;
  label: string;
  selector: string;
  where: string;
  reveal: TutorialAnchorReveal;
  description: string;
  /** The control only exists while this condition holds (see tutorialMilestones.json). */
  needs?: string;
  /** The same, in words, when no condition fits (e.g. "a panel is minimized"). */
  shows_when?: string;
}

export const TUTORIAL_ANCHORS: readonly TutorialAnchor[] = (catalog as { anchors: TutorialAnchor[] }).anchors;

const BY_ID = new Map(TUTORIAL_ANCHORS.map(entry => [entry.id, entry]));

export function tutorialAnchorById(id: string | null | undefined): TutorialAnchor | undefined {
  return id ? BY_ID.get(id) : undefined;
}

/** The first match on screen (a hidden duplicate would put the spotlight off screen). */
export function findVisible(selector: string): HTMLElement | null {
  if (!selector || typeof document === 'undefined') return null;
  try {
    const all = Array.from(document.querySelectorAll(selector)) as HTMLElement[];
    return all.find(el => el.getClientRects().length > 0) ?? null;
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

async function waitForVisible(selector: string, timeoutMs: number): Promise<HTMLElement | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const el = findVisible(selector);
    if (el || Date.now() >= deadline) return el;
    await delay(100);
  }
}

/** Open a sidebar section (and subsection) the way the rest of the app does. */
export function openSidebarSection(section: string, subsection?: string): void {
  if (typeof window === 'undefined' || !section) return;
  window.dispatchEvent(new CustomEvent('fiberbrowser:open-sidebar-section', {
    detail: { sectionId: section, ...(subsection ? { subsectionId: subsection } : {}) },
  }));
}

/** Switch an open analysis panel to a tab (the panel may still be mounting). */
export async function showPanelTab(panel: string, tab: string, timeoutMs = 3000): Promise<boolean> {
  const tabButton = await waitForVisible(
    `[data-panel-content-type="${panel}"] [data-analysis-tab="${tab}"]`, timeoutMs,
  );
  if (!tabButton) return false;
  // Re-selecting the active tab is a no-op, so no need to check which is active.
  tabButton.click();
  return true;
}

/** Open a panel (restoring it if minimized). */
export function openPanel(panel: string): void {
  const state = useBrowserStore.getState();
  const existing = state.panels.find(p => p.contentType === panel);
  if (existing?.collapsed) state.setPanelCollapsed(existing.id, false);
  else if (!existing) state.openAnalysisPanel(panel);
}

/**
 * Open whatever hides the anchor, then wait (up to `timeoutMs`, like the
 * tour's wait for lazily loaded panels) for it to appear. Returns the element,
 * or null when it never showed (e.g. a strand chip on a non-DAF dataset).
 */
export async function revealTutorialAnchor(anchor: TutorialAnchor, timeoutMs = 3000, depth = 0): Promise<HTMLElement | null> {
  const already = findVisible(anchor.selector);
  if (already) return already;
  const { panel, tab, sidebar, subsection, expand } = anchor.reveal;
  if (sidebar) {
    useBrowserStore.getState().setSidebarOpen(true);
    openSidebarSection(sidebar, subsection);
  }
  if (panel) {
    openPanel(panel);
    if (tab) await showPanelTab(panel, tab, timeoutMs);
  }
  const toggleAnchor = expand && depth < 3 ? tutorialAnchorById(expand) : undefined;
  if (toggleAnchor) {
    // Idempotent: the target isn't visible yet, and an open toggle says so
    // (aria-expanded), so this never collapses something already open.
    const toggle = await revealTutorialAnchor(toggleAnchor, timeoutMs, depth + 1);
    if (toggle && toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
  }
  return waitForVisible(anchor.selector, timeoutMs);
}
