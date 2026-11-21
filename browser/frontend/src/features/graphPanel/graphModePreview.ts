/**
 * Graph mode on dataset panels (Linear ⇄ Graph, haplotype pop-outs) as a labelled Preview (utils/previewFeatures): the
 * graph-mode toggle carries the Preview badge; nothing is hidden while previews are off. The standalone Graph view
 * panel is a separate, switchable Preview (GRAPH_VIEW_PREVIEW).
 */
import { registerPreviewFeature } from '../../utils/previewFeatures';

export const GRAPH_MODE_PREVIEW = 'graph-mode';

registerPreviewFeature({
  id: GRAPH_MODE_PREVIEW,
  label: 'Graph mode',
  summary: 'A dataset panel drawn on a pangenome graph package\'s haplotype lanes, with pop-outs, graph clustering and site sort.',
  limitations: [
    'It needs the graph helper, built for Apple silicon Macs for now, and a registered graph package that binds the dataset.',
    'Wide or unresolved views switch to linear (by default past 50 kb).',
  ],
  graduation: 'It leaves Preview when the graph helper is available on every platform and sessions saved with earlier versions are checked to open unchanged.',
  labelOnly: true,
});
