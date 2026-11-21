/**
 * The one-to-one table between a hub feature type (`typeId`, dotted: 'fp.class') and the selection kind of its
 * refs (`FeatureRef.kind`, hyphenated: 'fp-class'). Existing kinds keep their names (fp-class, nfr, nfr-variant,
 * sv); new ones are the type id with dots and underscores as hyphens (peaks-peak, var-diff, nuc-seg-regular).
 * Code checks a kind through its `FeatureKindDef` (stores/featureStore.ts), never by its string.
 */

export const LEGACY_KINDS: Record<string, string> = {
  'fp.class': 'fp-class',
  'nfr.region': 'nfr',
  'nfr.variant': 'nfr-variant',
  'var.sv': 'sv',
  'peaks.peak': 'peaks-peak',
  'var.diff': 'var-diff',
  'graph.bubble': 'graph-bubble',
  'var.snp': 'var-snp',
};
const LEGACY_TYPE: Record<string, string> = Object.fromEntries(Object.entries(LEGACY_KINDS).map(([t, k]) => [k, t]));

/** The selection kind of a type's refs. */
export function kindOfType(typeId: string): string {
  return LEGACY_KINDS[typeId] ?? typeId.replace(/[._]/g, '-');
}

/**
 * The type a kind belongs to, among the types the registry knows (the generic rule is not reversible on its own:
 * 'nuc-seg-low-information' could be nuc.seg.low_information or nuc.seg.low.information).
 */
export function typeOfKind(kind: string, known: Iterable<string> = []): string | undefined {
  if (LEGACY_TYPE[kind]) return LEGACY_TYPE[kind];
  for (const t of known) if (kindOfType(t) === kind) return t;
  return undefined;
}

/** Whether a set of type ids maps to distinct kinds (the table stays one to one). */
export function kindsAreDistinct(typeIds: string[]): boolean {
  const kinds = typeIds.map(kindOfType);
  return new Set(kinds).size === new Set(typeIds).size;
}
