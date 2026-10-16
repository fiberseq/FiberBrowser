/** Accessibility (preview): the panel's terms in words, for its legend and "?" help (one place, so they agree). */

export const HELP = {
  callable: 'Callable reads have a nucleosome call on both sides of the region, so both edges of their opening are seen. '
    + 'Other reads are edge-censored and left out of every number of the card.',
  closed: 'Closed %: the share of the callable reads with no opening of at least the minimum gap in the region (estimated, as the variants are).',
  interval: 'The numbers in brackets, e.g. [26–30], are the 95% interval of the prevalence from a read bootstrap that holds the variant set fixed.',
  types: 'Variant types, against the most common variant ("full"): full-like (both edges within the shift tolerance), extended (wider on one '
    + 'or both edges), trimmed / core (narrower on one / both edges), shifted (one edge out, one in), alternative (overlaps the full one by at '
    + 'most half the smaller width), satellite (an alternative that is on the same reads as the full one more often than not), merged Va+Vb '
    + '(one opening spanning two smaller variants that sit side by side).',
  prevalence: 'Prevalence is the estimated molecule prevalence: an EM estimate over the callable reads, where each read counts by how likely '
    + 'it is to carry the variant. Group in this panel and Split into panels instead put each read in one group, its most likely '
    + 'configuration (a read can carry two variants, e.g. V1+V3), and count every read, the edge-censored ones as not informative; their counts '
    + 'therefore differ from the prevalence.',
  detection: 'The share of callable reads inside a gap of at least 175 bp at the NFR peak. Background, fold over background and q describe the evidence; raw detection does not gate on fold or q. Enrichment in Settings adds those gates.',
  rarest: 'Find NFRs open in at least this raw percentage of callable reads. Read, depth and width floors still apply. The background marker describes this view; it is not a cutoff. Enrichment in Settings also gates on background and q.',
  configurations: 'Each read goes to its most likely configuration: closed, one variant (V1), two on the same read (V1+V3), or other (an '
    + 'opening that fits no variant). The variants above count a read in every configuration that holds them; these are the configurations '
    + 'that are not a single variant.',
} as const;

/** A variant type's one-line meaning (its relation to the most common variant). */
export function variantTypeHelp(relation: string): string {
  const r = relation.toLowerCase();
  if (r === 'full') return 'full: the most common variant, the one the others are described against';
  if (r === 'full-like') return 'full-like: both edges within the shift tolerance of the full variant';
  if (r.startsWith('extended')) return `${relation}: wider than the full variant on ${r === 'extended' ? 'both edges' : `its ${r.split('-')[1]} edge`}`;
  if (r.startsWith('trimmed')) return `${relation}: narrower than the full variant on its ${r.split('-')[1]} edge`;
  if (r === 'core') return 'core: narrower than the full variant on both edges';
  if (r.startsWith('shifted')) return `${relation}: one edge outside the full variant and one inside`;
  if (r.startsWith('alternative')) return `${relation}: overlaps the full variant by at most half the smaller width (another opening)`;
  if (r.startsWith('satellite')) return `${relation}: an alternative opening found on the same reads as the full variant more often than not`;
  if (r.startsWith('merged')) return `${relation}: one opening spanning two smaller variants that sit side by side`;
  return relation;
}
