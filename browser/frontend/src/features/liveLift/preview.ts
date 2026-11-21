/**
 * Live lift (and the Differences row's assembly lanes) as a labelled Preview (utils/previewFeatures): its entry points
 * carry the Preview badge (Open ▾ → Add live lift…, the dialog, a lifted panel's chip); nothing is hidden while
 * previews are off (owner, 20 Nov 2026: 3.1.0 ships live lift and graph mode as previews, labelled, on by default).
 */
import { registerPreviewFeature } from '../../utils/previewFeatures';
import { isLiveLift } from '../../utils/datasetKinds';
import type { Dataset, PanelConfig } from '../../types';

export const LIVE_LIFT_PREVIEW = 'live-lift';

registerPreviewFeature({
  id: LIVE_LIFT_PREVIEW,
  label: 'Live lift',
  summary: 'Reads aligned to a sample\'s own assembly, drawn on this genome through a lift map without realigning, with linked source views and the Differences row.',
  limitations: [
    'Its controls, settings and the Differences row\'s evidence labels may still change between releases.',
    'Analyses that need one coordinate system per read refuse incomplete lifted evidence (truncated, folded or noncolinear records) and say which input to use instead.',
  ],
  graduation: 'It leaves Preview once its lift and evidence rules are checked on more samples and assemblies and sessions saved with earlier versions are checked to open unchanged.',
  labelOnly: true,
});

/** Does this panel's live-lift chip carry the Preview badge? A lifted panel outside graph mode: one Preview badge per
 * panel (owner, 20 Nov 2026), so its graph toggle shows none; a graph host or member shows graph mode's instead. */
export function liveLiftBadgeShown(panel: Pick<PanelConfig, 'datasetId' | 'viewMode' | 'graphView' | 'graphMemberOf'>,
  dataset: Dataset | null | undefined): boolean {
  if (!isLiveLift(dataset) || !panel.datasetId) return false;
  return !(panel.viewMode === 'graph' || panel.graphView?.role === 'host' || Boolean(panel.graphMemberOf));
}
