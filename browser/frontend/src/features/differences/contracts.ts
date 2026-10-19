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
  enrichment?: {
    enrichment_id: string;
    snapshot: { target_id: string; revision: number; analysis_scope: 'native_only' };
    calls_by_molecule: Record<string, MoleculeCall>;
    search_complete?: boolean;
    reasons: string[];
    counts?: Record<string, number>;
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

/** Explicit revision selection: sequence loading never replaces a geometry
 * cohort or a historical split implicitly. Missing/refused revisions fail. */
export function fanOutEnrichedCalls(envelope: MoleculeEnvelope, datasetId: string, enrichmentId: string): Record<string, MoleculeCall> {
  const enrichment = envelope.enrichment;
  if (!enrichment || enrichment.enrichment_id !== enrichmentId || !Object.keys(enrichment.calls_by_molecule).length) {
    throw new Error('Requested allele enrichment is unavailable');
  }
  return fanOutMoleculeCalls({ ...envelope, calls_by_molecule: enrichment.calls_by_molecule }, datasetId);
}

export interface ProjectedEnvelope {
  schema_version: typeof DIFFERENCES_SCHEMA;
  analysis_scope: 'lifted_only' | 'combined';
  membership: MoleculeEnvelope['membership'];
  targets: { target: { target_id: string; revision: number; target_type: 'geometry' | 'exact' };
    calls_by_molecule: Record<string, MoleculeCall>; counts: number[]; geometry_counts: number[] }[];
  status?: string;
}

/** Explicit frozen target/revision/scope selection precedes split/highlight fan-out.
 * Placement rows never add votes. Incomplete calls retain their own uncertainty;
 * refused or stale envelopes cannot replace a saved cohort. */
export function fanOutProjectedCalls(envelope: ProjectedEnvelope, datasetId: string,
  selection: { targetId: string; revision: number; analysisScope: ProjectedEnvelope['analysis_scope'] }): Record<string, MoleculeCall> {
  if (envelope.status || envelope.analysis_scope !== selection.analysisScope) throw new Error('Projected analysis is unavailable');
  const target = envelope.targets.find(t => t.target.target_id === selection.targetId && t.target.revision === selection.revision);
  if (!target) throw new Error('Requested frozen target is unavailable');
  return fanOutMoleculeCalls({ schema_version: envelope.schema_version, membership: envelope.membership,
    calls_by_molecule: target.calls_by_molecule }, datasetId);
}
