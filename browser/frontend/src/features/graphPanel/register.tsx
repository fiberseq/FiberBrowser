/**
 * The graph-view panel type (DESIGN_GRAPH_PANEL.md §1): `contentType: 'graph-view'`, not a singleton, opened from
 * its rail tile or the strip with no dataset. A Preview feature while Gates C–G are outstanding.
 */
import { lazy } from 'react';
import { registerAnalysisPanel, registerPanelMigration } from '../../plugins/registry';
import { registerPanelHeaderExtension } from '../../components/tracks/panelHeaderExtensions';
import { registerDatasetBody } from '../../components/tracks/datasetBodyExtensions';
import { useBrowserStore } from '../../stores/browserStore';
import { restoreOrphanGraphMembers } from '../../stores/graphMembership';
import { GraphHostBody, hostShowsGraph, useGraphModeHeader } from './hostHeader';
import { startHandoffController } from './handoff';
import { useGraphBindingsStore } from './bindingsStore';
import { settlePendingGraphOpens } from './openAsGraph';
import { registerGraphClustering } from './graphCluster';
import { registerGraphScan } from './graphScan';
import { startSelectionSync } from './selectionSync';
import { declareContribution } from '../../plugins/packRegistry';
import { registerPreviewFeature } from '../../utils/previewFeatures';
import { GraphView } from '../icons';
import './types';

export const GRAPH_VIEW_PANEL = 'graph-view';
export const GRAPH_VIEW_PREVIEW = 'graph-view';

const LazyGraphPanel = lazy(() => import('./GraphPanel'));

let done = false;

export function registerGraphPanel(): void {
  if (done) return;
  done = true;
  registerPreviewFeature({
    id: GRAPH_VIEW_PREVIEW,
    label: 'Graph view',
    summary: 'Up to four paths of a prepared pangenome graph package (a target and the haplotypes compared with it), drawn on the target\'s own ruler, with no BAM needed.',
    limitations: [
      'Paths are drawn as a selected-path tube map: shared sequence once, small differences as marks on the tube, larger ones as bubbles; not every graph allele.',
      'Reads are drawn for datasets bound to a path by explicit identity (a live-lift map of the same path, or a BAM on the target). A bound dataset panel can also be viewed as a graph in place (its header\'s Linear ⇄ Graph), with its haplotypes popped out as panels.',
      'At most 50 kb of the target and four paths (the target included) at a time.',
      'The graph helper (the fiberbrowser-graph-native companion package, or the macOS app) and a package made by fiberbrowser-graph prepare are needed.',
    ],
    inUse: state => Boolean(state.panels?.some(p => p.contentType === GRAPH_VIEW_PANEL)),
    graduation: 'It graduates with every platform\'s helper and the release replay (Gate G).',
  });
  registerAnalysisPanel({
    contentType: GRAPH_VIEW_PANEL,
    label: 'Graph view',
    shortLabel: 'Graph',
    // Stone (stone-600): neutral like the graph's target backbone, apart from every other tile.
    headerColor: '#57534e',
    component: LazyGraphPanel,
    icon: GraphView,
    description: 'Paths of a pangenome graph package around a target locus, on the graph\'s own ruler (no BAM needed)',
    group: 'view',
    singleton: false,
    hostOnly: true,
    minUsableWidth: 280,
    bodyLayout: 'fill',
    // A tube map a few lanes tall: under the reads at its natural height, not a tall column beside them.
    sizeToContent: true,
    opens: 'stack-below-reads',
    preview: GRAPH_VIEW_PREVIEW,
    sessionKeys: ['panels[].graphView', 'graphSelection', 'graphInspect'],
    apiEndpoints: ['/api/graph/status', '/api/graph/subgraph', '/api/graph/requests/{id}', '/api/graph/read_bindings',
      '/api/graph/reads', '/api/graph/sequence', '/api/graph/differences', '/api/graph/cluster', '/api/graph/cluster/assign'],
  });
  declareContribution('panelFields', 'graphView');
  for (const field of ['viewMode', 'graphMemberOf', 'collapsedByGraphGroup', 'graphHandoff']) declareContribution('panelFields', field);
  registerGraphMode();
}

/**
 * Graph mode of dataset panels (DESIGN_GRAPH_PRIMARY; graph primary G1/G6): the header toggle, the graph body in place
 * of the sub-tracks, the zoom-out hand-off, the read bindings every header reads, orphaned members shown again, and
 * schema 1 sessions restored as standalone graph views.
 */
function registerGraphMode(): void {
  registerPanelHeaderExtension(useGraphModeHeader);
  registerDatasetBody({ id: 'graph-mode', shows: hostShowsGraph, component: GraphHostBody });
  registerPanelMigration(panel => {
    const gv = panel.graphView as { schema?: number; role?: string } | undefined;
    if (!gv || typeof gv !== 'object' || gv.role) return null;
    // Schema 1 (a graph-view panel's state before graph mode): standalone. A dataset panel never had one.
    return { ...panel, graphView: { ...gv, schema: 2, role: panel.contentType === 'dataset' ? 'host' : 'standalone' } };
  });
  startHandoffController();
  // Cluster on graph columns when a host draws its graph (DESIGN_GRAPH_PRIMARY §3.4; graph primary G4/G5).
  registerGraphClustering();
  registerGraphScan();
  startSelectionSync();
  useBrowserStore.subscribe((s, prev) => {
    if (s.panels !== prev.panels) {
      // Members whose host closed (or a session without it): shown again, out of the graph (D8).
      const fixed = restoreOrphanGraphMembers(s.panels);
      if (fixed !== s.panels) queueMicrotask(() => useBrowserStore.setState(st => ({ panels: restoreOrphanGraphMembers(st.panels) })));
      settlePendingGraphOpens();
    }
  });
  useGraphBindingsStore.subscribe(settlePendingGraphOpens);
}
