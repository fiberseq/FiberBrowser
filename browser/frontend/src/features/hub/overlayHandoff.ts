/** Hand loci to the Feature hub's overlay tab (DESIGN §8): the nucleosome panel's patch list, or any panel. */
import { useBrowserStore } from '../../stores/browserStore';
import { DEFAULT_OVERLAY, type OverlayLayer, type OverlayLocus } from './overlayTypes';

export function sendToOverlay(loci: OverlayLocus[], layer?: OverlayLayer): void {
  const s = useBrowserStore.getState();
  s.setFeatureHub(h => ({ overlay: { ...(h.overlay ?? DEFAULT_OVERLAY), loci: 'patches', handed: loci.slice(0, 5000), ...(layer ? { layer } : {}), result: null },
    ui: { ...h.ui, tab: 'overlay' } }));
  s.openAnalysisPanel('feature-hub');
}
