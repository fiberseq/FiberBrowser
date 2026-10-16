/**
 * The Footprints panel's footprint classes (Find classes: fiberhmm-consensus) as a labelled Preview
 * (utils/previewFeatures): the section carries the Preview badge; it is not hidden while previews are off.
 */
import { registerPreviewFeature } from '../../../utils/previewFeatures';

export const FOOTPRINT_CLASSES_PREVIEW = 'footprint-classes';

registerPreviewFeature({
  id: FOOTPRINT_CLASSES_PREVIEW,
  label: 'Footprint classes',
  summary: 'Find classes: the recurrent footprint classes in a region (fiberhmm-consensus), their read groups and comparisons.',
  limitations: [
    'Class discovery (fiberhmm-consensus) is newer than FiberHMM\'s footprint calls: its method, parameters and outputs can still change.',
  ],
  graduation: 'It graduates once its classes are checked across loci, assays and datasets and its outputs are stable between releases.',
  labelOnly: true,
});
