import type { PanelConfig } from '../../types';

/**
 * Minimized dataset panels are listed in one place at a time (M18): as
 * buttons at the right end of the analysis strip, or, while the strip is
 * folded away, in a tray under the panels.
 */
export function minimizedTrayShown(
  panels: Pick<PanelConfig, 'collapsed' | 'contentType'>[],
  analysisStripCollapsed: boolean,
): boolean {
  return analysisStripCollapsed && panels.some(p => p.collapsed && p.contentType === 'dataset');
}
