/** Alt-allele (insert-expanded) panels as a Preview feature (utils/previewFeatures). */
import { registerPreviewFeature } from '../../utils/previewFeatures';

export const ALT_ALLELE_PREVIEW = 'alt-allele';

export function registerAltAllelePreview(): void {
  registerPreviewFeature({
    id: ALT_ALLELE_PREVIEW,
    label: 'Insert-expanded panels',
    summary: 'An insertion\'s carriers re-aligned onto its alternate allele (reference flank + insert consensus + reference flank), so the reads inside the insert can be clustered, sorted, filtered and analysed like any region.',
    limitations: [
      'The insert is a consensus of the carriers that hold all of it in their alignment; carriers clipped at the breakpoint place only the part of the insert they hold, and hard-clipped carriers only their flank.',
      'Above the carrier cap (5,000 by default) the carriers are sampled evenly; the panel\'s provenance says how many were placed and why others were left out.',
      'Positions inside the insert have no reference coordinates: the ruler shows insert coordinates there, and a linked panel holds the main view at the breakpoint.',
      'The first build of an insertion takes about 25–40 s for thousands of carriers (re-alignment); it is cached, so reopening it or restoring a session is quick.',
    ],
    inUse: state => Boolean(state.panels?.some(p => p.altAllele != null)),
    graduation: 'It graduates once partial (clipped) carriers are placed reliably and the consensus is checked against assembled alleles at several insertions and chemistries.',
  });
}
