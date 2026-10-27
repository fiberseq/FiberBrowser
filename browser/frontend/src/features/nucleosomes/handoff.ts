/**
 * Hand-offs into window mode (DESIGN §6.2): an NFR, a footprint, a peak or a hub hit elsewhere sends its span and
 * anchor here. The first nucleosome panel takes it (one is opened when none is), switches to window mode on the
 * hand-off, and keeps its own anchor, orientation and background choices.
 */
import { useBrowserStore } from '../../stores/browserStore';
import { revealDrawerPanel } from '../../stores/drawerTabsStore';
import type { NucWindow } from './types';

export function sendToNucleosomeWindow(window: NucWindow): string | null {
  if (!window.chrom || !(window.end > window.start)) return null;
  const find = () => useBrowserStore.getState().panels.find(p => p.contentType === 'nucleosomes');
  let panel = find();
  if (!panel) {
    useBrowserStore.getState().openAnalysisPanel('nucleosomes');
    panel = find();
    if (!panel) return null;
  } else {
    if (panel.collapsed) useBrowserStore.setState(s => ({ panels: s.panels.map(p => p.id === panel!.id ? { ...p, collapsed: false } : p) }));
    revealDrawerPanel(panel.id);
  }
  const id = panel.id;
  useBrowserStore.setState(s => ({ panels: s.panels.map(p => p.id === id ? {
    ...p, nucleosomes: { ...(p.nucleosomes ?? {}), mode: 'window', windowSource: 'handoff', window,
      // A hand-off with an anchor phases at it, unless the user chose another anchor kind before.
      anchor: p.nucleosomes?.anchor && p.nucleosomes.windowSource === 'handoff' ? p.nucleosomes.anchor
        : { kind: window.anchor != null ? 'feature' : 'none', orientation: 'feature' } },
  } : p) }));
  return id;
}
