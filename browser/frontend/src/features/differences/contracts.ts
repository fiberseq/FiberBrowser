/** Additive differences:v1 wire contract. All spans are absolute half-open. */
export const DIFFERENCES_SCHEMA = 'differences:v1' as const;
export interface MoleculeIdentity { provenance_group: string; library_id: string; raw_name: string }
export interface MoleculeCall {
  call: { assignment: 'target' | 'other_allele' | 'reference' | 'ambiguous' | 'unknown' | 'unavailable';
    level: 'confirmed' | 'putative' | 'conflicting' | 'ambiguous' | null;
    method: string; reasons: string[]; witness_ids: string[]; allele_id?: string | null };
  geometry_group?: number;
  representations: unknown[];
  complete: boolean;
}
export interface MoleculeEnvelope {
  schema_version: typeof DIFFERENCES_SCHEMA;
  calls_by_molecule: Record<string, MoleculeCall>;
  membership: {
    rows: Record<string, Record<string, string>>;
    molecules: Record<string, MoleculeIdentity>;
    legacy_aliases: Record<string, Record<string, string>>;
  };
}

/** Count once at molecule level, then use these memberships for rows/highlights.
 * Raw-name aliases are scoped to one dataset and emitted only when unambiguous. */
export function fanOutMoleculeCalls(envelope: MoleculeEnvelope, datasetId: string): Record<string, MoleculeCall> {
  if (envelope.schema_version !== DIFFERENCES_SCHEMA) throw new Error('Unsupported differences payload');
  return Object.fromEntries(Object.entries(envelope.membership.rows[datasetId] ?? {})
    .filter(([, molecule]) => envelope.calls_by_molecule[molecule])
    .map(([row, molecule]) => [row, envelope.calls_by_molecule[molecule]]));
}
