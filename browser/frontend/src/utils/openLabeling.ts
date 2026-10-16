import { useBrowserStore } from '../stores/browserStore';

/** Open the Labeling panel, on its Rules or Quality tab. */
export function openLabelingPanel(tab: 'rules' | 'quality' = 'rules'): void {
  try {
    window.sessionStorage.setItem('fiberbrowser_colormap_tab', tab);
  } catch { /* tab memory is a convenience */ }
  useBrowserStore.getState().openAnalysisPanel('colormap');
  window.dispatchEvent(new CustomEvent('fiberbrowser:open-colormap-tab', { detail: { tab } }));
}
