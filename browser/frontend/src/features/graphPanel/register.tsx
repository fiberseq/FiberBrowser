/**
 * The graph-view panel type (DESIGN_GRAPH_PANEL.md §1): `contentType: 'graph-view'`, not a singleton, opened from
 * its rail tile or the strip with no dataset. A Preview feature while Gates C–G are outstanding.
 */
import { lazy } from 'react';
import { registerAnalysisPanel } from '../../plugins/registry';
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
      'Reads are drawn for datasets bound to a path by explicit identity (a live-lift map of the same path, or a BAM on the target).',
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
      '/api/graph/reads', '/api/graph/sequence', '/api/graph/differences'],
  });
  declareContribution('panelFields', 'graphView');
}
