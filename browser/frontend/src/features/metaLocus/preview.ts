/** The meta-locus (a BED file's sites pooled into one virtual locus) as a Preview feature (utils/previewFeatures). */
import { registerPreviewFeature } from '../../utils/previewFeatures';

export const META_LOCUS_PREVIEW = 'meta-locus';

export function registerMetaLocusPreview(): void {
  registerPreviewFeature({
    id: META_LOCUS_PREVIEW,
    label: 'Meta-locus',
    summary: 'A BED file\'s sites (e.g. all promoters, TSS ± 10 kb) pooled into one virtual locus, with a seeded working set of reads drawn from the pool: browse, cluster and plot it like any locus.',
    limitations: [
      'Rows and panels that need one real genome position are left out on the meta contig: reference sequence, genes, motifs and other external tracks, primers, Micro-C, the SV row and the Variants panel, graph view, the insertion lens and the feature hub; autozoom and Best-covered window too.',
      'A read that falls in several sites counts once per site (read-site observations) in the view, the pool totals and Find more like this.',
      'Find classes runs FiberHMM\'s pooled mode, which analyses each molecule at one site: a shared read\'s other rows carry no class.',
      'Links and reloads rebuild the pool from the BED path, so the server must still read that file (its content is checked).',
    ],
    graduation: 'It leaves Preview once Find classes can analyse each read-site observation, and the pool, Find more like this and the refill are checked on several BED sets and datasets.',
  });
}
