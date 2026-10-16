import type { PanelConfig } from '../../../types';

/**
 * The primer target box on the ruler belongs to the Primers panel: it is drawn
 * only while that panel is open (not minimized), so closing the panel clears
 * the ruler without forgetting the target (M13).
 */
export function primerTargetOverlayVisible(panels: Pick<PanelConfig, 'contentType' | 'collapsed'>[]): boolean {
  return panels.some(panel => panel.contentType === 'primer-design' && !panel.collapsed);
}
