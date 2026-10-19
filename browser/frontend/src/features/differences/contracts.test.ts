import { describe, expect, it } from 'vitest';
import { fanOutEnrichedCalls, fanOutMoleculeCalls, type MoleculeEnvelope } from './contracts';

describe('explicit allele enrichment revision', () => {
  const unknown = { call: { assignment: 'unknown' as const, level: null, method: 'geometry_only', reasons: ['sequence_not_assessed'], witness_ids: [] },
    representations: [], complete: true, geometry_group: 0 };
  const carrier = { ...unknown, call: { ...unknown.call, assignment: 'target' as const, level: 'confirmed' as const, method: 'exact_sequence', reasons: [] } };
  const envelope: MoleculeEnvelope = { schema_version: 'differences:v1',
    calls_by_molecule: { molecule: unknown }, membership: { rows: { dataset: { row: 'molecule', placement: 'molecule' } }, molecules: {}, legacy_aliases: {} },
    enrichment: { enrichment_id: 'revision-1', snapshot: { target_id: 'target', revision: 1, analysis_scope: 'native_only' },
      calls_by_molecule: { molecule: carrier }, search_complete: true, reasons: [] } };

  it('fans one enriched molecule call to every row while retaining frozen geometry calls', () => {
    expect(fanOutMoleculeCalls(envelope, 'dataset')).toEqual({ row: unknown, placement: unknown });
    expect(fanOutEnrichedCalls(envelope, 'dataset', 'revision-1')).toEqual({ row: carrier, placement: carrier });
    expect(envelope.calls_by_molecule.molecule).toBe(unknown);
  });

  it('rejects stale, missing and resource-refused revisions', () => {
    expect(() => fanOutEnrichedCalls(envelope, 'dataset', 'revision-0')).toThrow('unavailable');
    expect(() => fanOutEnrichedCalls({ ...envelope, enrichment: undefined }, 'dataset', 'revision-1')).toThrow('unavailable');
    expect(() => fanOutEnrichedCalls({ ...envelope, enrichment: { ...envelope.enrichment!, calls_by_molecule: {} } }, 'dataset', 'revision-1')).toThrow('unavailable');
  });
});
