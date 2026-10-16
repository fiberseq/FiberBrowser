import { lazy } from 'react';
import { registerAnalysisPanel } from '../../plugins/registry';
import { registerSyncState } from './syncState';
import { registerAnchorPick } from './anchors';
import { registerMatchedRegions } from './matchedRegions';
import { SyncRegions } from './icon';
const Panel = lazy(() => import('./SyncPanel').then(m => ({ default: m.SyncPanel })));
/** All entry points and persisted state belong to the lab pack. */
export function registerSync() {
  registerAnalysisPanel({
    contentType: 'sync-regions', label: 'Synchronise regions', shortLabel: 'Synchronise',
    headerColor: '#0d9488', component: Panel, icon: SyncRegions, group: 'analysis', stripOrder: 5.6,
    description: 'Map comparable subregions, refine their extent and save an oriented comparison frame.',
    sessionKeys: ['comparisonFrames', 'activeComparisonFrameId'], apiEndpoints: ['/api/lab/region-sync/jobs', '/api/lab/region-sync/jobs/*', '/api/lab/cluster-regions']
  });
  registerSyncState();
  registerAnchorPick();
  registerMatchedRegions();
}
