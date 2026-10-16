/**
 * Copilot teaches: it navigates and opens panels, tabs and sidebar sections
 * for the user and points at controls, but leaves the clicks that run
 * something (scan, cluster, filter, load, export, ...) to the user. A
 * `try_it` step asks the user to do one and waits until they have.
 *
 * Mirrors COPILOT_TEACH_ACTIONS in browser/services/natural_language_commands.py,
 * which already drops everything else from a plan; this is the second line
 * of defence for the Copilot panel only. The guided tour, the Jupyter bridge
 * and the headless API call executeBrowserAction directly and are unaffected.
 */
export const COPILOT_TEACH_ONLY = true;

export const COPILOT_TEACH_ACTIONS: ReadonlySet<string> = new Set([
  'explain',
  'try_it',
  'open_panel',
  'open_sidebar',
  'close_panel',
  'navigate_gene',
  'navigate_region',
  'zoom_view',
  'pan_view',
  'reset_view',
  'go_to_top_locus',
]);

export function splitTeachActions<T extends { type?: unknown }>(actions: readonly T[]): { allowed: T[]; dropped: T[] } {
  if (!COPILOT_TEACH_ONLY) return { allowed: [...actions], dropped: [] };
  const allowed: T[] = [];
  const dropped: T[] = [];
  for (const action of actions) {
    (COPILOT_TEACH_ACTIONS.has(String(action.type ?? '')) ? allowed : dropped).push(action);
  }
  return { allowed, dropped };
}
