/**
 * The feature hub (native/feature_hub/DESIGN.md): the singleton analysis panel docked beside the reads, its session
 * state, the core browser providers, and the kinds of hub types. Registered through the same extension points a
 * plugin pack uses; called once from features/register.ts.
 */
import { lazy } from 'react';
import { registerAnalysisPanel } from '../../plugins/registry';
import { registerHubState } from './hubState';
import { registerCoreHubProviders } from './providers';
import { FeatureHubIcon } from './icon';

const Panel = lazy(() => import('./FeatureHubPanel').then(m => ({ default: m.FeatureHubPanel })));
let done = false;

export function registerFeatureHub(): void {
  if (done) return;
  done = true;
  registerHubState();
  registerCoreHubProviders();
  registerAnalysisPanel({
    contentType: 'feature-hub', label: 'Feature hub', shortLabel: 'Hub', headerColor: '#4f46e5', component: Panel,
    icon: FeatureHubIcon, group: 'analysis', stripOrder: 5.4, singleton: true, minUsableWidth: 320,
    description: 'Every feature set (scans, footprint classes, NFRs, SVs, peaks, Differences) in one list, with a column per dataset; use hits as anchors, cluster regions or a filter.',
    sessionKeys: ['featureHub'], apiEndpoints: ['/api/scan/*', '/api/features/states'],
  });
}
